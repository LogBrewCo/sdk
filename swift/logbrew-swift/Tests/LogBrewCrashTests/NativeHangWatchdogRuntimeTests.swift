import Foundation
@testable import LogBrewCrash
import Testing

@Suite("Apple native hang watchdog runtime")
struct NativeHangWatchdogRuntimeTests {
    @Test("never-started teardown activates before cancel exactly once")
    func neverStartedTeardownIsSafe() {
        let fixture = RuntimeFixture()
        var runtime: NativeHangWatchdogRuntime? = fixture.makeRuntime()

        runtime?.stop()
        runtime?.stop()
        runtime = nil

        #expect(fixture.timer.activations == 1)
        #expect(fixture.timer.cancellations == 1)
        #expect(fixture.controller.stops == 1)
        #expect(fixture.lifecycle.stops == 1)
    }

    @Test("start and repeated teardown own one active timer lifecycle")
    func startedTeardownIsIdempotent() {
        let fixture = RuntimeFixture(active: true)
        var runtime: NativeHangWatchdogRuntime? = fixture.makeRuntime()

        runtime?.start()
        runtime?.start()
        runtime?.stop()
        runtime?.stop()
        runtime = nil

        #expect(fixture.timer.activations == 1)
        #expect(fixture.timer.cancellations == 1)
        #expect(fixture.controller.starts == [true])
        #expect(fixture.controller.stops == 1)
        #expect(fixture.lifecycle.starts == 1)
        #expect(fixture.lifecycle.stops == 1)
    }

    @Test("ordered callback may synchronously stop runtime and enqueue another diagnostic")
    func callbackReentryDoesNotDeadlockAndPreservesOrder() {
        let fixture = RuntimeFixture(active: true)
        let delivered = LockedDiagnosticCodes()
        let completed = DispatchSemaphore(value: 0)
        let runtimeReference = RuntimeReferenceBox()
        let delivery = OrderedHangDiagnosticDelivery { diagnostic in
            delivered.append(diagnostic.code)
            if diagnostic.code == .captured {
                runtimeReference.value?.stop()
            } else if diagnostic.code == .recovered {
                completed.signal()
            }
        }
        fixture.controller.onStop = {
            delivery.enqueue(NativeHangDiagnostic(.recovered))
        }
        var runtime: NativeHangWatchdogRuntime? = fixture.makeRuntime()
        runtimeReference.value = runtime
        runtime?.start()

        delivery.enqueue(NativeHangDiagnostic(.captured))

        #expect(completed.wait(timeout: .now() + 2) == .success)
        #expect(delivered.values == [.captured, .recovered])
        #expect(fixture.controller.stops == 1)
        runtime = nil
        runtimeReference.value = nil
    }
}

private struct RuntimeFixture {
    let controller = FakeHangWatchdogController()
    let timer = FakeHangTimer()
    let lifecycle: FakeHangLifecycle

    init(active: Bool = false) {
        lifecycle = FakeHangLifecycle(active: active)
    }

    func makeRuntime() -> NativeHangWatchdogRuntime {
        NativeHangWatchdogRuntime(
            controller: controller,
            timer: timer,
            lifecycle: lifecycle,
        )
    }
}

private final class FakeHangWatchdogController: HangWatchdogControlling, @unchecked Sendable {
    var starts: [Bool] = []
    var stops = 0
    var polls = 0
    var activeChanges: [Bool] = []
    var onStop: (@Sendable () -> Void)?

    func start(active: Bool) {
        starts.append(active)
    }

    func setActive(_ active: Bool) {
        activeChanges.append(active)
    }

    func poll() {
        polls += 1
    }

    func stop() {
        stops += 1
        onStop?()
    }
}

private final class FakeHangTimer: HangTimerControlling, @unchecked Sendable {
    var activations = 0
    var cancellations = 0

    func activate() {
        activations += 1
    }

    func cancel() {
        cancellations += 1
    }
}

private final class FakeHangLifecycle: HangLifecycleObserving, @unchecked Sendable {
    var onActiveChange: (@Sendable (Bool) -> Void)?
    let isActive: Bool
    var starts = 0
    var stops = 0

    init(active: Bool) {
        isActive = active
    }

    func start() {
        starts += 1
    }

    func stop() {
        stops += 1
    }
}

private final class LockedDiagnosticCodes: @unchecked Sendable {
    private let lock = NSLock()
    private var codes: [NativeHangDiagnosticCode] = []

    var values: [NativeHangDiagnosticCode] {
        lock.lock()
        defer { lock.unlock() }
        return codes
    }

    func append(_ code: NativeHangDiagnosticCode) {
        lock.lock()
        codes.append(code)
        lock.unlock()
    }
}

private final class RuntimeReferenceBox: @unchecked Sendable {
    private let lock = NSLock()
    private var runtime: NativeHangWatchdogRuntime?

    var value: NativeHangWatchdogRuntime? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return runtime
        }
        set {
            lock.lock()
            runtime = newValue
            lock.unlock()
        }
    }
}
