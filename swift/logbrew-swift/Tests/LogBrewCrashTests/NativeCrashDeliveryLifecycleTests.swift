import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

extension NativeCrashDeliveryTests {
    @Test("durable replay deletes a report only after accepted delivery")
    func durableReplayAcknowledgesOnlyAcceptedDelivery() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        let client = try makeClient(name: "durable-replay", maxRetries: 0)
        let durableParent = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: durableParent, withIntermediateDirectories: false)
        try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: durableParent))
        let transport = RecordingTransport(scriptedResponses: [.status(503), .status(202)])

        let retained = try capture.replayPendingReports(in: client, transport: transport)

        #expect(retained.attempted == 1)
        #expect(retained.acknowledged == 0)
        #expect(retained.pending == 1)
        #expect(client.pendingEvents() == 1)
        #expect(store.reportIDs == [1])
        let firstBody = try #require(transport.sentBodies.first)

        let accepted = try capture.replayPendingReports(in: client, transport: transport)

        #expect(accepted.attempted == 1)
        #expect(accepted.acknowledged == 1)
        #expect(accepted.pending == 0)
        #expect(client.pendingEvents() == 0)
        #expect(store.reportIDs.isEmpty)
        #expect(transport.sentBodies == [firstBody, firstBody])
    }

    @Test("explicit purge verifies deletion and reports only fixed health")
    func purgeAndHealthAreFailClosed() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        _ = try capture.replayPendingReports { _ in false }

        let retained = try capture.status()
        #expect(retained.lifecycle == .installed)
        #expect(retained.pending == 1)
        #expect(retained.acknowledged == 0)
        #expect(retained.lastOutcome == .retained)
        #expect(!retained.description.contains("sensitive-value"))

        store.ignoresDeleteAll = true
        #expect(throws: NativeCrashError.self) {
            try capture.purge()
        }
        #expect(store.reportIDs == [1])

        store.ignoresDeleteAll = false
        try capture.purge()
        let purged = try capture.status()
        #expect(purged.pending == 0)
        #expect(purged.lastOutcome == .purged)
    }

    @Test("a second replay fails fast while the first handler is in flight")
    func concurrentReplayIsSingleFlight() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let done = DispatchSemaphore(value: 0)
        let result = ThreadResultBox()

        Thread.detachNewThread {
            defer { done.signal() }
            do {
                _ = try capture.replayPendingReports { _ in
                    started.signal()
                    release.wait()
                    return false
                }
            } catch {
                result.set(error)
            }
        }
        #expect(started.wait(timeout: .now() + 2) == .success)

        do {
            _ = try capture.replayPendingReports { _ in true }
            Issue.record("expected a concurrent replay to fail")
        } catch let error as NativeCrashError {
            #expect(error.code == .replayBusy)
        }

        release.signal()
        #expect(done.wait(timeout: .now() + 2) == .success)
        #expect(result.error == nil)
        #expect(store.reportIDs == [1])
    }
}
