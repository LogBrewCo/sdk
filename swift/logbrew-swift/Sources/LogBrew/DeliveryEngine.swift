import Foundation

final class DeliveryEngine: @unchecked Sendable {
    static let maxQueuedEvents = 1000
    static let maxQueuedBytes = 4 * 1024 * 1024
    static let maxRequestEvents = 100
    static let maxRequestBytes = 256 * 1024
    static let maxScheduleDelay: TimeInterval = 24 * 60 * 60

    struct QueuedEvent {
        let event: Event
        let encodedBytes: Int
        let durableRecordName: String?
    }

    struct FrozenPrefix {
        let count: Int
        let bytes: Int
        let body: Data
        let durableRecordNames: [String]
    }

    enum AttemptResult {
        case accepted(statusCode: Int, attempts: Int)
        case retryable(attempts: Int, error: SdkError)
        case terminal(reason: DeliveryPauseReason, attempts: Int, error: SdkError)

        var attempts: Int {
            switch self {
            case let .accepted(_, attempts), let .retryable(attempts, _), let .terminal(_, attempts, _):
                attempts
            }
        }
    }

    let apiKey: String
    let sdk: SDKInfo
    let maxRetries: Int
    let stateLock = NSLock()
    let flushLock = NSLock()
    let storageLock = NSLock()
    var queue: [QueuedEvent] = []
    var queuedBytes = 0
    var frozenPrefix: FrozenPrefix?
    var durableStore: DurableDeliveryStore?
    var durableParent: URL?
    var closed = false

    var state: DeliveryState = .manual
    var lastOutcome: DeliveryOutcome = .none
    var pauseReason: DeliveryPauseReason = .none
    var inFlight = false
    var acceptedEvents = 0
    var droppedEvents = 0
    var deliveryAttempts = 0
    var consecutiveFailures = 0

    var automaticTransport: (any Transport)?
    var automaticOptions: AutomaticDeliveryOptions?
    var schedulerQueue: DispatchQueue?
    var schedulerTimer: DispatchSourceTimer?
    var nextWakeNanoseconds: UInt64?
    var generation: UInt64 = 0
    var retryAttempt = 0
    let schedulerKey = DispatchSpecificKey<UInt8>()

    init(apiKey: String, sdk: SDKInfo, maxRetries: Int) {
        self.apiKey = apiKey
        self.sdk = sdk
        self.maxRetries = max(0, maxRetries)
    }

    deinit {
        schedulerTimer?.setEventHandler {}
        schedulerTimer?.cancel()
    }

    func pendingEvents() -> Int {
        withStateLock { queue.count }
    }

    func previewJSON() throws -> String {
        let events = withStateLock { queue.map(\.event) }
        let data = try encodeBatch(events)
        guard let json = String(data: data, encoding: .utf8) else {
            throw SdkError(code: "encoding_error", message: "event batch was not valid UTF-8")
        }
        return json
    }

    func health() -> DeliveryHealth {
        withStateLock {
            DeliveryHealth(
                state: state,
                queuedEvents: queue.count,
                queuedBytes: queuedBytes,
                inFlight: inFlight,
                acceptedEvents: acceptedEvents,
                droppedEvents: droppedEvents,
                deliveryAttempts: deliveryAttempts,
                consecutiveFailures: consecutiveFailures,
                lastOutcome: lastOutcome,
                pauseReason: pauseReason,
            )
        }
    }

    func startAutomaticDelivery(transport: any Transport, options: AutomaticDeliveryOptions) throws {
        try validate(options)

        storageLock.lock()
        stateLock.lock()
        if closed || state == .closed || state == .shuttingDown {
            stateLock.unlock()
            storageLock.unlock()
            throw SdkError(code: "shutdown_error", message: "client is already shut down")
        }
        if automaticTransport != nil {
            stateLock.unlock()
            storageLock.unlock()
            throw SdkError(code: "configuration_error", message: "automatic delivery is already running")
        }
        if state == .paused, pauseReason == .storage {
            stateLock.unlock()
            storageLock.unlock()
            throw SdkError(code: "storage_corrupt", message: "durable delivery data requires explicit recovery")
        }
        generation &+= 1
        let ownerGeneration = generation
        let scheduler = DispatchQueue(label: "co.logbrew.swift.delivery", qos: .utility)
        scheduler.setSpecific(key: schedulerKey, value: 1)
        let timer = DispatchSource.makeTimerSource(queue: scheduler)
        timer.setEventHandler { [weak self] in
            self?.timerFired(generation: ownerGeneration)
        }
        automaticTransport = transport
        automaticOptions = options
        schedulerQueue = scheduler
        schedulerTimer = timer
        state = .running
        pauseReason = .none
        retryAttempt = 0
        let shouldSchedule = scheduleLiveQueueLocked()
        stateLock.unlock()
        storageLock.unlock()

        timer.resume()
        if shouldSchedule {
            scheduleTimerUpdate()
        }
    }

    func recoverAutomaticDelivery() throws {
        stateLock.lock()
        guard automaticTransport != nil, automaticOptions != nil else {
            stateLock.unlock()
            throw SdkError(code: "configuration_error", message: "automatic delivery is not running")
        }
        guard state == .paused else {
            stateLock.unlock()
            return
        }
        if pauseReason == .storage {
            stateLock.unlock()
            throw SdkError(code: "storage_corrupt", message: "durable delivery data requires explicit recovery")
        }
        state = .running
        pauseReason = .none
        retryAttempt = 0
        consecutiveFailures = 0
        nextWakeNanoseconds = nil
        let shouldSchedule = scheduleLiveQueueLocked()
        stateLock.unlock()
        if shouldSchedule {
            scheduleTimerUpdate()
        }
    }

    func stopAutomaticDelivery() {
        let timer: DispatchSourceTimer?
        let scheduler: DispatchQueue?
        storageLock.lock()
        stateLock.lock()
        generation &+= 1
        timer = schedulerTimer
        scheduler = schedulerQueue
        schedulerTimer = nil
        schedulerQueue = nil
        nextWakeNanoseconds = nil
        automaticTransport = nil
        automaticOptions = nil
        retryAttempt = 0
        pauseReason = .none
        if !closed, state != .shuttingDown {
            state = .manual
        }
        stateLock.unlock()
        storageLock.unlock()

        timer?.setEventHandler {}
        timer?.cancel()
        if DispatchQueue.getSpecific(key: schedulerKey) == nil {
            scheduler?.sync {}
            flushLock.lock()
            flushLock.unlock()
        }
    }

    func flush(transport: any Transport) throws -> TransportResponse {
        try prepareManualOperation()
        flushLock.lock()
        defer {
            flushLock.unlock()
            rescheduleAfterManualOperation()
        }
        return try flushAll(transport: transport)
    }

    func flushOwnedTransport() throws -> TransportResponse {
        let transport = try ownedTransport()
        return try flush(transport: transport)
    }

    func shutdown(transport: any Transport) throws -> TransportResponse {
        let priorAutomatic = try beginShutdown()
        flushLock.lock()
        do {
            let response = try flushAll(transport: transport)
            stateLock.lock()
            closed = true
            state = .closed
            inFlight = false
            stateLock.unlock()
            flushLock.unlock()
            finishStopping(timer: priorAutomatic.timer, scheduler: priorAutomatic.scheduler)
            return response
        } catch {
            stateLock.lock()
            state = pauseReason == .storage ? .paused : .manual
            closed = false
            inFlight = false
            stateLock.unlock()
            flushLock.unlock()
            finishStopping(timer: priorAutomatic.timer, scheduler: priorAutomatic.scheduler)
            throw error
        }
    }

    func shutdownOwnedTransport() throws -> TransportResponse {
        let transport = try ownedTransport()
        return try shutdown(transport: transport)
    }
}
