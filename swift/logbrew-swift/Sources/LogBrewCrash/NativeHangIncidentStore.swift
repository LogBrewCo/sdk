import CryptoKit
import Darwin
import Foundation
@_spi(CrashReplay) import LogBrew

enum NativeHangIncidentState: String, Codable {
    case ongoing
    case recovered
}

struct NativeHangIncident: Codable, Equatable {
    private let version: Int
    let eventID: String
    let timestamp: String
    var state: NativeHangIncidentState
    let artifactIdentity: NativeArtifactIdentityValue
    let nativeStackFrames: [NativeStackFrame]

    init(
        eventID: String,
        timestamp: String,
        state: NativeHangIncidentState,
        identity: NativeArtifactIdentity,
        nativeStackFrames: [NativeStackFrame],
    ) {
        version = 1
        self.eventID = eventID
        self.timestamp = timestamp
        self.state = state
        artifactIdentity = NativeArtifactIdentityValue(identity)
        self.nativeStackFrames = nativeStackFrames
    }

    func validated() throws -> NativeHangIncident {
        guard version == 1,
              UUID(uuidString: eventID)?.uuidString.lowercased() == eventID,
              normalizedTimestamp(timestamp) == timestamp,
              (1 ... 32).contains(nativeStackFrames.count),
              nativeStackFrames.allSatisfy(validFrame)
        else {
            throw NativeCrashError(.reportCorrupt)
        }
        do {
            _ = try artifactIdentity.validatedIdentity()
        } catch {
            throw NativeCrashError(.reportCorrupt)
        }
        return self
    }

    func digest() throws -> Data {
        try Data(SHA256.hash(data: encoded()))
    }

    func makeRecord(ownerNonce: UUID) throws -> NativeCrashRecord {
        try NativeCrashRecord(
            eventID: eventID,
            timestamp: timestamp,
            mechanism: .deadlock,
            nativeStackFrames: nativeStackFrames,
            artifactIdentity: artifactIdentity.validatedIdentity(),
            hangState: state,
            source: .hang(eventID: eventID),
            digest: digest(),
            ownerNonce: ownerNonce,
        )
    }

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(self)
        guard data.count <= NativeHangIncidentFileStore.maxBytes else {
            throw NativeCrashError(.reportCorrupt)
        }
        return data
    }

    private func validFrame(_ frame: NativeStackFrame) -> Bool {
        UUID(uuidString: frame.imageUuid)?.uuidString.lowercased() == frame.imageUuid
            && frame.instructionOffset.utf8.count == 16
            && frame.instructionOffset.utf8.allSatisfy {
                ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
            }
    }

    private func normalizedTimestamp(_ value: String) -> String? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: value) else {
            return nil
        }
        return formatter.string(from: date)
    }
}

protocol HangIncidentStoring: AnyObject, Sendable {
    func read() throws -> NativeHangIncident?
    func write(_ incident: NativeHangIncident) throws
    func markRecovered(eventID: String) throws
    func delete(eventID: String) throws
    func purge() throws
}

final class NativeHangIncidentFileStore: HangIncidentStoring, @unchecked Sendable {
    static let recordName = "hang-v1.record"
    static let maxBytes = 16 * 1024

    private let directory: URL
    private let recordURL: URL
    private let temporaryURL: URL
    private let lease: CrashStorageLease
    private let lock = NSLock()

    init(directory: URL) throws {
        self.directory = CrashStorageDirectory.normalized(directory)
        lease = try CrashStorageDirectory.prepare(self.directory)
        recordURL = self.directory.appendingPathComponent(Self.recordName, isDirectory: false)
        temporaryURL = self.directory.appendingPathComponent("\(Self.recordName).tmp", isDirectory: false)
        try removeStaleTemporary()
    }

    func read() throws -> NativeHangIncident? {
        lock.lock()
        defer { lock.unlock() }
        return try readLocked()
    }

    func write(_ incident: NativeHangIncident) throws {
        lock.lock()
        defer { lock.unlock() }
        guard try readLocked() == nil else {
            throw NativeCrashError(.reportChanged)
        }
        try writeLocked(incident.validated())
    }

    func markRecovered(eventID: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard var incident = try readLocked(), incident.eventID == eventID else {
            throw NativeCrashError(.reportChanged)
        }
        incident.state = .recovered
        try writeLocked(incident)
    }

    func delete(eventID: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let incident = try readLocked(), incident.eventID == eventID else {
            throw NativeCrashError(.reportChanged)
        }
        try lease.verify()
        guard unlink(recordURL.path) == 0 else {
            throw NativeCrashError(.reportDeletionFailed)
        }
        try lease.synchronize()
        guard try readLocked() == nil else {
            throw NativeCrashError(.reportDeletionFailed)
        }
    }

    func purge() throws {
        lock.lock()
        defer { lock.unlock() }
        try lease.verify()
        if unlink(recordURL.path) != 0, errno != ENOENT {
            throw NativeCrashError(.reportDeletionFailed)
        }
        try lease.synchronize()
    }

    private func readLocked() throws -> NativeHangIncident? {
        try lease.verify()
        let descriptor = open(recordURL.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0 {
            if errno == ENOENT {
                return nil
            }
            throw NativeCrashError(.storageUnsupported)
        }
        defer { close(descriptor) }

        var information = stat()
        guard fstat(descriptor, &information) == 0,
              information.st_mode & S_IFMT == S_IFREG,
              information.st_mode & 0o077 == 0,
              information.st_size > 0,
              information.st_size <= Self.maxBytes
        else {
            throw NativeCrashError(.reportCorrupt)
        }
        var data = Data(count: Int(information.st_size))
        let count = data.withUnsafeMutableBytes { buffer -> Int in
            guard let base = buffer.baseAddress else {
                return -1
            }
            var consumed = 0
            while consumed < buffer.count {
                let result = Darwin.read(descriptor, base.advanced(by: consumed), buffer.count - consumed)
                if result <= 0 {
                    return -1
                }
                consumed += result
            }
            return consumed
        }
        guard count == data.count else {
            throw NativeCrashError(.reportCorrupt)
        }
        do {
            return try JSONDecoder().decode(NativeHangIncident.self, from: data).validated()
        } catch let error as NativeCrashError {
            throw error
        } catch {
            throw NativeCrashError(.reportCorrupt)
        }
    }

    private func writeLocked(_ incident: NativeHangIncident) throws {
        try lease.verify()
        let data = try incident.encoded()
        try removeStaleTemporary()
        let descriptor = open(
            temporaryURL.path,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
            S_IRUSR | S_IWUSR,
        )
        guard descriptor >= 0 else {
            throw NativeCrashError(.storageUnsupported)
        }

        var succeeded = false
        defer {
            close(descriptor)
            if !succeeded {
                unlink(temporaryURL.path)
            }
        }
        let written = data.withUnsafeBytes { buffer -> Bool in
            guard let base = buffer.baseAddress else {
                return false
            }
            var consumed = 0
            while consumed < buffer.count {
                let result = Darwin.write(descriptor, base.advanced(by: consumed), buffer.count - consumed)
                if result <= 0 {
                    return false
                }
                consumed += result
            }
            return true
        }
        guard written,
              fsync(descriptor) == 0,
              rename(temporaryURL.path, recordURL.path) == 0
        else {
            throw NativeCrashError(.storageUnsupported)
        }
        try lease.synchronize()
        succeeded = true
    }

    private func removeStaleTemporary() throws {
        var information = stat()
        if lstat(temporaryURL.path, &information) != 0 {
            if errno == ENOENT {
                return
            }
            throw NativeCrashError(.storageUnsupported)
        }
        guard information.st_mode & S_IFMT == S_IFREG,
              information.st_mode & 0o077 == 0,
              unlink(temporaryURL.path) == 0
        else {
            throw NativeCrashError(.storageUnsupported)
        }
        try lease.synchronize()
    }
}
