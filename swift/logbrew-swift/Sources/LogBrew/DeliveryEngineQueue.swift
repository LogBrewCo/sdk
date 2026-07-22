import Foundation

extension DeliveryEngine {
    func enqueue(_ event: Event) throws {
        let eventBytes = try encodeEvent(event).count
        let singleRequestBytes = try encodeBatch([event]).count
        var shouldSchedule = false
        var admissionError: SdkError?
        var durableRecordName: String?

        storageLock.lock()
        defer { storageLock.unlock() }
        stateLock.lock()
        if closed || state == .shuttingDown || state == .closed {
            admissionError = SdkError(code: "shutdown_error", message: "client is already shut down")
        } else if state == .paused, pauseReason == .storage {
            admissionError = SdkError(
                code: "storage_corrupt",
                message: "durable delivery data requires explicit recovery",
            )
        } else if singleRequestBytes > Self.maxRequestBytes {
            droppedEvents += 1
            lastOutcome = .dropped
            admissionError = SdkError(code: "event_too_large", message: "event exceeds the delivery request byte limit")
        } else if queue.count >= Self.maxQueuedEvents || queuedBytes > Self.maxQueuedBytes - eventBytes {
            droppedEvents += 1
            lastOutcome = .dropped
            admissionError = SdkError(code: "queue_full", message: "delivery queue capacity exceeded")
        } else {
            let store = durableStore
            stateLock.unlock()
            do {
                durableRecordName = try store?.append(event, encodedBytes: eventBytes)
            } catch {
                recordStorageFailure()
                throw storageError(error)
            }
            stateLock.lock()
            queue.append(
                QueuedEvent(
                    event: event,
                    encodedBytes: eventBytes,
                    durableRecordName: durableRecordName,
                ),
            )
            queuedBytes += eventBytes
            shouldSchedule = scheduleCaptureLocked()
        }
        stateLock.unlock()

        if shouldSchedule {
            scheduleTimerUpdate()
        }
        if let admissionError {
            throw admissionError
        }
    }

    func flushAll(transport: any Transport) throws -> TransportResponse {
        var totalAttempts = 0
        var statusCode = 204

        while let prefix = try freezePrefix() {
            var accepted = false
            for attemptIndex in 0 ... maxRetries {
                let result = attempt(transport: transport, prefix: prefix)
                totalAttempts += result.attempts
                recordManualAttempts(result.attempts)
                switch result {
                case let .accepted(status, _):
                    try acknowledge(prefix)
                    statusCode = status
                    accepted = true
                case .retryable where attemptIndex < maxRetries:
                    continue
                case let .retryable(_, error):
                    recordManualFailure(outcome: .retryableFailure, pauseReason: .retryExhausted)
                    throw error
                case let .terminal(reason, _, error):
                    recordManualFailure(outcome: .terminalFailure, pauseReason: reason)
                    throw error
                }
                break
            }
            if !accepted {
                throw SdkError(code: "transport_error", message: "exhausted retries")
            }
        }

        return TransportResponse(statusCode: statusCode, attempts: totalAttempts)
    }

    func freezePrefix() throws -> FrozenPrefix? {
        storageLock.lock()
        defer { storageLock.unlock() }

        stateLock.lock()
        if let frozenPrefix {
            inFlight = true
            stateLock.unlock()
            return frozenPrefix
        }
        guard !queue.isEmpty else {
            stateLock.unlock()
            return nil
        }
        let queueSnapshot = queue
        let store = durableStore
        stateLock.unlock()

        let prefix = try makePrefix(queueSnapshot: queueSnapshot, store: store)
        stateLock.lock()
        frozenPrefix = prefix
        inFlight = true
        stateLock.unlock()
        return prefix
    }

    private func makePrefix(
        queueSnapshot: [QueuedEvent],
        store: DurableDeliveryStore?,
    ) throws -> FrozenPrefix {
        var selected: [Event] = []
        var body = Data()
        for queuedEvent in queueSnapshot.prefix(Self.maxRequestEvents) {
            let candidate = selected + [queuedEvent.event]
            let candidateBody = try encodeBatch(candidate)
            if candidateBody.count > Self.maxRequestBytes {
                break
            }
            selected = candidate
            body = candidateBody
        }
        guard !selected.isEmpty else {
            throw SdkError(code: "event_too_large", message: "event exceeds the delivery request byte limit")
        }
        let selectedQueue = Array(queueSnapshot.prefix(selected.count))
        let prefixBytes = selectedQueue.reduce(0) { $0 + $1.encodedBytes }
        let recordNames = selectedQueue.compactMap(\.durableRecordName)
        if let store {
            guard recordNames.count == selected.count else {
                recordStorageFailure()
                throw storageError(DurableStoreFailure.corrupt)
            }
            do {
                try store.persistPrefix(body: body, eventRecordNames: recordNames, encodedBytes: prefixBytes)
            } catch {
                recordStorageFailure()
                throw storageError(error)
            }
        }
        return FrozenPrefix(
            count: selected.count,
            bytes: prefixBytes,
            body: body,
            durableRecordNames: recordNames,
        )
    }

    func acknowledge(_ prefix: FrozenPrefix) throws {
        do {
            try acknowledgeDurableFiles(prefix)
        } catch {
            recordStorageFailure()
            throw error
        }
        stateLock.lock()
        acknowledgeLocked(prefix)
        acceptedEvents += prefix.count
        consecutiveFailures = 0
        lastOutcome = .accepted
        stateLock.unlock()
    }

    func acknowledgeDurableFiles(_ prefix: FrozenPrefix) throws {
        storageLock.lock()
        defer { storageLock.unlock() }
        let store = withStateLock { durableStore }
        guard let store else {
            return
        }
        do {
            try store.acknowledge(body: prefix.body, eventRecordNames: prefix.durableRecordNames)
        } catch {
            throw storageError(error)
        }
    }

    func acknowledgeLocked(_ prefix: FrozenPrefix) {
        guard frozenPrefix?.body == prefix.body, queue.count >= prefix.count else {
            return
        }
        queue.removeFirst(prefix.count)
        queuedBytes -= prefix.bytes
        frozenPrefix = nil
        inFlight = false
        retryAttempt = 0
    }

    func attempt(transport: any Transport, prefix: FrozenPrefix) -> AttemptResult {
        do {
            let response = try transport.send(apiKey: apiKey, body: prefix.body)
            return classify(response)
        } catch let transportError as TransportError {
            let error = SdkError(code: transportError.code, message: transportError.message)
            if transportError.retryable {
                return .retryable(attempts: 1, error: error)
            }
            return .terminal(reason: .nonRetryable, attempts: 1, error: error)
        } catch {
            return .terminal(
                reason: .nonRetryable,
                attempts: 1,
                error: SdkError(code: "transport_error", message: "unexpected transport response"),
            )
        }
    }

    private func classify(_ response: TransportResponse) -> AttemptResult {
        let attempts = max(1, response.attempts)
        if (200 ..< 300).contains(response.statusCode) {
            return .accepted(statusCode: response.statusCode, attempts: attempts)
        }
        let error = transportError(statusCode: response.statusCode)
        if response.statusCode == 408 || response.statusCode >= 500 {
            return .retryable(attempts: attempts, error: error)
        }
        return .terminal(reason: pauseReason(for: response.statusCode), attempts: attempts, error: error)
    }

    private func transportError(statusCode: Int) -> SdkError {
        if statusCode == 401 {
            return SdkError(code: "unauthenticated", message: "transport rejected the API key")
        }
        return SdkError(code: "transport_error", message: "unexpected transport status \(statusCode)")
    }

    private func pauseReason(for statusCode: Int) -> DeliveryPauseReason {
        switch statusCode {
        case 401, 403:
            .authentication
        case 429:
            .quota
        case 400, 404, 409, 413, 422:
            .validation
        default:
            .nonRetryable
        }
    }

    func recordManualFailure(outcome: DeliveryOutcome, pauseReason reason: DeliveryPauseReason) {
        stateLock.lock()
        inFlight = false
        consecutiveFailures += 1
        lastOutcome = outcome
        if automaticTransport != nil, state != .shuttingDown, state != .closed {
            state = .paused
            pauseReason = reason
            nextWakeNanoseconds = nil
        }
        stateLock.unlock()
    }

    private func recordManualAttempts(_ attempts: Int) {
        stateLock.lock()
        deliveryAttempts += attempts
        stateLock.unlock()
    }

    func encodeEvent(_ event: Event) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(event)
    }

    func encodeBatch(_ events: [Event]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(EventBatch(sdk: sdk, events: events))
    }

    func withStateLock<T>(_ operation: () -> T) -> T {
        stateLock.lock()
        defer { stateLock.unlock() }
        return operation()
    }

    func recordStorageFailure() {
        stateLock.lock()
        inFlight = false
        state = .paused
        pauseReason = .storage
        lastOutcome = .terminalFailure
        consecutiveFailures += 1
        nextWakeNanoseconds = nil
        stateLock.unlock()
    }

    func storageError(_ error: Error) -> SdkError {
        if let failure = error as? DurableStoreFailure, failure == .corrupt {
            return SdkError(code: "storage_corrupt", message: "durable delivery data requires explicit recovery")
        }
        if let failure = error as? DurableStoreFailure, failure == .capacity {
            return SdkError(code: "queue_full", message: "durable delivery capacity exceeded")
        }
        if let failure = error as? DurableStoreFailure, failure == .owned {
            return SdkError(code: "storage_error", message: "durable delivery storage is already in use")
        }
        return SdkError(code: "storage_error", message: "durable delivery storage is unavailable")
    }
}
