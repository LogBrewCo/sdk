import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

extension NativeCrashDeliveryTests {
    func makeArtifactIdentityCapture(
        persistedIdentity: [String: Any]?,
        replayIdentity: NativeArtifactIdentity,
        capturedSystem: [String: Any]? = nil,
    ) throws -> NativeCrashCapture {
        var report = makeKSCrashReport(
            threads: [crashedThread(addresses: [0x1010, 0x2010, 0x3010])],
            images: [
                binaryImage(
                    start: 0x1000,
                    size: 0x100,
                    uuid: "11111111-2222-3333-4444-555555555555",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
                binaryImage(
                    start: 0x2000,
                    size: 0x100,
                    uuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 2,
                ),
                binaryImage(
                    start: 0x3000,
                    size: 0x100,
                    uuid: "01234567-89AB-CDEF-0123-456789ABCDEF",
                    cpuType: 0x0100_0007,
                    cpuSubtype: 3,
                ),
            ],
        )
        if let persistedIdentity {
            report["user"] = [
                "logbrew_native_artifact_identity": persistedIdentity,
            ]
        }
        if let capturedSystem {
            report["system"] = capturedSystem
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let configuration = try NativeCrashConfiguration(
            storageDirectory: directory,
            artifactIdentity: replayIdentity,
            hangWatchdog: nil,
        )
        let store = FakeCrashReportStore(reports: [1: report])
        let capture = NativeCrashCapture(
            configuration: configuration,
            driver: FakeCrashEngineDriver(store: store),
            ownership: ProcessCrashCaptureOwnership(),
        )
        try capture.install()
        return capture
    }

    func makeClient(name: String, maxRetries: Int = 2) throws -> LogBrewClient {
        try LogBrewClient.create(
            apiKey: "LOGBREW_API_KEY",
            sdkName: name,
            sdkVersion: "0.1.0",
            maxRetries: maxRetries,
        )
    }

    func firstEvent(in client: LogBrewClient) throws -> [String: Any] {
        let data = try #require(client.previewJSON().data(using: .utf8))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try #require(object["events"] as? [[String: Any]])
        return try #require(events.first)
    }
}

final class MixedReplayFixture {
    let crashID = "ffffffff-ffff-4fff-bfff-ffffffffffff"
    let hangID = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee"
    let crashStore: FakeCrashReportStore
    let hangStore: NativeHangIncidentFileStore
    let capture: NativeCrashCapture
    private let directory: URL

    init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        crashStore = FakeCrashReportStore(reports: [
            7: rawReport(
                id: crashID,
                timestamp: "2026-07-25T10:00:00.000000001Z",
                mechanism: "signal",
                privateMarker: "crash",
            ),
        ])
        let installedCapture = try NativeCrashCapture(
            configuration: NativeCrashConfiguration(storageDirectory: directory),
            driver: FakeCrashEngineDriver(store: crashStore),
            ownership: ProcessCrashCaptureOwnership(),
        )
        try installedCapture.install()
        let installedHangStore = try NativeHangIncidentFileStore(
            directory: directory.appendingPathComponent("mixed-hang", isDirectory: true),
        )
        try installedHangStore.write(NativeHangIncident(
            eventID: hangID,
            timestamp: "2026-07-25T10:00:00Z",
            state: .recovered,
            identity: NativeArtifactIdentity(
                projectId: "550e8400-e29b-41d4-a716-446655440000",
                release: "com.example.app@1.2.3+45",
                environment: "production",
                service: "ios-app",
            ),
            nativeStackFrames: [
                NativeStackFrame(
                    imageUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                    architecture: .arm64,
                    instructionOffset: "0000000000000010",
                ),
            ],
            durationMs: 2000,
        ))
        installedCapture.hangStore = installedHangStore
        capture = installedCapture
        hangStore = installedHangStore
    }

    func invalidateStoredHang(_ corruption: StoredHangCorruption) throws {
        let recordURL = directory
            .appendingPathComponent("mixed-hang", isDirectory: true)
            .appendingPathComponent(NativeHangIncidentFileStore.recordName)
        let data = try Data(contentsOf: recordURL)
        var record = try #require(
            JSONSerialization.jsonObject(with: data) as? [String: Any],
        )
        switch corruption {
        case .identity:
            var identity = try #require(record["artifactIdentity"] as? [String: Any])
            identity["projectId"] = "not-a-uuid"
            record["artifactIdentity"] = identity
        case .duration:
            record["durationMs"] = "invalid"
        }
        try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            .write(to: recordURL)
    }

    func removeStorage() {
        try? FileManager.default.removeItem(at: directory)
    }
}

enum StoredHangCorruption: CaseIterable {
    case identity
    case duration
}
