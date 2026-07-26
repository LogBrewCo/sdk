import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

extension NativeCrashDeliveryTests {
    @Test("native record is acknowledged only after its exact accepted request")
    func exactAcceptedRequestAcknowledgesNativeRecord() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        let client = try makeClient(name: "exact-accepted", maxRetries: 0)
        let transport = RecordingTransport(scriptedResponses: [.status(202)])

        let result = try capture.replayPendingReports(
            in: client,
            transport: transport,
        )

        #expect(result.attempted == 1)
        #expect(result.acknowledged == 1)
        #expect(result.pending == 0)
        #expect(store.reportIDs.isEmpty)
        #expect(client.pendingEvents() == 0)
        #expect(transport.sentBodies.count == 1)
        #expect(transport.sentBodies[0].contains(sampleCrashEventID.lowercased()))
    }

    @Test("transport failure retains the native record and exact client event")
    func transportFailureRetainsNativeRecord() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        let client = try makeClient(name: "transport-failure", maxRetries: 0)
        let transport = RecordingTransport(scriptedResponses: [
            .failure(.network("temporary delivery failure")),
        ])

        let result = try capture.replayPendingReports(
            in: client,
            transport: transport,
        )

        #expect(result.acknowledged == 0)
        #expect(result.pending == 1)
        #expect(store.reportIDs == [1])
        #expect(client.pendingEvents() == 1)
    }

    @Test("non-success status retains the native record and exact client event")
    func nonSuccessStatusRetainsNativeRecord() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        let client = try makeClient(name: "status-failure", maxRetries: 0)
        let transport = RecordingTransport(scriptedResponses: [.status(422)])

        let result = try capture.replayPendingReports(
            in: client,
            transport: transport,
        )

        #expect(result.acknowledged == 0)
        #expect(result.pending == 1)
        #expect(store.reportIDs == [1])
        #expect(client.pendingEvents() == 1)
    }

    @Test("malformed success retains the native record")
    func malformedSuccessRetainsNativeRecord() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        let client = try makeClient(name: "malformed-success", maxRetries: 0)
        let transport = CrashInvalidAttemptCountTransport()

        let result = try capture.replayPendingReports(
            in: client,
            transport: transport,
        )

        #expect(result.acknowledged == 0)
        #expect(result.pending == 1)
        #expect(store.reportIDs == [1])
        #expect(client.pendingEvents() == 1)
    }

    @Test("stale automatic completion cannot acknowledge the native record")
    func staleAutomaticCompletionRetainsNativeRecord() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        let client = try makeClient(name: "stale-completion", maxRetries: 0)
        let record = try #require(try capture.pendingReports().first)
        try record.enqueue(in: client)
        let automatic = BlockingAcceptedCrashTransport()
        try client.startAutomaticDelivery(
            transport: automatic,
            options: AutomaticDeliveryOptions(interval: 30, threshold: 1),
        )
        #expect(automatic.waitUntilStarted())

        let replay = NativeReplayResultBox()
        let manualStarted = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        let manual = CrashThreadSafeRecordingTransport()
        Thread.detachNewThread {
            defer { finished.signal() }
            manualStarted.signal()
            replay.capture {
                try capture.replayPendingReports(
                    in: client,
                    transport: manual,
                )
            }
        }
        #expect(manualStarted.wait(timeout: .now() + 2) == .success)
        Thread.sleep(forTimeInterval: 0.05)
        automatic.finish()
        #expect(finished.wait(timeout: .now() + 2) == .success)

        let retained = try replay.result.get()
        #expect(retained.acknowledged == 0)
        #expect(retained.pending == 1)
        #expect(store.reportIDs == [1])
        #expect(manual.sentBodies.isEmpty)

        client.stopAutomaticDelivery()
        let accepted = try capture.replayPendingReports(
            in: client,
            transport: manual,
        )
        #expect(accepted.acknowledged == 1)
        #expect(accepted.pending == 0)
        #expect(store.reportIDs.isEmpty)
        #expect(manual.sentBodies.count == 1)
        #expect(manual.sentBodies[0].contains(record.eventID))
    }

    @Test("queue admission failure retains the native record without transport")
    func queueAdmissionFailureRetainsNativeRecord() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        let client = try makeClient(name: "admission-failure", maxRetries: 0)
        for index in 0 ..< 1000 {
            try client.log(
                "queued-\(index)",
                timestamp: "2026-07-25T12:00:00Z",
                attributes: LogAttributes(message: "bounded", level: .info),
            )
        }
        let transport = RecordingTransport(scriptedResponses: [.status(202)])

        let result = try capture.replayPendingReports(
            in: client,
            transport: transport,
        )

        #expect(result.acknowledged == 0)
        #expect(result.pending == 1)
        #expect(store.reportIDs == [1])
        #expect(client.pendingEvents() == 1000)
        #expect(transport.sentBodies.isEmpty)
    }
}

private let sampleCrashEventID = "8F12B746-0C79-4CC6-A077-98ED62F094B2"

private final class CrashInvalidAttemptCountTransport: Transport {
    func send(apiKey _: String, body _: Data) throws -> TransportResponse {
        TransportResponse(statusCode: 202, attempts: 0)
    }
}

private final class BlockingAcceptedCrashTransport: Transport, @unchecked Sendable {
    private let started = DispatchSemaphore(value: 0)
    private let release = DispatchSemaphore(value: 0)

    func send(apiKey _: String, body _: Data) throws -> TransportResponse {
        started.signal()
        release.wait()
        return TransportResponse(statusCode: 202, attempts: 1)
    }

    func waitUntilStarted() -> Bool {
        started.wait(timeout: .now() + 2) == .success
    }

    func finish() {
        release.signal()
    }
}

private final class CrashThreadSafeRecordingTransport: Transport, @unchecked Sendable {
    private let lock = NSLock()
    private var bodies: [String] = []

    var sentBodies: [String] {
        lock.lock()
        defer { lock.unlock() }
        return bodies
    }

    func send(apiKey _: String, body: Data) throws -> TransportResponse {
        lock.lock()
        bodies.append(String(bytes: body, encoding: .utf8) ?? "")
        lock.unlock()
        return TransportResponse(statusCode: 202, attempts: 1)
    }
}

private final class NativeReplayResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Result<NativeCrashReplayResult, Error>?

    var result: Result<NativeCrashReplayResult, Error> {
        lock.lock()
        defer { lock.unlock() }
        return stored ?? .failure(NativeCrashError(.reportChanged))
    }

    func capture(_ operation: () throws -> NativeCrashReplayResult) {
        let value = Result(catching: operation)
        lock.lock()
        stored = value
        lock.unlock()
    }
}
