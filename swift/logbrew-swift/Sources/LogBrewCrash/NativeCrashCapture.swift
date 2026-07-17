import Darwin
import Foundation

@objc(LBWNativeCrashCapture)
@objcMembers
public final class NativeCrashCapture: NSObject, @unchecked Sendable {
    private let configuration: NativeCrashConfiguration
    private let driver: any CrashEngineDriving
    private let ownership: ProcessCrashCaptureOwnership
    private let processIDProvider: @Sendable () -> Int32
    private let ownerProcessID: Int32
    private let ownerNonce = UUID()
    private let lock = NSLock()

    private var store: (any CrashReportStoring)?
    private var storageLease: CrashStorageLease?
    private var lifecycle: NativeCrashLifecycleState = .idle
    private var lastOutcome: NativeCrashOutcome = .none
    private var acknowledged = 0
    private var replaying = false

    public init(configuration: NativeCrashConfiguration) {
        let processIDProvider: @Sendable () -> Int32 = { getpid() }
        self.configuration = configuration
        driver = KSCrashEngineDriver()
        ownership = .shared
        self.processIDProvider = processIDProvider
        ownerProcessID = processIDProvider()
        super.init()
    }

    init(
        configuration: NativeCrashConfiguration,
        driver: any CrashEngineDriving,
        ownership: ProcessCrashCaptureOwnership,
        processIDProvider: @escaping @Sendable () -> Int32 = { getpid() },
    ) {
        self.configuration = configuration
        self.driver = driver
        self.ownership = ownership
        self.processIDProvider = processIDProvider
        ownerProcessID = processIDProvider()
        super.init()
    }

    public func install() throws {
        lock.lock()
        defer { lock.unlock() }
        try verifyProcessLocked()

        if store != nil {
            try verifyStorageLocked()
            return
        }
        if lifecycle == .failed {
            throw NativeCrashError(.engineInstallFailed)
        }

        do {
            let storageLease = try CrashStorageDirectory.prepare(configuration.storageDirectory)
            try ownership.claim(self)
            try storageLease.verify()
            self.storageLease = storageLease
            let installedStore = try driver.install(
                configuration: CrashEngineConfiguration(
                    storageDirectory: configuration.storageDirectory,
                    maxStoredReports: configuration.maxStoredReports,
                    monitors: [.machException, .signal, .cppException, .objectiveCException],
                    includesMemory: false,
                    includesQueueNames: false,
                    includesConsoleLog: false,
                    includesUserContext: false,
                    deletionIsExplicit: true,
                ),
            )
            try storageLease.verify()
            store = installedStore
            lifecycle = .installed
        } catch let error as NativeCrashError {
            lifecycle = .failed
            lastOutcome = .failed
            throw error
        } catch {
            lifecycle = .failed
            lastOutcome = .failed
            throw NativeCrashError(.engineInstallFailed)
        }
    }

    public func pendingReports() throws -> [NativeCrashRecord] {
        lock.lock()
        defer { lock.unlock() }
        try verifyProcessLocked()
        return try pendingReportsLocked()
    }

    @objc(replayPendingReportsWithHandler:error:)
    public func replayPendingReports(
        _ handler: (NativeCrashRecord) -> Bool,
    ) throws -> NativeCrashReplayResult {
        lock.lock()
        do {
            try verifyProcessLocked()
        } catch {
            lock.unlock()
            throw error
        }
        guard store != nil else {
            lock.unlock()
            throw NativeCrashError(.notInstalled)
        }
        guard !replaying else {
            lock.unlock()
            throw NativeCrashError(.replayBusy)
        }
        replaying = true
        lifecycle = .replaying
        lock.unlock()

        var attempted = 0
        var accepted = 0
        do {
            while let record = try nextPendingReport() {
                attempted += 1
                guard handler(record) else {
                    lock.lock()
                    lastOutcome = .retained
                    lock.unlock()
                    break
                }
                try acknowledge(record)
                accepted += 1
            }

            let pending = try finishReplay()
            return NativeCrashReplayResult(attempted: attempted, acknowledged: accepted, pending: pending)
        } catch {
            failReplay()
            throw error
        }
    }

    public func purge() throws {
        lock.lock()
        defer { lock.unlock() }
        try verifyProcessLocked()
        guard let store else {
            throw NativeCrashError(.notInstalled)
        }
        try verifyStorageLocked()
        guard !replaying else {
            throw NativeCrashError(.replayBusy)
        }

        store.deleteAllReports()
        guard store.reportIDs.isEmpty else {
            lastOutcome = .failed
            throw NativeCrashError(.reportDeletionFailed)
        }
        lastOutcome = .purged
    }

    public func status() throws -> NativeCrashStatus {
        lock.lock()
        defer { lock.unlock() }
        try verifyProcessLocked()
        let pending = store == nil ? 0 : try pendingCountLocked()
        return NativeCrashStatus(
            lifecycle: lifecycle,
            pending: pending,
            acknowledged: acknowledged,
            lastOutcome: lastOutcome,
        )
    }
}

private extension NativeCrashCapture {
    func finishReplay() throws -> Int {
        lock.lock()
        defer { lock.unlock() }
        let pending = try pendingCountLocked()
        replaying = false
        lifecycle = .installed
        return pending
    }

    func failReplay() {
        lock.lock()
        replaying = false
        lifecycle = .installed
        lastOutcome = .failed
        lock.unlock()
    }

    func nextPendingReport() throws -> NativeCrashRecord? {
        lock.lock()
        defer { lock.unlock() }
        return try pendingReportsLocked().first
    }

    func acknowledge(_ record: NativeCrashRecord) throws {
        lock.lock()
        defer { lock.unlock() }
        guard record.ownerNonce == ownerNonce, let store else {
            throw NativeCrashError(.reportChanged)
        }
        try verifyStorageLocked()
        guard store.reportIDs.contains(record.reportID),
              let rawReport = store.report(for: record.reportID),
              try sanitizer.digest(rawReport) == record.digest
        else {
            throw NativeCrashError(.reportChanged)
        }

        store.deleteReport(with: record.reportID)
        guard !store.reportIDs.contains(record.reportID) else {
            throw NativeCrashError(.reportDeletionFailed)
        }
        acknowledged += 1
        lastOutcome = .acknowledged
    }

    func pendingReportsLocked() throws -> [NativeCrashRecord] {
        guard let store else {
            throw NativeCrashError(.notInstalled)
        }
        try verifyStorageLocked()
        let ids = store.reportIDs.sorted()
        guard ids.count <= configuration.maxStoredReports,
              Set(ids).count == ids.count,
              ids.allSatisfy({ $0 > 0 })
        else {
            throw NativeCrashError(.reportCorrupt)
        }

        let records = try ids.map { id in
            guard let rawReport = store.report(for: id) else {
                throw NativeCrashError(.reportChanged)
            }
            return try sanitizer.makeRecord(reportID: id, rawReport: rawReport)
        }
        guard store.reportIDs.sorted() == ids else {
            throw NativeCrashError(.reportChanged)
        }
        return records
    }

    func pendingCountLocked() throws -> Int {
        guard let store else {
            throw NativeCrashError(.notInstalled)
        }
        try verifyStorageLocked()
        let ids = store.reportIDs
        guard ids.count <= configuration.maxStoredReports,
              Set(ids).count == ids.count,
              ids.allSatisfy({ $0 > 0 })
        else {
            throw NativeCrashError(.reportCorrupt)
        }
        return ids.count
    }

    var sanitizer: CrashReportSanitizer {
        CrashReportSanitizer(
            maxReplayBytes: configuration.maxReplayBytes,
            ownerNonce: ownerNonce,
        )
    }

    func verifyStorageLocked() throws {
        guard let storageLease else {
            throw NativeCrashError(.notInstalled)
        }
        try storageLease.verify()
    }

    func verifyProcessLocked() throws {
        guard processIDProvider() == ownerProcessID else {
            throw NativeCrashError(.processChanged)
        }
    }
}
