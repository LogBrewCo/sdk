import Foundation

public final class LogBrewLifecycleTracker {
    private let client: LogBrewClient
    private let eventIDPrefix: String
    private let context: Metadata?
    private let lock = NSLock()
    private var currentState: String
    private var currentStartedAtMs: Double
    private var nextEventSequence = 1

    public init(
        client: LogBrewClient,
        initialState: String,
        initialTimestampMs: Double,
        eventIDPrefix: String = "evt_lifecycle",
        context: Metadata? = nil,
    ) throws {
        self.client = client
        currentState = try normalizedLifecycleState("lifecycle initialState", initialState)
        currentStartedAtMs = try validatedLifecycleTimestampMs("lifecycle initialTimestampMs", initialTimestampMs)
        self.eventIDPrefix = try normalizedLifecycleEventIDPrefix(eventIDPrefix)
        self.context = context
    }

    @discardableResult
    public func captureTransition(
        to nextState: String,
        timestamp: String,
        atMs: Double,
        metadata: Metadata? = nil,
    ) throws -> Bool {
        let normalizedNextState = try normalizedLifecycleState("lifecycle nextState", nextState)
        let checkedAtMs = try validatedLifecycleTimestampMs("lifecycle atMs", atMs)

        lock.lock()
        defer {
            lock.unlock()
        }
        if normalizedNextState == currentState {
            return false
        }
        if checkedAtMs < currentStartedAtMs {
            throw SdkError(
                code: "validation_error",
                message: "lifecycle atMs must be greater than or equal to the current state start",
            )
        }
        let eventID = "\(eventIDPrefix)_\(nextEventSequence)"
        let previousState = currentState
        let durationMs = checkedAtMs - currentStartedAtMs
        try client.captureLifecycleSpan(
            eventID,
            timestamp: timestamp,
            previousState: previousState,
            currentState: normalizedNextState,
            durationMs: durationMs,
            context: context,
            metadata: metadata,
        )
        nextEventSequence += 1
        currentState = normalizedNextState
        currentStartedAtMs = checkedAtMs
        return true
    }
}

public extension LogBrewClient {
    func captureLifecycleSpan(
        _ id: String,
        timestamp: String,
        previousState: String,
        currentState: String,
        durationMs: Double? = nil,
        context: Metadata? = nil,
        metadata: Metadata? = nil,
    ) throws {
        let normalizedPreviousState = try normalizedLifecycleState("lifecycle previousState", previousState)
        let normalizedCurrentState = try normalizedLifecycleState("lifecycle currentState", currentState)
        let checkedDurationMs = try validatedLifecycleDurationMs(durationMs)
        let sourceContext = LogBrewTrace.current
        let spanContext = sourceContext.map(LogBrewTraceContext.child(of:)) ?? LogBrewTraceContext.fallbackRoot()

        var spanMetadata: Metadata = [:]
        try copyMetadata(context, into: &spanMetadata)
        try copyMetadata(metadata, into: &spanMetadata)
        spanMetadata["source"] = .string("swift.lifecycle")
        spanMetadata["previousState"] = .string(normalizedPreviousState)
        spanMetadata["currentState"] = .string(normalizedCurrentState)
        if checkedDurationMs != nil {
            spanMetadata["durationSource"] = .string("previous_state")
        }

        try span(
            id,
            timestamp: timestamp,
            attributes: SpanAttributes(
                name: "swift.lifecycle:\(normalizedPreviousState)->\(normalizedCurrentState)",
                traceId: spanContext.traceId,
                spanId: spanContext.spanId,
                parentSpanId: spanContext.parentSpanId,
                status: .ok,
                durationMs: checkedDurationMs,
                metadata: LogBrewTrace.mergeTraceMetadata(spanMetadata, context: spanContext),
            ),
        )
    }
}

private func normalizedLifecycleState(_ label: String, _ state: String) throws -> String {
    try requireNonEmpty(label, state)
    return state.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func validatedLifecycleDurationMs(_ durationMs: Double?) throws -> Double? {
    guard let durationMs else {
        return nil
    }
    guard durationMs.isFinite, durationMs >= 0 else {
        throw SdkError(code: "validation_error", message: "lifecycle durationMs must be finite and non-negative")
    }
    return durationMs
}

private func validatedLifecycleTimestampMs(_ label: String, _ timestampMs: Double) throws -> Double {
    guard timestampMs.isFinite, timestampMs >= 0 else {
        throw SdkError(code: "validation_error", message: "\(label) must be finite and non-negative")
    }
    return timestampMs
}

private func normalizedLifecycleEventIDPrefix(_ prefix: String) throws -> String {
    let normalized = prefix.trimmingCharacters(in: .whitespacesAndNewlines)
    try requireNonEmpty("lifecycle eventIDPrefix", normalized)
    return normalized
}
