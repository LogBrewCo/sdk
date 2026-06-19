import LogBrew
import Testing

@Suite("LogBrew Swift OpenTelemetry trace context")
struct OpenTelemetryTraceContextTests {
    @Test("OpenTelemetry span context copy creates a local child span")
    func openTelemetrySpanContextCopyCreatesChildSpan() throws {
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

    @Test("OpenTelemetry sampled flag maps to W3C trace flags")
    func openTelemetrySampledFlagMapsToTraceFlags() throws {
        let sampled = try LogBrewTrace.openTelemetrySpanContext(
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
            sampled: false,
        )
        let context = LogBrewTrace.context(fromOpenTelemetrySpanContext: sampled)

        #expect(!sampled.sampled)
        #expect(sampled.traceFlags == "00")
        #expect(context.traceFlags == "00")
    }

    @Test("OpenTelemetry carrier protocol copies valid live span context fields")
    func openTelemetryCarrierProtocolCopiesValidFields() throws {
        let carrier = FakeOpenTelemetrySpanContext(
            traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
            spanId: "00F067AA0BA902B7",
            traceFlags: "01",
            isValid: true,
        )
        let parentCandidate = try LogBrewTrace.openTelemetrySpanContext(from: carrier)
        let contextCandidate = try LogBrewTrace.context(fromOpenTelemetrySpanContextCarrier: carrier)
        let parent = try #require(parentCandidate)
        let context = try #require(contextCandidate)

        #expect(parent.traceId == "4bf92f3577b34da6a3ce929d0e0e4736")
        #expect(parent.spanId == "00f067aa0ba902b7")
        #expect(parent.traceFlags == "01")
        #expect(context.traceId == parent.traceId)
        #expect(context.parentSpanId == parent.spanId)
        #expect(context.spanId != parent.spanId)
    }

    @Test("OpenTelemetry carrier protocol returns nil for invalid live span contexts")
    func openTelemetryCarrierProtocolReturnsNilForInvalidContexts() throws {
        let carrier = FakeOpenTelemetrySpanContext(
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
            traceFlags: "01",
            isValid: false,
        )

        #expect(try LogBrewTrace.openTelemetrySpanContext(from: carrier) == nil)
        #expect(try LogBrewTrace.context(fromOpenTelemetrySpanContextCarrier: carrier) == nil)
    }

    @Test("OpenTelemetry span context rejects malformed ids and flags")
    func openTelemetrySpanContextRejectsMalformedValues() throws {
        let parent = try makeOpenTelemetryParent()

        #expect(throws: SdkError.self) {
            _ = try LogBrewTrace.openTelemetrySpanContext(
                traceId: "00000000000000000000000000000000",
                spanId: parent.spanId,
            )
        }
        #expect(throws: SdkError.self) {
            _ = try LogBrewTrace.openTelemetrySpanContext(
                traceId: parent.traceId,
                spanId: "0000000000000000",
            )
        }
        #expect(throws: SdkError.self) {
            _ = try LogBrewTrace.openTelemetrySpanContext(
                traceId: parent.traceId,
                spanId: parent.spanId,
                traceFlags: "zz",
            )
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
    let traceId: String
    let spanId: String
    let traceFlags: String
    let isValid: Bool

    var logBrewOpenTelemetryTraceId: String {
        traceId
    }

    var logBrewOpenTelemetrySpanId: String {
        spanId
    }

    var logBrewOpenTelemetryTraceFlags: String {
        traceFlags
    }

    var logBrewOpenTelemetryIsValid: Bool {
        isValid
    }
}
