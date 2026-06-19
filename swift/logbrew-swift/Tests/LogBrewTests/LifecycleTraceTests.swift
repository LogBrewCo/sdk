import LogBrew
import Testing

@Suite("LogBrew Swift lifecycle trace correlation")
struct LifecycleTraceTests {
    @Test("lifecycle tracker captures previous state duration and dedupes repeated state")
    func lifecycleTrackerCapturesPreviousStateDurationAndDedupesRepeatedState() throws {
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
        let event = try #require(lifecycleEvents.first)

        #expect(captured == true)
        #expect(duplicate == false)
        #expect(lifecycleEvents.count == 1)
        #expect(event["id"] as? String == "evt_scene_lifecycle_1")
        try assertTrackerLifecycleEvent(event, context: context, preview: preview)
    }

    private func assertTrackerLifecycleEvent(
        _ event: [String: Any],
        context: LogBrewTraceContext,
        preview: String,
    ) throws {
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        let childSpanId = try #require(attributes["spanId"] as? String)

        #expect(attributes["name"] as? String == "swift.lifecycle:inactive->active")
        #expect(attributes["traceId"] as? String == context.traceId)
        #expect(attributes["parentSpanId"] as? String == context.spanId)
        #expect(childSpanId != context.spanId)
        #expect(attributes["durationMs"] as? Double == 245.5)
        #expect(metadata["source"] as? String == "swift.lifecycle")
        #expect(metadata["previousState"] as? String == "inactive")
        #expect(metadata["currentState"] as? String == "active")
        #expect(metadata["durationSource"] as? String == "previous_state")
        #expect(metadata["screen"] as? String == "Checkout")
        #expect(metadata["component"] as? String == "scene-phase")
        #expect(metadata["traceId"] as? String == context.traceId)
        #expect(metadata["spanId"] as? String == childSpanId)
        #expect(metadata["parentSpanId"] as? String == context.spanId)
        #expect(!preview.contains("spoofed_trace"))
        #expect(!preview.contains("traceparent"))
    }

    @Test("lifecycle span helper captures app-owned child span")
    func lifecycleSpanHelperCapturesAppOwnedChildSpan() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        let context = try fixedTraceContext()

        try LogBrewTrace.withContext(context) {
            try client.captureLifecycleSpan(
                "evt_lifecycle_span_001",
                timestamp: "2026-06-02T10:00:08Z",
                previousState: " active ",
                currentState: "background",
                durationMs: 1532.25,
                context: ["screen": "Checkout", "traceId": "spoofed_trace"],
                metadata: ["component": "scene-delegate"],
            )
        }

        let preview = try client.previewJSON()
        let payload = try parsePayload(preview)
        let events = try #require(payload["events"] as? [[String: Any]])
        let event = try #require(events.first { $0["id"] as? String == "evt_lifecycle_span_001" })
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        let childSpanId = try #require(attributes["spanId"] as? String)

        #expect(attributes["name"] as? String == "swift.lifecycle:active->background")
        #expect(attributes["traceId"] as? String == context.traceId)
        #expect(attributes["parentSpanId"] as? String == context.spanId)
        #expect(childSpanId != context.spanId)
        #expect(attributes["status"] as? String == "ok")
        #expect(attributes["durationMs"] as? Double == 1532.25)
        #expect(metadata["source"] as? String == "swift.lifecycle")
        #expect(metadata["previousState"] as? String == "active")
        #expect(metadata["currentState"] as? String == "background")
        #expect(metadata["durationSource"] as? String == "previous_state")
        #expect(metadata["screen"] as? String == "Checkout")
        #expect(metadata["component"] as? String == "scene-delegate")
        #expect(metadata["traceId"] as? String == context.traceId)
        #expect(metadata["spanId"] as? String == childSpanId)
        #expect(metadata["parentSpanId"] as? String == context.spanId)
        #expect(!preview.contains("spoofed_trace"))
        #expect(!preview.contains("traceparent"))
    }

    @Test("lifecycle span helper validates state and duration")
    func lifecycleSpanHelperValidatesStateAndDuration() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")

        #expect(throws: SdkError.self) {
            try client.captureLifecycleSpan(
                "evt_lifecycle_bad_state",
                timestamp: "2026-06-02T10:00:08Z",
                previousState: " ",
                currentState: "background",
            )
        }
        #expect(throws: SdkError.self) {
            try client.captureLifecycleSpan(
                "evt_lifecycle_bad_duration",
                timestamp: "2026-06-02T10:00:08Z",
                previousState: "active",
                currentState: "background",
                durationMs: -1,
            )
        }
    }

    private func fixedTraceContext() throws -> LogBrewTraceContext {
        try LogBrewTraceContext(
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "aaaaaaaaaaaaaaaa",
            parentSpanId: "00f067aa0ba902b7",
            traceFlags: "01",
        )
    }
}
