import Foundation
@_spi(CrashReplay) import LogBrew
import Testing

@Suite("Exact event delivery")
struct ExactEventDeliveryTests {
    @Test("accepted delivery is confirmed only for the requested event")
    func acceptedDeliveryConfirmsRequestedEvent() throws {
        let client = try makeClient(maxRetries: 0)
        try captureLog(client, id: "event-before-target")
        try captureLog(client, id: "native-target")
        let transport = ThreadSafeScriptedTransport(statuses: [202])

        let accepted = try client.flushEvent(
            "native-target",
            transport: transport,
        )

        #expect(accepted)
        #expect(client.pendingEvents() == 0)
        #expect(transport.requestBodies.count == 1)
        #expect(transport.requestBodies[0].contains("event-before-target"))
        #expect(transport.requestBodies[0].contains("native-target"))
    }

    @Test("an absent event cannot borrow an empty flush success")
    func absentEventDoesNotBorrowEmptyFlushSuccess() throws {
        let client = try makeClient(maxRetries: 0)
        let transport = ThreadSafeScriptedTransport(statuses: [202])

        let accepted = try client.flushEvent(
            "native-target",
            transport: transport,
        )

        #expect(!accepted)
        #expect(transport.requestBodies.isEmpty)
    }

    @Test("a malformed accepted response retains the requested event")
    func malformedAcceptedResponseRetainsRequestedEvent() throws {
        let client = try makeClient(maxRetries: 0)
        try captureLog(client, id: "native-target")
        let transport = InvalidAttemptCountTransport()

        do {
            _ = try client.flushEvent(
                "native-target",
                transport: transport,
            )
            Issue.record("expected malformed transport response to fail")
        } catch let error as SdkError {
            #expect(error.code == "transport_error")
        }

        #expect(client.pendingEvents() == 1)
        #expect(transport.requestBodies.count == 1)
        #expect(transport.requestBodies[0].contains("native-target"))
    }
}

private final class InvalidAttemptCountTransport: Transport {
    private(set) var requestBodies: [String] = []

    func send(apiKey _: String, body: Data) throws -> TransportResponse {
        requestBodies.append(String(bytes: body, encoding: .utf8) ?? "")
        return TransportResponse(statusCode: 202, attempts: 0)
    }
}
