import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

public struct LogBrewURLSessionSpan {
    public let request: URLRequest
    public let traceContext: LogBrewTraceContext
    public let method: String
    public let routeTemplate: String

    public init(
        request: URLRequest,
        traceContext: LogBrewTraceContext,
        method: String,
        routeTemplate: String,
    ) {
        self.request = request
        self.traceContext = traceContext
        self.method = method
        self.routeTemplate = routeTemplate
    }
}

public struct LogBrewURLSessionTimings: Equatable, Sendable {
    private let values: Metadata

    public init(
        fetchMs: Double? = nil,
        redirectMs: Double? = nil,
        nameLookupMs: Double? = nil,
        connectMs: Double? = nil,
        tlsMs: Double? = nil,
        sendMs: Double? = nil,
        waitMs: Double? = nil,
        receiveMs: Double? = nil,
        requestBodyBytes: Int64? = nil,
        responseBodyBytes: Int64? = nil,
    ) throws {
        var metadata: Metadata = [:]
        try Self.addDuration(fetchMs, key: "requestFetchMs", into: &metadata)
        try Self.addDuration(redirectMs, key: "requestRedirectMs", into: &metadata)
        try Self.addDuration(nameLookupMs, key: "requestNameLookupMs", into: &metadata)
        try Self.addDuration(connectMs, key: "requestConnectMs", into: &metadata)
        try Self.addDuration(tlsMs, key: "requestTlsMs", into: &metadata)
        try Self.addDuration(sendMs, key: "requestSendMs", into: &metadata)
        try Self.addDuration(waitMs, key: "requestWaitMs", into: &metadata)
        try Self.addDuration(receiveMs, key: "requestReceiveMs", into: &metadata)
        try Self.addByteCount(requestBodyBytes, key: "requestBodyBytes", into: &metadata)
        try Self.addByteCount(responseBodyBytes, key: "responseBodyBytes", into: &metadata)
        values = metadata
    }

    public init(taskMetrics: URLSessionTaskMetrics) throws {
        var metadata: Metadata = [:]
        try Self.addDuration(taskMetrics.taskInterval, key: "requestFetchMs", into: &metadata)

        let networkTransactions = taskMetrics.transactionMetrics.filter { $0.resourceFetchType != .localCache }
        let mainTransaction = networkTransactions.last
        try Self.addRedirectTimings(networkTransactions.dropLast(), into: &metadata)
        if let mainTransaction {
            try Self.addMainTransactionTimings(mainTransaction, into: &metadata)
        }

        values = metadata
    }

    var metadata: Metadata {
        values
    }

    private static func addRedirectTimings(
        _ transactions: ArraySlice<URLSessionTaskTransactionMetrics>,
        into metadata: inout Metadata,
    ) throws {
        let redirectStarts = transactions.compactMap(\.fetchStartDate)
        let redirectEnds = transactions.compactMap(\.responseEndDate)
        if let firstRedirectStart = redirectStarts.first, let lastRedirectEnd = redirectEnds.last {
            try addDuration(firstRedirectStart, lastRedirectEnd, key: "requestRedirectMs", into: &metadata)
        }
    }

    private static func addMainTransactionTimings(
        _ transaction: URLSessionTaskTransactionMetrics,
        into metadata: inout Metadata,
    ) throws {
        try addDuration(
            transaction.domainLookupStartDate,
            transaction.domainLookupEndDate,
            key: "requestNameLookupMs",
            into: &metadata,
        )
        try addDuration(
            transaction.connectStartDate,
            transaction.connectEndDate,
            key: "requestConnectMs",
            into: &metadata,
        )
        try addDuration(
            transaction.secureConnectionStartDate,
            transaction.secureConnectionEndDate,
            key: "requestTlsMs",
            into: &metadata,
        )
        try addDuration(
            transaction.requestStartDate,
            transaction.requestEndDate,
            key: "requestSendMs",
            into: &metadata,
        )
        try addDuration(
            transaction.requestEndDate ?? transaction.requestStartDate,
            transaction.responseStartDate,
            key: "requestWaitMs",
            into: &metadata,
        )
        try addDuration(
            transaction.responseStartDate,
            transaction.responseEndDate,
            key: "requestReceiveMs",
            into: &metadata,
        )
        try addByteCount(
            transaction.countOfRequestBodyBytesSent,
            key: "requestBodyBytes",
            into: &metadata,
        )
        try addByteCount(
            transaction.countOfResponseBodyBytesReceived,
            key: "responseBodyBytes",
            into: &metadata,
        )
    }

    private static func addDuration(_ value: Double?, key: String, into metadata: inout Metadata) throws {
        guard let value else {
            return
        }
        guard value >= 0, value.isFinite else {
            throw SdkError(
                code: "validation_error",
                message: "URLSession timing values must be non-negative and finite",
            )
        }
        metadata[key] = .double(value)
    }

    private static func addDuration(_ interval: DateInterval, key: String, into metadata: inout Metadata) throws {
        try addDuration(interval.duration * 1000, key: key, into: &metadata)
    }

    private static func addDuration(_ start: Date?, _ end: Date?, key: String, into metadata: inout Metadata) throws {
        guard let start, let end else {
            return
        }
        try addDuration(end.timeIntervalSince(start) * 1000, key: key, into: &metadata)
    }

    private static func addByteCount(_ value: Int64?, key: String, into metadata: inout Metadata) throws {
        guard let value else {
            return
        }
        guard value >= 0, value <= Int64(Int.max) else {
            throw SdkError(code: "validation_error", message: "URLSession byte counts must be non-negative")
        }
        metadata[key] = .int(Int(value))
    }
}

public extension LogBrewTrace {
    static func startURLSessionSpan(
        for request: URLRequest,
        routeTemplate: String? = nil,
        context: LogBrewTraceContext? = current,
    ) throws -> LogBrewURLSessionSpan {
        let method = try normalizedNetworkMethod(request.httpMethod ?? "GET")
        let route = try routeTemplateFromURLRequest(request, routeTemplate: routeTemplate)
        let spanContext = context.map(LogBrewTraceContext.child(of:)) ?? LogBrewTraceContext.fallbackRoot()

        var tracedRequest = request
        tracedRequest.setValue(spanContext.traceparent, forHTTPHeaderField: "traceparent")

        return LogBrewURLSessionSpan(
            request: tracedRequest,
            traceContext: spanContext,
            method: method,
            routeTemplate: route,
        )
    }
}

public extension LogBrewClient {
    func captureURLSessionSpan(
        _ id: String,
        timestamp: String,
        span: LogBrewURLSessionSpan,
        statusCode: Int? = nil,
        durationMs: Double? = nil,
        error: Error? = nil,
        metadata: Metadata? = nil,
        timings: LogBrewURLSessionTimings? = nil,
    ) throws {
        let checkedStatusCode = try validatedStatusCode(statusCode)
        let checkedDurationMs = try validatedDurationMs(durationMs)
        var spanMetadata: Metadata = [:]
        try copyMetadata(metadata, into: &spanMetadata)
        for key in urlSessionGeneratedMetadataKeys {
            spanMetadata.removeValue(forKey: key)
        }
        spanMetadata["source"] = .string("swift.urlsession")
        spanMetadata["method"] = .string(span.method)
        spanMetadata["routeTemplate"] = .string(span.routeTemplate)
        if let checkedStatusCode {
            spanMetadata["statusCode"] = .int(checkedStatusCode)
        }
        if let error {
            spanMetadata["errorType"] = .string(String(describing: type(of: error)))
        }
        for (key, value) in timings?.metadata ?? [:] {
            spanMetadata[key] = value
        }

        try self.span(
            id,
            timestamp: timestamp,
            attributes: SpanAttributes(
                name: "\(span.method) \(span.routeTemplate)",
                traceId: span.traceContext.traceId,
                spanId: span.traceContext.spanId,
                parentSpanId: span.traceContext.parentSpanId,
                status: urlSessionSpanStatus(statusCode: checkedStatusCode, error: error),
                durationMs: checkedDurationMs,
                metadata: LogBrewTrace.mergeTraceMetadata(spanMetadata, context: span.traceContext),
            ),
        )
    }
}

private let urlSessionGeneratedMetadataKeys: Set<String> = [
    "source",
    "method",
    "routeTemplate",
    "statusCode",
    "errorType",
    "requestFetchMs",
    "requestRedirectMs",
    "requestNameLookupMs",
    "requestConnectMs",
    "requestTlsMs",
    "requestSendMs",
    "requestWaitMs",
    "requestReceiveMs",
    "requestBodyBytes",
    "responseBodyBytes",
]

private func routeTemplateFromURLRequest(_ request: URLRequest, routeTemplate: String?) throws -> String {
    if let routeTemplate {
        return try normalizedRouteTemplate(routeTemplate)
    }
    guard let url = request.url else {
        throw SdkError(code: "validation_error", message: "URLSession request URL is required")
    }
    return try normalizedRouteTemplate(url.absoluteString)
}

private func urlSessionSpanStatus(statusCode: Int?, error: Error?) -> SpanStatus {
    if error != nil {
        return .error
    }
    guard let statusCode else {
        return .ok
    }
    return statusCode >= 400 ? .error : .ok
}
