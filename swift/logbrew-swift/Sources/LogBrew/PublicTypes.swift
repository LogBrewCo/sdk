public enum IssueLevel: String, Codable, Sendable {
    case trace
    case debug
    case info
    case warn
    case warning
    case error
    case fatal
    case critical

    public var canonicalValue: String {
        switch self {
        case .trace, .debug, .info:
            "info"
        case .warn, .warning:
            "warning"
        case .error:
            "error"
        case .fatal, .critical:
            "critical"
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(canonicalValue)
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard let level = IssueLevel(rawValue: value) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported issue level")
        }
        self = level
    }
}

public enum LogLevel: String, Codable, Sendable {
    case trace
    case debug
    case info
    case warn
    case warning
    case error
    case fatal
    case critical

    public var canonicalValue: String {
        switch self {
        case .trace, .debug, .info:
            "info"
        case .warn, .warning:
            "warning"
        case .error:
            "error"
        case .fatal, .critical:
            "critical"
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(canonicalValue)
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard let level = LogLevel(rawValue: value) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported log level")
        }
        self = level
    }
}

public enum SpanStatus: String, Codable, Sendable {
    case ok
    case error
}

public enum ActionStatus: String, Codable, Sendable {
    case queued
    case running
    case success
    case failure
}

public enum MetricKind: String, Codable, Sendable {
    case counter
    case gauge
    case histogram
}

public enum MetricTemporality: String, Codable, Sendable {
    case delta
    case cumulative
    case instant
}

public struct ClientConfig: Equatable, Sendable {
    public let apiKey: String
    public let sdkName: String
    public let sdkVersion: String
    public let maxRetries: Int
    public let context: TelemetryContext?
    public let includeAutomaticContext: Bool

    public init(
        apiKey: String,
        sdkName: String,
        sdkVersion: String,
        maxRetries: Int = 2,
        context: TelemetryContext? = nil,
        includeAutomaticContext: Bool = true,
    ) {
        self.apiKey = apiKey
        self.sdkName = sdkName
        self.sdkVersion = sdkVersion
        self.maxRetries = maxRetries
        self.context = context
        self.includeAutomaticContext = includeAutomaticContext
    }
}

public struct ReleaseAttributes: Codable, Equatable, Sendable {
    public let version: String
    public let commit: String?
    public let notes: String?
    public let metadata: Metadata?
    public let context: TelemetryContext?

    public init(
        version: String,
        commit: String? = nil,
        notes: String? = nil,
        metadata: Metadata? = nil,
        context: TelemetryContext? = nil,
    ) {
        self.version = version
        self.commit = commit
        self.notes = notes
        self.metadata = metadata
        self.context = context
    }
}

public struct EnvironmentAttributes: Codable, Equatable, Sendable {
    public let name: String
    public let region: String?
    public let metadata: Metadata?
    public let context: TelemetryContext?

    public init(
        name: String,
        region: String? = nil,
        metadata: Metadata? = nil,
        context: TelemetryContext? = nil,
    ) {
        self.name = name
        self.region = region
        self.metadata = metadata
        self.context = context
    }
}

public struct IssueAttributes: Codable, Equatable, Sendable {
    public let title: String
    public let level: IssueLevel
    public let message: String?
    public let exception: IssueException?
    public let stackFrames: [IssueStackFrame]?
    public let breadcrumbs: [IssueBreadcrumb]?
    public let breadcrumbsTruncated: Bool?
    public let metadata: Metadata?
    public let context: TelemetryContext?
    @_spi(CrashReplay) public let nativeStackFrames: [NativeStackFrame]?

    public init(
        title: String,
        level: IssueLevel,
        message: String? = nil,
        exception: IssueException? = nil,
        stackFrames: [IssueStackFrame]? = nil,
        breadcrumbs: [IssueBreadcrumb]? = nil,
        breadcrumbsTruncated: Bool? = nil,
        metadata: Metadata? = nil,
        context: TelemetryContext? = nil,
    ) {
        self.title = title
        self.level = level
        self.message = message
        self.exception = exception
        self.stackFrames = stackFrames
        self.breadcrumbs = breadcrumbs
        self.breadcrumbsTruncated = breadcrumbsTruncated
        self.metadata = metadata
        self.context = context
        nativeStackFrames = nil
    }

    @_spi(CrashReplay)
    public init(
        title: String,
        level: IssueLevel,
        message: String? = nil,
        exception: IssueException? = nil,
        stackFrames: [IssueStackFrame]? = nil,
        breadcrumbs: [IssueBreadcrumb]? = nil,
        breadcrumbsTruncated: Bool? = nil,
        metadata: Metadata? = nil,
        context: TelemetryContext? = nil,
        nativeStackFrames: [NativeStackFrame]?,
    ) {
        self.title = title
        self.level = level
        self.message = message
        self.exception = exception
        self.stackFrames = stackFrames
        self.breadcrumbs = breadcrumbs
        self.breadcrumbsTruncated = breadcrumbsTruncated
        self.metadata = metadata
        self.context = context
        self.nativeStackFrames = nativeStackFrames
    }
}

public struct LogAttributes: Codable, Equatable, Sendable {
    public let message: String
    public let level: LogLevel
    public let logger: String?
    public let metadata: Metadata?
    public let context: TelemetryContext?

    public init(
        message: String,
        level: LogLevel,
        logger: String? = nil,
        metadata: Metadata? = nil,
        context: TelemetryContext? = nil,
    ) {
        self.message = message
        self.level = level
        self.logger = logger
        self.metadata = metadata
        self.context = context
    }
}

public struct SpanAttributes: Codable, Equatable, Sendable {
    public let name: String
    public let traceId: String
    public let spanId: String
    public let parentSpanId: String?
    public let status: SpanStatus
    public let durationMs: Double?
    public let events: [SpanEventSummary]?
    public let links: [SpanLinkSummary]?
    public let metadata: Metadata?
    public let context: TelemetryContext?

    public init(
        name: String,
        traceId: String,
        spanId: String,
        parentSpanId: String? = nil,
        status: SpanStatus,
        durationMs: Double? = nil,
        events: [SpanEventSummary]? = nil,
        links: [SpanLinkSummary]? = nil,
        metadata: Metadata? = nil,
        context: TelemetryContext? = nil,
    ) {
        self.name = name
        self.traceId = traceId
        self.spanId = spanId
        self.parentSpanId = parentSpanId
        self.status = status
        self.durationMs = durationMs
        self.events = events
        self.links = links
        self.metadata = metadata
        self.context = context
    }
}

public struct ActionAttributes: Codable, Equatable, Sendable {
    public let name: String
    public let status: ActionStatus
    public let metadata: Metadata?
    public let context: TelemetryContext?

    public init(
        name: String,
        status: ActionStatus,
        metadata: Metadata? = nil,
        context: TelemetryContext? = nil,
    ) {
        self.name = name
        self.status = status
        self.metadata = metadata
        self.context = context
    }
}

public struct MetricAttributes: Codable, Equatable, Sendable {
    public let name: String
    public let kind: MetricKind
    public let value: Double
    public let unit: String
    public let temporality: MetricTemporality
    public let metadata: Metadata?
    public let context: TelemetryContext?

    public init(
        name: String,
        kind: MetricKind,
        value: Double,
        unit: String,
        temporality: MetricTemporality,
        metadata: Metadata? = nil,
        context: TelemetryContext? = nil,
    ) {
        self.name = name
        self.kind = kind
        self.value = value
        self.unit = unit
        self.temporality = temporality
        self.metadata = metadata
        self.context = context
    }
}
