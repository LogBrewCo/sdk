import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

extension NativeCrashDeliveryTests {
    @Test("equivalent fractional widths share one exact chronology key")
    func equivalentFractionalWidthsShareChronologyKey() throws {
        let compact = try #require(NativeCrashTimestamp("2026-07-25T10:00:00.0001Z"))
        let padded = try #require(NativeCrashTimestamp("2026-07-25T10:00:00.000100000Z"))

        #expect(compact == padded)
    }

    @Test("mixed hang and crash replay is oldest-first and rejection retains both sources")
    func mixedReplayOrdersByOccurrenceAndRetainsRejectedWork() throws {
        let fixture = try MixedReplayFixture()
        defer { fixture.removeStorage() }

        var rejected: [String] = []
        let retained = try fixture.capture.replayPendingReports { record in
            rejected.append(record.eventID)
            return false
        }

        #expect(rejected == [fixture.hangID])
        #expect(retained.attempted == 1)
        #expect(retained.acknowledged == 0)
        #expect(retained.pending == 2)
        #expect(fixture.crashStore.reportIDs == [7])
        #expect(try fixture.hangStore.read()?.eventID == fixture.hangID)

        var accepted: [(String, String)] = []
        let drained = try fixture.capture.replayPendingReports { record in
            accepted.append((record.eventID, record.timestamp))
            return true
        }

        #expect(accepted.map(\.0) == [
            fixture.hangID,
            fixture.crashID,
        ])
        #expect(accepted.map(\.1) == [
            "2026-07-25T10:00:00Z",
            "2026-07-25T10:00:00.000000001Z",
        ])
        #expect(drained.attempted == 2)
        #expect(drained.acknowledged == 2)
        #expect(drained.pending == 0)
        #expect(fixture.crashStore.reportIDs.isEmpty)
        #expect(fixture.crashStore.deletedIDs == [7])
        #expect(try fixture.hangStore.read() == nil)
    }

    @Test("sub-millisecond engine reports replay by exact chronology before report sequence")
    func subMillisecondEngineReportsUseExactChronology() throws {
        let laterID = "ffffffff-ffff-4fff-bfff-ffffffffffff"
        let earlierID = "00000000-0000-4000-8000-000000000009"
        let store = FakeCrashReportStore(reports: [
            7: rawReport(
                id: laterID,
                timestamp: "2026-07-25T10:00:00.000000002Z",
                mechanism: "signal",
                privateMarker: "later-crash",
            ),
            9: rawReport(
                id: earlierID,
                timestamp: "2026-07-25T10:00:00.000000001Z",
                mechanism: "signal",
                privateMarker: "earlier-crash",
            ),
        ])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()

        var accepted: [(String, String)] = []
        let result = try capture.replayPendingReports { record in
            accepted.append((record.eventID, record.timestamp))
            return true
        }

        #expect(accepted.map(\.0) == [earlierID, laterID])
        #expect(accepted.map(\.1) == [
            "2026-07-25T10:00:00.000000001Z",
            "2026-07-25T10:00:00.000000002Z",
        ])
        #expect(result.acknowledged == 2)
        #expect(result.pending == 0)
        #expect(store.deletedIDs == [9, 7])
    }

    @Test(
        "malformed hang data is discarded without blocking valid crash replay",
        arguments: StoredHangCorruption.allCases,
    )
    func malformedHangIsDiscardedWithoutBlockingCrashReplay(
        _ corruption: StoredHangCorruption,
    ) throws {
        let fixture = try MixedReplayFixture()
        defer { fixture.removeStorage() }
        try fixture.invalidateStoredHang(corruption)

        var accepted: [String] = []
        let result = try fixture.capture.replayPendingReports { record in
            accepted.append(record.eventID)
            return true
        }

        #expect(accepted == [fixture.crashID])
        #expect(result.attempted == 1)
        #expect(result.acknowledged == 1)
        #expect(result.discarded == 1)
        #expect(result.pending == 0)
        #expect(fixture.crashStore.deletedIDs == [7])
        #expect(try fixture.hangStore.read() == nil)
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
        #expect(metadata["crash.breadcrumbs"] as? String == "not_captured")
        #expect(metadata["crash.correlation"] as? String == "not_captured")
        #expect(metadata.count == 4)
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

    @Test("oversized reports are discarded without invoking delivery")
    func oversizedReportIsDiscarded() throws {
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

        var deliveries = 0
        let result = try capture.replayPendingReports { _ in
            deliveries += 1
            return true
        }

        #expect(result.attempted == 0)
        #expect(result.acknowledged == 0)
        #expect(result.discarded == 1)
        #expect(result.pending == 0)
        #expect(deliveries == 0)
        #expect(store.reportIDs.isEmpty)
        let health = try capture.status()
        #expect(health.discarded == 1)
        #expect(health.lastOutcome == .discarded)
    }
}
