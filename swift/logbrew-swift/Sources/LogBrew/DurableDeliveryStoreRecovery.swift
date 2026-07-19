import Darwin
import Foundation

extension DurableDeliveryStore {
    static func loadRecovery(from directory: URL, sdk: SDKInfo, fileManager: FileManager) throws -> Recovery {
        let children = try recoveryChildren(in: directory, fileManager: fileManager)
        var events: [(UInt64, RecoveredEvent)] = []
        var prefix: RecoveredPrefix?

        for child in children where child.lastPathComponent != lockName {
            let values = try resourceValues(for: child)
            guard values.isSymbolicLink != true, values.isRegularFile == true else {
                throw DurableStoreFailure.corrupt
            }
            try hardenOwnedFile(child, fileManager: fileManager)
            if child.lastPathComponent == prefixName {
                guard prefix == nil else {
                    throw DurableStoreFailure.corrupt
                }
                prefix = try recoverPrefix(from: child, values: values, sdk: sdk)
            } else {
                try events.append(recoverEvent(from: child, values: values, sdk: sdk))
            }
        }

        events.sort { $0.0 < $1.0 }
        let recovered = events.map(\.1)
        try validateRecovery(events: recovered, prefix: prefix)
        return Recovery(events: recovered, prefix: prefix)
    }

    static func validateParent(_ parent: URL, fileManager: FileManager) throws {
        guard parent.isFileURL else {
            throw DurableStoreFailure.invalidLocation
        }
        let values = try resourceValues(for: parent)
        guard values.isSymbolicLink != true, values.isDirectory == true else {
            throw DurableStoreFailure.invalidLocation
        }
        let permissions = try permissions(at: parent, fileManager: fileManager)
        guard permissions & 0o022 == 0 else {
            throw DurableStoreFailure.invalidLocation
        }
    }

    static func prepareOwnedDirectory(_ directory: URL, fileManager: FileManager) throws {
        if fileManager.fileExists(atPath: directory.path) {
            try validateDirectory(directory, fileManager: fileManager)
        } else {
            do {
                try fileManager.createDirectory(
                    at: directory,
                    withIntermediateDirectories: false,
                    attributes: ownedDirectoryAttributes,
                )
            } catch {
                throw DurableStoreFailure.inputOutput
            }
        }
        do {
            try fileManager.setAttributes(ownedDirectoryAttributes, ofItemAtPath: directory.path)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var mutableDirectory = directory
            try mutableDirectory.setResourceValues(values)
        } catch {
            throw DurableStoreFailure.inputOutput
        }
    }

    static func validateDirectory(_ directory: URL, fileManager: FileManager) throws {
        let values = try resourceValues(for: directory)
        guard values.isSymbolicLink != true, values.isDirectory == true else {
            throw DurableStoreFailure.invalidLocation
        }
        let permissions = try permissions(at: directory, fileManager: fileManager)
        guard permissions & 0o077 == 0 else {
            throw DurableStoreFailure.invalidLocation
        }
    }

    static func acquireLock(in directory: URL, fileManager: FileManager) throws -> FileHandle {
        let lock = directory.appendingPathComponent(lockName, isDirectory: false)
        if !fileManager.fileExists(atPath: lock.path) {
            guard fileManager.createFile(atPath: lock.path, contents: Data(), attributes: ownedFileAttributes) else {
                throw DurableStoreFailure.inputOutput
            }
        }
        do {
            let values = try resourceValues(for: lock)
            guard values.isSymbolicLink != true, values.isRegularFile == true else {
                throw DurableStoreFailure.invalidLocation
            }
            try hardenOwnedFile(lock, fileManager: fileManager)
            let handle = try FileHandle(forUpdating: lock)
            guard flock(handle.fileDescriptor, LOCK_EX | LOCK_NB) == 0 else {
                try? handle.close()
                throw DurableStoreFailure.owned
            }
            return handle
        } catch let failure as DurableStoreFailure {
            throw failure
        } catch {
            throw DurableStoreFailure.inputOutput
        }
    }

    static func releaseLock(_ handle: FileHandle) {
        _ = flock(handle.fileDescriptor, LOCK_UN)
        try? handle.close()
    }

    static func resourceValues(for url: URL) throws -> URLResourceValues {
        do {
            return try url.resourceValues(forKeys: [
                .fileSizeKey,
                .isDirectoryKey,
                .isRegularFileKey,
                .isSymbolicLinkKey,
            ])
        } catch {
            throw DurableStoreFailure.inputOutput
        }
    }

    static func permissions(at url: URL, fileManager: FileManager) throws -> Int {
        do {
            let attributes = try fileManager.attributesOfItem(atPath: url.path)
            guard let permissions = attributes[.posixPermissions] as? NSNumber else {
                throw DurableStoreFailure.invalidLocation
            }
            return permissions.intValue
        } catch let failure as DurableStoreFailure {
            throw failure
        } catch {
            throw DurableStoreFailure.inputOutput
        }
    }

    static func hardenOwnedFile(_ file: URL, fileManager: FileManager) throws {
        do {
            try fileManager.setAttributes(ownedFileAttributes, ofItemAtPath: file.path)
        } catch {
            throw DurableStoreFailure.inputOutput
        }
    }

    static var ownedDirectoryAttributes: [FileAttributeKey: Any] {
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        #if os(iOS) || os(tvOS) || os(watchOS)
            attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        return attributes
    }

    static var ownedFileAttributes: [FileAttributeKey: Any] {
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #if os(iOS) || os(tvOS) || os(watchOS)
            attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        return attributes
    }

    static func eventName(sequence: UInt64) -> String {
        String(format: "event-%020llu.json", sequence)
    }

    static func sequence(from recovered: RecoveredEvent) throws -> UInt64 {
        try sequence(from: recovered.recordName)
    }

    static func sequence(from name: String) throws -> UInt64 {
        let prefix = "event-"
        let suffix = ".json"
        guard name.hasPrefix(prefix), name.hasSuffix(suffix) else {
            throw DurableStoreFailure.corrupt
        }
        let start = name.index(name.startIndex, offsetBy: prefix.count)
        let end = name.index(name.endIndex, offsetBy: -suffix.count)
        let digits = String(name[start ..< end])
        guard digits.count == 20,
              digits.allSatisfy(\.isNumber),
              let sequence = UInt64(digits),
              eventName(sequence: sequence) == name
        else {
            throw DurableStoreFailure.corrupt
        }
        return sequence
    }

    static func isOwnedName(_ name: String) -> Bool {
        name == prefixName || (try? sequence(from: name)) != nil
    }

    static func encode(_ value: some Encodable) throws -> Data {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            return try encoder.encode(value)
        } catch {
            throw DurableStoreFailure.inputOutput
        }
    }

    static func encodeEvent(_ event: Event) throws -> Data {
        try encode(event)
    }

    static func checksum(_ data: Data) -> String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in data {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return String(format: "%016llx", hash)
    }

    private static func recoveryChildren(in directory: URL, fileManager: FileManager) throws -> [URL] {
        do {
            return try fileManager.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey],
                options: [],
            )
        } catch {
            throw DurableStoreFailure.inputOutput
        }
    }

    private static func recoverPrefix(
        from file: URL,
        values: URLResourceValues,
        sdk: SDKInfo,
    ) throws -> RecoveredPrefix {
        guard let size = values.fileSize, size <= maxPrefixRecordBytes else {
            throw DurableStoreFailure.corrupt
        }
        let record = try decodePrefixRecord(from: file)
        guard record.version == version, record.sdk == sdk else {
            throw DurableStoreFailure.corrupt
        }
        return RecoveredPrefix(
            body: record.body,
            eventRecordNames: record.eventRecordNames,
            encodedBytes: record.encodedBytes,
        )
    }

    private static func recoverEvent(
        from file: URL,
        values: URLResourceValues,
        sdk: SDKInfo,
    ) throws -> (UInt64, RecoveredEvent) {
        let name = file.lastPathComponent
        let sequence = try sequence(from: name)
        guard let size = values.fileSize, size <= maxEventRecordBytes else {
            throw DurableStoreFailure.corrupt
        }
        let record = try decodeEventRecord(from: file)
        let encodedEvent = try encodeEvent(record.event)
        guard record.version == version,
              record.sequence == sequence,
              record.sdk == sdk,
              record.encodedBytes == encodedEvent.count,
              record.checksum == checksum(encodedEvent)
        else {
            throw DurableStoreFailure.corrupt
        }
        return (
            sequence,
            RecoveredEvent(event: record.event, encodedBytes: record.encodedBytes, recordName: name),
        )
    }

    private static func validateRecovery(events: [RecoveredEvent], prefix: RecoveredPrefix?) throws {
        guard events.count <= DeliveryEngine.maxQueuedEvents,
              events.reduce(0, { $0 + $1.encodedBytes }) <= DeliveryEngine.maxQueuedBytes
        else {
            throw DurableStoreFailure.corrupt
        }
        guard let prefix else {
            return
        }
        let frozenEvents = events.prefix(prefix.eventRecordNames.count)
        guard !prefix.eventRecordNames.isEmpty,
              prefix.eventRecordNames.count <= DeliveryEngine.maxRequestEvents,
              prefix.body.count <= DeliveryEngine.maxRequestBytes,
              frozenEvents.map(\.recordName) == prefix.eventRecordNames,
              frozenEvents.reduce(0, { $0 + $1.encodedBytes }) == prefix.encodedBytes
        else {
            throw DurableStoreFailure.corrupt
        }
    }

    private static func decodeEventRecord(from file: URL) throws -> EventRecord {
        do {
            return try JSONDecoder().decode(EventRecord.self, from: read(file, maxBytes: maxEventRecordBytes))
        } catch let failure as DurableStoreFailure {
            throw failure
        } catch {
            throw DurableStoreFailure.corrupt
        }
    }

    private static func decodePrefixRecord(from file: URL) throws -> PrefixRecord {
        do {
            return try JSONDecoder().decode(PrefixRecord.self, from: read(file, maxBytes: maxPrefixRecordBytes))
        } catch let failure as DurableStoreFailure {
            throw failure
        } catch {
            throw DurableStoreFailure.corrupt
        }
    }

    private static func read(_ file: URL, maxBytes: Int) throws -> Data {
        do {
            let data = try Data(contentsOf: file, options: [.mappedIfSafe])
            guard data.count <= maxBytes else {
                throw DurableStoreFailure.corrupt
            }
            return data
        } catch let failure as DurableStoreFailure {
            throw failure
        } catch {
            throw DurableStoreFailure.corrupt
        }
    }
}
