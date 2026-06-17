import Foundation

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
