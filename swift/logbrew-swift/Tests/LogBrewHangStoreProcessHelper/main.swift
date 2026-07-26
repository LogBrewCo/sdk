import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash

@main
enum LogBrewHangStoreProcessHelper {
    static func main() throws {
        let arguments = try HelperArguments(CommandLine.arguments)
        let incident = try makeIncident()
        let store = try NativeHangIncidentFileStore(directory: arguments.directory)
        let result = try runPhase(arguments, incident: incident, store: store)
        try result.write(to: arguments.result, atomically: true, encoding: .utf8)
    }

    private static func runPhase(
        _ arguments: HelperArguments,
        incident: NativeHangIncident,
        store: NativeHangIncidentFileStore,
    ) throws -> String {
        switch arguments.phase {
        case "write":
            try store.write(incident)
            return "stored"
        case "read":
            return try readResult(store)
        case "ack":
            try store.delete(eventID: incident.eventID)
            return "acknowledged"
        case "empty":
            return try emptyResult(
                store,
                deliveryDirectory: arguments.deliveryDirectory,
            )
        case "delivery-seed":
            return try seedFailedDelivery(
                incident: incident,
                store: store,
                directory: arguments.requiredDeliveryDirectory(),
            )
        case "delivery-replay":
            return try replayAcceptedDelivery(
                store: store,
                directory: arguments.requiredDeliveryDirectory(),
            )
        default:
            throw NativeCrashError(.invalidConfiguration)
        }
    }

    private static func readResult(_ store: NativeHangIncidentFileStore) throws -> String {
        guard let stored = try store.read(),
              let durationMs = stored.durationMs
        else {
            throw NativeCrashError(.reportChanged)
        }
        let replayed = try replay(stored)
        guard replayed.eventID == stored.eventID,
              replayed.durationMs == durationMs
        else {
            throw NativeCrashError(.reportChanged)
        }
        return "\(stored.eventID)|\(stored.state.rawValue)|\(durationMs)"
    }

    private static func emptyResult(
        _ store: NativeHangIncidentFileStore,
        deliveryDirectory: URL?,
    ) throws -> String {
        guard try store.read() == nil else {
            throw NativeCrashError(.reportChanged)
        }
        if let deliveryDirectory {
            let client = try makeDurableClient(directory: deliveryDirectory)
            guard client.pendingEvents() == 0 else {
                throw NativeCrashError(.reportChanged)
            }
        }
        return "empty"
    }

    private static func seedFailedDelivery(
        incident: NativeHangIncident,
        store: NativeHangIncidentFileStore,
        directory: URL,
    ) throws -> String {
        try store.write(incident)
        let client = try makeDurableClient(directory: directory)
        try incident.makeRecord(ownerNonce: UUID()).enqueue(in: client)
        do {
            _ = try client.flushEvent(
                incident.eventID,
                transport: FailedDeliveryTransport(),
            )
            throw NativeCrashError(.reportChanged)
        } catch is TransportError {
            throw NativeCrashError(.reportChanged)
        } catch let error as SdkError where error.code == "network_failure" {}
        guard client.pendingEvents() == 1,
              try store.read()?.eventID == incident.eventID
        else {
            throw NativeCrashError(.reportChanged)
        }
        return "retained|\(incident.eventID)"
    }

    private static func replayAcceptedDelivery(
        store: NativeHangIncidentFileStore,
        directory: URL,
    ) throws -> String {
        guard let incident = try store.read() else {
            throw NativeCrashError(.reportChanged)
        }
        let client = try makeDurableClient(directory: directory)
        guard client.pendingEvents() == 1 else {
            throw NativeCrashError(.reportChanged)
        }
        try incident.makeRecord(ownerNonce: UUID()).enqueue(in: client)
        guard try client.flushEvent(
            incident.eventID,
            transport: AcceptedDeliveryTransport(),
        ) else {
            throw NativeCrashError(.reportChanged)
        }
        try store.delete(eventID: incident.eventID)
        guard client.pendingEvents() == 0, try store.read() == nil else {
            throw NativeCrashError(.reportChanged)
        }
        return "acknowledged|\(incident.eventID)"
    }

    private static func makeDurableClient(directory: URL) throws -> LogBrewClient {
        let client = try LogBrewClient.create(
            apiKey: "LOGBREW_API_KEY",
            sdkName: "hang-delivery-process-helper",
            sdkVersion: "0.1.0",
            maxRetries: 0,
        )
        try client.enableDurableDelivery(
            options: DurableDeliveryOptions(directory: directory),
        )
        return client
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
            durationMs: 2100,
        )
    }

    private static func replay(
        _ incident: NativeHangIncident,
    ) throws -> (eventID: String, durationMs: Double) {
        let client = try LogBrewClient.create(
            apiKey: "LOGBREW_API_KEY",
            sdkName: "hang-store-process-helper",
            sdkVersion: "0.1.0",
        )
        try incident.makeRecord(ownerNonce: UUID()).enqueue(in: client)
        guard let data = try client.previewJSON().data(using: .utf8),
              let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = (payload["events"] as? [[String: Any]])?.first,
              let eventID = event["id"] as? String,
              let attributes = event["attributes"] as? [String: Any],
              let metadata = attributes["metadata"] as? [String: Any],
              let durationMs = metadata["durationMs"] as? Double
        else {
            throw NativeCrashError(.reportChanged)
        }
        return (eventID, durationMs)
    }
}

private struct HelperArguments {
    let phase: String
    let directory: URL
    let deliveryDirectory: URL?
    let result: URL

    init(_ arguments: [String]) throws {
        guard arguments.count == 7 || arguments.count == 9,
              arguments[1] == "--phase",
              arguments[3] == "--directory",
              arguments[arguments.count - 2] == "--result"
        else {
            throw NativeCrashError(.invalidConfiguration)
        }
        if arguments.count == 9, arguments[5] != "--delivery-directory" {
            throw NativeCrashError(.invalidConfiguration)
        }
        phase = arguments[2]
        directory = URL(fileURLWithPath: arguments[4], isDirectory: true)
        deliveryDirectory = arguments.count == 9
            ? URL(fileURLWithPath: arguments[6], isDirectory: true)
            : nil
        result = URL(fileURLWithPath: arguments[arguments.count - 1])
    }

    func requiredDeliveryDirectory() throws -> URL {
        guard let deliveryDirectory else {
            throw NativeCrashError(.invalidConfiguration)
        }
        return deliveryDirectory
    }
}

private final class FailedDeliveryTransport: Transport {
    func send(apiKey _: String, body _: Data) throws -> TransportResponse {
        throw TransportError.network("delivery unavailable")
    }
}

private final class AcceptedDeliveryTransport: Transport {
    func send(apiKey _: String, body _: Data) throws -> TransportResponse {
        TransportResponse(statusCode: 202, attempts: 1)
    }
}
