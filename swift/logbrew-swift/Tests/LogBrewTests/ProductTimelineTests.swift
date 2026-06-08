import LogBrew
import Testing

@Suite("LogBrew Swift SDK product timelines")
struct ProductTimelineTests {
    @Test("Swift product action helper adds safe context metadata")
    func productActionAddsSafeContextMetadata() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        try client.captureProductAction(
            "evt_product_action_001",
            timestamp: "2026-06-02T10:00:07Z",
            name: "checkout.pay_tapped",
            context: timelineContext(),
            metadata: ["component": "pay-button"],
        )

        let payload = try parsePayload(client.previewJSON())
        let events = try #require(payload["events"] as? [[String: Any]])
        let attributes = try #require(events[0]["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(attributes["name"] as? String == "checkout.pay_tapped")
        #expect(attributes["status"] as? String == "success")
        #expect(metadata["source"] as? String == "swift.action")
        #expect(metadata["sessionId"] as? String == "session_123")
        #expect(metadata["screen"] as? String == "Checkout")
        #expect(metadata["traceId"] as? String == "trace_abc")
        #expect(metadata["funnel"] as? String == "checkout")
        #expect(metadata["step"] as? String == "payment")
        #expect(metadata["platform"] as? String == "ios")
        #expect(metadata["component"] as? String == "pay-button")
    }

    @Test("Swift network timeline helper sanitizes route metadata")
    func networkTimelineSanitizesRouteMetadata() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")

        try client.captureNetworkMilestone(
            "evt_network_milestone_001",
            timestamp: "2026-06-02T10:00:08Z",
            method: "post",
            routeTemplate: "https://mobile.example.test/api/checkout?itemId=123#pay",
            statusCode: 503,
            durationMs: 184.5,
            context: timelineContext(),
            metadata: ["retryable": true],
        )

        let payload = try parsePayload(client.previewJSON())
        let events = try #require(payload["events"] as? [[String: Any]])
        let networkAttributes = try #require(events[0]["attributes"] as? [String: Any])
        let networkMetadata = try #require(networkAttributes["metadata"] as? [String: Any])
        let preview = try client.previewJSON()

        #expect(networkAttributes["name"] as? String == "POST /api/checkout")
        #expect(networkAttributes["status"] as? String == "failure")
        #expect(networkMetadata["source"] as? String == "swift.network")
        #expect(networkMetadata["method"] as? String == "POST")
        #expect(networkMetadata["routeTemplate"] as? String == "/api/checkout")
        #expect(networkMetadata["statusCode"] as? Int == 503)
        #expect(networkMetadata["durationMs"] as? Double == 184.5)
        #expect(networkMetadata["retryable"] as? Bool == true)
        #expect(!preview.contains("itemId"))
        #expect(!preview.contains("#pay"))
    }

    @Test("Swift product timeline helpers reject unsafe network fields")
    func rejectUnsafeNetworkFields() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")

        #expect(throws: SdkError.self) {
            try client.captureNetworkMilestone(
                "evt_network_bad_duration",
                timestamp: "2026-06-02T10:00:08Z",
                method: "GET",
                routeTemplate: "/api/checkout",
                durationMs: -1,
            )
        }
        #expect(throws: SdkError.self) {
            try client.captureNetworkMilestone(
                "evt_network_bad_status",
                timestamp: "2026-06-02T10:00:08Z",
                method: "GET",
                routeTemplate: "/api/checkout",
                statusCode: 99,
            )
        }
        #expect(throws: SdkError.self) {
            try client.captureNetworkMilestone(
                "evt_network_bad_route",
                timestamp: "2026-06-02T10:00:08Z",
                method: "GET",
                routeTemplate: "ftp://example.test/private",
            )
        }
        #expect(throws: SdkError.self) {
            try client.captureNetworkMilestone(
                "evt_network_query_only_route",
                timestamp: "2026-06-02T10:00:08Z",
                method: "GET",
                routeTemplate: "?private=value",
            )
        }
        #expect(throws: SdkError.self) {
            try client.captureProductAction(
                "evt_product_action_bad_metadata",
                timestamp: "2026-06-02T10:00:07Z",
                name: "checkout.pay_tapped",
                metadata: ["value": .double(.infinity)],
            )
        }
    }

    private func timelineContext() -> ProductTimelineContext {
        ProductTimelineContext(
            sessionId: "session_123",
            screen: "Checkout",
            traceId: "trace_abc",
            funnel: "checkout",
            step: "payment",
            metadata: ["platform": "ios"],
        )
    }
}
