import Foundation
@preconcurrency import KSCrashRecording

enum CrashMonitor: Equatable, Hashable {
    case machException
    case signal
    case cppException
    case objectiveCException
}

struct CrashEngineConfiguration: Equatable {
    let storageDirectory: URL
    let maxStoredReports: Int
    let monitors: Set<CrashMonitor>
    let includesMemory: Bool
    let includesQueueNames: Bool
    let includesConsoleLog: Bool
    let includesUserContext: Bool
    let deletionIsExplicit: Bool
}

protocol CrashEngineDriving: AnyObject {
    func install(configuration: CrashEngineConfiguration) throws -> any CrashReportStoring
}

protocol CrashReportStoring: AnyObject {
    var reportIDs: [Int64] { get }
    func report(for id: Int64) -> [String: Any]?
    func deleteReport(with id: Int64)
    func deleteAllReports()
}

final class ProcessCrashCaptureOwnership: @unchecked Sendable {
    static let shared = ProcessCrashCaptureOwnership()

    private let lock = NSLock()
    private weak var owner: AnyObject?
    private var claimed = false

    func claim(_ candidate: AnyObject) throws {
        lock.lock()
        defer { lock.unlock() }
        if let owner {
            guard owner === candidate else {
                throw NativeCrashError(.ownershipConflict)
            }
            return
        }
        guard !claimed else {
            throw NativeCrashError(.ownershipConflict)
        }
        owner = candidate
        claimed = true
    }
}

final class KSCrashEngineDriver: CrashEngineDriving {
    func install(configuration: CrashEngineConfiguration) throws -> any CrashReportStoring {
        let storeConfiguration = CrashReportStoreConfiguration()
        storeConfiguration.appName = "logbrew-native-crash"
        storeConfiguration.maxReportCount = configuration.maxStoredReports
        storeConfiguration.reportCleanupPolicy = configuration.deletionIsExplicit ? .never : .always

        let engineConfiguration = KSCrashConfiguration()
        engineConfiguration.installPath = configuration.storageDirectory.path
        engineConfiguration.reportStoreConfiguration = storeConfiguration
        var monitors: MonitorType = []
        if configuration.monitors.contains(.machException) {
            monitors.insert(.machException)
        }
        if configuration.monitors.contains(.signal) {
            monitors.insert(.signal)
        }
        if configuration.monitors.contains(.cppException) {
            monitors.insert(.cppException)
        }
        if configuration.monitors.contains(.objectiveCException) {
            monitors.insert(.nsException)
        }
        engineConfiguration.monitors = monitors
        engineConfiguration.userInfoJSON = configuration.includesUserContext ? [:] : nil
        engineConfiguration.deadlockWatchdogInterval = 0
        engineConfiguration.enableQueueNameSearch = configuration.includesQueueNames
        engineConfiguration.enableMemoryIntrospection = configuration.includesMemory
        engineConfiguration.addConsoleLogToReport = configuration.includesConsoleLog
        engineConfiguration.printPreviousLogOnStartup = false
        engineConfiguration.enableSigTermMonitoring = false

        do {
            try KSCrash.shared.install(with: engineConfiguration)
        } catch {
            throw NativeCrashError(.engineInstallFailed)
        }
        guard let reportStore = KSCrash.shared.reportStore else {
            throw NativeCrashError(.engineInstallFailed)
        }
        return KSCrashReportStoreAdapter(store: reportStore)
    }
}

private final class KSCrashReportStoreAdapter: CrashReportStoring {
    private let store: CrashReportStore

    init(store: CrashReportStore) {
        self.store = store
    }

    var reportIDs: [Int64] {
        store.reportIDs.map(\.int64Value)
    }

    func report(for id: Int64) -> [String: Any]? {
        store.report(for: id)?.value
    }

    func deleteReport(with id: Int64) {
        store.deleteReport(with: id)
    }

    func deleteAllReports() {
        store.deleteAllReports()
    }
}
