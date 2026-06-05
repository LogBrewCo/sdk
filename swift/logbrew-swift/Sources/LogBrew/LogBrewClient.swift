import Foundation

public final class LogBrewClient {
    private let apiKey: String
    private let sdk: SDKInfo
    private let maxRetries: Int
    private var events: [Event] = []
    private var closed = false

    public static func create(
        apiKey: String,
        sdkName: String,
        sdkVersion: String,
        maxRetries: Int = 2,
    ) throws -> LogBrewClient {
        try LogBrewClient(
            config: ClientConfig(
                apiKey: apiKey,
                sdkName: sdkName,
                sdkVersion: sdkVersion,
                maxRetries: maxRetries,
            ),
        )
    }

    public init(config: ClientConfig) throws {
        try requireNonEmpty("api_key", config.apiKey)
        try requireNonEmpty("sdk_name", config.sdkName)
        try requireNonEmpty("sdk_version", config.sdkVersion)
        apiKey = config.apiKey
        sdk = SDKInfo(name: config.sdkName, language: "swift", version: config.sdkVersion)
        maxRetries = config.maxRetries
    }

    public func pendingEvents() -> Int {
        events.count
    }

    public func previewJSON() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(EventBatch(sdk: sdk, events: events))
        guard let json = String(data: data, encoding: .utf8) else {
            throw SdkError(code: "encoding_error", message: "event batch was not valid UTF-8")
        }
        return json
    }

    public func release(_ id: String, timestamp: String, attributes: ReleaseAttributes) throws {
        try pushEvent(.release(validateRelease(attributes)), id: id, timestamp: timestamp)
    }

    public func environment(_ id: String, timestamp: String, attributes: EnvironmentAttributes) throws {
        try pushEvent(.environment(validateEnvironment(attributes)), id: id, timestamp: timestamp)
    }

    public func issue(_ id: String, timestamp: String, attributes: IssueAttributes) throws {
        try pushEvent(.issue(validateIssue(attributes)), id: id, timestamp: timestamp)
    }

    public func log(_ id: String, timestamp: String, attributes: LogAttributes) throws {
        try pushEvent(.log(validateLog(attributes)), id: id, timestamp: timestamp)
    }

    public func span(_ id: String, timestamp: String, attributes: SpanAttributes) throws {
        try pushEvent(.span(validateSpan(attributes)), id: id, timestamp: timestamp)
    }

    public func action(_ id: String, timestamp: String, attributes: ActionAttributes) throws {
        try pushEvent(.action(validateAction(attributes)), id: id, timestamp: timestamp)
    }

    public func flush(transport: any Transport) throws -> TransportResponse {
        if closed {
            throw SdkError(code: "shutdown_error", message: "client is already shut down")
        }
        return try flushInternal(transport: transport)
    }

    public func shutdown(transport: any Transport) throws -> TransportResponse {
        if closed {
            throw SdkError(code: "shutdown_error", message: "client is already shut down")
        }
        let response = try flushInternal(transport: transport)
        closed = true
        return response
    }

    private func pushEvent(_ attributes: EventAttributes, id: String, timestamp: String) throws {
        if closed {
            throw SdkError(code: "shutdown_error", message: "client is already shut down")
        }
        try requireNonEmpty("event id", id)
        try requireTimestamp(timestamp)
        events.append(Event(type: attributes.eventType, timestamp: timestamp, id: id, attributes: attributes))
    }

    private func flushInternal(transport: any Transport) throws -> TransportResponse {
        if events.isEmpty {
            return TransportResponse(statusCode: 204, attempts: 0)
        }

        let body = try Data(previewJSON().utf8)
        let maxAttempts = maxRetries + 1
        var attempts = 0

        while attempts < maxAttempts {
            attempts += 1
            do {
                let response = try transport.send(apiKey: apiKey, body: body)
                if response.statusCode == 401 {
                    throw SdkError(code: "unauthenticated", message: "transport rejected the API key")
                }
                if (200 ..< 300).contains(response.statusCode) {
                    events.removeAll()
                    return TransportResponse(statusCode: response.statusCode, attempts: attempts)
                }
                if response.statusCode >= 500, attempts < maxAttempts {
                    continue
                }
                throw SdkError(
                    code: "transport_error",
                    message: "unexpected transport status \(response.statusCode)",
                )
            } catch let error as SdkError {
                throw error
            } catch let error as TransportError {
                if error.retryable, attempts < maxAttempts {
                    continue
                }
                throw SdkError(code: error.code, message: error.message)
            }
        }

        throw SdkError(code: "transport_error", message: "exhausted retries")
    }
}
