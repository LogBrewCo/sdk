import Foundation

extension DeliveryEngine {
    func timerFired(generation ownerGeneration: UInt64) {
        let now = DispatchTime.now().uptimeNanoseconds
        stateLock.lock()
        guard generation == ownerGeneration else {
            stateLock.unlock()
            return
        }
        guard let deadline = nextWakeNanoseconds, now >= deadline else {
            stateLock.unlock()
            return
        }
        nextWakeNanoseconds = nil
        let active = automaticTransport != nil && (state == .running || state == .retrying)
        stateLock.unlock()
        guard active else {
            return
        }
        runAutomaticDelivery(generation: ownerGeneration)
    }

    func runAutomaticDelivery(generation currentGeneration: UInt64) {
        flushLock.lock()
        defer { flushLock.unlock() }

        guard let transport = transportForAutomaticRun(generation: currentGeneration) else {
            return
        }
        let prefix: FrozenPrefix
        do {
            guard let nextPrefix = try freezePrefix() else {
                finishEmptyAutomaticRun(generation: currentGeneration)
                return
            }
            prefix = nextPrefix
        } catch {
            pauseAfterInternalFailure(generation: currentGeneration)
            return
        }

        let result = attempt(transport: transport, prefix: prefix)
        finishAutomaticAttempt(result, prefix: prefix, generation: currentGeneration)
    }

    private func transportForAutomaticRun(generation currentGeneration: UInt64) -> (any Transport)? {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard generation == currentGeneration, state == .running || state == .retrying else {
            return nil
        }
        return automaticTransport
    }

    private func finishEmptyAutomaticRun(generation currentGeneration: UInt64) {
        stateLock.lock()
        if generation == currentGeneration, state != .paused {
            state = .running
        }
        stateLock.unlock()
    }

    private func finishAutomaticAttempt(
        _ result: AttemptResult,
        prefix: FrozenPrefix,
        generation currentGeneration: UInt64,
    ) {
        if case .accepted = result {
            finishAcceptedAutomaticAttempt(result, prefix: prefix, generation: currentGeneration)
            return
        }
        stateLock.lock()
        guard generation == currentGeneration || state == .shuttingDown else {
            inFlight = false
            stateLock.unlock()
            return
        }
        inFlight = false
        deliveryAttempts += result.attempts
        let shouldSchedule = applyAutomaticResultLocked(result, prefix: prefix)
        stateLock.unlock()
        if shouldSchedule {
            scheduleTimerUpdate()
        }
    }

    private func finishAcceptedAutomaticAttempt(
        _ result: AttemptResult,
        prefix: FrozenPrefix,
        generation currentGeneration: UInt64,
    ) {
        storageLock.lock()
        stateLock.lock()
        guard generation == currentGeneration || state == .shuttingDown else {
            inFlight = false
            stateLock.unlock()
            storageLock.unlock()
            return
        }
        let store = durableStore
        stateLock.unlock()

        let finalResult: AttemptResult
        do {
            try store?.acknowledge(body: prefix.body, eventRecordNames: prefix.durableRecordNames)
            finalResult = result
        } catch {
            finalResult = .terminal(
                reason: .storage,
                attempts: result.attempts,
                error: storageError(error),
            )
        }

        stateLock.lock()
        inFlight = false
        deliveryAttempts += finalResult.attempts
        let shouldSchedule = applyAutomaticResultLocked(finalResult, prefix: prefix)
        stateLock.unlock()
        storageLock.unlock()
        if shouldSchedule {
            scheduleTimerUpdate()
        }
    }

    private func applyAutomaticResultLocked(_ result: AttemptResult, prefix: FrozenPrefix) -> Bool {
        switch result {
        case .accepted:
            return applyAcceptedResultLocked(prefix)
        case .retryable:
            return applyRetryableResultLocked()
        case let .terminal(reason, _, _):
            applyTerminalResultLocked(reason: reason)
            return false
        }
    }

    private func applyAcceptedResultLocked(_ prefix: FrozenPrefix) -> Bool {
        acknowledgeLocked(prefix)
        acceptedEvents += prefix.count
        consecutiveFailures = 0
        retryAttempt = 0
        lastOutcome = .accepted
        guard state != .shuttingDown else {
            return false
        }
        state = .running
        return scheduleLiveQueueLocked()
    }

    private func applyRetryableResultLocked() -> Bool {
        consecutiveFailures += 1
        lastOutcome = .retryableFailure
        guard state != .shuttingDown else {
            return false
        }
        guard retryAttempt < maxRetries else {
            state = .paused
            pauseReason = .retryExhausted
            return false
        }
        retryAttempt += 1
        state = .retrying
        return scheduleRetryLocked()
    }

    private func applyTerminalResultLocked(reason: DeliveryPauseReason) {
        consecutiveFailures += 1
        lastOutcome = .terminalFailure
        if state != .shuttingDown {
            state = .paused
            pauseReason = reason
        }
    }

    func scheduleCaptureLocked() -> Bool {
        guard automaticTransport != nil, state == .running || state == .retrying else {
            return false
        }
        if inFlight || frozenPrefix != nil {
            return false
        }
        return scheduleLiveQueueLocked()
    }

    func scheduleLiveQueueLocked() -> Bool {
        guard let options = automaticOptions, !queue.isEmpty, state == .running || state == .retrying else {
            nextWakeNanoseconds = nil
            return false
        }
        let delay: TimeInterval = queue.count >= options.threshold ? 0 : options.interval
        return setWakeLocked(delay: delay, replaceLaterWake: true)
    }

    private func scheduleRetryLocked() -> Bool {
        guard let options = automaticOptions else {
            return false
        }
        let multiplier = pow(2, Double(max(0, retryAttempt - 1)))
        let ceiling = min(options.retryBaseDelay * multiplier, options.maxRetryDelay)
        let delay = Double.random(in: (ceiling / 2) ... ceiling)
        return setWakeLocked(delay: delay, replaceLaterWake: true)
    }

    private func setWakeLocked(delay: TimeInterval, replaceLaterWake: Bool) -> Bool {
        let delta = UInt64(min(delay * 1_000_000_000, Double(UInt64.max)))
        let now = DispatchTime.now().uptimeNanoseconds
        let deadline = now > UInt64.max - delta ? UInt64.max : now + delta
        if let current = nextWakeNanoseconds, !replaceLaterWake || current <= deadline {
            return false
        }
        nextWakeNanoseconds = deadline
        return true
    }

    func scheduleTimerUpdate() {
        let timerAndDelay: (DispatchSourceTimer, UInt64)? = withStateLock {
            guard let timer = schedulerTimer, let deadline = nextWakeNanoseconds else {
                return nil
            }
            let now = DispatchTime.now().uptimeNanoseconds
            return (timer, deadline > now ? deadline - now : 0)
        }
        guard let (timer, delay) = timerAndDelay else {
            return
        }
        timer.schedule(deadline: .now() + .nanoseconds(Int(min(delay, UInt64(Int.max)))), leeway: .milliseconds(1))
    }

    func prepareManualOperation() throws {
        stateLock.lock()
        if closed || state == .closed || state == .shuttingDown {
            stateLock.unlock()
            throw SdkError(code: "shutdown_error", message: "client is already shut down")
        }
        if state == .paused, pauseReason == .storage {
            stateLock.unlock()
            throw SdkError(code: "storage_corrupt", message: "durable delivery data requires explicit recovery")
        }
        nextWakeNanoseconds = nil
        stateLock.unlock()
    }

    func rescheduleAfterManualOperation() {
        stateLock.lock()
        let shouldSchedule: Bool
        if automaticTransport != nil, state != .paused, state != .shuttingDown, state != .closed {
            state = .running
            retryAttempt = 0
            shouldSchedule = scheduleLiveQueueLocked()
        } else {
            shouldSchedule = false
        }
        stateLock.unlock()
        if shouldSchedule {
            scheduleTimerUpdate()
        }
    }

    func ownedTransport() throws -> any Transport {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard let transport = automaticTransport else {
            throw SdkError(code: "configuration_error", message: "automatic delivery is not running")
        }
        return transport
    }

    func beginShutdown() throws -> (timer: DispatchSourceTimer?, scheduler: DispatchQueue?) {
        storageLock.lock()
        defer { storageLock.unlock() }
        stateLock.lock()
        guard !closed, state != .closed, state != .shuttingDown else {
            stateLock.unlock()
            throw SdkError(code: "shutdown_error", message: "client is already shut down")
        }
        if state == .paused, pauseReason == .storage {
            stateLock.unlock()
            throw SdkError(code: "storage_corrupt", message: "durable delivery data requires explicit recovery")
        }
        generation &+= 1
        state = .shuttingDown
        closed = true
        nextWakeNanoseconds = nil
        let result = (schedulerTimer, schedulerQueue)
        schedulerTimer = nil
        schedulerQueue = nil
        automaticTransport = nil
        automaticOptions = nil
        stateLock.unlock()
        return result
    }

    func finishStopping(timer: DispatchSourceTimer?, scheduler: DispatchQueue?) {
        timer?.setEventHandler {}
        timer?.cancel()
        if DispatchQueue.getSpecific(key: schedulerKey) == nil {
            scheduler?.sync {}
        }
    }

    private func pauseAfterInternalFailure(generation currentGeneration: UInt64) {
        stateLock.lock()
        if generation == currentGeneration, state != .shuttingDown {
            state = .paused
            pauseReason = .nonRetryable
            lastOutcome = .terminalFailure
            consecutiveFailures += 1
            inFlight = false
        }
        stateLock.unlock()
    }

    func validate(_ options: AutomaticDeliveryOptions) throws {
        guard options.interval.isFinite, options.interval > 0, options.interval <= Self.maxScheduleDelay else {
            throw SdkError(code: "configuration_error", message: "automatic delivery interval is out of range")
        }
        guard (1 ... Self.maxQueuedEvents).contains(options.threshold) else {
            throw SdkError(code: "configuration_error", message: "automatic delivery threshold is out of range")
        }
        guard options.retryBaseDelay.isFinite, options.retryBaseDelay > 0,
              options.maxRetryDelay.isFinite, options.maxRetryDelay >= options.retryBaseDelay,
              options.maxRetryDelay <= Self.maxScheduleDelay
        else {
            throw SdkError(code: "configuration_error", message: "automatic delivery retry delays are invalid")
        }
    }
}
