import Foundation
@testable import LogBrewCrash
import Testing

func makeCapture(
    driver: FakeCrashEngineDriver,
    ownership: ProcessCrashCaptureOwnership = ProcessCrashCaptureOwnership(),
) throws -> NativeCrashCapture {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let configuration = try NativeCrashConfiguration(storageDirectory: directory)
    return NativeCrashCapture(
        configuration: configuration,
        driver: driver,
        ownership: ownership,
    )
}

func makeRecord() throws -> NativeCrashRecord {
    let store = FakeCrashReportStore(reports: [1: sampleRawReport()])
    let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
    try capture.install()
    return try #require(capture.pendingReports().first)
}

func sampleRawReport() -> [String: Any] {
    rawReport(
        id: "8F12B746-0C79-4CC6-A077-98ED62F094B2",
        timestamp: "2026-07-17T09:10:11Z",
        mechanism: "signal",
        privateMarker: "sensitive-value",
    )
}

func rawReport(
    id: String,
    timestamp: String,
    mechanism: String,
    privateMarker: String,
) -> [String: Any] {
    [
        "report": ["id": id, "timestamp": timestamp],
        "crash": [
            "error": ["type": mechanism, "reason": privateMarker],
            "threads": [["name": privateMarker, "backtrace": ["contents": []]]],
        ],
        "system": ["process_name": privateMarker, "executable_path": "/private/\(privateMarker)"],
        "user": ["opaque_value": privateMarker],
    ]
}

final class FakeCrashEngineDriver: CrashEngineDriving {
    let store: FakeCrashReportStore
    var onInstall: ((CrashEngineConfiguration) throws -> Void)?
    private(set) var configurations: [CrashEngineConfiguration] = []

    init(store: FakeCrashReportStore) {
        self.store = store
    }

    func install(configuration: CrashEngineConfiguration) throws -> any CrashReportStoring {
        configurations.append(configuration)
        try onInstall?(configuration)
        return store
    }
}

final class FakeCrashReportStore: CrashReportStoring {
    var reports: [Int64: [String: Any]]
    var ignoresDeleteAll = false
    var ignoresDeleteReport = false
    private(set) var deletedIDs: [Int64] = []

    init(reports: [Int64: [String: Any]] = [:]) {
        self.reports = reports
    }

    var reportIDs: [Int64] {
        reports.keys.sorted()
    }

    func report(for id: Int64) -> [String: Any]? {
        reports[id]
    }

    func deleteReport(with id: Int64) {
        deletedIDs.append(id)
        if !ignoresDeleteReport {
            reports.removeValue(forKey: id)
        }
    }

    func deleteAllReports() {
        guard !ignoresDeleteAll else {
            return
        }
        deletedIDs.append(contentsOf: reportIDs)
        reports.removeAll()
    }
}

final class ThreadResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storedError: (any Error)?

    var error: (any Error)? {
        lock.lock()
        defer { lock.unlock() }
        return storedError
    }

    func set(_ error: any Error) {
        lock.lock()
        storedError = error
        lock.unlock()
    }
}

final class ProcessIDBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storedValue: Int32

    init(_ value: Int32) {
        storedValue = value
    }

    var value: Int32 {
        get {
            lock.lock()
            defer { lock.unlock() }
            return storedValue
        }
        set {
            lock.lock()
            storedValue = newValue
            lock.unlock()
        }
    }
}
