import Foundation
@testable import LogBrewCrash
import Testing

@Suite("Apple native crash capture")
struct NativeCrashCaptureTests {
    @Test("engine installation receives the fixed privacy profile")
    func engineUsesFixedPrivacyProfile() throws {
        let driver = FakeCrashEngineDriver(store: FakeCrashReportStore())
        let capture = try makeCapture(driver: driver)

        try capture.install()

        let configuration = try #require(driver.configurations.first)
        #expect(configuration.maxStoredReports == 5)
        #expect(configuration.monitors == [.machException, .signal, .cppException, .objectiveCException])
        #expect(configuration.includesMemory == false)
        #expect(configuration.includesQueueNames == false)
        #expect(configuration.includesConsoleLog == false)
        #expect(configuration.includesUserContext == false)
        #expect(configuration.deletionIsExplicit == true)
    }

    @Test("existing dedicated directories remain usable and owner-only")
    func existingStorageDirectoryIsOwnerOnly() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(
            at: directory.appendingPathComponent("Reports", isDirectory: true),
            withIntermediateDirectories: false,
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: 0o755)],
            ofItemAtPath: directory.path,
        )
        let capture = try NativeCrashCapture(
            configuration: NativeCrashConfiguration(storageDirectory: directory),
            driver: FakeCrashEngineDriver(store: FakeCrashReportStore()),
            ownership: ProcessCrashCaptureOwnership(),
        )

        try capture.install()

        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        let permissions = try #require(attributes[.posixPermissions] as? NSNumber).intValue
        #expect(permissions & 0o077 == 0)
    }

    @Test("a symlink storage target fails closed before engine installation")
    func symlinkStorageTargetFailsClosed() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let target = root.appendingPathComponent("target", isDirectory: true)
        let link = root.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let driver = FakeCrashEngineDriver(store: FakeCrashReportStore())
        let capture = try NativeCrashCapture(
            configuration: NativeCrashConfiguration(storageDirectory: link),
            driver: driver,
            ownership: ProcessCrashCaptureOwnership(),
        )

        #expect(throws: NativeCrashError.self) {
            try capture.install()
        }
        #expect(driver.configurations.isEmpty)
    }

    @Test("storage replacement during engine installation fails closed")
    func storageReplacementDuringInstallFailsClosed() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let movedDirectory = directory.appendingPathExtension("moved")
        let driver = FakeCrashEngineDriver(store: FakeCrashReportStore())
        driver.onInstall = { configuration in
            try FileManager.default.moveItem(at: configuration.storageDirectory, to: movedDirectory)
            try FileManager.default.createDirectory(
                at: configuration.storageDirectory,
                withIntermediateDirectories: false,
            )
        }
        let capture = try NativeCrashCapture(
            configuration: NativeCrashConfiguration(storageDirectory: directory),
            driver: driver,
            ownership: ProcessCrashCaptureOwnership(),
        )

        do {
            try capture.install()
            Issue.record("expected replacement during install to fail")
        } catch let error as NativeCrashError {
            #expect(error.code == .storageUnsupported)
        }
        #expect(driver.configurations.count == 1)
    }

    @Test("replay sanitizes reports and acknowledges only the accepted prefix")
    func replayAcknowledgesAcceptedPrefix() throws {
        let first = rawReport(
            id: "8F12B746-0C79-4CC6-A077-98ED62F094B2",
            timestamp: "2026-07-17T09:10:11Z",
            mechanism: "signal",
            privateMarker: "authorization=header-value-marker",
        )
        let second = rawReport(
            id: "067BDECA-8CD2-44B9-BF9C-8068BF8EB2C8",
            timestamp: "2026-07-17T09:11:12Z",
            mechanism: "nsexception",
            privateMarker: "user@example.invalid",
        )
        let store = FakeCrashReportStore(reports: [7: first, 9: second])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()

        var delivered: [NativeCrashRecord] = []
        let result = try capture.replayPendingReports { record in
            delivered.append(record)
            return delivered.count == 1
        }

        #expect(result.attempted == 2)
        #expect(result.acknowledged == 1)
        #expect(result.pending == 1)
        #expect(delivered.map(\.eventID) == [
            "8f12b746-0c79-4cc6-a077-98ed62f094b2",
            "067bdeca-8cd2-44b9-bf9c-8068bf8eb2c8",
        ])
        #expect(delivered.map(\.mechanism) == [.signal, .objectiveCException])
        #expect(store.deletedIDs == [7])
        #expect(store.reportIDs == [9])

        let publicDescription = String(describing: delivered)
        #expect(!publicDescription.contains("header-value-marker"))
        #expect(!publicDescription.contains("user@example.invalid"))
    }

    @Test("a malformed oldest report blocks replay without deleting later work")
    func malformedReportFailsClosed() throws {
        let malformed: [String: Any] = [
            "report": ["id": "not-a-uuid", "timestamp": "2026-07-17T09:10:11Z"],
            "crash": ["error": ["type": "signal"]],
        ]
        let valid = rawReport(
            id: "067BDECA-8CD2-44B9-BF9C-8068BF8EB2C8",
            timestamp: "2026-07-17T09:11:12Z",
            mechanism: "signal",
            privateMarker: "later work",
        )
        let store = FakeCrashReportStore(reports: [1: malformed, 2: valid])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()

        #expect(throws: NativeCrashError.self) {
            _ = try capture.replayPendingReports { _ in true }
        }
        #expect(store.reportIDs == [1, 2])
        #expect(store.deletedIDs.isEmpty)
    }

    @Test("report replacement before acknowledgement fails closed")
    func replacementBeforeAcknowledgementFailsClosed() throws {
        let original = rawReport(
            id: "8F12B746-0C79-4CC6-A077-98ED62F094B2",
            timestamp: "2026-07-17T09:10:11Z",
            mechanism: "signal",
            privateMarker: "original",
        )
        let replacement = rawReport(
            id: "8F12B746-0C79-4CC6-A077-98ED62F094B2",
            timestamp: "2026-07-17T09:10:11Z",
            mechanism: "mach",
            privateMarker: "replacement",
        )
        let store = FakeCrashReportStore(reports: [1: original])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()

        #expect(throws: NativeCrashError.self) {
            _ = try capture.replayPendingReports { _ in
                store.reports[1] = replacement
                return true
            }
        }
        #expect(store.reportIDs == [1])
        #expect(store.deletedIDs.isEmpty)
    }

    @Test("only one capture owner may install in a process")
    func processOwnershipIsExclusive() throws {
        let ownership = ProcessCrashCaptureOwnership()
        let first = try makeCapture(
            driver: FakeCrashEngineDriver(store: FakeCrashReportStore()),
            ownership: ownership,
        )
        let second = try makeCapture(
            driver: FakeCrashEngineDriver(store: FakeCrashReportStore()),
            ownership: ownership,
        )

        try first.install()
        try first.install()
        #expect(throws: NativeCrashError.self) {
            try second.install()
        }
    }

    @Test("an inherited capture fails closed after the process changes")
    func inheritedCaptureFailsClosed() throws {
        let process = ProcessIDBox(100)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let capture = try NativeCrashCapture(
            configuration: NativeCrashConfiguration(storageDirectory: directory),
            driver: FakeCrashEngineDriver(store: FakeCrashReportStore(reports: [1: sampleRawReport()])),
            ownership: ProcessCrashCaptureOwnership(),
            processIDProvider: { process.value },
        )
        try capture.install()

        process.value = 101

        do {
            _ = try capture.pendingReports()
            Issue.record("expected inherited capture to fail")
        } catch let error as NativeCrashError {
            #expect(error.code == .processChanged)
        }
    }
}
