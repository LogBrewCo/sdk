import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

@Suite("Apple native hang duration")
struct NativeHangDurationTests {
    @Test("a bounded duration survives storage and replays as typed milliseconds once")
    func boundedDurationPersistsAndReplaysOnce() throws {
        let fixture = try DurationFixture(durationMs: 2125.5)
        defer { fixture.removeStorage() }
        let store = try NativeHangIncidentFileStore(directory: fixture.directory)

        try store.write(fixture.incident)
        let persisted = try #require(try NativeHangIncidentFileStore(
            directory: fixture.directory,
        ).read())
        let record = try persisted.makeRecord(ownerNonce: UUID())
        let client = try LogBrewClient.create(
            apiKey: "LOGBREW_API_KEY",
            sdkName: "hang-duration-test",
            sdkVersion: "0.1.0",
        )

        try record.enqueue(in: client)
        try record.enqueue(in: client)
        let metadata = try issueMetadata(in: client)

        #expect(persisted.durationMs == 2125.5)
        #expect(metadata["durationMs"] as? Double == 2125.5)
        #expect(client.pendingEvents() == 1)
    }

    @Test("a v0.1.4 record without duration decodes without inventing one")
    func legacyRecordWithoutDurationRemainsCompatible() throws {
        let fixture = try DurationFixture(durationMs: 2000)
        defer { fixture.removeStorage() }
        let store = try NativeHangIncidentFileStore(directory: fixture.directory)
        try store.write(fixture.incident)
        try removeDurationField(from: fixture.recordURL)

        let legacy = try #require(try NativeHangIncidentFileStore(
            directory: fixture.directory,
        ).read())
        let client = try LogBrewClient.create(
            apiKey: "LOGBREW_API_KEY",
            sdkName: "legacy-hang-duration-test",
            sdkVersion: "0.1.0",
        )
        try legacy.makeRecord(ownerNonce: UUID()).enqueue(in: client)

        #expect(legacy.durationMs == nil)
        #expect(try issueMetadata(in: client)["durationMs"] == nil)
    }

    @Test("invalid and unreasonably large durations fail closed")
    func invalidDurationsFailClosed() throws {
        let invalidValues = [
            -1,
            Double.nan,
            Double.infinity,
            -Double.infinity,
            Double.greatestFiniteMagnitude,
            NativeHangDuration.maxMilliseconds.nextUp,
        ]

        for value in invalidValues {
            let incident = try DurationFixture(durationMs: value).incident
            #expect(throws: NativeCrashError.self) {
                _ = try incident.validated()
            }
        }
    }

    @Test("a malformed persisted duration is corrupt")
    func malformedPersistedDurationFailsClosed() throws {
        let fixture = try DurationFixture(durationMs: 2000)
        defer { fixture.removeStorage() }
        let store = try NativeHangIncidentFileStore(directory: fixture.directory)
        try store.write(fixture.incident)
        try replaceDurationField(in: fixture.recordURL, with: "two seconds")

        #expect(throws: NativeCrashError.self) {
            _ = try NativeHangIncidentFileStore(directory: fixture.directory).read()
        }
    }
}

private struct DurationFixture {
    let directory: URL
    let incident: NativeHangIncident

    var recordURL: URL {
        directory.appendingPathComponent(NativeHangIncidentFileStore.recordName)
    }

    init(durationMs: Double) throws {
        directory = FileManager.default.temporaryDirectory
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
                    architecture: .arm64,
                    instructionOffset: "0000000000000010",
                ),
            ],
            durationMs: durationMs,
        )
    }

    func removeStorage() {
        try? FileManager.default.removeItem(at: directory)
    }
}

private func issueMetadata(in client: LogBrewClient) throws -> [String: Any] {
    let data = try #require(client.previewJSON().data(using: .utf8))
    let payload = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let events = try #require(payload["events"] as? [[String: Any]])
    let attributes = try #require(events.first?["attributes"] as? [String: Any])
    return try #require(attributes["metadata"] as? [String: Any])
}

private func removeDurationField(from recordURL: URL) throws {
    try replaceDurationField(in: recordURL, with: nil)
}

private func replaceDurationField(in recordURL: URL, with value: Any?) throws {
    let data = try Data(contentsOf: recordURL)
    var object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    object["durationMs"] = value
    let replacement = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    let handle = try FileHandle(forWritingTo: recordURL)
    defer { try? handle.close() }
    try handle.truncate(atOffset: 0)
    try handle.write(contentsOf: replacement)
    try handle.synchronize()
}
