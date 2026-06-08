import Foundation
import LogBrew
import Testing

@Suite("LogBrew Swift SDK metrics")
struct MetricTests {
    @Test("metric helper emits typed metric event")
    func metricHelperEmitsTypedMetricEvent() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")

        try client.metric(
            "evt_metric_001",
            timestamp: "2026-06-02T10:00:06Z",
            attributes: MetricAttributes(
                name: "queue.depth",
                kind: .gauge,
                value: -2,
                unit: "items",
                temporality: .instant,
                metadata: ["queue": "checkout", "shard": 1],
            ),
        )

        let payload = try parsePayload(client.previewJSON())
        let events = try #require(payload["events"] as? [[String: Any]])
        let event = try #require(events.first)
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(events.count == 1)
        #expect(event["type"] as? String == "metric")
        #expect(attributes["name"] as? String == "queue.depth")
        #expect(attributes["kind"] as? String == "gauge")
        #expect((attributes["value"] as? NSNumber)?.doubleValue == -2)
        #expect(attributes["unit"] as? String == "items")
        #expect(attributes["temporality"] as? String == "instant")
        #expect(metadata["queue"] as? String == "checkout")
        #expect(metadata["shard"] as? Int == 1)
    }

    @Test("metric helper rejects invalid values and temporalities")
    func metricHelperRejectsInvalidValuesAndTemporalities() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")

        #expect(throws: SdkError.self) {
            try client.metric(
                "evt_metric_nan",
                timestamp: "2026-06-02T10:00:06Z",
                attributes: MetricAttributes(
                    name: "queue.depth",
                    kind: .gauge,
                    value: Double.nan,
                    unit: "items",
                    temporality: .instant,
                ),
            )
        }
        #expect(throws: SdkError.self) {
            try client.metric(
                "evt_metric_negative_counter",
                timestamp: "2026-06-02T10:00:06Z",
                attributes: MetricAttributes(
                    name: "jobs.processed",
                    kind: .counter,
                    value: -1,
                    unit: "jobs",
                    temporality: .delta,
                ),
            )
        }
        #expect(throws: SdkError.self) {
            try client.metric(
                "evt_metric_bad_temporality",
                timestamp: "2026-06-02T10:00:06Z",
                attributes: MetricAttributes(
                    name: "queue.depth",
                    kind: .gauge,
                    value: 5,
                    unit: "items",
                    temporality: .delta,
                ),
            )
        }
    }
}
