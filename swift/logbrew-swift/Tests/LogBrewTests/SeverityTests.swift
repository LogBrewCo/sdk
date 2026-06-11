import LogBrew
import Testing

@Suite("LogBrew Swift SDK severity")
struct SeverityTests {
    @Test("severity aliases encode as canonical levels")
    func severityAliasesEncodeAsCanonicalLevels() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        try client.issue(
            "evt_issue_alias",
            timestamp: "2026-06-02T10:00:02Z",
            attributes: IssueAttributes(title: "Checkout timeout", level: .fatal),
        )
        try client.log(
            "evt_log_debug",
            timestamp: "2026-06-02T10:00:03Z",
            attributes: LogAttributes(message: "verbose runtime detail", level: .debug),
        )
        try client.log(
            "evt_log_warn",
            timestamp: "2026-06-02T10:00:04Z",
            attributes: LogAttributes(message: "legacy warning alias", level: .warn),
        )

        let payload = try parsePayload(client.previewJSON())
        let events = try #require(payload["events"] as? [[String: Any]])
        let levels = try events.map { event in
            let attributes = try #require(event["attributes"] as? [String: Any])
            return attributes["level"] as? String
        }
        #expect(levels == ["critical", "info", "warning"])
    }
}
