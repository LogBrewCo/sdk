import Darwin
import Foundation

#if canImport(UIKit)
    import UIKit
#endif

final class DispatchHangTimer: HangTimerControlling, @unchecked Sendable {
    private let source: DispatchSourceTimer

    init(interval: TimeInterval, controller: any HangWatchdogControlling) {
        source = DispatchSource.makeTimerSource(
            queue: DispatchQueue(label: "co.logbrew.native-hang-watchdog", qos: .utility),
        )
        source.schedule(
            deadline: .now() + interval,
            repeating: interval,
            leeway: .milliseconds(20),
        )
        source.setEventHandler { [weak controller] in
            controller?.poll()
        }
    }

    func activate() {
        source.activate()
    }

    func cancel() {
        source.cancel()
    }
}

final class SystemHangWatchdogClock: HangWatchdogClock, @unchecked Sendable {
    func monotonicNow() -> TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: Date())
    }
}

final class DispatchMainThreadPinger: MainThreadPinging, @unchecked Sendable {
    func ping(_ response: @escaping @Sendable () -> Void) {
        DispatchQueue.main.async(execute: response)
    }
}

final class NativeHangSafetyPolicy: HangSafetyChecking, @unchecked Sendable {
    func isDebuggerAttached() -> Bool {
        var information = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, u_int(mib.count), &information, &size, nil, 0) == 0 else {
            return true
        }
        return information.kp_proc.p_flag & P_TRACED != 0
    }

    func isThermallyRestricted() -> Bool {
        switch ProcessInfo.processInfo.thermalState {
        case .serious, .critical:
            true
        default:
            false
        }
    }
}

final class NativeHangLifecycleObserver: HangLifecycleObserving, @unchecked Sendable {
    var onActiveChange: (@Sendable (Bool) -> Void)?
    private let lock = NSLock()
    private var observers: [NSObjectProtocol] = []
    private var active = false

    var isActive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return active
    }

    init() throws {
        #if !canImport(UIKit)
            throw NativeCrashError(.invalidConfiguration)
        #else
            active = MainActor.assumeIsolated {
                UIApplication.shared.applicationState == .active
            }
        #endif
    }

    func start() {
        #if canImport(UIKit)
            let center = NotificationCenter.default
            observers = [
                center.addObserver(
                    forName: UIApplication.didBecomeActiveNotification,
                    object: nil,
                    queue: .main,
                ) { [weak self] _ in
                    self?.updateActive(true)
                },
                center.addObserver(
                    forName: UIApplication.willResignActiveNotification,
                    object: nil,
                    queue: .main,
                ) { [weak self] _ in
                    self?.updateActive(false)
                },
                center.addObserver(
                    forName: UIApplication.didEnterBackgroundNotification,
                    object: nil,
                    queue: .main,
                ) { [weak self] _ in
                    self?.updateActive(false)
                },
            ]
        #endif
    }

    func stop() {
        let center = NotificationCenter.default
        observers.forEach(center.removeObserver)
        observers.removeAll()
    }

    private func updateActive(_ active: Bool) {
        lock.lock()
        self.active = active
        let handler = onActiveChange
        lock.unlock()
        handler?(active)
    }
}
