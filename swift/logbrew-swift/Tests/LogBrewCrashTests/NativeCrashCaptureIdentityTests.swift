import Foundation
@testable import LogBrewCrash
import Testing

extension NativeCrashCaptureTests {
    @Test("engine receives only the reserved exact artifact identity")
    func engineReceivesReservedArtifactIdentity() throws {
        let identity = try NativeArtifactIdentity(
            projectId: "550e8400-e29b-41d4-a716-446655440000",
            release: "com.example.app@1.2.3+45",
            environment: "production",
            service: "ios-app",
        )
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let driver = FakeCrashEngineDriver(store: FakeCrashReportStore())
        let capture = try NativeCrashCapture(
            configuration: NativeCrashConfiguration(
                storageDirectory: directory,
                artifactIdentity: identity,
                hangWatchdog: nil,
            ),
            driver: driver,
            ownership: ProcessCrashCaptureOwnership(),
        )

        try capture.install()

        let configuration = try #require(driver.configurations.first)
        #expect(configuration.artifactIdentity == NativeArtifactIdentityValue(identity))
        #expect(configuration.artifactIdentity?.crashUserInfoJSON as NSDictionary? == [
            "logbrew_native_artifact_identity": [
                "version": 1,
                "project_id": "550e8400-e29b-41d4-a716-446655440000",
                "release": "com.example.app@1.2.3+45",
                "environment": "production",
                "service": "ios-app",
            ],
        ] as NSDictionary)
    }
}
