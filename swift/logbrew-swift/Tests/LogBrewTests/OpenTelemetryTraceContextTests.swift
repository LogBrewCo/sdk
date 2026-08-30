import LogBrew
import Testing

@Suite("LogBrew Swift OpenTelemetry trace context")
struct OpenTelemetryTraceContextTests {
    @Test("OpenTelemetry copies parent, sampling, and carrier fields")
    func openTelemetryCopiesContextFields() throws {
        let parent = try makeOpenTelemetryParent()
        let context = LogBrewTrace.context(fromOpenTelemetrySpanContext: parent)

        #expect(parent.traceId == "4bf92f3577b34da6a3ce929d0e0e4736")
        #expect(parent.spanId == "00f067aa0ba902b7")
        #expect(parent.traceFlags == "01")
        #expect(parent.sampled)
        #expect(context.traceId == parent.traceId)
        #expect(context.parentSpanId == parent.spanId)
        #expect(context.spanId.count == 16)
        #expect(context.spanId != parent.spanId)
        #expect(context.traceFlags == parent.traceFlags)
        let unsampled = try LogBrewTrace.openTelemetrySpanContext(
            traceId: parent.traceId,
            spanId: parent.spanId,
            sampled: false,
        )
        #expect(!unsampled.sampled && unsampled.traceFlags == "00")
        #expect(LogBrewTrace.context(fromOpenTelemetrySpanContext: unsampled).traceFlags == "00")

        let carrier = FakeOpenTelemetrySpanContext(
            logBrewOpenTelemetryTraceId: parent.traceId.uppercased(),
            logBrewOpenTelemetrySpanId: parent.spanId.uppercased(),
            logBrewOpenTelemetryTraceFlags: "01",
            logBrewOpenTelemetryIsValid: true,
        )
        let copied = try #require(try LogBrewTrace.openTelemetrySpanContext(from: carrier))
        let carried = try #require(try LogBrewTrace.context(fromOpenTelemetrySpanContextCarrier: carrier))
        #expect(copied == parent)
        #expect(carried.traceId == parent.traceId)
        #expect(carried.parentSpanId == parent.spanId)
        #expect(carried.spanId != parent.spanId)
    }

    @Test("OpenTelemetry span attributes create a child span with sanitized metadata")
    func openTelemetrySpanAttributesCreateChildSpan() throws {
        let parent = try makeOpenTelemetryParent()
        let attributes = LogBrewTrace.spanAttributesFromOpenTelemetrySpanContext(
            parent,
            name: "POST /api/checkout",
            status: .error,
            durationMs: 184.5,
            metadata: ["traceId": "spoofed", "component": "otel-bridge"],
        )
        let metadata = try #require(attributes.metadata)

        #expect(attributes.traceId == parent.traceId)
        #expect(attributes.parentSpanId == parent.spanId)
        #expect(attributes.spanId.count == 16)
        #expect(attributes.spanId != parent.spanId)
        #expect(metadata["traceId"] == .string(parent.traceId))
        #expect(metadata["spanId"] == .string(attributes.spanId))
        #expect(metadata["parentSpanId"] == .string(parent.spanId))
        #expect(metadata["traceFlags"] == .string(parent.traceFlags))
        #expect(metadata["traceSampled"] == .bool(true))
        #expect(metadata["component"] == .string("otel-bridge"))
    }

    @Test("OpenTelemetry rejects malformed values and invalid carriers")
    func openTelemetryRejectsInvalidInputs() throws {
        let parent = try makeOpenTelemetryParent()
        let invalidCarrier = FakeOpenTelemetrySpanContext(
            logBrewOpenTelemetryTraceId: parent.traceId,
            logBrewOpenTelemetrySpanId: parent.spanId,
            logBrewOpenTelemetryTraceFlags: parent.traceFlags,
            logBrewOpenTelemetryIsValid: false,
        )
        #expect(try LogBrewTrace.openTelemetrySpanContext(from: invalidCarrier) == nil)
        #expect(try LogBrewTrace.context(fromOpenTelemetrySpanContextCarrier: invalidCarrier) == nil)
        let malformed = [
            ("00000000000000000000000000000000", parent.spanId, "01"),
            (parent.traceId, "0000000000000000", "01"),
            (parent.traceId, parent.spanId, "zz"),
        ]
        for (traceId, spanId, traceFlags) in malformed {
            #expect(throws: SdkError.self) {
                _ = try LogBrewTrace.openTelemetrySpanContext(
                    traceId: traceId, spanId: spanId, traceFlags: traceFlags,
                )
            }
        }
    }

    private func makeOpenTelemetryParent() throws -> LogBrewOpenTelemetrySpanContext {
        try LogBrewTrace.openTelemetrySpanContext(
            traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
            spanId: "00F067AA0BA902B7",
            traceFlags: "01",
        )
    }
}

private struct FakeOpenTelemetrySpanContext: LogBrewOpenTelemetrySpanContextCarrier {
    let logBrewOpenTelemetryTraceId: String
    let logBrewOpenTelemetrySpanId: String
    let logBrewOpenTelemetryTraceFlags: String
    let logBrewOpenTelemetryIsValid: Bool
}
