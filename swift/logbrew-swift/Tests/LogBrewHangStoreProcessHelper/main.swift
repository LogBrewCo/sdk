import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash

@main
enum LogBrewHangStoreProcessHelper {
    static func main() throws {
        let arguments = try HelperArguments(CommandLine.arguments)
        let incident = try makeIncident()
        let store = try NativeHangIncidentFileStore(directory: arguments.directory)
        let result: String

        switch arguments.phase {
        case "write":
            try store.write(incident)
            result = "stored"
        case "read":
            guard let stored = try store.read() else {
                throw NativeCrashError(.reportChanged)
            }
            result = stored.eventID
        case "ack":
            try store.delete(eventID: incident.eventID)
            result = "acknowledged"
        case "empty":
            guard try store.read() == nil else {
                throw NativeCrashError(.reportChanged)
            }
            result = "empty"
        default:
            throw NativeCrashError(.invalidConfiguration)
        }

        try result.write(to: arguments.result, atomically: true, encoding: .utf8)
    }

    private static func makeIncident() throws -> NativeHangIncident {
        try NativeHangIncident(
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
        )
    }
}

private struct HelperArguments {
    let phase: String
    let directory: URL
    let result: URL

    init(_ arguments: [String]) throws {
        guard arguments.count == 7,
              arguments[1] == "--phase",
              arguments[3] == "--directory",
              arguments[5] == "--result"
        else {
            throw NativeCrashError(.invalidConfiguration)
        }
        phase = arguments[2]
        directory = URL(fileURLWithPath: arguments[4], isDirectory: true)
        result = URL(fileURLWithPath: arguments[6])
    }
}
