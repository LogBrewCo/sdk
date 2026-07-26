import Foundation
@_spi(CrashReplay) import LogBrew

final class OrderedHangDiagnosticDelivery: HangDiagnosticDelivering, @unchecked Sendable {
    private let queue = DispatchQueue(label: "co.logbrew.native-hang-diagnostics")
    private let handler: @Sendable (NativeHangDiagnostic) -> Void

    init(_ handler: @escaping @Sendable (NativeHangDiagnostic) -> Void) {
        self.handler = handler
    }

    func enqueue(_ diagnostic: NativeHangDiagnostic) {
        queue.async { [handler] in
            handler(diagnostic)
        }
    }
}

final class HangWatchdogController: @unchecked Sendable {
    private let threshold: TimeInterval
    private let identity: NativeArtifactIdentity
    private let store: any HangIncidentStoring
    private let stackCapture: any MainThreadStackCapturing
    private let safetyPolicy: any HangSafetyChecking
    private let clock: any HangWatchdogClock
    private let mainPinger: any MainThreadPinging
    private let diagnosticDelivery: any HangDiagnosticDelivering
    private let lock = NSLock()

    private var active = false
    private var running = false
    private var heartbeat: HangHeartbeatState = .idle

    init(
        threshold: TimeInterval,
        identity: NativeArtifactIdentity,
        store: any HangIncidentStoring,
        stackCapture: any MainThreadStackCapturing,
        safetyPolicy: any HangSafetyChecking,
        clock: any HangWatchdogClock,
        mainPinger: any MainThreadPinging,
        diagnosticDelivery: any HangDiagnosticDelivering,
    ) {
        self.threshold = threshold
        self.identity = identity
        self.store = store
        self.stackCapture = stackCapture
        self.safetyPolicy = safetyPolicy
        self.clock = clock
        self.mainPinger = mainPinger
        self.diagnosticDelivery = diagnosticDelivery
    }

    func start(active: Bool) {
        lock.lock()
        guard !running else {
            lock.unlock()
            return
        }
        running = true
        self.active = active
        heartbeat = .idle
        let shouldPing = active
        lock.unlock()
        if shouldPing {
            beginHeartbeat()
        }
    }

    func setActive(_ active: Bool) {
        if !active {
            lock.lock()
            guard running else {
                lock.unlock()
                return
            }
            self.active = false
            let captured = heartbeat.captured
            heartbeat = .idle
            lock.unlock()
            markRecovered(captured)
            return
        }

        lock.lock()
        guard running else {
            lock.unlock()
            return
        }
        self.active = active
        let shouldPing = heartbeat == .idle
        lock.unlock()
        if shouldPing {
            beginHeartbeat()
        }
    }

    func poll() {
        guard let sentAt = waitingHeartbeatForPoll() else {
            return
        }
        let elapsed = clock.monotonicNow() - sentAt
        guard elapsed >= threshold else {
            return
        }
        if let suppression = suppressionCode(elapsed: elapsed) {
            suppress(suppression, sentAt: sentAt)
            return
        }
        guard let durationMs = NativeHangDuration.milliseconds(
            from: sentAt,
            through: sentAt + elapsed,
        ) else {
            suppress(.storageFailed, sentAt: sentAt)
            return
        }

        let frames = stackCapture.capture()
        guard !frames.isEmpty else {
            suppress(.stackUnavailable, sentAt: sentAt)
            return
        }
        captureIncident(
            frames: frames,
            sentAt: sentAt,
            durationMs: durationMs,
        )
    }

    func stop() {
        lock.lock()
        let captured = heartbeat.captured
        running = false
        active = false
        heartbeat = .idle
        lock.unlock()
        markRecovered(captured)
    }

    private func suppressionCode(elapsed: TimeInterval) -> NativeHangDiagnosticCode? {
        if elapsed > threshold * 1.5 {
            return .skippedSchedulerStall
        }
        if safetyPolicy.isDebuggerAttached() {
            return .skippedDebugger
        }
        if safetyPolicy.isThermallyRestricted() {
            return .skippedThermal
        }
        do {
            guard try store.read() == nil else {
                return .pendingRetained
            }
        } catch {
            return .storageFailed
        }
        return nil
    }

    private func waitingHeartbeatForPoll() -> TimeInterval? {
        lock.lock()
        guard running, active else {
            lock.unlock()
            return nil
        }
        guard case let .waiting(sentAt) = heartbeat else {
            let shouldBegin = heartbeat == .idle
            lock.unlock()
            if shouldBegin {
                beginHeartbeat()
            }
            return nil
        }
        lock.unlock()
        return sentAt
    }

    private func captureIncident(
        frames: [NativeStackFrame],
        sentAt: TimeInterval,
        durationMs: Double,
    ) {
        let eventID = UUID().uuidString.lowercased()
        let incident = NativeHangIncident(
            eventID: eventID,
            timestamp: clock.timestamp(),
            state: .ongoing,
            identity: identity,
            nativeStackFrames: frames,
            durationMs: durationMs,
        )
        do {
            lock.lock()
            guard running, active, heartbeat == .waiting(sentAt: sentAt) else {
                lock.unlock()
                return
            }
            try store.write(incident)
            heartbeat = .captured(eventID: eventID, sentAt: sentAt)
            diagnosticDelivery.enqueue(NativeHangDiagnostic(.captured))
            lock.unlock()
        } catch {
            let persisted = try? store.read()
            heartbeat = persisted == incident
                ? .captured(eventID: eventID, sentAt: sentAt)
                : .suppressed
            diagnosticDelivery.enqueue(NativeHangDiagnostic(.storageFailed))
            lock.unlock()
        }
    }

    private func beginHeartbeat() {
        let sentAt = clock.monotonicNow()
        lock.lock()
        guard running, active, heartbeat == .idle else {
            lock.unlock()
            return
        }
        heartbeat = .waiting(sentAt: sentAt)
        lock.unlock()
        mainPinger.ping { [weak self] in
            self?.mainDidRespond()
        }
    }

    private func mainDidRespond() {
        lock.lock()
        let captured = heartbeat.captured
        heartbeat = .idle
        lock.unlock()
        markRecovered(captured)
    }

    private func markRecovered(
        _ captured: (eventID: String, sentAt: TimeInterval)?,
    ) {
        guard let captured else {
            return
        }
        guard let durationMs = NativeHangDuration.milliseconds(
            from: captured.sentAt,
            through: clock.monotonicNow(),
        ) else {
            emit(.storageFailed)
            return
        }
        do {
            try store.markRecovered(
                eventID: captured.eventID,
                durationMs: durationMs,
            )
            emit(.recovered)
        } catch {
            emit(.storageFailed)
        }
    }

    private func suppress(_ code: NativeHangDiagnosticCode, sentAt: TimeInterval) {
        lock.lock()
        guard heartbeat == .waiting(sentAt: sentAt) else {
            lock.unlock()
            return
        }
        heartbeat = .suppressed
        diagnosticDelivery.enqueue(NativeHangDiagnostic(code))
        lock.unlock()
    }

    private func emit(_ code: NativeHangDiagnosticCode) {
        diagnosticDelivery.enqueue(NativeHangDiagnostic(code))
    }
}

extension HangWatchdogController: HangWatchdogControlling {}

private enum HangHeartbeatState: Equatable {
    case idle
    case waiting(sentAt: TimeInterval)
    case captured(eventID: String, sentAt: TimeInterval)
    case suppressed

    var captured: (eventID: String, sentAt: TimeInterval)? {
        guard case let .captured(eventID, sentAt) = self else {
            return nil
        }
        return (eventID, sentAt)
    }
}

private enum HangTimerLifecycleState {
    case prepared
    case active
    case stopped
}

final class NativeHangWatchdogRuntime: @unchecked Sendable {
    private let controller: any HangWatchdogControlling
    private let timer: any HangTimerControlling
    private let lifecycle: any HangLifecycleObserving
    private let lock = NSLock()
    private var timerState: HangTimerLifecycleState = .prepared

    init(
        configuration: NativeHangWatchdogConfiguration,
        identity: NativeArtifactIdentity,
        store: any HangIncidentStoring,
    ) throws {
        guard Thread.isMainThread else {
            throw NativeCrashError(.invalidConfiguration)
        }
        let stackCapture = try NativeMainThreadStackCapture()
        let lifecycle = try NativeHangLifecycleObserver()
        let diagnosticDelivery = OrderedHangDiagnosticDelivery(
            configuration.diagnosticsHandler ?? { _ in },
        )
        let controller = HangWatchdogController(
            threshold: configuration.threshold,
            identity: identity,
            store: store,
            stackCapture: stackCapture,
            safetyPolicy: NativeHangSafetyPolicy(),
            clock: SystemHangWatchdogClock(),
            mainPinger: DispatchMainThreadPinger(),
            diagnosticDelivery: diagnosticDelivery,
        )
        let timer = DispatchHangTimer(
            interval: configuration.threshold / 5,
            controller: controller,
        )
        self.controller = controller
        self.timer = timer
        self.lifecycle = lifecycle
        lifecycle.onActiveChange = { [weak controller] active in
            controller?.setActive(active)
        }
    }

    init(
        controller: any HangWatchdogControlling,
        timer: any HangTimerControlling,
        lifecycle: any HangLifecycleObserving,
    ) {
        self.controller = controller
        self.timer = timer
        self.lifecycle = lifecycle
        lifecycle.onActiveChange = { [weak controller] active in
            controller?.setActive(active)
        }
    }

    deinit {
        stop()
    }

    func start() {
        lock.lock()
        guard timerState == .prepared else {
            lock.unlock()
            return
        }
        controller.start(active: lifecycle.isActive)
        lifecycle.start()
        timer.activate()
        timerState = .active
        lock.unlock()
    }

    func stop() {
        lock.lock()
        switch timerState {
        case .prepared:
            timer.activate()
            timer.cancel()
        case .active:
            timer.cancel()
        case .stopped:
            lock.unlock()
            return
        }
        timerState = .stopped
        lock.unlock()
        lifecycle.stop()
        controller.stop()
    }
}
