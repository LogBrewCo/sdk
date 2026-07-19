import Foundation

public final class LogBrewClient: @unchecked Sendable {
    private let engine: DeliveryEngine

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
        engine = DeliveryEngine(
            apiKey: config.apiKey,
            sdk: SDKInfo(name: config.sdkName, language: "swift", version: config.sdkVersion),
            maxRetries: config.maxRetries,
        )
    }

    public func pendingEvents() -> Int {
        engine.pendingEvents()
    }

    public func previewJSON() throws -> String {
        try engine.previewJSON()
    }

    public func release(_ id: String, timestamp: String, attributes: ReleaseAttributes) throws {
        try pushEvent(.release(validateRelease(attributes)), id: id, timestamp: timestamp)
    }

    public func environment(_ id: String, timestamp: String, attributes: EnvironmentAttributes) throws {
        try pushEvent(.environment(validateEnvironment(attributes)), id: id, timestamp: timestamp)
    }

    public func issue(_ id: String, timestamp: String, attributes: IssueAttributes) throws {
        try pushEvent(.issue(validateIssue(attributes.withActiveTrace())), id: id, timestamp: timestamp)
    }

    @_spi(CrashReplay)
    public func issueDetached(_ id: String, timestamp: String, attributes: IssueAttributes) throws {
        try pushEvent(.issue(validateIssue(attributes)), id: id, timestamp: timestamp)
    }

    public func log(_ id: String, timestamp: String, attributes: LogAttributes) throws {
        try pushEvent(.log(validateLog(attributes.withActiveTrace())), id: id, timestamp: timestamp)
    }

    public func span(_ id: String, timestamp: String, attributes: SpanAttributes) throws {
        try pushEvent(.span(validateSpan(attributes)), id: id, timestamp: timestamp)
    }

    public func action(_ id: String, timestamp: String, attributes: ActionAttributes) throws {
        try pushEvent(.action(validateAction(attributes.withActiveTrace())), id: id, timestamp: timestamp)
    }

    public func metric(_ id: String, timestamp: String, attributes: MetricAttributes) throws {
        try pushEvent(.metric(validateMetric(attributes.withActiveTrace())), id: id, timestamp: timestamp)
    }

    public func flush(transport: any Transport) throws -> TransportResponse {
        try engine.flush(transport: transport)
    }

    public func shutdown(transport: any Transport) throws -> TransportResponse {
        try engine.shutdown(transport: transport)
    }

    public func startAutomaticDelivery(
        transport: any Transport,
        options: AutomaticDeliveryOptions = AutomaticDeliveryOptions(),
    ) throws {
        try engine.startAutomaticDelivery(transport: transport, options: options)
    }

    public func recoverAutomaticDelivery() throws {
        try engine.recoverAutomaticDelivery()
    }

    public func stopAutomaticDelivery() {
        engine.stopAutomaticDelivery()
    }

    public func deliveryHealth() -> DeliveryHealth {
        engine.health()
    }

    public func enableDurableDelivery(options: DurableDeliveryOptions) throws {
        try engine.enableDurableDelivery(options: options)
    }

    public func purgeDurableDelivery() throws {
        try engine.purgeDurableDelivery()
    }

    public func flush() throws -> TransportResponse {
        try engine.flushOwnedTransport()
    }

    public func shutdown() throws -> TransportResponse {
        try engine.shutdownOwnedTransport()
    }

    private func pushEvent(_ attributes: EventAttributes, id: String, timestamp: String) throws {
        try requireNonEmpty("event id", id)
        try requireTimestamp(timestamp)
        try engine.enqueue(Event(type: attributes.eventType, timestamp: timestamp, id: id, attributes: attributes))
    }
}

private extension IssueAttributes {
    func withActiveTrace() -> IssueAttributes {
        IssueAttributes(
            title: title,
            level: level,
            message: message,
            metadata: LogBrewTrace.metadataWithCurrentTrace(metadata),
        )
    }
}

private extension LogAttributes {
    func withActiveTrace() -> LogAttributes {
        LogAttributes(
            message: message,
            level: level,
            logger: logger,
            metadata: LogBrewTrace.metadataWithCurrentTrace(metadata),
        )
    }
}

private extension ActionAttributes {
    func withActiveTrace() -> ActionAttributes {
        ActionAttributes(name: name, status: status, metadata: LogBrewTrace.metadataWithCurrentTrace(metadata))
    }
}

private extension MetricAttributes {
    func withActiveTrace() -> MetricAttributes {
        MetricAttributes(
            name: name,
            kind: kind,
            value: value,
            unit: unit,
            temporality: temporality,
            metadata: LogBrewTrace.metadataWithCurrentTrace(metadata),
        )
    }
}
