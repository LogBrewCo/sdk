import LogBrew
import Testing

@Suite("Swift span evidence")
struct SpanEvidenceTests {
    @Test("span milestones and links retain typed investigative evidence")
    func spanMilestonesAndLinks() throws {
        let client = try richClient()
        try client.span(
            "span-evidence",
            timestamp: "2026-08-06T10:00:00Z",
            attributes: richSpanAttributes(),
        )

        let attributes = try richParsedAttributes(client)
        let events = try #require(attributes["events"] as? [[String: Any]])
        let links = try #require(attributes["links"] as? [[String: Any]])
        let context = try #require(attributes["context"] as? [String: Any])
        let trace = try #require(context["trace"] as? [String: Any])

        #expect(events.count == 2)
        #expect(events[0]["name"] as? String == "payment.retry")
        #expect((events[0]["metadata"] as? [String: Any])?["attempt"] as? Int == 2)
        #expect(links.count == 1)
        #expect(links[0]["traceId"] as? String == "11111111111111111111111111111111")
        #expect(links[0]["spanId"] as? String == "2222222222222222")
        #expect(links[0]["sampled"] as? Bool == true)
        #expect(trace["traceId"] as? String == "4bf92f3577b34da6a3ce929d0e0e4736")
        #expect(trace["spanId"] as? String == "00f067aa0ba902b7")
    }

    @Test("oversized or zero-id span evidence fails before queue admission")
    func invalidSpanEvidenceFailsClosed() throws {
        let client = try richClient()
        let invalid = [
            invalidSpan(events: (0 ..< 9).map { SpanEventSummary(name: "event_\($0)") }),
            invalidSpan(links: [
                SpanLinkSummary(
                    traceId: String(repeating: "0", count: 32),
                    spanId: "2222222222222222",
                ),
            ]),
        ]
        for (index, attributes) in invalid.enumerated() {
            #expect(throws: SdkError.self) {
                try client.span(
                    "invalid-span-\(index)", timestamp: "2026-08-06T10:00:00Z", attributes: attributes,
                )
            }
        }
        #expect(client.pendingEvents() == 0)
    }

    @Test("span context cannot contradict first-class trace identity")
    func spanTraceIdentityIsCanonical() throws {
        let client = try richClient()
        let inheritedTrace = try LogBrewTraceContext(
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
        )
        try LogBrewTrace.withContext(inheritedTrace) {
            try client.span(
                "legacy-span",
                timestamp: "2026-08-06T10:00:00Z",
                attributes: SpanAttributes(
                    name: "legacy.operation",
                    traceId: "trace_legacy",
                    spanId: "span_legacy",
                    status: .ok,
                    context: TelemetryContext(tags: ["source": "legacy"]),
                ),
            )
        }

        let attributes = try richParsedAttributes(client)
        let context = try #require(attributes["context"] as? [String: Any])
        #expect(attributes["traceId"] as? String == "trace_legacy")
        #expect(attributes["spanId"] as? String == "span_legacy")
        #expect(context["trace"] == nil)
        #expect((context["tags"] as? [String: Any])?["source"] as? String == "legacy")
    }

    @Test("first-class W3C span identity replaces an event context trace")
    func firstClassSpanTraceWins() throws {
        let client = try richClient()
        try client.span(
            "canonical-span",
            timestamp: "2026-08-06T10:00:00Z",
            attributes: SpanAttributes(
                name: "checkout.submit",
                traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                spanId: "00f067aa0ba902b7",
                status: .ok,
                context: TelemetryContext(
                    trace: TelemetryTraceContext(
                        traceId: "11111111111111111111111111111111",
                        spanId: "2222222222222222",
                    ),
                ),
            ),
        )

        let context = try richContext(client)
        let trace = try #require(context["trace"] as? [String: Any])
        #expect(trace["traceId"] as? String == "4bf92f3577b34da6a3ce929d0e0e4736")
        #expect(trace["spanId"] as? String == "00f067aa0ba902b7")
    }
}

private func richSpanAttributes() -> SpanAttributes {
    SpanAttributes(
        name: "checkout.submit",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        status: .error,
        durationMs: 420,
        events: [
            SpanEventSummary(
                name: "payment.retry",
                timestamp: "2026-08-06T10:00:00.200Z",
                metadata: ["attempt": 2, "provider": "primary"],
            ),
            SpanEventSummary(name: "payment.rejected", metadata: ["retryable": false]),
        ],
        links: [
            SpanLinkSummary(
                traceId: "11111111111111111111111111111111",
                spanId: "2222222222222222",
                sampled: true,
                metadata: ["relationship": "follows_from"],
            ),
        ],
    )
}

private func invalidSpan(
    events: [SpanEventSummary]? = nil,
    links: [SpanLinkSummary]? = nil,
) -> SpanAttributes {
    SpanAttributes(
        name: "checkout",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        status: .ok,
        events: events,
        links: links,
    )
}
