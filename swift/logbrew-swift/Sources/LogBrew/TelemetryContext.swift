/// A bounded name and optional version shared by service, runtime, and framework context.
public struct TelemetryNamedVersion: Codable, Equatable, Sendable {
    public let name: String
    public let version: String?

    public init(name: String, version: String? = nil) {
        self.name = name
        self.version = version
    }
}

/// Deployment identity shared across related telemetry signals.
public struct TelemetryDeployment: Codable, Equatable, Sendable {
    public let environment: String?
    public let release: String?

    public init(environment: String? = nil, release: String? = nil) {
        self.environment = environment
        self.release = release
    }
}

/// Operating-system identity without host, account, or network identifiers.
public struct TelemetryOperatingSystem: Codable, Equatable, Sendable {
    public let name: String
    public let version: String?
    public let build: String?

    public init(name: String, version: String? = nil, build: String? = nil) {
        self.name = name
        self.version = version
        self.build = build
    }
}

/// Privacy-bounded device class. Do not use unique hardware identifiers as these values.
public struct TelemetryDevice: Codable, Equatable, Sendable {
    public let family: String?
    public let model: String?
    public let architecture: String?

    public init(family: String? = nil, model: String? = nil, architecture: String? = nil) {
        self.family = family
        self.model = model
        self.architecture = architecture
    }
}

/// Application bundle identity shared by issues, logs, traces, metrics, and product events.
public struct TelemetryApplication: Codable, Equatable, Sendable {
    public let name: String?
    public let version: String?
    public let build: String?

    public init(name: String? = nil, version: String? = nil, build: String? = nil) {
        self.name = name
        self.version = version
        self.build = build
    }
}

/// Stable resource identity shared by every LogBrew signal.
public struct TelemetryResource: Codable, Equatable, Sendable {
    public let service: TelemetryNamedVersion?
    public let deployment: TelemetryDeployment?
    public let runtime: TelemetryNamedVersion?
    public let framework: TelemetryNamedVersion?
    public let operatingSystem: TelemetryOperatingSystem?
    public let device: TelemetryDevice?
    public let application: TelemetryApplication?

    public init(
        service: TelemetryNamedVersion? = nil,
        deployment: TelemetryDeployment? = nil,
        runtime: TelemetryNamedVersion? = nil,
        framework: TelemetryNamedVersion? = nil,
        operatingSystem: TelemetryOperatingSystem? = nil,
        device: TelemetryDevice? = nil,
        application: TelemetryApplication? = nil,
    ) {
        self.service = service
        self.deployment = deployment
        self.runtime = runtime
        self.framework = framework
        self.operatingSystem = operatingSystem
        self.device = device
        self.application = application
    }
}

/// W3C-compatible trace identity shared by non-span telemetry and trace evidence.
public struct TelemetryTraceContext: Codable, Equatable, Sendable {
    public let traceId: String
    public let spanId: String?
    public let parentSpanId: String?
    public let sampled: Bool?

    public init(
        traceId: String,
        spanId: String? = nil,
        parentSpanId: String? = nil,
        sampled: Bool? = nil,
    ) {
        self.traceId = traceId
        self.spanId = spanId
        self.parentSpanId = parentSpanId
        self.sampled = sampled
    }
}

/// Opaque application-owned session identity.
public struct TelemetrySessionContext: Codable, Equatable, Sendable {
    public let id: String
    public let previousId: String?

    public init(id: String, previousId: String? = nil) {
        self.id = id
        self.previousId = previousId
    }
}

public enum TelemetrySubjectKind: String, Codable, Equatable, Sendable {
    case anonymous
    case user
}

/// Explicit app-owned subject identity. Do not send names, email addresses, or IP addresses.
public struct TelemetrySubjectContext: Codable, Equatable, Sendable {
    public let id: String
    public let kind: TelemetrySubjectKind

    public init(id: String, kind: TelemetrySubjectKind) {
        self.id = id
        self.kind = kind
    }
}

/// Versioned, privacy-bounded context available on every LogBrew event type.
public struct TelemetryContext: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let resource: TelemetryResource?
    public let trace: TelemetryTraceContext?
    public let session: TelemetrySessionContext?
    public let subject: TelemetrySubjectContext?
    public let tags: [String: String]?

    public init(
        resource: TelemetryResource? = nil,
        trace: TelemetryTraceContext? = nil,
        session: TelemetrySessionContext? = nil,
        subject: TelemetrySubjectContext? = nil,
        tags: [String: String]? = nil,
    ) {
        schemaVersion = 1
        self.resource = resource
        self.trace = trace
        self.session = session
        self.subject = subject
        self.tags = tags
    }

    /// Merge this context with an event-level override using deterministic field-level rules.
    public func merging(_ override: TelemetryContext) throws -> TelemetryContext {
        try requireTelemetryContext(mergeTelemetryContexts(self, override))
    }
}

/// Task-local context for correlating related telemetry without global mutable user state.
public enum LogBrewTelemetry {
    @TaskLocal private static var activeContext: TelemetryContext?

    public static var current: TelemetryContext? {
        activeContext
    }

    public static func withContext<T>(
        _ context: TelemetryContext,
        operation: () throws -> T,
    ) throws -> T {
        let nested = try mergeTelemetryContexts(activeContext, context)
        return try $activeContext.withValue(nested) {
            try operation()
        }
    }

    public static func withContext<T>(
        _ context: TelemetryContext,
        operation: () async throws -> T,
    ) async throws -> T {
        let nested = try mergeTelemetryContexts(activeContext, context)
        return try await $activeContext.withValue(nested) {
            try await operation()
        }
    }
}
