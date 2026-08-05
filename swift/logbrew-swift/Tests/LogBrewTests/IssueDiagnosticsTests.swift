import LogBrew
import Testing

@Suite("Swift issue diagnostics")
struct IssueDiagnosticsTests {
    @Test("handled errors include bounded exception, frame, and breadcrumb evidence")
    func handledErrorEvidence() throws {
        let client = try richClient()
        try addBreadcrumbHistory(to: client)
        let issue = IssueAttributes.fromError(
            CheckoutError.declined(restrictedValue: "card-number-must-never-escape"),
            title: "Payment authorization failed",
            mechanism: "swift.task",
            fileID: "/opt/app/Shop/Checkout.swift?query=value",
            line: 42,
            column: 17,
            function: "submitPayment()",
        )

        try client.issue("handled", timestamp: "2026-08-06T10:00:01Z", attributes: issue)
        try assertHandledIssue(client)

        client.clearBreadcrumbs()
        try client.issue(
            "after-clear",
            timestamp: "2026-08-06T10:00:02Z",
            attributes: IssueAttributes(title: "Fresh issue", level: .error),
        )
        let events = try richParsedEvents(client)
        let cleared = try #require(events.last?["attributes"] as? [String: Any])
        #expect(cleared["breadcrumbs"] == nil)
        #expect(cleared["breadcrumbsTruncated"] == nil)
    }

    @Test("invalid breadcrumb evidence fails before queue admission")
    func invalidBreadcrumbFailsClosed() throws {
        let client = try richClient()
        #expect(throws: SdkError.self) {
            try client.addBreadcrumb(
                IssueBreadcrumb(timestamp: "not-a-time", category: "unsafe category"),
            )
        }
        #expect(client.pendingEvents() == 0)
    }
}

private enum CheckoutError: Error {
    case declined(restrictedValue: String)
}

private func addBreadcrumbHistory(to client: LogBrewClient) throws {
    for index in 0 ..< 66 {
        try client.addBreadcrumb(
            IssueBreadcrumb(
                timestamp: "2026-08-06T10:00:00Z",
                category: "step_\(index)",
                type: "navigation",
                level: .info,
                message: "Checkout step",
                data: ["index": .int(index)],
            ),
        )
    }
}

private func assertHandledIssue(_ client: LogBrewClient) throws {
    let json = try client.previewJSON()
    let attributes = try richParsedAttributes(client)
    let exception = try #require(attributes["exception"] as? [String: Any])
    let mechanism = try #require(exception["mechanism"] as? [String: Any])
    let frames = try #require(attributes["stackFrames"] as? [[String: Any]])
    let breadcrumbs = try #require(attributes["breadcrumbs"] as? [[String: Any]])

    #expect((exception["type"] as? String)?.contains("CheckoutError") == true)
    #expect(mechanism["type"] as? String == "swift.task")
    #expect(mechanism["handled"] as? Bool == true)
    #expect(attributes["message"] == nil)
    #expect(frames.count == 1)
    #expect(frames[0]["filename"] as? String == "Checkout.swift")
    #expect(frames[0]["line"] as? Int == 42)
    #expect(frames[0]["column"] as? Int == 17)
    #expect(frames[0]["function"] as? String == "submitPayment()")
    #expect(frames[0]["inApp"] as? Bool == true)
    #expect(breadcrumbs.count == 64)
    #expect(breadcrumbs.first?["category"] as? String == "step_2")
    #expect(breadcrumbs.last?["category"] as? String == "step_65")
    #expect(attributes["breadcrumbsTruncated"] as? Bool == true)
    #expect(!json.contains("card-number-must-never-escape"))
    #expect(!json.contains("/opt/app"))
}
