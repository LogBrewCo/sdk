import Foundation

public struct LogBrewTraceContext: Equatable, Sendable {
    public let traceId: String
    public let spanId: String
    public let parentSpanId: String?
    public let traceFlags: String
    public let sampled: Bool

    public var traceparent: String {
        "00-\(traceId)-\(spanId)-\(traceFlags)"
    }

    public init(
        traceId: String,
        spanId: String,
        parentSpanId: String? = nil,
        traceFlags: String = "01",
    ) throws {
        let normalizedTraceId = try Self.normalizedTraceId(traceId)
        let normalizedSpanId = try Self.normalizedSpanId("spanId", spanId)
        let normalizedParentSpanId = try parentSpanId.map { try Self.normalizedSpanId("parentSpanId", $0) }
        let normalizedTraceFlags = try Self.normalizedTraceFlags(traceFlags)
        self.init(
            validatedTraceId: normalizedTraceId,
            spanId: normalizedSpanId,
            parentSpanId: normalizedParentSpanId,
            traceFlags: normalizedTraceFlags,
        )
    }

    static func createRoot(traceFlags: String = "01") throws -> LogBrewTraceContext {
        let normalizedTraceFlags = try normalizedTraceFlags(traceFlags)
        return LogBrewTraceContext(
            validatedTraceId: randomTraceId(),
            spanId: randomSpanId(),
            parentSpanId: nil,
            traceFlags: normalizedTraceFlags,
        )
    }

    static func fallbackRoot() -> LogBrewTraceContext {
        LogBrewTraceContext(
            validatedTraceId: randomTraceId(),
            spanId: randomSpanId(),
            parentSpanId: nil,
            traceFlags: "01",
        )
    }

    static func child(of parent: LogBrewTraceContext) -> LogBrewTraceContext {
        LogBrewTraceContext(
            validatedTraceId: parent.traceId,
            spanId: randomSpanId(),
            parentSpanId: parent.spanId,
            traceFlags: parent.traceFlags,
        )
    }

    fileprivate static func child(
        traceId: String,
        parentSpanId: String,
        traceFlags: String,
    ) -> LogBrewTraceContext {
        LogBrewTraceContext(
            validatedTraceId: traceId,
            spanId: randomSpanId(),
            parentSpanId: parentSpanId,
            traceFlags: traceFlags,
        )
    }

    private init(validatedTraceId: String, spanId: String, parentSpanId: String?, traceFlags: String) {
        traceId = validatedTraceId
        self.spanId = spanId
        self.parentSpanId = parentSpanId
        self.traceFlags = traceFlags
        sampled = (Int(traceFlags, radix: 16) ?? 0) & 1 == 1
    }

    private static func randomTraceId() -> String {
        let value = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        return value == zeroTraceId ? "00000000000000000000000000000001" : value
    }

    private static func randomSpanId() -> String {
        let value = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(16))
        return value == zeroSpanId ? "0000000000000001" : value
    }

    fileprivate static func normalizedTraceId(_ value: String) throws -> String {
        let normalized = try normalizedHex("traceId", value, length: 32)
        if normalized == zeroTraceId {
            throw SdkError(code: "validation_error", message: "traceId must not be all zeros")
        }
        return normalized
    }

    fileprivate static func normalizedSpanId(_ label: String, _ value: String) throws -> String {
        let normalized = try normalizedHex(label, value, length: 16)
        if normalized == zeroSpanId {
            throw SdkError(code: "validation_error", message: "\(label) must not be all zeros")
        }
        return normalized
    }

    fileprivate static func normalizedTraceFlags(_ value: String) throws -> String {
        try normalizedHex("traceFlags", value, length: 2)
    }

    private static func normalizedHex(_ label: String, _ value: String, length: Int) throws -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized.count == length, normalized.allSatisfy(\.isHexDigit) else {
            throw SdkError(
                code: "validation_error",
                message: "\(label) must be \(length) lowercase or uppercase hex characters",
            )
        }
        return normalized
    }
}

public struct LogBrewOpenTelemetrySpanContext: Equatable, Sendable {
    public let traceId: String
    public let spanId: String
    public let traceFlags: String
    public let sampled: Bool

    public init(
        traceId: String,
        spanId: String,
        traceFlags: String = "01",
    ) throws {
        let normalizedTraceId = try LogBrewTraceContext.normalizedTraceId(traceId)
        let normalizedSpanId = try LogBrewTraceContext.normalizedSpanId("OpenTelemetry spanId", spanId)
        let normalizedTraceFlags = try LogBrewTraceContext.normalizedTraceFlags(traceFlags)

        self.traceId = normalizedTraceId
        self.spanId = normalizedSpanId
        self.traceFlags = normalizedTraceFlags
        sampled = (Int(normalizedTraceFlags, radix: 16) ?? 0) & 1 == 1
    }

    public init(
        traceId: String,
        spanId: String,
        sampled: Bool,
    ) throws {
        try self.init(traceId: traceId, spanId: spanId, traceFlags: sampled ? "01" : "00")
    }
}

public enum LogBrewTrace {
    @TaskLocal private static var activeContext: LogBrewTraceContext?

    public static var current: LogBrewTraceContext? {
        activeContext
    }

    public static func createContext(traceFlags: String = "01") throws -> LogBrewTraceContext {
        try LogBrewTraceContext.createRoot(traceFlags: traceFlags)
    }

    public static func openTelemetrySpanContext(
        traceId: String,
        spanId: String,
        traceFlags: String = "01",
    ) throws -> LogBrewOpenTelemetrySpanContext {
        try LogBrewOpenTelemetrySpanContext(traceId: traceId, spanId: spanId, traceFlags: traceFlags)
    }

    public static func openTelemetrySpanContext(
        traceId: String,
        spanId: String,
        sampled: Bool,
    ) throws -> LogBrewOpenTelemetrySpanContext {
        try LogBrewOpenTelemetrySpanContext(traceId: traceId, spanId: spanId, sampled: sampled)
    }

    public static func childContext(of parent: LogBrewTraceContext) -> LogBrewTraceContext {
        LogBrewTraceContext.child(of: parent)
    }

    public static func context(
        fromOpenTelemetrySpanContext spanContext: LogBrewOpenTelemetrySpanContext,
    ) -> LogBrewTraceContext {
        LogBrewTraceContext.child(
            traceId: spanContext.traceId,
            parentSpanId: spanContext.spanId,
            traceFlags: spanContext.traceFlags,
        )
    }

    public static func continueOrCreateContext(fromTraceparent traceparent: String?) -> LogBrewTraceContext {
        guard let traceparent, !traceparent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return LogBrewTraceContext.fallbackRoot()
        }

        guard let remoteParent = try? parseTraceparent(traceparent) else {
            return LogBrewTraceContext.fallbackRoot()
        }

        return childContext(of: remoteParent)
    }

    public static func parseTraceparent(_ traceparent: String) throws -> LogBrewTraceContext {
        let parts = traceparent.trimmingCharacters(in: .whitespacesAndNewlines).split(
            separator: "-",
            omittingEmptySubsequences: false,
        )
        guard parts.count == 4 else {
            throw SdkError(
                code: "validation_error",
                message: "traceparent must use W3C version-traceId-parentSpanId-traceFlags format",
            )
        }

        let version = String(parts[0]).lowercased()
        guard version.count == 2, version.allSatisfy(\.isHexDigit), version != "ff" else {
            throw SdkError(code: "validation_error", message: "traceparent version must be 2 hex characters and not ff")
        }

        let traceId = try LogBrewTraceContext.normalizedTraceId(String(parts[1]))
        let parentSpanId = try LogBrewTraceContext.normalizedSpanId("traceparent parent span id", String(parts[2]))
        let traceFlags = try LogBrewTraceContext.normalizedTraceFlags(String(parts[3]))
        return try LogBrewTraceContext(traceId: traceId, spanId: parentSpanId, traceFlags: traceFlags)
    }

    public static func withContext<T>(
        _ context: LogBrewTraceContext,
        operation: () throws -> T,
    ) rethrows -> T {
        try $activeContext.withValue(context) {
            try operation()
        }
    }

    public static func withContext<T>(
        _ context: LogBrewTraceContext,
        operation: () async throws -> T,
    ) async rethrows -> T {
        try await $activeContext.withValue(context) {
            try await operation()
        }
    }

    public static func metadata(_ context: LogBrewTraceContext? = current) -> Metadata {
        guard let context else {
            return [:]
        }

        var output: Metadata = [
            "traceId": .string(context.traceId),
            "spanId": .string(context.spanId),
            "traceFlags": .string(context.traceFlags),
            "traceSampled": .bool(context.sampled),
        ]
        if let parentSpanId = context.parentSpanId {
            output["parentSpanId"] = .string(parentSpanId)
        }
        return output
    }

    public static func metadataWithCurrentTrace(_ metadata: Metadata? = nil) -> Metadata? {
        mergeTraceMetadata(metadata, context: current)
    }

    public static func outgoingHeaders(_ context: LogBrewTraceContext? = current) -> [String: String] {
        guard let context else {
            return [:]
        }
        return ["traceparent": context.traceparent]
    }

    public static func spanAttributes(
        name: String,
        status: SpanStatus,
        durationMs: Double? = nil,
        metadata: Metadata? = nil,
        context: LogBrewTraceContext? = current,
    ) throws -> SpanAttributes {
        guard let context else {
            throw SdkError(code: "validation_error", message: "trace context is required for span attributes")
        }

        return SpanAttributes(
            name: name,
            traceId: context.traceId,
            spanId: context.spanId,
            parentSpanId: context.parentSpanId,
            status: status,
            durationMs: durationMs,
            metadata: mergeTraceMetadata(metadata, context: context),
        )
    }

    public static func spanAttributesFromOpenTelemetrySpanContext(
        _ spanContext: LogBrewOpenTelemetrySpanContext,
        name: String,
        status: SpanStatus,
        durationMs: Double? = nil,
        metadata: Metadata? = nil,
    ) -> SpanAttributes {
        let context = context(fromOpenTelemetrySpanContext: spanContext)
        return SpanAttributes(
            name: name,
            traceId: context.traceId,
            spanId: context.spanId,
            parentSpanId: context.parentSpanId,
            status: status,
            durationMs: durationMs,
            metadata: mergeTraceMetadata(metadata, context: context),
        )
    }

    static func mergeTraceMetadata(_ metadata: Metadata?, context: LogBrewTraceContext? = current) -> Metadata? {
        var output = metadata ?? [:]
        for (key, value) in self.metadata(context) {
            output[key] = value
        }
        return output.isEmpty ? nil : output
    }
}

private let zeroTraceId = "00000000000000000000000000000000"
private let zeroSpanId = "0000000000000000"
