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
    public let artifactIdentity: NativeArtifactIdentity?
    @nonobjc public let hangWatchdog: NativeHangWatchdogConfiguration?

    public convenience init(
        storageDirectory: URL,
        maxStoredReports: Int = 5,
        maxReplayBytes: Int = 4 * 1024 * 1024,
    ) throws {
        try self.init(
            storageDirectory: storageDirectory,
            maxStoredReports: maxStoredReports,
            maxReplayBytes: maxReplayBytes,
            artifactIdentity: nil,
            hangWatchdog: nil,
        )
    }

    @nonobjc
    public init(
        storageDirectory: URL,
        maxStoredReports: Int = 5,
        maxReplayBytes: Int = 4 * 1024 * 1024,
        artifactIdentity: NativeArtifactIdentity?,
        hangWatchdog: NativeHangWatchdogConfiguration?,
    ) throws {
        guard storageDirectory.isFileURL,
              !storageDirectory.path.isEmpty,
              storageDirectory.path != "/",
              (1 ... 32).contains(maxStoredReports),
              (1024 ... 16 * 1024 * 1024).contains(maxReplayBytes),
              hangWatchdog == nil || artifactIdentity != nil
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
        self.artifactIdentity = artifactIdentity
        self.hangWatchdog = hangWatchdog
    }
}

@objc(LBWNativeCrashRecord)
@objcMembers
public final class NativeCrashRecord: NSObject, @unchecked Sendable {
    public let eventID: String
    public let timestamp: String
    public let mechanism: NativeCrashMechanism

    private let nativeStackFrames: [NativeStackFrame]?
    private let artifactIdentity: NativeArtifactIdentity?
    private let context: TelemetryContext?
    private let correlationState: NativeCrashCorrelationState?
    private let hangState: NativeHangIncidentState?
    private let hangDurationMs: Double?
    let source: NativeCrashRecordSource
    let digest: Data
    let ownerNonce: UUID

    init(
        eventID: String,
        timestamp: String,
        mechanism: NativeCrashMechanism,
        nativeStackFrames: [NativeStackFrame]?,
        artifactIdentity: NativeArtifactIdentity?,
        context: TelemetryContext?,
        correlationState: NativeCrashCorrelationState? = nil,
        hangState: NativeHangIncidentState?,
        hangDurationMs: Double? = nil,
        source: NativeCrashRecordSource,
        digest: Data,
        ownerNonce: UUID,
    ) {
        self.eventID = eventID
        self.timestamp = timestamp
        self.mechanism = mechanism
        self.nativeStackFrames = nativeStackFrames
        self.artifactIdentity = artifactIdentity
        self.context = context
        self.correlationState = correlationState
        self.hangState = hangState
        self.hangDurationMs = hangDurationMs
        self.source = source
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
        "NativeCrashRecord(mechanism: \(mechanism.name), configuredIdentity: \(artifactIdentity != nil))"
    }

    private var issueAttributes: IssueAttributes {
        var metadata: Metadata = [
            "crash.mechanism": .string(mechanism.name),
            "crash.replayed": .bool(true),
        ]
        if let artifactIdentity {
            metadata["projectId"] = .string(artifactIdentity.projectId)
            metadata["release"] = .string(artifactIdentity.release)
            metadata["environment"] = .string(artifactIdentity.environment)
            metadata["service"] = .string(artifactIdentity.service)
        }
        if let correlationState {
            metadata["crash.correlation"] = .string(correlationState.rawValue)
        }
        if let hangState {
            metadata["crash.handled"] = .bool(hangState == .recovered)
        }
        if let hangDurationMs {
            metadata["durationMs"] = .double(hangDurationMs)
        }
        return IssueAttributes(
            title: hangState == nil ? "Native application crash" : "Native application hang",
            level: hangState == .recovered ? .error : .fatal,
            exception: issueException,
            exceptionChain: nativeCrashExceptionChain(for: issueException),
            metadata: metadata,
            context: context,
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
              attributesMatch(attributes)
        else {
            return .collision
        }
        return .matching
    }

    private var issueException: IssueException {
        IssueException(
            type: hangState == nil ? "AppleNativeCrash" : "AppleNativeHang",
            mechanism: IssueExceptionMechanism(
                type: mechanism.name,
                handled: hangState == .recovered,
            ),
        )
    }

    private func attributesMatch(_ actual: [String: Any]) -> Bool {
        guard let encoded = try? JSONEncoder().encode(issueAttributes),
              var expected = try? JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        else {
            return false
        }
        for legacyField in ["exception", "exceptionChain", "context"] where actual[legacyField] == nil {
            expected.removeValue(forKey: legacyField)
        }
        if (actual["metadata"] as? [String: Any])?["crash.correlation"] == nil {
            var metadata = expected["metadata"] as? [String: Any]
            metadata?.removeValue(forKey: "crash.correlation")
            expected["metadata"] = metadata
        }
        return actual as NSDictionary == expected as NSDictionary
    }
}

enum NativeCrashRecordSource: Equatable {
    case engine(reportID: Int64)
    case hang(eventID: String)
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
