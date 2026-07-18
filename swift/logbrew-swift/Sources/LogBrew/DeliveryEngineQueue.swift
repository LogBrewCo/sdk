import Foundation

extension DeliveryEngine {
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
                    acknowledge(prefix)
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
        stateLock.lock()
        defer { stateLock.unlock() }
        if let frozenPrefix {
            inFlight = true
            return frozenPrefix
        }
        guard !queue.isEmpty else {
            return nil
        }

        var selected: [Event] = []
        var body = Data()
        for queuedEvent in queue.prefix(Self.maxRequestEvents) {
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
        let prefixBytes = queue.prefix(selected.count).reduce(0) { $0 + $1.encodedBytes }
        let prefix = FrozenPrefix(count: selected.count, bytes: prefixBytes, body: body)
        frozenPrefix = prefix
        inFlight = true
        return prefix
    }

    func acknowledge(_ prefix: FrozenPrefix) {
        stateLock.lock()
        acknowledgeLocked(prefix)
        acceptedEvents += prefix.count
        consecutiveFailures = 0
        lastOutcome = .accepted
        stateLock.unlock()
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
}
