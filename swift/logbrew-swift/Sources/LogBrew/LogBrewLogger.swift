import Foundation

public enum LogBrewLoggerLevel: String, Sendable {
    case trace
    case debug
    case info
    case notice
    case warning
    case error
    case fault
    case critical

    var logBrewLevel: LogLevel {
        switch self {
        case .trace, .debug:
            .info
        case .info, .notice:
            .info
        case .warning:
            .warning
        case .error, .fault:
            .error
        case .critical:
            .critical
        }
    }
}

public final class LogBrewLogger {
    private let client: LogBrewClient
    private let loggerName: String
    private let subsystem: String?
    private let category: String?
    private let eventIDPrefix: String
    private let baseMetadata: Metadata
    private let transport: (any Transport)?
    private let flushOnLog: Bool
    private let timestampProvider: () -> String
    private let onError: ((any Error) -> Void)?
    private let lock = NSLock()
    private var nextEventNumber = 0

    public init(
        client: LogBrewClient,
        loggerName: String? = nil,
        subsystem: String? = nil,
        category: String? = nil,
        eventIDPrefix: String = "swift_log",
        metadata: Metadata? = nil,
        transport: (any Transport)? = nil,
        flushOnLog: Bool = false,
        timestampProvider: (() -> String)? = nil,
        onError: ((any Error) -> Void)? = nil,
    ) throws {
        if let loggerName {
            try requireNonEmpty("logger name", loggerName)
        }
        if let subsystem {
            try requireNonEmpty("logger subsystem", subsystem)
        }
        if let category {
            try requireNonEmpty("logger category", category)
        }
        try requireNonEmpty("event id prefix", eventIDPrefix)

        self.client = client
        self.loggerName = loggerName ?? category ?? subsystem ?? "swift-logger"
        self.subsystem = subsystem
        self.category = category
        self.eventIDPrefix = eventIDPrefix
        baseMetadata = metadata ?? [:]
        self.transport = transport
        self.flushOnLog = flushOnLog
        self.timestampProvider = timestampProvider ?? Self.defaultTimestamp
        self.onError = onError
    }

    public func log(
        _ level: LogBrewLoggerLevel,
        _ message: @autoclosure () -> String,
        id: String? = nil,
        timestamp: String? = nil,
        metadata: Metadata? = nil,
        error: (any Error)? = nil,
    ) {
        capture(
            level,
            message(),
            call: LogBrewLoggerCall(id: id, timestamp: timestamp, metadata: metadata, error: error),
        )
    }

    public func trace(
        _ message: @autoclosure () -> String,
        id: String? = nil,
        timestamp: String? = nil,
        metadata: Metadata? = nil,
    ) {
        log(.trace, message(), id: id, timestamp: timestamp, metadata: metadata)
    }

    public func debug(
        _ message: @autoclosure () -> String,
        id: String? = nil,
        timestamp: String? = nil,
        metadata: Metadata? = nil,
    ) {
        log(.debug, message(), id: id, timestamp: timestamp, metadata: metadata)
    }

    public func info(
        _ message: @autoclosure () -> String,
        id: String? = nil,
        timestamp: String? = nil,
        metadata: Metadata? = nil,
    ) {
        log(.info, message(), id: id, timestamp: timestamp, metadata: metadata)
    }

    public func notice(
        _ message: @autoclosure () -> String,
        id: String? = nil,
        timestamp: String? = nil,
        metadata: Metadata? = nil,
    ) {
        log(.notice, message(), id: id, timestamp: timestamp, metadata: metadata)
    }

    public func warning(
        _ message: @autoclosure () -> String,
        id: String? = nil,
        timestamp: String? = nil,
        metadata: Metadata? = nil,
    ) {
        log(.warning, message(), id: id, timestamp: timestamp, metadata: metadata)
    }

    public func warn(
        _ message: @autoclosure () -> String,
        id: String? = nil,
        timestamp: String? = nil,
        metadata: Metadata? = nil,
    ) {
        warning(message(), id: id, timestamp: timestamp, metadata: metadata)
    }

    public func error(
        _ message: @autoclosure () -> String,
        id: String? = nil,
        timestamp: String? = nil,
        metadata: Metadata? = nil,
        error: (any Error)? = nil,
    ) {
        log(.error, message(), id: id, timestamp: timestamp, metadata: metadata, error: error)
    }

    public func fault(
        _ message: @autoclosure () -> String,
        id: String? = nil,
        timestamp: String? = nil,
        metadata: Metadata? = nil,
        error: (any Error)? = nil,
    ) {
        log(.fault, message(), id: id, timestamp: timestamp, metadata: metadata, error: error)
    }

    public func critical(
        _ message: @autoclosure () -> String,
        id: String? = nil,
        timestamp: String? = nil,
        metadata: Metadata? = nil,
        error: (any Error)? = nil,
    ) {
        log(.critical, message(), id: id, timestamp: timestamp, metadata: metadata, error: error)
    }

    public func flush() {
        guard let transport, client.pendingEvents() > 0 else {
            return
        }

        lock.lock()
        defer {
            lock.unlock()
        }

        do {
            _ = try client.flush(transport: transport)
        } catch {
            onError?(error)
        }
    }

    private func capture(_ level: LogBrewLoggerLevel, _ message: String, call: LogBrewLoggerCall) {
        lock.lock()
        defer {
            lock.unlock()
        }

        do {
            try client.log(
                call.id ?? nextEventID(),
                timestamp: call.timestamp ?? timestampProvider(),
                attributes: LogAttributes(
                    message: message,
                    level: level.logBrewLevel,
                    logger: loggerName,
                    metadata: logMetadata(level: level, metadata: call.metadata, error: call.error),
                ),
            )
            if flushOnLog, let transport {
                _ = try client.flush(transport: transport)
            }
        } catch {
            onError?(error)
        }
    }

    private func nextEventID() -> String {
        nextEventNumber += 1
        return "\(eventIDPrefix)_\(nextEventNumber)"
    }

    private func logMetadata(
        level: LogBrewLoggerLevel,
        metadata: Metadata?,
        error: (any Error)?,
    ) -> Metadata {
        var merged = baseMetadata
        metadata?.forEach { key, value in
            merged[key] = value
        }
        merged["source"] = "swift"
        merged["swiftLogLevel"] = .string(level.rawValue)
        if let subsystem {
            merged["swiftSubsystem"] = .string(subsystem)
        }
        if let category {
            merged["swiftCategory"] = .string(category)
        }
        if let error {
            merged["swiftErrorType"] = .string(String(reflecting: type(of: error)))
            merged["swiftErrorDescription"] = .string(error.localizedDescription)
        }
        return merged
    }

    private static func defaultTimestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}

private struct LogBrewLoggerCall {
    let id: String?
    let timestamp: String?
    let metadata: Metadata?
    let error: (any Error)?
}
