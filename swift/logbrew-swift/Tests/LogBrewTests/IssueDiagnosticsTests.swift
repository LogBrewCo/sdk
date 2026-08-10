import Foundation
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

    @Test("underlying errors preserve causal structure without private descriptions")
    func underlyingErrorEvidence() throws {
        let client = try richClient()
        let issue = IssueAttributes.fromError(
            WrappedCheckoutError(),
            mechanism: "swift.task",
            fileID: "Shop/Checkout.swift",
            line: 52,
            column: 9,
            function: "authorize()",
        )
        try client.issue("underlying", timestamp: "2026-08-06T10:00:01Z", attributes: issue)

        let json = try client.previewJSON()
        let attributes = try richParsedAttributes(client)
        let exception = try #require(attributes["exception"] as? [String: Any])
        let frames = try #require(attributes["stackFrames"] as? [[String: Any]])
        let chain = try #require(attributes["exceptionChain"] as? [String: Any])
        let entries = try #require(chain["entries"] as? [[String: Any]])
        #expect(entries.count == 2)
        #expect(chain["truncated"] as? Bool == false)
        #expect(entries[0]["id"] as? Int == 0)
        #expect(entries[0]["relationship"] as? String == "reported")
        #expect(entries[0]["type"] as? String == exception["type"] as? String)
        #expect(entries[0]["messageState"] as? String == "redacted")
        #expect(entries[0]["message"] == nil)
        #expect(entries[0]["stackFramesState"] as? String == "captured")
        let rootFrames = try #require(entries[0]["stackFrames"] as? [[String: Any]])
        #expect(rootFrames.first?["filename"] as? String == frames.first?["filename"] as? String)
        #expect(entries[1]["id"] as? Int == 1)
        #expect(entries[1]["parentId"] as? Int == 0)
        #expect(entries[1]["relationship"] as? String == "cause")
        #expect((entries[1]["type"] as? String)?.contains("ProviderFailure") == true)
        #expect(entries[1]["messageState"] as? String == "redacted")
        #expect(entries[1]["stackFramesState"] as? String == "not_captured")
        #expect(entries[1]["stackFrames"] == nil)
        #expect(!json.contains("private checkout wrapper text"))
        #expect(!json.contains("private provider response"))
    }

    @Test("manual chains preserve approved per-node evidence and reject root mismatches")
    func manualChainEvidence() throws {
        let client = try richClient()
        let mechanism = IssueExceptionMechanism(type: "swift.manual", handled: true)
        let evidence = manualExceptionEvidence(mechanism: mechanism)
        try client.issue(
            "manual",
            timestamp: "2026-08-06T10:00:01Z",
            attributes: IssueAttributes(
                title: "Checkout failed",
                level: .error,
                exception: IssueException(type: "Shop.CheckoutFailure", mechanism: mechanism),
                exceptionChain: evidence.chain,
                stackFrames: [evidence.rootFrame],
            ),
        )
        try assertManualChain(client)
        assertManualMismatch(client, mechanism: mechanism, evidence: evidence)
    }
}

private func manualExceptionEvidence(
    mechanism: IssueExceptionMechanism,
) -> (rootFrame: IssueStackFrame, chain: IssueExceptionChain) {
    let rootFrame = IssueStackFrame(
        filename: "Checkout.swift",
        line: 42,
        column: 7,
        function: "submit()",
        module: "Shop",
        inApp: true,
    )
    let causeFrame = IssueStackFrame(
        filename: "Provider.swift",
        line: 18,
        column: 3,
        function: "authorize()",
        module: "Payments",
        inApp: true,
    )
    let entries = [
        IssueExceptionChainEntry(
            id: 0,
            relationship: .reported,
            type: "Shop.CheckoutFailure",
            messageState: .redacted,
            mechanism: mechanism,
            stackFrames: [rootFrame],
            stackFramesState: .truncated,
        ),
        IssueExceptionChainEntry(
            id: 1,
            parentId: 0,
            relationship: .cause,
            type: "Payments.AuthorizationFailure",
            message: "provider rejected the authorization",
            messageState: .captured,
            stackFrames: [causeFrame],
            stackFramesState: .captured,
        ),
    ]
    return (rootFrame, IssueExceptionChain(entries: entries))
}

private func assertManualChain(_ client: LogBrewClient) throws {
    let attributes = try richParsedAttributes(client)
    let encodedChain = try #require(attributes["exceptionChain"] as? [String: Any])
    let entries = try #require(encodedChain["entries"] as? [[String: Any]])
    #expect(entries[0]["stackFramesState"] as? String == "truncated")
    #expect(entries[1]["messageState"] as? String == "captured")
    #expect(entries[1]["message"] as? String == "provider rejected the authorization")
    #expect(entries[1]["stackFramesState"] as? String == "captured")
}

private func assertManualMismatch(
    _ client: LogBrewClient,
    mechanism: IssueExceptionMechanism,
    evidence: (rootFrame: IssueStackFrame, chain: IssueExceptionChain),
) {
    #expect(throws: SdkError.self) {
        try client.issue(
            "mismatch",
            timestamp: "2026-08-06T10:00:02Z",
            attributes: IssueAttributes(
                title: "Mismatch",
                level: .error,
                exception: IssueException(type: "Shop.OtherFailure", mechanism: mechanism),
                exceptionChain: evidence.chain,
                stackFrames: [evidence.rootFrame],
            ),
        )
    }
}

private enum CheckoutError: Error {
    case declined(restrictedValue: String)
}

private struct ProviderFailure: Error {}

private struct WrappedCheckoutError: Error, CustomNSError {
    static let errorDomain = "co.logbrew.tests.checkout"
    let errorCode = 1
    var errorUserInfo: [String: Any] {
        [
            NSLocalizedDescriptionKey: "private checkout wrapper text",
            NSUnderlyingErrorKey: ProviderFailure(),
            "private": "private provider response",
        ]
    }
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
    let chain = try #require(attributes["exceptionChain"] as? [String: Any])
    let entries = try #require(chain["entries"] as? [[String: Any]])
    let frames = try #require(attributes["stackFrames"] as? [[String: Any]])
    let breadcrumbs = try #require(attributes["breadcrumbs"] as? [[String: Any]])

    #expect((exception["type"] as? String)?.contains("CheckoutError") == true)
    #expect(mechanism["type"] as? String == "swift.task")
    #expect(mechanism["handled"] as? Bool == true)
    #expect(entries.count == 1)
    #expect(entries[0]["relationship"] as? String == "reported")
    #expect(entries[0]["messageState"] as? String == "redacted")
    #expect(entries[0]["stackFramesState"] as? String == "captured")
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
