public enum IssueLevel: String, Codable, Sendable {
    case info
    case warning
    case error
    case critical
}

public enum LogLevel: String, Codable, Sendable {
    case debug
    case info
    case warning
    case error
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

    public init(apiKey: String, sdkName: String, sdkVersion: String, maxRetries: Int = 2) {
        self.apiKey = apiKey
        self.sdkName = sdkName
        self.sdkVersion = sdkVersion
        self.maxRetries = maxRetries
    }
}

public struct ReleaseAttributes: Codable, Equatable, Sendable {
    public let version: String
    public let commit: String?
    public let notes: String?
    public let metadata: Metadata?

    public init(
        version: String,
        commit: String? = nil,
        notes: String? = nil,
        metadata: Metadata? = nil,
    ) {
        self.version = version
        self.commit = commit
        self.notes = notes
        self.metadata = metadata
    }
}

public struct EnvironmentAttributes: Codable, Equatable, Sendable {
    public let name: String
    public let region: String?
    public let metadata: Metadata?

    public init(name: String, region: String? = nil, metadata: Metadata? = nil) {
        self.name = name
        self.region = region
        self.metadata = metadata
    }
}

public struct IssueAttributes: Codable, Equatable, Sendable {
    public let title: String
    public let level: IssueLevel
    public let message: String?
    public let metadata: Metadata?

    public init(
        title: String,
        level: IssueLevel,
        message: String? = nil,
        metadata: Metadata? = nil,
    ) {
        self.title = title
        self.level = level
        self.message = message
        self.metadata = metadata
    }
}

public struct LogAttributes: Codable, Equatable, Sendable {
    public let message: String
    public let level: LogLevel
    public let logger: String?
    public let metadata: Metadata?

    public init(
        message: String,
        level: LogLevel,
        logger: String? = nil,
        metadata: Metadata? = nil,
    ) {
        self.message = message
        self.level = level
        self.logger = logger
        self.metadata = metadata
    }
}

public struct SpanAttributes: Codable, Equatable, Sendable {
    public let name: String
    public let traceId: String
    public let spanId: String
    public let parentSpanId: String?
    public let status: SpanStatus
    public let durationMs: Double?
    public let metadata: Metadata?

    public init(
        name: String,
        traceId: String,
        spanId: String,
        parentSpanId: String? = nil,
        status: SpanStatus,
        durationMs: Double? = nil,
        metadata: Metadata? = nil,
    ) {
        self.name = name
        self.traceId = traceId
        self.spanId = spanId
        self.parentSpanId = parentSpanId
        self.status = status
        self.durationMs = durationMs
        self.metadata = metadata
    }
}

public struct ActionAttributes: Codable, Equatable, Sendable {
    public let name: String
    public let status: ActionStatus
    public let metadata: Metadata?

    public init(name: String, status: ActionStatus, metadata: Metadata? = nil) {
        self.name = name
        self.status = status
        self.metadata = metadata
    }
}

public struct MetricAttributes: Codable, Equatable, Sendable {
    public let name: String
    public let kind: MetricKind
    public let value: Double
    public let unit: String
    public let temporality: MetricTemporality
    public let metadata: Metadata?

    public init(
        name: String,
        kind: MetricKind,
        value: Double,
        unit: String,
        temporality: MetricTemporality,
        metadata: Metadata? = nil,
    ) {
        self.name = name
        self.kind = kind
        self.value = value
        self.unit = unit
        self.temporality = temporality
        self.metadata = metadata
    }
}
