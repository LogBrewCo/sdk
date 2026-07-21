import Foundation
@_spi(CrashReplay) import LogBrew

@objc(LBWNativeCrashMechanism)
public enum NativeCrashMechanism: Int, Sendable {
    case signal
    case machException
    case cppException
    case objectiveCException
    case memoryTermination
    case deadlock
    case unknown

    public var name: String {
        switch self {
        case .signal:
            "signal"
        case .machException:
            "mach"
        case .cppException:
            "cpp_exception"
        case .objectiveCException:
            "nsexception"
        case .memoryTermination:
            "memory_termination"
        case .deadlock:
            "deadlock"
        case .unknown:
            "unknown"
        }
    }
}

@objc(LBWNativeCrashLifecycleState)
public enum NativeCrashLifecycleState: Int, Sendable {
    case idle
    case installed
    case replaying
    case failed
    case stopped
}

@objc(LBWNativeCrashOutcome)
public enum NativeCrashOutcome: Int, Sendable {
    case none
    case acknowledged
    case retained
    case purged
    case failed
    case discarded
}

public enum NativeCrashErrorCode: String, Sendable {
    case invalidConfiguration = "crash_invalid_configuration"
    case storageUnsupported = "crash_storage_unsupported"
    case ownershipConflict = "crash_capture_owned"
    case notInstalled = "crash_capture_not_installed"
    case engineInstallFailed = "crash_engine_install_failed"
    case replayBusy = "crash_replay_busy"
    case reportCorrupt = "crash_report_corrupt"
    case reportChanged = "crash_report_changed"
    case reportDeletionFailed = "crash_report_delete_failed"
    case processChanged = "crash_process_changed"
}

public struct NativeCrashError: Error, CustomNSError, LocalizedError, Sendable {
    public let code: NativeCrashErrorCode

    init(_ code: NativeCrashErrorCode) {
        self.code = code
    }

    public static var errorDomain: String {
        "co.logbrew.native-crash"
    }

    public var errorCode: Int {
        switch code {
        case .invalidConfiguration: 1
        case .storageUnsupported: 2
        case .ownershipConflict: 3
        case .notInstalled: 4
        case .engineInstallFailed: 5
        case .replayBusy: 6
        case .reportCorrupt: 7
        case .reportChanged: 8
        case .reportDeletionFailed: 9
        case .processChanged: 10
        }
    }

    public var errorDescription: String? {
        code.rawValue
    }

    public var errorUserInfo: [String: Any] {
        [NSLocalizedDescriptionKey: code.rawValue]
    }
}

@objc(LBWNativeCrashConfiguration)
@objcMembers
public final class NativeCrashConfiguration: NSObject, @unchecked Sendable {
    public let storageDirectory: URL
    public let maxStoredReports: Int
    public let maxReplayBytes: Int

    public init(
        storageDirectory: URL,
        maxStoredReports: Int = 5,
        maxReplayBytes: Int = 4 * 1024 * 1024,
    ) throws {
        guard storageDirectory.isFileURL,
              !storageDirectory.path.isEmpty,
              storageDirectory.path != "/",
              (1 ... 32).contains(maxStoredReports),
              (1024 ... 16 * 1024 * 1024).contains(maxReplayBytes)
        else {
            throw NativeCrashError(.invalidConfiguration)
        }

        let normalizedDirectory = CrashStorageDirectory.normalized(storageDirectory)
        guard normalizedDirectory.path != "/",
              !["", ".", ".."].contains(storageDirectory.lastPathComponent)
        else {
            throw NativeCrashError(.invalidConfiguration)
        }
        self.storageDirectory = normalizedDirectory
        self.maxStoredReports = maxStoredReports
        self.maxReplayBytes = maxReplayBytes
    }
}

@objc(LBWNativeCrashRecord)
@objcMembers
public final class NativeCrashRecord: NSObject, @unchecked Sendable {
    public let eventID: String
    public let timestamp: String
    public let mechanism: NativeCrashMechanism

    private let nativeStackFrames: [NativeStackFrame]?
    let reportID: Int64
    let digest: Data
    let ownerNonce: UUID

    init(
        eventID: String,
        timestamp: String,
        mechanism: NativeCrashMechanism,
        nativeStackFrames: [NativeStackFrame]?,
        reportID: Int64,
        digest: Data,
        ownerNonce: UUID,
    ) {
        self.eventID = eventID
        self.timestamp = timestamp
        self.mechanism = mechanism
        self.nativeStackFrames = nativeStackFrames
        self.reportID = reportID
        self.digest = digest
        self.ownerNonce = ownerNonce
    }

    @nonobjc
    public func enqueue(in client: LogBrewClient) throws {
        let existing = try existingEvent(in: client)
        if existing == .matching {
            return
        }
        if existing == .collision {
            throw NativeCrashError(.reportChanged)
        }

        try client.issueDetached(
            eventID,
            timestamp: timestamp,
            attributes: issueAttributes,
        )
    }

    override public var description: String {
        "NativeCrashRecord(mechanism: \(mechanism.name))"
    }

    private var issueAttributes: IssueAttributes {
        IssueAttributes(
            title: "Native application crash",
            level: .fatal,
            metadata: [
                "crash.mechanism": .string(mechanism.name),
                "crash.replayed": .bool(true),
            ],
            nativeStackFrames: nativeStackFrames,
        )
    }

    private func existingEvent(in client: LogBrewClient) throws -> ExistingEvent {
        guard let data = try client.previewJSON().data(using: .utf8),
              let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let events = payload["events"] as? [[String: Any]]
        else {
            throw NativeCrashError(.reportChanged)
        }
        guard let event = events.first(where: { $0["id"] as? String == eventID }) else {
            return .absent
        }
        guard event["type"] as? String == "issue",
              event["timestamp"] as? String == timestamp,
              let attributes = event["attributes"] as? [String: Any],
              attributes["title"] as? String == "Native application crash",
              attributes["level"] as? String == "critical",
              attributes["message"] == nil,
              let metadata = attributes["metadata"] as? [String: Any],
              metadata as NSDictionary == [
                  "crash.mechanism": mechanism.name,
                  "crash.replayed": true,
              ],
              nativeStackFramesMatch(attributes["nativeStackFrames"])
        else {
            return .collision
        }
        return .matching
    }

    private func nativeStackFramesMatch(_ value: Any?) -> Bool {
        guard let nativeStackFrames else {
            return value == nil
        }
        guard let frames = value as? [[String: Any]], frames.count == nativeStackFrames.count else {
            return false
        }
        return zip(frames, nativeStackFrames).allSatisfy { frame, expected in
            frame as NSDictionary == [
                "imageUuid": expected.imageUuid,
                "architecture": expected.architecture.rawValue,
                "instructionOffset": expected.instructionOffset,
            ] as NSDictionary
        }
    }
}

private enum ExistingEvent {
    case absent
    case matching
    case collision
}

@objc(LBWNativeCrashReplayResult)
@objcMembers
public final class NativeCrashReplayResult: NSObject, @unchecked Sendable {
    public let attempted: Int
    public let acknowledged: Int
    public let discarded: Int
    public let pending: Int

    init(attempted: Int, acknowledged: Int, discarded: Int, pending: Int) {
        self.attempted = attempted
        self.acknowledged = acknowledged
        self.discarded = discarded
        self.pending = pending
    }
}

@objc(LBWNativeCrashStatus)
@objcMembers
public final class NativeCrashStatus: NSObject, @unchecked Sendable {
    public let lifecycle: NativeCrashLifecycleState
    public let pending: Int
    public let acknowledged: Int
    public let discarded: Int
    public let lastOutcome: NativeCrashOutcome

    init(
        lifecycle: NativeCrashLifecycleState,
        pending: Int,
        acknowledged: Int,
        discarded: Int,
        lastOutcome: NativeCrashOutcome,
    ) {
        self.lifecycle = lifecycle
        self.pending = pending
        self.acknowledged = acknowledged
        self.discarded = discarded
        self.lastOutcome = lastOutcome
    }
}
