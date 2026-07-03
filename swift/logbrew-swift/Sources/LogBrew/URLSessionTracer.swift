import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

public final class LogBrewURLSessionTracer: @unchecked Sendable {
    private let client: LogBrewClient
    private let dataLoader: @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let timestampProvider: @Sendable () -> String
    private let nowMsProvider: @Sendable () -> Double
    private let onCaptureError: (@Sendable (any Error) -> Void)?
    private let eventIDPrefix: String
    private let lock = NSLock()
    private var nextEventSequence = 1

    public convenience init(
        client: LogBrewClient,
        session: URLSession = .shared,
        eventIDPrefix: String = "evt_urlsession",
        timestampProvider: (@Sendable () -> String)? = nil,
        nowMsProvider: (@Sendable () -> Double)? = nil,
        onCaptureError: (@Sendable (any Error) -> Void)? = nil,
    ) throws {
        let loader = LogBrewURLSessionDataLoader(session: session)
        try self.init(
            client: client,
            eventIDPrefix: eventIDPrefix,
            timestampProvider: timestampProvider,
            nowMsProvider: nowMsProvider,
            onCaptureError: onCaptureError,
            dataLoader: { request in
                try await loader.data(for: request)
            },
        )
    }

    init(
        client: LogBrewClient,
        eventIDPrefix: String = "evt_urlsession",
        timestampProvider: (@Sendable () -> String)? = nil,
        nowMsProvider: (@Sendable () -> Double)? = nil,
        onCaptureError: (@Sendable (any Error) -> Void)? = nil,
        dataLoader: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse),
    ) throws {
        let normalizedPrefix = eventIDPrefix.trimmingCharacters(in: .whitespacesAndNewlines)
        try requireNonEmpty("URLSession tracer eventIDPrefix", normalizedPrefix)
        self.client = client
        self.eventIDPrefix = normalizedPrefix
        self.timestampProvider = timestampProvider ?? Self.defaultTimestamp
        self.nowMsProvider = nowMsProvider ?? Self.defaultNowMs
        self.onCaptureError = onCaptureError
        self.dataLoader = dataLoader
    }

    @discardableResult
    public func data(
        for request: URLRequest,
        routeTemplate: String? = nil,
        eventID: String? = nil,
        metadata: Metadata? = nil,
    ) async throws -> (Data, URLResponse) {
        let span = try LogBrewTrace.startURLSessionSpan(for: request, routeTemplate: routeTemplate)
        let startedAtMs = nowMsProvider()

        do {
            let (data, response) = try await dataLoader(span.request)
            captureSpan(URLSessionTraceCapture(
                eventID: eventID,
                span: span,
                response: response,
                durationMs: durationSince(startedAtMs),
                error: nil,
                metadata: metadata,
            ))
            return (data, response)
        } catch {
            captureSpan(URLSessionTraceCapture(
                eventID: eventID,
                span: span,
                response: nil,
                durationMs: durationSince(startedAtMs),
                error: error,
                metadata: metadata,
            ))
            throw error
        }
    }

    private func captureSpan(_ capture: URLSessionTraceCapture) {
        do {
            try client.captureURLSessionSpan(
                capture.eventID ?? nextEventID(),
                timestamp: timestampProvider(),
                span: capture.span,
                statusCode: (capture.response as? HTTPURLResponse)?.statusCode,
                durationMs: capture.durationMs,
                error: capture.error,
                metadata: capture.metadata,
            )
        } catch {
            onCaptureError?(error)
        }
    }

    private func durationSince(_ startedAtMs: Double) -> Double {
        let endedAtMs = nowMsProvider()
        guard startedAtMs.isFinite, endedAtMs.isFinite else {
            return 0
        }
        return max(0, endedAtMs - startedAtMs)
    }

    private func nextEventID() -> String {
        lock.lock()
        defer {
            lock.unlock()
        }
        let eventID = "\(eventIDPrefix)_\(nextEventSequence)"
        nextEventSequence += 1
        return eventID
    }

    private static func defaultTimestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static func defaultNowMs() -> Double {
        ProcessInfo.processInfo.systemUptime * 1000
    }
}

private struct URLSessionTraceCapture {
    let eventID: String?
    let span: LogBrewURLSessionSpan
    let response: URLResponse?
    let durationMs: Double
    let error: (any Error)?
    let metadata: Metadata?
}

private struct LogBrewURLSessionDataLoader: @unchecked Sendable {
    let session: URLSession

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }
}
