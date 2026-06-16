import Foundation
import LogBrew
import Testing

@Suite("LogBrew Swift trace correlation")
struct TraceContextTests {
    private let incomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    @Test("W3C traceparent continuation creates a local child span")
    func traceparentContinuationCreatesChildSpan() throws {
        let remoteParent = try LogBrewTrace.parseTraceparent(incomingTraceparent)
        let context = LogBrewTrace.continueOrCreateContext(fromTraceparent: incomingTraceparent)

        #expect(remoteParent.traceId == "4bf92f3577b34da6a3ce929d0e0e4736")
        #expect(remoteParent.spanId == "00f067aa0ba902b7")
        #expect(remoteParent.traceFlags == "01")
        #expect(remoteParent.sampled)
        #expect(context.traceId == remoteParent.traceId)
        #expect(context.parentSpanId == remoteParent.spanId)
        #expect(context.spanId.count == 16)
        #expect(context.spanId != remoteParent.spanId)
        #expect(context.traceparent == "00-\(context.traceId)-\(context.spanId)-01")
    }

    @Test("strict traceparent parsing rejects malformed propagation")
    func strictTraceparentParsingRejectsMalformedPropagation() throws {
        #expect(throws: SdkError.self) {
            _ = try LogBrewTrace.parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")
        }
        #expect(throws: SdkError.self) {
            _ = try LogBrewTrace.parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")
        }
        #expect(throws: SdkError.self) {
            _ = try LogBrewTrace.parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
        }
    }

    @Test("malformed propagation falls back without leaking raw header")
    func malformedPropagationFallsBackWithoutLeakingRawHeader() {
        let context = LogBrewTrace.continueOrCreateContext(fromTraceparent: "not-a-traceparent")
        let metadata = LogBrewTrace.metadata(context)

        #expect(context.parentSpanId == nil)
        #expect(context.traceId.count == 32)
        #expect(context.spanId.count == 16)
        #expect(metadata["traceId"] == .string(context.traceId))
        #expect(metadata["traceparent"] == nil)
    }

    @Test("explicit context creation rejects invalid trace flags")
    func explicitContextCreationRejectsInvalidTraceFlags() throws {
        #expect(throws: SdkError.self) {
            _ = try LogBrewTrace.createContext(traceFlags: "zz")
        }
    }

    @Test("task-local trace survives async work")
    func taskLocalTraceSurvivesAsyncWork() async throws {
        let context = try fixedTraceContext()

        try await LogBrewTrace.withContext(context) {
            try await Task.sleep(nanoseconds: 1000)
            #expect(LogBrewTrace.current == context)
        }

        #expect(LogBrewTrace.current == nil)
    }

    @Test("active trace correlates logs issues actions metrics and spans")
    func activeTraceCorrelatesSignals() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        let logger = try makeLogger(client)
        let context = try fixedTraceContext()

        try recordCorrelatedSignals(client: client, logger: logger, context: context)

        let events = try payloadEvents(client)
        try assertCorrelatedEvents(events, context: context)
        try assertCorrelatedSpan(events, context: context)
    }

    @Test("outgoing headers only expose normalized traceparent")
    func outgoingHeadersOnlyExposeTraceparent() throws {
        let context = try fixedTraceContext()
        let headers = LogBrewTrace.outgoingHeaders(context)

        #expect(headers == ["traceparent": "00-\(context.traceId)-\(context.spanId)-\(context.traceFlags)"])
        #expect(headers["authorization"] == nil)
        #expect(headers["baggage"] == nil)
    }

    private func fixedTraceContext() throws -> LogBrewTraceContext {
        try LogBrewTraceContext(
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "aaaaaaaaaaaaaaaa",
            parentSpanId: "00f067aa0ba902b7",
            traceFlags: "01",
        )
    }

    private func makeLogger(_ client: LogBrewClient) throws -> LogBrewLogger {
        try LogBrewLogger(
            client: client,
            subsystem: "co.logbrew.app",
            category: "checkout",
            eventIDPrefix: "ios_log",
            timestampProvider: { "2026-06-02T10:00:03Z" },
        )
    }

    private func recordCorrelatedSignals(
        client: LogBrewClient,
        logger: LogBrewLogger,
        context: LogBrewTraceContext,
    ) throws {
        try LogBrewTrace.withContext(context) {
            try client.issue(
                "evt_issue_001",
                timestamp: "2026-06-02T10:00:02Z",
                attributes: IssueAttributes(title: "Checkout timeout", level: .error, metadata: ["traceId": "spoofed"]),
            )
            logger.error("checkout failed")
            try client.captureProductAction(
                "evt_action_001",
                timestamp: "2026-06-02T10:00:04Z",
                name: "checkout.pay_tapped",
                metadata: ["component": "pay-button"],
            )
            try recordCorrelatedMetricAndSpan(client)
        }
    }

    private func recordCorrelatedMetricAndSpan(_ client: LogBrewClient) throws {
        try client.metric(
            "evt_metric_001",
            timestamp: "2026-06-02T10:00:05Z",
            attributes: MetricAttributes(
                name: "checkout.duration",
                kind: .histogram,
                value: 184.5,
                unit: "ms",
                temporality: .delta,
            ),
        )
        try client.span(
            "evt_span_001",
            timestamp: "2026-06-02T10:00:06Z",
            attributes: LogBrewTrace.spanAttributes(
                name: "POST /api/checkout",
                status: .error,
                durationMs: 184.5,
                metadata: ["routeTemplate": "/api/checkout"],
            ),
        )
    }

    private func payloadEvents(_ client: LogBrewClient) throws -> [[String: Any]] {
        let payload = try parsePayload(client.previewJSON())
        return try #require(payload["events"] as? [[String: Any]])
    }

    private func assertTraceMetadata(_ event: [String: Any], context: LogBrewTraceContext) throws {
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        #expect(metadata["traceId"] as? String == context.traceId)
        #expect(metadata["spanId"] as? String == context.spanId)
        #expect(metadata["parentSpanId"] as? String == context.parentSpanId)
        #expect(metadata["traceFlags"] as? String == context.traceFlags)
        #expect(metadata["traceSampled"] as? Bool == true)
    }

    private func assertCorrelatedEvents(_ events: [[String: Any]], context: LogBrewTraceContext) throws {
        for eventID in ["evt_issue_001", "ios_log_1", "evt_action_001", "evt_metric_001"] {
            let event = try #require(events.first { $0["id"] as? String == eventID })
            try assertTraceMetadata(event, context: context)
        }
    }

    private func assertCorrelatedSpan(_ events: [[String: Any]], context: LogBrewTraceContext) throws {
        let span = try #require(events.first { $0["id"] as? String == "evt_span_001" })
        let spanAttributes = try #require(span["attributes"] as? [String: Any])
        let spanMetadata = try #require(spanAttributes["metadata"] as? [String: Any])
        #expect(spanAttributes["traceId"] as? String == context.traceId)
        #expect(spanAttributes["spanId"] as? String == context.spanId)
        #expect(spanAttributes["parentSpanId"] as? String == context.parentSpanId)
        #expect(spanMetadata["routeTemplate"] as? String == "/api/checkout")
        #expect(spanMetadata["traceId"] as? String == context.traceId)
        #expect(spanMetadata["spanId"] as? String == context.spanId)
        #expect(spanMetadata["traceFlags"] as? String == context.traceFlags)
        #expect(spanMetadata["traceSampled"] as? Bool == true)
    }
}
