import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

extension NativeCrashDeliveryTests {
    @Test("capture-time artifact identity survives replay after an app update")
    func captureTimeArtifactIdentitySurvivesUpdate() throws {
        let replayIdentity = try NativeArtifactIdentity(
            projectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            release: "com.example.app@2.0.0+60",
            environment: "production/new",
            service: "ios-app-v2",
        )
        let capture = try makeArtifactIdentityCapture(
            persistedIdentity: [
                "version": 1,
                "project_id": "550e8400-e29b-41d4-a716-446655440000",
                "release": "com.example.app@1.2.3+45",
                "environment": "production",
                "service": "ios-app",
            ],
            replayIdentity: replayIdentity,
        )
        let record = try #require(capture.pendingReports().first)
        let client = try makeClient(name: "artifact-identity-test")

        try record.enqueue(in: client)
        let event = try firstEvent(in: client)
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        let frames = try #require(attributes["nativeStackFrames"] as? [[String: Any]])

        #expect(metadata as NSDictionary == [
            "crash.mechanism": "signal",
            "crash.replayed": true,
            "projectId": "550e8400-e29b-41d4-a716-446655440000",
            "release": "com.example.app@1.2.3+45",
            "environment": "production",
            "service": "ios-app",
        ])
        #expect(frames.map { $0["architecture"] as? String } == ["arm64", "arm64e", "x86_64"])
        #expect(frames.allSatisfy { Set($0.keys) == ["architecture", "imageUuid", "instructionOffset"] })
    }

    @Test("legacy crash reports replay without borrowing the current app identity")
    func legacyReportDoesNotBorrowReplayIdentity() throws {
        let replayIdentity = try NativeArtifactIdentity(
            projectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            release: "com.example.app@2.0.0+60",
            environment: "production",
            service: "ios-app-v2",
        )
        let capture = try makeArtifactIdentityCapture(
            persistedIdentity: nil,
            replayIdentity: replayIdentity,
        )
        let record = try #require(capture.pendingReports().first)
        let client = try makeClient(name: "legacy-artifact-identity-test")

        try record.enqueue(in: client)
        let event = try firstEvent(in: client)
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(metadata as NSDictionary == [
            "crash.mechanism": "signal",
            "crash.replayed": true,
        ])
    }

    @Test("malformed persisted artifact identity fails closed")
    func malformedPersistedIdentityFailsClosed() throws {
        let replayIdentity = try NativeArtifactIdentity(
            projectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            release: "com.example.app@2.0.0+60",
            environment: "production",
            service: "ios-app-v2",
        )
        let capture = try makeArtifactIdentityCapture(
            persistedIdentity: [
                "version": 1,
                "project_id": "not-a-uuid",
                "release": "com.example.app@1.2.3+45",
                "environment": "production",
                "service": "ios-app",
            ],
            replayIdentity: replayIdentity,
        )

        do {
            _ = try capture.pendingReports()
            Issue.record("expected malformed persisted identity to fail closed")
        } catch let error as NativeCrashError {
            #expect(error.code == .reportCorrupt)
        }
    }

    @Test("hang replay uses fixed bounded fields and distinguishes recovered state")
    func hangReplayIsPrivacyBounded() throws {
        let identity = try NativeArtifactIdentity(
            projectId: "550e8400-e29b-41d4-a716-446655440000",
            release: "com.example.app@1.2.3+45",
            environment: "production",
            service: "ios-app",
        )
        let incident = NativeHangIncident(
            eventID: "11111111-2222-3333-4444-555555555555",
            timestamp: "2026-07-25T12:00:00Z",
            state: .recovered,
            identity: identity,
            nativeStackFrames: [
                NativeStackFrame(
                    imageUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                    architecture: .arm64,
                    instructionOffset: "0000000000000010",
                ),
            ],
            durationMs: 4250,
        )
        let record = try incident.makeRecord(ownerNonce: UUID())
        let client = try makeClient(name: "hang-privacy-test")

        try record.enqueue(in: client)
        let event = try firstEvent(in: client)
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(attributes["title"] as? String == "Native application hang")
        #expect(attributes["level"] as? String == "error")
        #expect(attributes["message"] == nil)
        #expect(metadata["crash.mechanism"] as? String == "deadlock")
        #expect(metadata["crash.replayed"] as? Bool == true)
        #expect(metadata["crash.handled"] as? Bool == true)
        #expect(metadata["durationMs"] as? Double == 4250)
        #expect(Set(metadata.keys) == [
            "crash.handled", "crash.mechanism", "crash.replayed",
            "durationMs", "environment", "projectId", "release", "service",
        ])
        try record.enqueue(in: client)
        #expect(client.pendingEvents() == 1)
        let payload = try client.previewJSON()
        for forbidden in ["symbolName", "imageName", "thread", "reason", "console", "/private/"] {
            #expect(!payload.contains(forbidden))
        }
    }

    @Test("sanitized replay records enqueue only fixed crash metadata")
    func enqueueUsesPrivacyAllowlist() throws {
        let store = FakeCrashReportStore(reports: [
            1: rawReport(
                id: "8F12B746-0C79-4CC6-A077-98ED62F094B2",
                timestamp: "2026-07-17T09:10:11Z",
                mechanism: "signal",
                privateMarker: "never-upload-this-value",
            ),
        ])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        let record = try #require(capture.pendingReports().first)
        let client = try makeClient(name: "installed-apple-test")

        try record.enqueue(in: client)
        let event = try firstEvent(in: client)
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(event["id"] as? String == "8f12b746-0c79-4cc6-a077-98ed62f094b2")
        #expect(event["type"] as? String == "issue")
        #expect(attributes["title"] as? String == "Native application crash")
        #expect(attributes["level"] as? String == "critical")
        #expect(attributes["message"] == nil)
        #expect(metadata as NSDictionary == [
            "crash.mechanism": "signal",
            "crash.replayed": true,
        ])
        let json = try client.previewJSON()
        #expect(!json.contains("hunter2"))
        #expect(!json.contains("never-upload-this-value"))
    }
}
