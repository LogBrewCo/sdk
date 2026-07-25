import Foundation
@testable import LogBrewCrash
import Testing

@Suite("Apple native artifact identity")
struct NativeArtifactIdentityTests {
    @Test("exact project release environment and service values are retained")
    func exactIdentityIsRetained() throws {
        let identity = try NativeArtifactIdentity(
            projectId: "550e8400-e29b-41d4-a716-446655440000",
            release: "com.example.app@1.2.3+45",
            environment: "production",
            service: "ios-app",
        )

        #expect(identity.projectId == "550e8400-e29b-41d4-a716-446655440000")
        #expect(identity.release == "com.example.app@1.2.3+45")
        #expect(identity.environment == "production")
        #expect(identity.service == "ios-app")
    }

    @Test("all deployed context fields accept exact 256-byte values spaces slashes and None")
    func deployedContextBoundaryIsAccepted() throws {
        let boundary = String(repeating: "x", count: 256)
        let boundaryIdentity = try NativeArtifactIdentity(
            projectId: "550e8400-e29b-41d4-a716-446655440000",
            release: boundary,
            environment: boundary,
            service: boundary,
        )
        #expect(boundaryIdentity.release == boundary)
        #expect(boundaryIdentity.environment == boundary)
        #expect(boundaryIdentity.service == boundary)

        let flexibleIdentity = try NativeArtifactIdentity(
            projectId: "550e8400-e29b-41d4-a716-446655440000",
            release: "release candidate/app",
            environment: "None",
            service: "ios app/service",
        )
        #expect(flexibleIdentity.release == "release candidate/app")
        #expect(flexibleIdentity.environment == "None")
        #expect(flexibleIdentity.service == "ios app/service")

        let roundTrip = try NativeArtifactIdentityValue(flexibleIdentity).validatedIdentity()
        #expect(roundTrip == flexibleIdentity)
    }

    @Test(arguments: [
        ("", "release", "production", "ios-app"),
        ("550E8400-E29B-41D4-A716-446655440000", "release", "production", "ios-app"),
        ("550e8400-e29b-41d4-a716-446655440000", "", "production", "ios-app"),
        ("550e8400-e29b-41d4-a716-446655440000", "release", "", "ios-app"),
        ("550e8400-e29b-41d4-a716-446655440000", "release", "production", ""),
        ("550e8400-e29b-41d4-a716-446655440000", " release", "production", "ios-app"),
        ("550e8400-e29b-41d4-a716-446655440000", "release", "production ", "ios-app"),
        ("550e8400-e29b-41d4-a716-446655440000", "release", "production", "\tios-app"),
        ("550e8400-e29b-41d4-a716-446655440000", "release\n", "production", "ios-app"),
        (
            "550e8400-e29b-41d4-a716-446655440000",
            String(repeating: "r", count: 257),
            "production",
            "ios-app",
        ),
        (
            "550e8400-e29b-41d4-a716-446655440000",
            "release",
            String(repeating: "e", count: 257),
            "ios-app",
        ),
        (
            "550e8400-e29b-41d4-a716-446655440000",
            "release",
            "production",
            String(repeating: "s", count: 257),
        ),
        ("550e8400-e29b-41d4-a716-446655440000", "release", "production", "ios\u{0000}app"),
    ])
    func invalidOrAmbiguousIdentityFailsClosed(
        projectId: String,
        release: String,
        environment: String,
        service: String,
    ) {
        #expect(throws: NativeCrashError.self) {
            _ = try NativeArtifactIdentity(
                projectId: projectId,
                release: release,
                environment: environment,
                service: service,
            )
        }
    }

    @Test("watchdog requires exact artifact identity while crash capture remains source compatible")
    func watchdogRequiresIdentity() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let watchdog = try NativeHangWatchdogConfiguration(threshold: 2)

        #expect(throws: NativeCrashError.self) {
            _ = try NativeCrashConfiguration(
                storageDirectory: directory,
                artifactIdentity: nil,
                hangWatchdog: watchdog,
            )
        }

        let legacy = try NativeCrashConfiguration(storageDirectory: directory)
        #expect(legacy.artifactIdentity == nil)
        #expect(legacy.hangWatchdog == nil)
    }
}
