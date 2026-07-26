import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

@Suite("Apple native hang incident storage")
struct NativeHangIncidentStoreTests {
    @Test("write read exact acknowledgement and empty state survive separate processes")
    func separateProcessLifecycle() throws {
        let fixture = try StoreFixture()
        let resultURL = fixture.directory
            .deletingLastPathComponent()
            .appendingPathComponent("\(UUID().uuidString).result")
        defer {
            try? FileManager.default.removeItem(at: fixture.directory)
            try? FileManager.default.removeItem(at: resultURL)
        }

        for (phase, expected) in [
            ("write", "stored"),
            ("read", "\(fixture.incident.eventID)|ongoing|2100.0"),
            ("ack", "acknowledged"),
            ("empty", "empty"),
        ] {
            let process = Process()
            process.executableURL = try NativeHangIncidentProcessHarness.executableURL()
            process.arguments = NativeHangIncidentProcessHarness.arguments(
                phase: phase,
                directory: fixture.directory,
                result: resultURL,
            )
            try process.run()
            process.waitUntilExit()

            #expect(process.terminationStatus == 0)
            #expect(try String(contentsOf: resultURL, encoding: .utf8) == expected)
        }
    }

    @Test("a bounded record survives a fresh store instance and exact acknowledgement removes it")
    func freshInstanceReadsAndAcknowledgesExactRecord() throws {
        let fixture = try StoreFixture()
        let writer = try NativeHangIncidentFileStore(directory: fixture.directory)
        try writer.write(fixture.incident)
        let directoryValues = try fixture.directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        let recordAttributes = try FileManager.default.attributesOfItem(
            atPath: fixture.directory
                .appendingPathComponent(NativeHangIncidentFileStore.recordName)
                .path,
        )

        let reader = try NativeHangIncidentFileStore(directory: fixture.directory)
        #expect(try reader.read() == fixture.incident)
        #expect(directoryValues.isExcludedFromBackup == true)
        #expect((recordAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        try reader.delete(eventID: fixture.incident.eventID)

        let fresh = try NativeHangIncidentFileStore(directory: fixture.directory)
        #expect(try fresh.read() == nil)
    }

    @Test("mismatched acknowledgement retains the record")
    func mismatchedAcknowledgementFailsClosed() throws {
        let fixture = try StoreFixture()
        let store = try NativeHangIncidentFileStore(directory: fixture.directory)
        try store.write(fixture.incident)

        #expect(throws: NativeCrashError.self) {
            try store.delete(eventID: "22222222-3333-4444-5555-666666666666")
        }
        #expect(try store.read() == fixture.incident)
    }

    @Test("occupied admission retains exact first bytes until acknowledgement or purge")
    func occupiedAdmissionDoesNotReplace() throws {
        let fixture = try StoreFixture()
        let store = try NativeHangIncidentFileStore(directory: fixture.directory)
        try store.write(fixture.incident)
        let first = try #require(try store.read())
        let firstDigest = try first.digest()
        let second = try NativeHangIncident(
            eventID: "22222222-3333-4444-5555-666666666666",
            timestamp: "2026-07-25T12:00:01Z",
            state: .ongoing,
            identity: first.artifactIdentity.validatedIdentity(),
            nativeStackFrames: first.nativeStackFrames,
        )

        #expect(throws: NativeCrashError.self) {
            try store.write(second)
        }

        let retained = try #require(try NativeHangIncidentFileStore(
            directory: fixture.directory,
        ).read())
        #expect(retained == first)
        #expect(try retained.digest() == firstDigest)
    }

    @Test("corruption symlinks and oversized content are rejected without raw details")
    func unsafeStorageFailsClosed() throws {
        let fixture = try StoreFixture()
        try FileManager.default.createDirectory(at: fixture.directory, withIntermediateDirectories: false)
        let recordURL = fixture.directory.appendingPathComponent(NativeHangIncidentFileStore.recordName)
        try Data(repeating: 0x78, count: NativeHangIncidentFileStore.maxBytes + 1).write(to: recordURL)

        let oversized = try NativeHangIncidentFileStore(directory: fixture.directory)
        #expect(throws: NativeCrashError.self) {
            _ = try oversized.read()
        }

        try FileManager.default.removeItem(at: recordURL)
        try FileManager.default.createSymbolicLink(
            at: recordURL,
            withDestinationURL: fixture.directory.appendingPathComponent("missing"),
        )
        #expect(throws: NativeCrashError.self) {
            _ = try oversized.read()
        }
    }

    @Test("recovery preserves stable identity and bounded frame tuples")
    func recoveryRewritesOnlyState() throws {
        let fixture = try StoreFixture()
        let store = try NativeHangIncidentFileStore(directory: fixture.directory)
        try store.write(fixture.incident)

        try store.markRecovered(
            eventID: fixture.incident.eventID,
            durationMs: 4250,
        )
        let recovered = try #require(try store.read())

        #expect(recovered.eventID == fixture.incident.eventID)
        #expect(recovered.timestamp == fixture.incident.timestamp)
        #expect(recovered.artifactIdentity == fixture.incident.artifactIdentity)
        #expect(recovered.nativeStackFrames == fixture.incident.nativeStackFrames)
        #expect(recovered.state == .recovered)
        #expect(recovered.durationMs == 4250)
    }

    @Test("one owned interrupted temporary is removed while a replacement link fails closed")
    func interruptedTemporaryIsBoundedAndSafe() throws {
        let fixture = try StoreFixture()
        try FileManager.default.createDirectory(
            at: fixture.directory,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: NSNumber(value: 0o700)],
        )
        let temporary = fixture.directory.appendingPathComponent(
            "\(NativeHangIncidentFileStore.recordName).tmp",
        )
        #expect(FileManager.default.createFile(
            atPath: temporary.path,
            contents: Data("partial".utf8),
            attributes: [.posixPermissions: NSNumber(value: 0o600)],
        ))

        _ = try NativeHangIncidentFileStore(directory: fixture.directory)
        #expect(!FileManager.default.fileExists(atPath: temporary.path))

        try FileManager.default.createSymbolicLink(
            at: temporary,
            withDestinationURL: fixture.directory.appendingPathComponent("missing"),
        )
        #expect(throws: NativeCrashError.self) {
            _ = try NativeHangIncidentFileStore(directory: fixture.directory)
        }
    }
}

@Suite("Apple native hang incident process harness")
struct NativeHangIncidentProcessHarnessTests {
    @Test("helper product and positional CLI remain explicit")
    func helperProductAndArgumentsAreExplicit() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("store", isDirectory: true)
        let result = FileManager.default.temporaryDirectory
            .appendingPathComponent("result")

        #expect(try NativeHangIncidentProcessHarness.executableURL().lastPathComponent
            == "LogBrewHangStoreProcessHelper")
        #expect(NativeHangIncidentProcessHarness.arguments(
            phase: "read",
            directory: directory,
            result: result,
        ) == [
            "--phase", "read",
            "--directory", directory.path,
            "--result", result.path,
        ])
    }
}

private enum NativeHangIncidentProcessHarness {
    private static let executableName = "LogBrewHangStoreProcessHelper"

    static func executableURL() throws -> URL {
        #if os(macOS)
            let productsDirectory = Bundle(for: NativeHangStoreTestAnchor.self)
                .bundleURL
                .deletingLastPathComponent()
        #else
            let productsDirectory = URL(fileURLWithPath: CommandLine.arguments[0])
                .deletingLastPathComponent()
        #endif
        let executable = productsDirectory.appendingPathComponent(executableName)
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw NativeCrashError(.invalidConfiguration)
        }
        return executable
    }

    static func arguments(phase: String, directory: URL, result: URL) -> [String] {
        [
            "--phase", phase,
            "--directory", directory.path,
            "--result", result.path,
        ]
    }
}

private final class NativeHangStoreTestAnchor {}

private struct StoreFixture {
    let directory: URL
    let incident: NativeHangIncident

    init(directory: URL? = nil) throws {
        self.directory = directory ?? FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        incident = try NativeHangIncident(
            eventID: "11111111-2222-3333-4444-555555555555",
            timestamp: "2026-07-25T12:00:00Z",
            state: .ongoing,
            identity: NativeArtifactIdentity(
                projectId: "550e8400-e29b-41d4-a716-446655440000",
                release: "com.example.app@1.2.3+45",
                environment: "production",
                service: "ios-app",
            ),
            nativeStackFrames: [
                NativeStackFrame(
                    imageUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                    architecture: .arm64e,
                    instructionOffset: "0000000000000040",
                ),
            ],
            durationMs: 2100,
        )
    }
}
