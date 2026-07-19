import Foundation
@testable import LogBrew
import Testing

@Suite("Durable delivery failure recovery")
struct DurableDeliveryFailureTests {
    @Test("unknown durable records pause with a typed reason until explicit purge")
    func unknownDurableRecordsPauseUntilExplicitPurge() throws {
        let parent = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let unrelated = parent.appendingPathComponent("unrelated.txt")
        try Data("unrelated".utf8).write(to: unrelated)
        let owned = parent.appendingPathComponent("logbrew-delivery-v1", isDirectory: true)
        try FileManager.default.createDirectory(
            at: owned,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700],
        )
        let unknown = owned.appendingPathComponent("unknown.record")
        try Data("unknown".utf8).write(to: unknown)
        let client = try makeClient()

        do {
            try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
            Issue.record("unknown durable record was accepted")
        } catch let error as SdkError {
            #expect(error.code == "storage_corrupt")
        }
        #expect(client.deliveryHealth().state == .paused)
        #expect(client.deliveryHealth().pauseReason == .storage)
        #expect(FileManager.default.fileExists(atPath: unknown.path))

        for operation in blockedStorageOperations(client: client) {
            do {
                try operation()
                Issue.record("storage pause allowed delivery work")
            } catch let error as SdkError {
                #expect(error.code == "storage_corrupt")
            }
        }
        #expect(client.pendingEvents() == 0)

        try client.purgeDurableDelivery()
        #expect(client.deliveryHealth().state == .manual)
        #expect(FileManager.default.fileExists(atPath: parent.path))
        #expect(FileManager.default.fileExists(atPath: unrelated.path))
        #expect(!FileManager.default.fileExists(atPath: owned.path))
    }

    @Test("exhausted durable sequence fails closed before FIFO order can wrap")
    func exhaustedDurableSequenceFailsClosed() throws {
        let parent = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let owned = parent.appendingPathComponent("logbrew-delivery-v1", isDirectory: true)

        do {
            let client = try makeClient()
            try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
            try captureLog(client, id: "sequence-exhaustion")
        }

        let original = try #require(
            try FileManager.default.contentsOfDirectory(at: owned, includingPropertiesForKeys: nil)
                .first { $0.lastPathComponent.hasPrefix("event-") },
        )
        var record = try #require(
            try JSONSerialization.jsonObject(with: Data(contentsOf: original)) as? [String: Any],
        )
        record["sequence"] = NSNumber(value: UInt64.max)
        let exhausted = owned.appendingPathComponent("event-18446744073709551615.json")
        try JSONSerialization.data(withJSONObject: record).write(to: exhausted, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: exhausted.path)
        try FileManager.default.removeItem(at: original)

        let recovered = try makeClient()
        do {
            try recovered.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
            Issue.record("exhausted durable sequence was accepted")
        } catch let error as SdkError {
            #expect(error.code == "storage_corrupt")
        }
        #expect(recovered.deliveryHealth().pauseReason == .storage)
        #expect(FileManager.default.fileExists(atPath: exhausted.path))
    }

    @Test("purge rejects active delivery ownership")
    func purgeRejectsActiveDeliveryOwnership() throws {
        let parent = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let client = try makeClient()
        try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
        try client.startAutomaticDelivery(
            transport: ThreadSafeScriptedTransport(statuses: [202]),
            options: AutomaticDeliveryOptions(interval: 30, threshold: 100),
        )

        do {
            try client.purgeDurableDelivery()
            Issue.record("purge accepted active automatic ownership")
        } catch let error as SdkError {
            #expect(error.code == "configuration_error")
        }
        client.stopAutomaticDelivery()
        try client.purgeDurableDelivery()
    }

    @Test("stopping an accepted in-flight send keeps durable and memory acknowledgement consistent")
    func stopDuringAcceptedSendRetainsDurablePrefixForRestart() throws {
        let parent = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let requestStarted = DispatchSemaphore(value: 0)
        let releaseRequest = DispatchSemaphore(value: 0)
        let stopFinished = DispatchSemaphore(value: 0)
        let transport = ThreadSafeScriptedTransport(statuses: [202]) { requestIndex in
            if requestIndex == 0 {
                requestStarted.signal()
                _ = releaseRequest.wait(timeout: .now() + 2)
            }
        }

        do {
            let client = try makeClient()
            try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
            try client.startAutomaticDelivery(
                transport: transport,
                options: AutomaticDeliveryOptions(interval: 30, threshold: 1),
            )
            try captureLog(client, id: "durable-stop-in-flight")
            #expect(requestStarted.wait(timeout: .now() + 2) == .success)

            DispatchQueue.global().async {
                client.stopAutomaticDelivery()
                stopFinished.signal()
            }
            #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .manual })
            #expect(stopFinished.wait(timeout: .now() + 0.1) == .timedOut)
            releaseRequest.signal()
            #expect(stopFinished.wait(timeout: .now() + 2) == .success)
            #expect(client.pendingEvents() == 1)
        }

        let recovered = try makeClient()
        try recovered.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
        #expect(recovered.pendingEvents() == 1)
        #expect(try recovered.previewJSON().contains("durable-stop-in-flight"))
    }

    @Test("shutdown preserves storage pause when accepted bytes cannot be acknowledged")
    func shutdownPreservesStoragePauseWhenAcknowledgementFails() throws {
        let parent = try temporaryStorageParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let owned = parent.appendingPathComponent("logbrew-delivery-v1", isDirectory: true)
        let client = try makeClient(maxRetries: 0)
        try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
        try captureLog(client, id: "durable-ack-failure")
        let transport = ThreadSafeScriptedTransport(statuses: [202]) { _ in
            try? FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: owned.path)
        }

        do {
            _ = try client.shutdown(transport: transport)
            Issue.record("shutdown accepted an uncommitted durable acknowledgement")
        } catch let error as SdkError {
            #expect(error.code == "storage_error")
        }
        #expect(client.deliveryHealth().state == .paused)
        #expect(client.deliveryHealth().pauseReason == .storage)
        #expect(client.pendingEvents() == 1)

        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: owned.path)
        try client.purgeDurableDelivery()
    }

    private func blockedStorageOperations(client: LogBrewClient) -> [() throws -> Void] {
        [
            { try captureLog(client, id: "must-not-bypass-corrupt-storage") },
            { _ = try client.flush(transport: RecordingTransport.alwaysAccept()) },
            { _ = try client.shutdown(transport: RecordingTransport.alwaysAccept()) },
            {
                try client.startAutomaticDelivery(
                    transport: RecordingTransport.alwaysAccept(),
                    options: AutomaticDeliveryOptions(),
                )
            },
        ]
    }
}
