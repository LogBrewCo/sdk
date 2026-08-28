import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

extension NativeCrashDeliveryTests {
    @Test("capture-time resource and artifact identity survive replay after an app update")
    func captureTimeResourceAndArtifactIdentitySurviveUpdate() throws {
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
            capturedSystem: capturedResourceSystem(),
        )
        let record = try #require(capture.pendingReports().first)
        let client = try makeClient(name: "artifact-identity-test")

        try record.enqueue(in: client)
        let event = try firstEvent(in: client)
        let attributes = try #require(event["attributes"] as? [String: Any])
        let exception = try #require(attributes["exception"] as? [String: Any])
        let exceptionMechanism = try #require(exception["mechanism"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        let frames = try #require(attributes["nativeStackFrames"] as? [[String: Any]])

        #expect(metadata as NSDictionary == [
            "crash.correlation": "not_captured",
            "crash.mechanism": "signal",
            "crash.replayed": true,
            "projectId": "550e8400-e29b-41d4-a716-446655440000",
            "release": "com.example.app@1.2.3+45",
            "environment": "production",
            "service": "ios-app",
        ])
        #expect(exception["type"] as? String == "AppleNativeCrash")
        #expect(exceptionMechanism["type"] as? String == "signal")
        #expect(exceptionMechanism["handled"] as? Bool == false)
        #expect(frames.map { $0["architecture"] as? String } == ["arm64", "arm64e", "x86_64"])
        #expect(frames.allSatisfy { Set($0.keys) == ["architecture", "imageUuid", "instructionOffset"] })
        try expectCapturedResource(in: attributes, payload: client.previewJSON())
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
        let exception = try #require(attributes["exception"] as? [String: Any])
        let exceptionMechanism = try #require(exception["mechanism"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(metadata as NSDictionary == [
            "crash.correlation": "not_captured",
            "crash.mechanism": "signal",
            "crash.replayed": true,
        ])
        #expect(exception["type"] as? String == "AppleNativeCrash")
        #expect(exceptionMechanism["type"] as? String == "signal")
        #expect(exceptionMechanism["handled"] as? Bool == false)
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
        let exception = try #require(attributes["exception"] as? [String: Any])
        let exceptionMechanism = try #require(exception["mechanism"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(attributes["title"] as? String == "Native application hang")
        #expect(attributes["level"] as? String == "error")
        #expect(attributes["message"] == nil)
        #expect(exception["type"] as? String == "AppleNativeHang")
        #expect(exceptionMechanism["type"] as? String == "deadlock")
        #expect(exceptionMechanism["handled"] as? Bool == true)
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

    @Test("typed crash diagnostics preserve retry identity for legacy queued events")
    func legacyQueuedCrashEventRemainsIdempotent() throws {
        let eventID = "11111111-2222-3333-4444-555555555555"
        let timestamp = "2026-07-25T12:00:00Z"
        let frame = NativeStackFrame(
            imageUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            architecture: .arm64,
            instructionOffset: "0000000000000010",
        )
        let identity = try NativeArtifactIdentity(
            projectId: "550e8400-e29b-41d4-a716-446655440000",
            release: "com.example.app@1.2.3+45",
            environment: "production",
            service: "ios-app",
        )
        let incident = NativeHangIncident(
            eventID: eventID,
            timestamp: timestamp,
            state: .recovered,
            identity: identity,
            nativeStackFrames: [frame],
            durationMs: 4250,
        )
        let record = try incident.makeRecord(ownerNonce: UUID())
        let client = try makeClient(name: "legacy-queued-crash-test")
        try client.issueDetached(
            eventID,
            timestamp: timestamp,
            attributes: IssueAttributes(
                title: "Native application hang",
                level: .error,
                metadata: [
                    "crash.mechanism": "deadlock",
                    "crash.replayed": true,
                    "crash.handled": true,
                    "durationMs": 4250,
                    "projectId": "550e8400-e29b-41d4-a716-446655440000",
                    "release": "com.example.app@1.2.3+45",
                    "environment": "production",
                    "service": "ios-app",
                ],
                nativeStackFrames: [frame],
            ),
        )

        try record.enqueue(in: client)

        let event = try firstEvent(in: client)
        let attributes = try #require(event["attributes"] as? [String: Any])
        #expect(client.pendingEvents() == 1)
        #expect(attributes["exception"] == nil)
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
        let exception = try #require(attributes["exception"] as? [String: Any])
        let exceptionMechanism = try #require(exception["mechanism"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(event["id"] as? String == "8f12b746-0c79-4cc6-a077-98ed62f094b2")
        #expect(event["type"] as? String == "issue")
        #expect(attributes["title"] as? String == "Native application crash")
        #expect(attributes["level"] as? String == "critical")
        #expect(attributes["message"] == nil)
        #expect(exception["type"] as? String == "AppleNativeCrash")
        #expect(exceptionMechanism["type"] as? String == "signal")
        #expect(exceptionMechanism["handled"] as? Bool == false)
        #expect(metadata as NSDictionary == [
            "crash.correlation": "not_captured",
            "crash.mechanism": "signal",
            "crash.replayed": true,
        ])
        let json = try client.previewJSON()
        #expect(!json.contains("hunter2"))
        #expect(!json.contains("never-upload-this-value"))
    }
}

private func capturedResourceSystem() -> [String: Any] {
    [
        "system_name": "iOS",
        "system_version": "26.5",
        "os_version": "23F79",
        "model": "iPhone",
        "machine": "iPhone17,3",
        "cpu_arch": "arm64",
        "CFBundleName": "Example",
        "CFBundleShortVersionString": "1.2.3",
        "CFBundleVersion": "45",
        "process_name": "never-upload-process",
        "CFBundleExecutablePath": "/private/never-upload-path",
        "CFBundleIdentifier": "never-upload-identifier",
        "device_app_hash": "never-upload-hash",
        "time_zone": "never-upload-timezone",
    ]
}

private func expectCapturedResource(in attributes: [String: Any], payload: String) throws {
    let context = try #require(attributes["context"] as? [String: Any])
    #expect(context as NSDictionary == [
        "schemaVersion": 1,
        "resource": [
            "service": ["name": "ios-app"],
            "deployment": ["environment": "production", "release": "com.example.app@1.2.3+45"],
            "operatingSystem": ["name": "iOS", "version": "26.5", "build": "23F79"],
            "device": ["family": "iPhone", "model": "iPhone17,3", "architecture": "arm64"],
            "application": ["name": "Example", "version": "1.2.3", "build": "45"],
        ],
    ])
    for forbidden in [
        "never-upload-process",
        "never-upload-path",
        "never-upload-identifier",
        "never-upload-hash",
        "never-upload-timezone",
    ] {
        #expect(!payload.contains(forbidden))
    }
}
