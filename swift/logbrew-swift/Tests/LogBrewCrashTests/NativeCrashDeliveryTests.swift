import Foundation
import LogBrew
@testable import LogBrewCrash
import Testing

@Suite("Apple native crash delivery")
struct NativeCrashDeliveryTests {
    @Test("sanitized replay records enqueue only fixed crash metadata")
    func enqueueUsesPrivacyAllowlist() throws {
        let store = FakeCrashReportStore(reports: [
            1: rawReport(
                id: "8F12B746-0C79-4CC6-A077-98ED62F094B2",
                timestamp: "2026-07-17T09:10:11Z",
                mechanism: "signal",
                privateMarker: "never-upload-this-value",
            ),
        ])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        let record = try #require(capture.pendingReports().first)
        let client = try makeClient(name: "installed-apple-test")

        try record.enqueue(in: client)
        let event = try firstEvent(in: client)
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(event["id"] as? String == "8f12b746-0c79-4cc6-a077-98ed62f094b2")
        #expect(event["type"] as? String == "issue")
        #expect(attributes["title"] as? String == "Native application crash")
        #expect(attributes["level"] as? String == "critical")
        #expect(attributes["message"] == nil)
        #expect(metadata as NSDictionary == [
            "crash.mechanism": "signal",
            "crash.replayed": true,
        ])
        let json = try client.previewJSON()
        #expect(!json.contains("hunter2"))
        #expect(!json.contains("never-upload-this-value"))
    }

    @Test("enqueue is idempotent for a retained crash event")
    func enqueueIsIdempotentForRetry() throws {
        let record = try makeRecord()
        let client = try makeClient(name: "retry-test")

        try record.enqueue(in: client)
        let firstBody = try client.previewJSON()
        try record.enqueue(in: client)

        #expect(client.pendingEvents() == 1)
        #expect(try client.previewJSON() == firstBody)
    }

    @Test("replayed crashes do not inherit the next launch trace")
    func enqueueIsDetachedFromCurrentTrace() throws {
        let record = try makeRecord()
        let client = try makeClient(name: "detached-trace-test")
        let context = LogBrewTrace.continueOrCreateContext(
            fromTraceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        )

        try LogBrewTrace.withContext(context) {
            try record.enqueue(in: client)
        }
        let event = try firstEvent(in: client)
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(metadata["traceId"] == nil)
        #expect(metadata["spanId"] == nil)
        #expect(metadata.count == 2)
    }

    @Test("an existing different event with the crash ID fails closed")
    func enqueueRejectsEventIDCollision() throws {
        let record = try makeRecord()
        let client = try makeClient(name: "collision-test")
        try client.issue(
            record.eventID,
            timestamp: record.timestamp,
            attributes: IssueAttributes(title: "Different issue", level: .error),
        )

        do {
            try record.enqueue(in: client)
            Issue.record("expected event ID collision to fail")
        } catch let error as NativeCrashError {
            #expect(error.code == .reportChanged)
        }
        #expect(client.pendingEvents() == 1)
    }

    @Test("retained reports produce byte-identical events on later replay")
    func retainedReportHasStableRetryBody() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()

        var bodies: [String] = []
        for _ in 0 ..< 2 {
            _ = try capture.replayPendingReports { record in
                guard let client = try? makeClient(name: "retry-test") else {
                    return false
                }
                try? record.enqueue(in: client)
                if let body = try? client.previewJSON() {
                    bodies.append(body)
                }
                return false
            }
        }

        #expect(bodies.count == 2)
        #expect(bodies[0] == bodies[1])
        #expect(store.reportIDs == [1])
    }

    @Test("oversized reports fail closed without skipping them")
    func oversizedReportFailsClosed() throws {
        let store = FakeCrashReportStore(reports: [
            1: rawReport(
                id: "8F12B746-0C79-4CC6-A077-98ED62F094B2",
                timestamp: "2026-07-17T09:10:11Z",
                mechanism: "signal",
                privateMarker: String(repeating: "x", count: 2000),
            ),
        ])
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let capture = try NativeCrashCapture(
            configuration: NativeCrashConfiguration(
                storageDirectory: directory,
                maxReplayBytes: 1024,
            ),
            driver: FakeCrashEngineDriver(store: store),
            ownership: ProcessCrashCaptureOwnership(),
        )
        try capture.install()

        #expect(throws: NativeCrashError.self) {
            _ = try capture.pendingReports()
        }
        #expect(store.reportIDs == [1])
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

    private func makeClient(name: String) throws -> LogBrewClient {
        try LogBrewClient.create(
            apiKey: "LOGBREW_API_KEY",
            sdkName: name,
            sdkVersion: "0.1.0",
        )
    }

    private func firstEvent(in client: LogBrewClient) throws -> [String: Any] {
        let data = try #require(client.previewJSON().data(using: .utf8))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try #require(object["events"] as? [[String: Any]])
        return try #require(events.first)
    }
}
