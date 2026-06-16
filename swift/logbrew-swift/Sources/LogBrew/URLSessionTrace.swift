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
    ) throws {
        let checkedStatusCode = try validatedStatusCode(statusCode)
        let checkedDurationMs = try validatedDurationMs(durationMs)
        var spanMetadata: Metadata = [:]
        try copyMetadata(metadata, into: &spanMetadata)
        spanMetadata["source"] = .string("swift.urlsession")
        spanMetadata["method"] = .string(span.method)
        spanMetadata["routeTemplate"] = .string(span.routeTemplate)
        if let checkedStatusCode {
            spanMetadata["statusCode"] = .int(checkedStatusCode)
        }
        if let error {
            spanMetadata["errorType"] = .string(String(describing: type(of: error)))
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
