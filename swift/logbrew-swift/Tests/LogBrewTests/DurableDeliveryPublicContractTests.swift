import Foundation
@testable import LogBrew
import Testing

@Suite("Durable delivery public contract")
struct DurableDeliveryPublicContractTests {
    @Test("durable delivery is explicit and recovers exact failed bytes")
    func durableDeliveryRecoversExactFailedBytes() throws {
        let parent = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: parent) }

        let failedTransport = ThreadSafeScriptedTransport(statuses: [503])
        var firstClient: LogBrewClient? = try makeClient(maxRetries: 0)
        try firstClient?.enableDurableDelivery(
            options: DurableDeliveryOptions(directory: parent),
        )
        try captureLog(#require(firstClient), id: "durable-retry")
        #expect(throws: SdkError.self) {
            _ = try firstClient?.shutdown(transport: failedTransport)
        }
        let failedBody = try #require(failedTransport.requestBodies.first)
        firstClient = nil

        let acceptedTransport = ThreadSafeScriptedTransport(statuses: [202])
        let recoveredClient = try makeClient(maxRetries: 0)
        try recoveredClient.enableDurableDelivery(
            options: DurableDeliveryOptions(directory: parent),
        )

        #expect(recoveredClient.pendingEvents() == 1)
        _ = try recoveredClient.flush(transport: acceptedTransport)
        #expect(acceptedTransport.requestBodies == [failedBody])
        #expect(recoveredClient.pendingEvents() == 0)
    }

    @Test("enabling durability migrates the accepted memory queue")
    func enablingDurabilityMigratesAcceptedMemoryQueue() throws {
        let parent = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        var firstClient: LogBrewClient? = try makeClient()
        try captureLog(#require(firstClient), id: "captured-before-enable")

        try firstClient?.enableDurableDelivery(
            options: DurableDeliveryOptions(directory: parent),
        )
        firstClient = nil

        let recoveredClient = try makeClient()
        try recoveredClient.enableDurableDelivery(
            options: DurableDeliveryOptions(directory: parent),
        )
        #expect(recoveredClient.pendingEvents() == 1)
        #expect(try recoveredClient.previewJSON().contains("captured-before-enable"))
    }

    @Test("SDK owns a fixed versioned child and purge removes queued work")
    func sdkOwnsVersionedChildAndPurgeRemovesQueuedWork() throws {
        let parent = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let client = try makeClient()

        try client.enableDurableDelivery(
            options: DurableDeliveryOptions(directory: parent),
        )
        try captureLog(client, id: "durable-purge")

        let children = try FileManager.default.contentsOfDirectory(
            at: parent,
            includingPropertiesForKeys: nil,
        )
        #expect(children.map(\.lastPathComponent) == ["logbrew-delivery-v1"])
        try client.purgeDurableDelivery()
        #expect(client.pendingEvents() == 0)
    }

    @Test("symlink storage parents fail closed")
    func symlinkStorageParentsFailClosed() throws {
        let root = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: root) }
        let destination = root.appendingPathComponent("destination", isDirectory: true)
        let symlink = root.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: destination)
        let client = try makeClient()
        try captureLog(client, id: "retained-after-enable-failure")

        do {
            try client.enableDurableDelivery(
                options: DurableDeliveryOptions(directory: symlink),
            )
            Issue.record("symlink storage parent was accepted")
        } catch let error as SdkError {
            #expect(error.code == "storage_error")
        }
        #expect(client.deliveryHealth().state == .manual)
        #expect(client.pendingEvents() == 1)
        #expect(try client.previewJSON().contains("retained-after-enable-failure"))
    }

    @Test("durable health stays content-free and JSON stable")
    func durableHealthStaysContentFreeAndJSONStable() throws {
        let parent = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let client = try makeClient()
        try client.enableDurableDelivery(
            options: DurableDeliveryOptions(directory: parent),
        )
        try captureLog(client, id: "private-event", message: "private-message")

        let health = try JSONEncoder().encode(client.deliveryHealth())
        let json = try #require(String(data: health, encoding: .utf8))
        #expect(!json.contains("private-event"))
        #expect(!json.contains("private-message"))
        #expect(!json.contains("LOGBREW_API_KEY"))
        #expect(!json.contains(parent.path))
        #expect(!json.contains("http"))
    }

    @Test("existing storage is hardened and records exclude authentication data")
    func existingStorageIsHardenedAndAuthenticationFree() throws {
        let parent = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let owned = parent.appendingPathComponent("logbrew-delivery-v1", isDirectory: true)
        try FileManager.default.createDirectory(
            at: owned,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700],
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = false
        var mutableOwned = owned
        try mutableOwned.setResourceValues(values)

        let client = try makeClient()
        try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
        try captureLog(client, id: "durable-private", message: "allowed-telemetry-content")

        let hardened = try owned.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(hardened.isExcludedFromBackup == true)
        let children = try FileManager.default.contentsOfDirectory(
            at: owned,
            includingPropertiesForKeys: [.isRegularFileKey],
        )
        for child in children {
            let attributes = try FileManager.default.attributesOfItem(atPath: child.path)
            #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
            let bytes = try Data(contentsOf: child)
            #expect(!bytes.contains(Data("LOGBREW_API_KEY".utf8)))
        }
    }
}

func temporaryStorageParent() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("logbrew-durable-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700],
    )
    return directory
}
