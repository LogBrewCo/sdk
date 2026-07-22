import Foundation

enum DurableStoreFailure: Equatable, Error {
    case capacity
    case corrupt
    case invalidLocation
    case inputOutput
    case owned
}

final class DurableDeliveryStore: @unchecked Sendable {
    static let directoryName = "logbrew-delivery-v1"

    struct RecoveredEvent {
        let event: Event
        let encodedBytes: Int
        let recordName: String
    }

    struct RecoveredPrefix {
        let body: Data
        let eventRecordNames: [String]
        let encodedBytes: Int
    }

    struct Recovery {
        let events: [RecoveredEvent]
        let prefix: RecoveredPrefix?
    }

    struct EventRecord: Codable {
        let version: Int
        let sequence: UInt64
        let sdk: SDKInfo
        let encodedBytes: Int
        let checksum: String
        let event: Event
    }

    struct PrefixRecord: Codable {
        let version: Int
        let sdk: SDKInfo
        let eventRecordNames: [String]
        let encodedBytes: Int
        let body: Data
    }

    static let version = 1
    static let prefixName = "frozen-prefix.json"
    static let lockName = ".lock"
    static let maxEventRecordBytes = DeliveryEngine.maxRequestBytes * 2
    static let maxPrefixRecordBytes = DeliveryEngine.maxRequestBytes * 2

    private let fileManager: FileManager
    private let directory: URL
    private let sdk: SDKInfo
    private let lockHandle: FileHandle
    private var recoveredEvents: [RecoveredEvent]
    private var recoveredPrefix: RecoveredPrefix?
    private var nextSequence: UInt64
    private var failed = false

    init(parent: URL, sdk: SDKInfo, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        self.sdk = sdk
        directory = parent.appendingPathComponent(Self.directoryName, isDirectory: true)

        try Self.validateParent(parent, fileManager: fileManager)
        try Self.prepareOwnedDirectory(directory, fileManager: fileManager)
        lockHandle = try Self.acquireLock(in: directory, fileManager: fileManager)

        do {
            let recovery = try Self.loadRecovery(from: directory, sdk: sdk, fileManager: fileManager)
            recoveredEvents = recovery.events
            recoveredPrefix = recovery.prefix
            if let last = recovery.events.last {
                let lastSequence = try Self.sequence(from: last)
                guard lastSequence < UInt64.max else {
                    throw DurableStoreFailure.corrupt
                }
                nextSequence = lastSequence + 1
            } else {
                nextSequence = 1
            }
        } catch {
            Self.releaseLock(lockHandle)
            throw error
        }
    }

    deinit {
        Self.releaseLock(lockHandle)
    }

    func recovery() -> Recovery {
        Recovery(events: recoveredEvents, prefix: recoveredPrefix)
    }

    func append(_ event: Event, encodedBytes: Int) throws -> String {
        try requireHealthy()
        guard recoveredEvents.count < DeliveryEngine.maxQueuedEvents,
              recoveredEvents.reduce(0, { $0 + $1.encodedBytes }) <= DeliveryEngine.maxQueuedBytes - encodedBytes
        else {
            throw DurableStoreFailure.capacity
        }
        guard nextSequence < UInt64.max else {
            throw DurableStoreFailure.corrupt
        }
        let name = Self.eventName(sequence: nextSequence)
        let eventData = try Self.encodeEvent(event)
        guard eventData.count == encodedBytes else {
            throw DurableStoreFailure.corrupt
        }
        let record = EventRecord(
            version: Self.version,
            sequence: nextSequence,
            sdk: sdk,
            encodedBytes: encodedBytes,
            checksum: Self.checksum(eventData),
            event: event,
        )
        let data = try Self.encode(record)
        guard data.count <= Self.maxEventRecordBytes else {
            throw DurableStoreFailure.capacity
        }
        do {
            try write(data, named: name)
        } catch {
            failed = true
            throw error
        }
        recoveredEvents.append(RecoveredEvent(event: event, encodedBytes: encodedBytes, recordName: name))
        nextSequence += 1
        return name
    }

    func appendExisting(_ events: [(event: Event, encodedBytes: Int)]) throws -> [String] {
        guard recoveredEvents.isEmpty, recoveredPrefix == nil else {
            throw DurableStoreFailure.owned
        }
        var names: [String] = []
        do {
            for item in events {
                try names.append(append(item.event, encodedBytes: item.encodedBytes))
            }
            return names
        } catch {
            for name in names {
                try? fileManager.removeItem(at: directory.appendingPathComponent(name, isDirectory: false))
            }
            recoveredEvents.removeAll()
            recoveredPrefix = nil
            nextSequence = 1
            throw error
        }
    }

    func persistPrefix(body: Data, eventRecordNames: [String], encodedBytes: Int) throws {
        try requireHealthy()
        guard !eventRecordNames.isEmpty,
              eventRecordNames.count <= DeliveryEngine.maxRequestEvents,
              body.count <= DeliveryEngine.maxRequestBytes,
              recoveredEvents.prefix(eventRecordNames.count).map(\.recordName) == eventRecordNames
        else {
            throw DurableStoreFailure.corrupt
        }
        if let recoveredPrefix {
            guard recoveredPrefix.body == body,
                  recoveredPrefix.eventRecordNames == eventRecordNames,
                  recoveredPrefix.encodedBytes == encodedBytes
            else {
                throw DurableStoreFailure.corrupt
            }
            return
        }
        let record = PrefixRecord(
            version: Self.version,
            sdk: sdk,
            eventRecordNames: eventRecordNames,
            encodedBytes: encodedBytes,
            body: body,
        )
        let data = try Self.encode(record)
        guard data.count <= Self.maxPrefixRecordBytes else {
            throw DurableStoreFailure.capacity
        }
        do {
            try write(data, named: Self.prefixName)
        } catch {
            failed = true
            throw error
        }
        recoveredPrefix = RecoveredPrefix(
            body: body,
            eventRecordNames: eventRecordNames,
            encodedBytes: encodedBytes,
        )
    }

    func acknowledge(body: Data, eventRecordNames: [String]) throws {
        try requireHealthy()
        guard let prefix = recoveredPrefix,
              prefix.body == body,
              prefix.eventRecordNames == eventRecordNames,
              recoveredEvents.prefix(eventRecordNames.count).map(\.recordName) == eventRecordNames
        else {
            throw DurableStoreFailure.corrupt
        }
        do {
            try fileManager.removeItem(at: directory.appendingPathComponent(Self.prefixName, isDirectory: false))
            for name in eventRecordNames {
                try fileManager.removeItem(at: directory.appendingPathComponent(name, isDirectory: false))
            }
        } catch {
            failed = true
            throw DurableStoreFailure.inputOutput
        }
        recoveredEvents.removeFirst(eventRecordNames.count)
        recoveredPrefix = nil
    }

    static func purge(parent: URL, fileManager: FileManager = .default) throws {
        try validateParent(parent, fileManager: fileManager)
        let directory = parent.appendingPathComponent(directoryName, isDirectory: true)
        guard fileManager.fileExists(atPath: directory.path) else {
            return
        }
        try validateDirectory(directory, fileManager: fileManager)
        let handle = try acquireLock(in: directory, fileManager: fileManager)
        defer { releaseLock(handle) }
        do {
            try fileManager.removeItem(at: directory)
        } catch {
            throw DurableStoreFailure.inputOutput
        }
    }

    private func requireHealthy() throws {
        if failed {
            throw DurableStoreFailure.corrupt
        }
    }

    private func write(_ data: Data, named name: String) throws {
        guard Self.isOwnedName(name) else {
            throw DurableStoreFailure.corrupt
        }
        let destination = directory.appendingPathComponent(name, isDirectory: false)
        do {
            try data.write(to: destination, options: .atomic)
            try Self.hardenOwnedFile(destination, fileManager: fileManager)
        } catch {
            throw DurableStoreFailure.inputOutput
        }
    }
}
