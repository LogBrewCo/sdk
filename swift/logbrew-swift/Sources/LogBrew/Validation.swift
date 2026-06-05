import Foundation

func validateRelease(_ attributes: ReleaseAttributes) throws -> ReleaseAttributes {
    try requireNonEmpty("release version", attributes.version)
    if let commit = attributes.commit {
        try requireNonEmpty("release commit", commit)
    }
    return attributes
}

func validateEnvironment(_ attributes: EnvironmentAttributes) throws -> EnvironmentAttributes {
    try requireNonEmpty("environment name", attributes.name)
    return attributes
}

func validateIssue(_ attributes: IssueAttributes) throws -> IssueAttributes {
    try requireNonEmpty("issue title", attributes.title)
    return attributes
}

func validateLog(_ attributes: LogAttributes) throws -> LogAttributes {
    try requireNonEmpty("log message", attributes.message)
    return attributes
}

func validateSpan(_ attributes: SpanAttributes) throws -> SpanAttributes {
    try requireNonEmpty("span name", attributes.name)
    try requireNonEmpty("span traceId", attributes.traceId)
    try requireNonEmpty("span spanId", attributes.spanId)
    if let parentSpanId = attributes.parentSpanId {
        try requireNonEmpty("span parentSpanId", parentSpanId)
    }
    if let durationMs = attributes.durationMs, durationMs < 0 {
        throw SdkError(code: "validation_error", message: "span durationMs must be non-negative")
    }
    return attributes
}

func validateAction(_ attributes: ActionAttributes) throws -> ActionAttributes {
    try requireNonEmpty("action name", attributes.name)
    return attributes
}

func requireNonEmpty(_ label: String, _ value: String) throws {
    if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        throw SdkError(code: "validation_error", message: "\(label) must be non-empty")
    }
}

func requireTimestamp(_ timestamp: String) throws {
    try requireNonEmpty("timestamp", timestamp)
    let timePart = timestamp.split(separator: "T", maxSplits: 1).dropFirst().first
    let hasZuluSuffix = timestamp.hasSuffix("Z")
    let hasPositiveOffset = timePart?.contains("+") == true
    let hasNegativeOffset = timePart?.dropFirst().contains("-") == true
    let hasTimeZone = hasZuluSuffix || hasPositiveOffset || hasNegativeOffset
    guard hasTimeZone else {
        throw SdkError(
            code: "validation_error",
            message: "timestamp must include a timezone offset: \(timestamp)",
        )
    }

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    if formatter.date(from: timestamp) != nil {
        return
    }

    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if formatter.date(from: timestamp) == nil {
        throw SdkError(code: "validation_error", message: "invalid timestamp: \(timestamp)")
    }
}
