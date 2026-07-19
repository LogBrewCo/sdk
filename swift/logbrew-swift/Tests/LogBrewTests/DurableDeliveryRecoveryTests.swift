import Foundation
@testable import LogBrew
import Testing

@Suite("Durable delivery recovery")
struct DurableDeliveryRecoveryTests {
    @Test("one process owns a durable spool at a time")
    func oneProcessOwnsDurableSpoolAtATime() throws {
        let parent = try durableTemporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let waitingClient = try makeClient()

        do {
            let owner = try makeClient()
            try owner.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
            do {
                try waitingClient.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
                Issue.record("second process owner was accepted")
            } catch let error as SdkError {
                #expect(error.code == "storage_error")
            }
            #expect(waitingClient.deliveryHealth().state == .manual)
        }

        try waitingClient.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
        try captureLog(waitingClient, id: "owned-after-release")
        #expect(waitingClient.pendingEvents() == 1)
    }

    @Test("malformed durable records remain for explicit recovery")
    func malformedRecordRemainsUntilExplicitPurge() throws {
        let parent = try durableTemporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let owned = parent.appendingPathComponent("logbrew-delivery-v1", isDirectory: true)

        do {
            let client = try makeClient()
            try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
            try captureLog(client, id: "malformed-record")
        }

        let record = try #require(
            try FileManager.default.contentsOfDirectory(at: owned, includingPropertiesForKeys: nil)
                .first { $0.lastPathComponent.hasPrefix("event-") },
        )
        try Data(#"{"version":1}"#.utf8).write(to: record, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.path)

        let recovered = try makeClient()
        do {
            try recovered.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
            Issue.record("malformed durable record was accepted")
        } catch let error as SdkError {
            #expect(error.code == "storage_corrupt")
        }
        #expect(recovered.deliveryHealth().pauseReason == .storage)
        #expect(FileManager.default.fileExists(atPath: record.path))
        try recovered.purgeDurableDelivery()
        #expect(!FileManager.default.fileExists(atPath: owned.path))
    }

    @Test("restart retries the exact frozen prefix before later FIFO work")
    func restartRetriesExactPrefixBeforeLaterWork() throws {
        let parent = try durableTemporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let failedTransport = ThreadSafeScriptedTransport(statuses: [503])
        var failedBody = ""

        do {
            let client = try makeClient(maxRetries: 0)
            try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
            for index in 0 ..< 101 {
                try captureLog(client, id: "durable-batch-\(index)")
            }
            do {
                _ = try client.flush(transport: failedTransport)
                Issue.record("retryable durable prefix was accepted")
            } catch let error as SdkError {
                #expect(error.code == "transport_error")
            }
            failedBody = try #require(failedTransport.requestBodies.first)
            #expect(try eventCount(in: failedBody) == 100)
            #expect(!failedBody.contains("durable-batch-100"))
        }

        let recovered = try makeClient(maxRetries: 0)
        try recovered.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
        let acceptedTransport = ThreadSafeScriptedTransport(statuses: [202, 202])
        _ = try recovered.flush(transport: acceptedTransport)

        let bodies = acceptedTransport.requestBodies
        #expect(bodies.count == 2)
        #expect(bodies.first == failedBody)
        #expect(try eventCount(in: bodies[1]) == 1)
        #expect(bodies[1].contains("durable-batch-100"))
        #expect(recovered.pendingEvents() == 0)
    }

    @Test("durable admission stays bounded and FIFO survives restart")
    func boundedQueueSurvivesRestartInFIFOOrder() throws {
        let parent = try durableTemporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }

        do {
            let client = try makeClient()
            try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
            for index in 0 ..< 1000 {
                try captureLog(client, id: "durable-capacity-\(index)")
            }
            do {
                try captureLog(client, id: "durable-capacity-overflow")
                Issue.record("durable queue accepted more than its event bound")
            } catch let error as SdkError {
                #expect(error.code == "queue_full")
            }
            #expect(client.pendingEvents() == 1000)
            #expect(client.deliveryHealth().droppedEvents == 1)
        }

        let recovered = try makeClient()
        try recovered.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
        let json = try recovered.previewJSON()
        let object = try #require(
            try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
        )
        let events = try #require(object["events"] as? [[String: Any]])
        #expect(events.count == 1000)
        #expect(events.first?["id"] as? String == "durable-capacity-0")
        #expect(events.last?["id"] as? String == "durable-capacity-999")
    }

    @Test("concurrent captures remain complete across restart")
    func concurrentCapturesRemainCompleteAcrossRestart() throws {
        let parent = try durableTemporaryParent()
        defer { try? FileManager.default.removeItem(at: parent) }
        let failures = DurableFailureCollector()

        do {
            let client = try makeClient()
            try client.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
            DispatchQueue.concurrentPerform(iterations: 64) { index in
                do {
                    try captureLog(client, id: "durable-concurrent-\(index)")
                } catch {
                    failures.append(error)
                }
            }
            #expect(failures.count == 0)
            #expect(client.pendingEvents() == 64)
        }

        let recovered = try makeClient()
        try recovered.enableDurableDelivery(options: DurableDeliveryOptions(directory: parent))
        let object = try #require(
            try JSONSerialization.jsonObject(with: Data(recovered.previewJSON().utf8)) as? [String: Any],
        )
        let events = try #require(object["events"] as? [[String: Any]])
        let ids = Set(events.compactMap { $0["id"] as? String })
        #expect(events.count == 64)
        #expect(ids == Set((0 ..< 64).map { "durable-concurrent-\($0)" }))
    }
}

private func durableTemporaryParent() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("logbrew-durable-recovery-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700],
    )
    return directory
}

private final class DurableFailureCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var failures: [Error] = []

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return failures.count
    }

    func append(_ error: Error) {
        lock.lock()
        failures.append(error)
        lock.unlock()
    }
}
