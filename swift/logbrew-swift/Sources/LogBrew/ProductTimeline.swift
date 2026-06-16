import Foundation

public struct ProductTimelineContext: Equatable, Sendable {
    public let sessionId: String?
    public let screen: String?
    public let traceId: String?
    public let funnel: String?
    public let step: String?
    public let metadata: Metadata?

    public init(
        sessionId: String? = nil,
        screen: String? = nil,
        traceId: String? = nil,
        funnel: String? = nil,
        step: String? = nil,
        metadata: Metadata? = nil,
    ) {
        self.sessionId = sessionId
        self.screen = screen
        self.traceId = traceId
        self.funnel = funnel
        self.step = step
        self.metadata = metadata
    }
}

public extension LogBrewClient {
    func captureProductAction(
        _ id: String,
        timestamp: String,
        name: String,
        status: ActionStatus = .success,
        context: ProductTimelineContext = ProductTimelineContext(),
        metadata: Metadata? = nil,
    ) throws {
        try action(
            id,
            timestamp: timestamp,
            attributes: ActionAttributes(
                name: name,
                status: status,
                metadata: productTimelineMetadata(
                    source: "swift.action",
                    context: context,
                    metadata: metadata,
                ),
            ),
        )
    }

    func captureNetworkMilestone(
        _ id: String,
        timestamp: String,
        method: String,
        routeTemplate: String,
        statusCode: Int? = nil,
        durationMs: Double? = nil,
        status: ActionStatus? = nil,
        context: ProductTimelineContext = ProductTimelineContext(),
        metadata: Metadata? = nil,
    ) throws {
        let normalizedMethod = try normalizedNetworkMethod(method)
        let normalizedRoute = try normalizedRouteTemplate(routeTemplate)
        let checkedStatusCode = try validatedStatusCode(statusCode)
        let checkedDurationMs = try validatedDurationMs(durationMs)
        var eventMetadata = try productTimelineMetadata(
            source: "swift.network",
            context: context,
            metadata: metadata,
        )
        eventMetadata["method"] = .string(normalizedMethod)
        eventMetadata["routeTemplate"] = .string(normalizedRoute)
        if let checkedStatusCode {
            eventMetadata["statusCode"] = .int(checkedStatusCode)
        }
        if let checkedDurationMs {
            eventMetadata["durationMs"] = .double(checkedDurationMs)
        }

        try action(
            id,
            timestamp: timestamp,
            attributes: ActionAttributes(
                name: "\(normalizedMethod) \(normalizedRoute)",
                status: status ?? statusFromStatusCode(checkedStatusCode),
                metadata: eventMetadata,
            ),
        )
    }
}

private func productTimelineMetadata(
    source: String,
    context: ProductTimelineContext,
    metadata: Metadata?,
) throws -> Metadata {
    var output: Metadata = [:]
    try copyOptionalString("sessionId", context.sessionId, into: &output)
    try copyOptionalString("screen", context.screen, into: &output)
    try copyOptionalString("traceId", context.traceId, into: &output)
    try copyOptionalString("funnel", context.funnel, into: &output)
    try copyOptionalString("step", context.step, into: &output)
    try copyMetadata(context.metadata, into: &output)
    try copyMetadata(metadata, into: &output)
    output["source"] = .string(source)
    return LogBrewTrace.mergeTraceMetadata(output) ?? output
}

private func copyOptionalString(_ key: String, _ value: String?, into output: inout Metadata) throws {
    guard let value else {
        return
    }
    try requireNonEmpty(key, value)
    output[key] = .string(value)
}

func copyMetadata(_ metadata: Metadata?, into output: inout Metadata) throws {
    guard let metadata else {
        return
    }
    for (key, value) in metadata {
        try requireNonEmpty("metadata key", key)
        if case let .double(doubleValue) = value, !doubleValue.isFinite {
            throw SdkError(code: "validation_error", message: "metadata value for \(key) must be finite")
        }
        output[key] = value
    }
}

func normalizedNetworkMethod(_ method: String) throws -> String {
    try requireNonEmpty("network method", method)
    return method.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
}

func normalizedRouteTemplate(_ routeTemplate: String) throws -> String {
    try requireNonEmpty("network routeTemplate", routeTemplate)
    let trimmed = routeTemplate.trimmingCharacters(in: .whitespacesAndNewlines)
    if let components = URLComponents(string: trimmed), components.scheme == "http" || components.scheme == "https" {
        let path = components.path.isEmpty ? "/" : components.path
        return stripQueryAndHash(path)
    }
    if trimmed.contains("://") {
        throw SdkError(
            code: "validation_error",
            message: "network routeTemplate must be a route template or HTTP(S) URL",
        )
    }
    let sanitized = stripQueryAndHash(trimmed)
    try requireNonEmpty("network routeTemplate", sanitized)
    return sanitized
}

private func stripQueryAndHash(_ value: String) -> String {
    let withoutQuery = value.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    let withoutHash = withoutQuery.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    return String(withoutHash)
}

func validatedStatusCode(_ statusCode: Int?) throws -> Int? {
    guard let statusCode else {
        return nil
    }
    guard (100 ... 599).contains(statusCode) else {
        throw SdkError(code: "validation_error", message: "network statusCode must be between 100 and 599")
    }
    return statusCode
}

func validatedDurationMs(_ durationMs: Double?) throws -> Double? {
    guard let durationMs else {
        return nil
    }
    guard durationMs.isFinite, durationMs >= 0 else {
        throw SdkError(code: "validation_error", message: "network durationMs must be finite and non-negative")
    }
    return durationMs
}

func statusFromStatusCode(_ statusCode: Int?) -> ActionStatus {
    guard let statusCode else {
        return .success
    }
    return statusCode >= 400 ? .failure : .success
}
