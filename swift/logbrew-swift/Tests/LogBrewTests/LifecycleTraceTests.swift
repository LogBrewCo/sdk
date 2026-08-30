import LogBrew
import Testing

@Suite("LogBrew Swift lifecycle trace correlation")
struct LifecycleTraceTests {
    @Test("lifecycle tracker captures child spans and dedupes repeated state")
    func lifecycleTrackerCapturesChildSpansAndDedupes() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        let context = try fixedTraceContext()
        let tracker = try LogBrewLifecycleTracker(
            client: client,
            initialState: " inactive ",
            initialTimestampMs: 1000,
            eventIDPrefix: "evt_scene_lifecycle",
            context: ["screen": "Checkout"],
        )

        let captured = try LogBrewTrace.withContext(context) {
            try tracker.captureTransition(
                to: "active",
                timestamp: "2026-06-02T10:00:09Z",
                atMs: 1245.5,
                metadata: ["component": "scene-phase", "traceId": "spoofed_trace"],
            )
        }
        let duplicate = try tracker.captureTransition(
            to: "active",
            timestamp: "2026-06-02T10:00:10Z",
            atMs: 1300,
            metadata: ["component": "scene-phase"],
        )
        let preview = try client.previewJSON()
        let payload = try parsePayload(preview)
        let events = try #require(payload["events"] as? [[String: Any]])
        let lifecycleEvents = events.filter { ($0["id"] as? String)?.hasPrefix("evt_scene_lifecycle_") == true }
        let transition = try #require(lifecycleEvents.first)

        #expect(captured && !duplicate && lifecycleEvents.count == 1
            && transition["id"] as? String == "evt_scene_lifecycle_1")
        try assertLifecycleEvent(
            transition, parent: context,
            span: ("swift.lifecycle:inactive->active", 245.5),
            stateTransition: (("inactive", "active"), "scene-phase"),
            preview: preview,
        )
    }

    @Test("lifecycle span helper validates state and duration")
    func lifecycleSpanHelperValidatesStateAndDuration() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        for (previousState, duration) in [
            (" ", nil),
            ("active", -1),
        ] as [(String, Double?)] {
            #expect(throws: SdkError.self) {
                try client.captureLifecycleSpan(
                    "evt_lifecycle_invalid", timestamp: "2026-06-02T10:00:08Z",
                    previousState: previousState, currentState: "background", durationMs: duration,
                )
            }
        }
    }

    private func assertLifecycleEvent(
        _ event: [String: Any],
        parent: LogBrewTraceContext,
        span: (name: String, durationMs: Double),
        stateTransition: (states: (previous: String, current: String), component: String),
        preview: String,
    ) throws {
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        let childSpanId = try #require(attributes["spanId"] as? String)
        #expect(["name": span.name, "traceId": parent.traceId, "parentSpanId": parent.spanId]
            .allSatisfy { attributes[$0.key] as? String == $0.value })
        #expect(childSpanId != parent.spanId)
        #expect(attributes["status"] as? String == "ok")
        #expect(attributes["durationMs"] as? Double == span.durationMs)
        let expectedMetadata = [
            "source": "swift.lifecycle", "previousState": stateTransition.states.previous,
            "currentState": stateTransition.states.current, "durationSource": "previous_state",
            "screen": "Checkout", "component": stateTransition.component,
            "traceId": parent.traceId, "spanId": childSpanId, "parentSpanId": parent.spanId,
        ]
        #expect(expectedMetadata.allSatisfy { metadata[$0.key] as? String == $0.value })
        #expect(!preview.contains("spoofed_trace") && !preview.contains("traceparent"))
    }
}
