@testable import LogBrewCrash
import Testing

@Suite("Apple native crash lifecycle")
struct NativeCrashLifecycleTests {
    @Test("additive lifecycle and outcome values preserve the Objective-C contract")
    func publicEnumRawValuesRemainStable() {
        #expect(NativeCrashLifecycleState.idle.rawValue == 0)
        #expect(NativeCrashLifecycleState.installed.rawValue == 1)
        #expect(NativeCrashLifecycleState.replaying.rawValue == 2)
        #expect(NativeCrashLifecycleState.failed.rawValue == 3)
        #expect(NativeCrashLifecycleState.stopped.rawValue == 4)
        #expect(NativeCrashOutcome.none.rawValue == 0)
        #expect(NativeCrashOutcome.acknowledged.rawValue == 1)
        #expect(NativeCrashOutcome.retained.rawValue == 2)
        #expect(NativeCrashOutcome.purged.rawValue == 3)
        #expect(NativeCrashOutcome.failed.rawValue == 4)
        #expect(NativeCrashOutcome.discarded.rawValue == 5)
    }

    @Test("stopping replay is explicit and retains stored work")
    func stopReplayRetainsStoredWork() throws {
        let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()

        try capture.stopReplay()

        let status = try capture.status()
        #expect(status.lifecycle == .stopped)
        #expect(status.pending == 1)
        #expect(throws: NativeCrashError.self) {
            _ = try capture.replayPendingReports { _ in true }
        }
        #expect(store.reportIDs == [1])
    }
}
