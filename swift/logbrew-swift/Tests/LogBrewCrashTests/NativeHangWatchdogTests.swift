import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

@Suite("Apple native hang watchdog")
struct NativeHangWatchdogTests {
    @Test("a foreground threshold persists once and recovery rewrites before delivery")
    func captureThenRecoveryIsDurable() throws {
        let fixture = try WatchdogFixture()
        fixture.controller.start(active: true)
        #expect(fixture.mainPinger.pendingCount == 1)

        fixture.clock.now = 2.1
        fixture.controller.poll()

        let ongoing = try #require(fixture.store.incident)
        #expect(ongoing.state == .ongoing)
        #expect(abs((ongoing.durationMs ?? 0) - 2100) < 0.001)
        #expect(ongoing.artifactIdentity == NativeArtifactIdentityValue(fixture.identity))
        #expect(ongoing.nativeStackFrames == fixture.frames)
        #expect(fixture.store.writeCount == 1)

        fixture.clock.now = 4.25
        fixture.mainPinger.respond()

        #expect(fixture.store.incident?.state == .recovered)
        #expect(fixture.store.incident?.durationMs == 4250)
        #expect(fixture.store.recoveryCount == 1)
        #expect(fixture.diagnostics.codes == [.captured, .recovered])
    }

    @Test("background debugger thermal and scheduler stalls suppress capture")
    func safetyGatesSuppressFalsePositives() throws {
        let fixture = try WatchdogFixture()
        fixture.controller.start(active: false)
        fixture.clock.now = 3
        fixture.controller.poll()
        #expect(fixture.store.incident == nil)

        fixture.controller.setActive(true)
        fixture.safety.debuggerAttached = true
        fixture.clock.now = 5.1
        fixture.controller.poll()
        fixture.controller.poll()
        fixture.controller.poll()
        #expect(fixture.store.incident == nil)
        #expect(fixture.diagnostics.codes == [.skippedDebugger])
        fixture.mainPinger.respond()

        fixture.safety.debuggerAttached = false
        fixture.safety.thermalRestricted = true
        fixture.clock.now = 6
        fixture.controller.poll()
        fixture.clock.now = 8.1
        fixture.controller.poll()
        fixture.controller.poll()
        #expect(fixture.store.incident == nil)
        #expect(fixture.diagnostics.codes.last == .skippedThermal)
        fixture.mainPinger.respond()

        fixture.safety.thermalRestricted = false
        fixture.clock.now = 9
        fixture.controller.poll()
        fixture.clock.now = 13.1
        fixture.controller.poll()
        fixture.controller.poll()
        #expect(fixture.store.incident == nil)
        #expect(fixture.diagnostics.codes.last == .skippedSchedulerStall)
    }

    @Test("empty main-thread frames and persistence errors fail closed with bounded diagnostics")
    func captureFailuresAreBounded() throws {
        let fixture = try WatchdogFixture()
        fixture.stack.frames = []
        fixture.controller.start(active: true)
        fixture.clock.now = 2.1
        fixture.controller.poll()
        fixture.controller.poll()
        #expect(fixture.store.incident == nil)
        #expect(fixture.diagnostics.codes == [.stackUnavailable])
        fixture.mainPinger.respond()

        fixture.stack.frames = fixture.frames
        fixture.store.writeError = NativeCrashError(.storageUnsupported)
        fixture.clock.now = 3
        fixture.controller.poll()
        fixture.clock.now = 5.1
        fixture.controller.poll()
        fixture.controller.poll()

        #expect(fixture.store.incident == nil)
        #expect(fixture.diagnostics.codes.last == .storageFailed)
        #expect(fixture.diagnostics.codes.count(where: { $0 == .storageFailed }) == 1)
        #expect(fixture.diagnostics.values.allSatisfy { !$0.description.contains("/") })
    }

    @Test("explicit stop marks an in-flight incident recovered and cancels future capture")
    func teardownRecoversAndStops() throws {
        let fixture = try WatchdogFixture()
        fixture.controller.start(active: true)
        fixture.clock.now = 2.1
        fixture.controller.poll()
        #expect(fixture.store.incident?.state == .ongoing)

        fixture.clock.now = 3.2
        fixture.controller.stop()
        fixture.clock.now = 10
        fixture.controller.poll()

        #expect(fixture.store.incident?.state == .recovered)
        #expect(fixture.store.incident?.durationMs == 3200)
        #expect(fixture.store.recoveryCount == 1)
        #expect(fixture.store.writeCount == 1)
    }

    @Test("an unacknowledged incident is retained instead of overwritten")
    func pendingIncidentIsRetained() throws {
        let fixture = try WatchdogFixture()
        let pending = NativeHangIncident(
            eventID: "22222222-3333-4444-5555-666666666666",
            timestamp: "2026-07-25T11:00:00Z",
            state: .recovered,
            identity: fixture.identity,
            nativeStackFrames: fixture.frames,
        )
        fixture.store.incident = pending
        fixture.controller.start(active: true)
        fixture.clock.now = 2.1

        fixture.controller.poll()
        fixture.controller.poll()

        #expect(fixture.store.incident == pending)
        #expect(fixture.store.writeCount == 0)
        #expect(fixture.diagnostics.codes == [.pendingRetained])

        fixture.mainPinger.respond()
        fixture.clock.now = 3
        fixture.controller.poll()
        fixture.clock.now = 5.1
        fixture.controller.poll()
        #expect(fixture.store.incident == pending)
        #expect(try fixture.store.incident?.digest() == pending.digest())
        fixture.controller.stop()

        let restartPinger = FakeMainPinger()
        let restartDiagnostics = FakeHangDiagnostics()
        let restarted = HangWatchdogController(
            threshold: 2,
            identity: fixture.identity,
            store: fixture.store,
            stackCapture: fixture.stack,
            safetyPolicy: fixture.safety,
            clock: fixture.clock,
            mainPinger: restartPinger,
            diagnosticDelivery: restartDiagnostics,
        )
        restarted.start(active: true)
        fixture.clock.now = 7.2
        restarted.poll()

        #expect(fixture.store.incident == pending)
        #expect(try fixture.store.incident?.digest() == pending.digest())
        #expect(restartDiagnostics.codes == [.pendingRetained])
    }

    @Test("post-rename sync ambiguity retains the first durable ID and recovers it")
    func ambiguousWriteKeepsDurableRecord() throws {
        let fixture = try WatchdogFixture()
        fixture.store.writeErrorAfterPersisting = NativeCrashError(.storageUnsupported)
        fixture.controller.start(active: true)
        fixture.clock.now = 2.1

        fixture.controller.poll()
        fixture.controller.poll()

        let durable = try #require(fixture.store.incident)
        let firstDigest = try durable.digest()
        #expect(durable.state == .ongoing)
        #expect(fixture.store.writeCount == 1)
        #expect(fixture.diagnostics.codes == [.storageFailed])

        fixture.mainPinger.respond()
        let recovered = try #require(fixture.store.incident)
        #expect(recovered.eventID == durable.eventID)
        #expect(recovered.state == .recovered)
        #expect(recovered.artifactIdentity == durable.artifactIdentity)
        #expect(recovered.nativeStackFrames == durable.nativeStackFrames)
        #expect(try recovered.digest() != firstDigest)

        fixture.store.writeErrorAfterPersisting = nil
        fixture.clock.now = 3
        fixture.controller.poll()
        fixture.clock.now = 5.1
        fixture.controller.poll()

        #expect(fixture.store.incident == recovered)
        #expect(fixture.store.writeCount == 1)
        #expect(fixture.diagnostics.codes.last == .pendingRetained)
    }
}

private final class WatchdogFixture {
    let identity: NativeArtifactIdentity
    let frames: [NativeStackFrame]
    let clock = FakeHangClock()
    let safety = FakeHangSafetyPolicy()
    let stack: FakeHangStackCapture
    let store = FakeHangIncidentStore()
    let mainPinger = FakeMainPinger()
    let diagnostics = FakeHangDiagnostics()
    let controller: HangWatchdogController

    init() throws {
        identity = try NativeArtifactIdentity(
            projectId: "550e8400-e29b-41d4-a716-446655440000",
            release: "com.example.app@1.2.3+45",
            environment: "production",
            service: "ios-app",
        )
        frames = [
            NativeStackFrame(
                imageUuid: "11111111-2222-3333-4444-555555555555",
                architecture: .arm64,
                instructionOffset: "0000000000000020",
            ),
        ]
        stack = FakeHangStackCapture(frames: frames)
        controller = HangWatchdogController(
            threshold: 2,
            identity: identity,
            store: store,
            stackCapture: stack,
            safetyPolicy: safety,
            clock: clock,
            mainPinger: mainPinger,
            diagnosticDelivery: diagnostics,
        )
    }
}

private final class FakeHangClock: HangWatchdogClock, @unchecked Sendable {
    var now: TimeInterval = 0

    func monotonicNow() -> TimeInterval {
        now
    }

    func timestamp() -> String {
        "2026-07-25T12:00:00Z"
    }
}

private final class FakeHangSafetyPolicy: HangSafetyChecking, @unchecked Sendable {
    var debuggerAttached = false
    var thermalRestricted = false

    func isDebuggerAttached() -> Bool {
        debuggerAttached
    }

    func isThermallyRestricted() -> Bool {
        thermalRestricted
    }
}

private final class FakeHangStackCapture: MainThreadStackCapturing, @unchecked Sendable {
    var frames: [NativeStackFrame]

    init(frames: [NativeStackFrame]) {
        self.frames = frames
    }

    func capture() -> [NativeStackFrame] {
        frames
    }
}

private final class FakeHangIncidentStore: HangIncidentStoring, @unchecked Sendable {
    var incident: NativeHangIncident?
    var writeError: (any Error)?
    var writeErrorAfterPersisting: (any Error)?
    var writeCount = 0
    var recoveryCount = 0

    func read() throws -> NativeHangIncident? {
        incident
    }

    func write(_ incident: NativeHangIncident) throws {
        if let writeError {
            throw writeError
        }
        guard self.incident == nil else {
            throw NativeCrashError(.reportChanged)
        }
        self.incident = incident
        writeCount += 1
        if let writeErrorAfterPersisting {
            throw writeErrorAfterPersisting
        }
    }

    func markRecovered(eventID: String, durationMs: Double) throws {
        guard var incident, incident.eventID == eventID else {
            throw NativeCrashError(.reportChanged)
        }
        incident.state = .recovered
        incident.durationMs = durationMs
        self.incident = incident
        recoveryCount += 1
    }

    func delete(eventID: String) throws {
        guard incident?.eventID == eventID else {
            throw NativeCrashError(.reportChanged)
        }
        incident = nil
    }

    func purge() throws {
        incident = nil
    }
}

private final class FakeMainPinger: MainThreadPinging, @unchecked Sendable {
    private var handlers: [@Sendable () -> Void] = []
    var pendingCount: Int {
        handlers.count
    }

    func ping(_ response: @escaping @Sendable () -> Void) {
        handlers.append(response)
    }

    func respond() {
        let response = handlers.removeFirst()
        response()
    }
}

private final class FakeHangDiagnostics: HangDiagnosticDelivering, @unchecked Sendable {
    var values: [NativeHangDiagnostic] = []
    var codes: [NativeHangDiagnosticCode] {
        values.map(\.code)
    }

    func enqueue(_ value: NativeHangDiagnostic) {
        values.append(value)
    }
}
