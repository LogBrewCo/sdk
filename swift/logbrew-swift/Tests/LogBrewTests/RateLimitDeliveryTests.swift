import Foundation
@testable import LogBrew
import Testing

@Suite("Rate-limited delivery")
struct RateLimitDeliveryTests {
    @Test("Retry-After seconds waits, then resends the same batch without an app call")
    func retryAfterSecondsResumesAutomatically() throws {
        let transport = ThreadSafeScriptedTransport(responses: [rateLimited(retryAfter: 1)])
        let client = try startClient(transport)

        try captureLog(client, id: "rate-limited-seconds")
        #expect(transport.waitForRequestCount(1, timeout: 2))
        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .retrying })
        let health = client.deliveryHealth()
        #expect(health.pauseReason == .none)
        #expect(health.lastOutcome == .retryableFailure)
        #expect((0.5 ... 1.1).contains(health.nextRetryDelay ?? 0))
        #expect(!transport.waitForRequestCount(2, timeout: 0.5))

        #expect(transport.waitForRequestCount(2, timeout: 2))
        #expect(waitUntil(timeout: 2) { client.pendingEvents() == 0 })
        #expect(transport.requestBodies[0] == transport.requestBodies[1])
        #expect(client.deliveryHealth().state == .running)
        _ = try client.shutdown()
    }

    @Test("rate_limited code without Retry-After waits with bounded backoff")
    func rateLimitedCodeWaits() throws {
        let response = rateLimited(code: "rate_limited")
        let transport = ThreadSafeScriptedTransport(responses: [response, response])
        let client = try startClient(transport)

        try captureLog(client, id: "rate-limited-code")
        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .retrying })
        #expect((0.5 ... 1.1).contains(client.deliveryHealth().nextRetryDelay ?? 0))
        #expect(throws: SdkError(code: "transport_error", message: "unexpected transport status 429")) {
            try client.flush()
        }
        #expect(client.deliveryHealth().state == .retrying)
        #expect(client.deliveryHealth().pauseReason == .none)
        _ = try client.shutdown()
    }

    @Test("usage_limit_exceeded pauses even with Retry-After")
    func usageLimitExceededPauses() throws {
        let transport = ThreadSafeScriptedTransport(
            responses: [rateLimited(retryAfter: 1, code: "usage_limit_exceeded")],
        )
        let client = try startClient(transport)

        try captureLog(client, id: "usage-limit")
        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .paused })
        #expect(client.deliveryHealth().pauseReason == .quota)
        #expect(client.deliveryHealth().nextRetryDelay == nil)
        #expect(!transport.waitForRequestCount(2, timeout: 1.2))
        _ = try client.shutdown()
    }

    @Test("rate-limit waits stay between 1 second and 1 hour")
    func rateLimitWaitBounds() throws {
        #expect(DeliveryEngine.rateLimitDelay(0.2, jitter: 0) == 1)
        #expect(DeliveryEngine.rateLimitDelay(0.2, jitter: 1) == 1.1)
        #expect(DeliveryEngine.rateLimitDelay(120, jitter: 0.5) == 126)
        #expect(DeliveryEngine.rateLimitDelay(3599, jitter: 1) == 3600)
        #expect(DeliveryEngine.rateLimitDelay(.nan, jitter: 0) == 1)

        let transport = ThreadSafeScriptedTransport(responses: [rateLimited(retryAfter: 7200)])
        let client = try startClient(transport)
        try captureLog(client, id: "rate-limit-cap")
        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .retrying })
        #expect((3599 ... 3600).contains(client.deliveryHealth().nextRetryDelay ?? 0))
        client.stopAutomaticDelivery()
    }

    @Test("HTTP transport reads Retry-After and a bounded 429 body code")
    func httpTransportParsesRateLimitResponse() throws {
        let url = try #require(URL(string: "https://example.logbrew.test/v1/events"))
        let date = "Wed, 21 Oct 2026 07:28:00 GMT"
        let dateNow = Date(timeIntervalSince1970: 1_792_567_680 - 120)
        #expect(HTTPTransport.retryAfterSeconds(date, now: dateNow) == 120)
        #expect(HTTPTransport.retryAfterSeconds(date, now: dateNow.addingTimeInterval(600)) == 0)
        #expect(HTTPTransport.retryAfterSeconds(" 30 ", now: dateNow) == 30)
        for unreadable in ["", "-1", "1.5", "5, 6", "soon", "Wed, 21 Oct 2026 07:28:00 UTC"] {
            #expect(HTTPTransport.retryAfterSeconds(unreadable, now: dateNow) == nil)
        }

        func parse(_ status: Int, _ headers: [String: String], _ body: String) throws -> TransportResponse {
            let response = try #require(
                HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers),
            )
            return HTTPTransport.transportResponse(response, body: Data(body.utf8), now: dateNow)
        }
        let oversized = #"{"code":"rate_limited","padding":""# + String(repeating: "x", count: 4096) + #""}"#
        #expect(try parse(429, ["Retry-After": date], #"{"code":"rate_limited","detail":"x"}"#)
            == TransportResponse(statusCode: 429, attempts: 1, retryAfter: 120, errorCode: "rate_limited"))
        #expect(try parse(429, ["Retry-After": "5, 6"], oversized) == TransportResponse(statusCode: 429, attempts: 1))
        #expect(try parse(429, [:], #"{"code":"usage_limit_exceeded"}"#).errorCode == "usage_limit_exceeded")
        #expect(try parse(429, [:], "not json") == TransportResponse(statusCode: 429, attempts: 1))
        #expect(try parse(503, ["Retry-After": "5"], #"{"code":"rate_limited"}"#)
            == TransportResponse(statusCode: 503, attempts: 1))
    }

    @Test("HTTP transport Retry-After date resumes automatic delivery through URLSession")
    func httpTransportRetryAfterDateResumes() throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RateLimitURLProtocol.self]
        let transport = try HTTPTransport(
            endpoint: #require(URL(string: "https://example.logbrew.test/v1/events")),
            timeout: 3,
            session: URLSession(configuration: configuration),
        )
        let client = try startClient(transport)

        try captureLog(client, id: "rate-limited-date")
        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .retrying })
        #expect(waitUntil(timeout: 3) { client.pendingEvents() == 0 })
        #expect(RateLimitURLProtocol.requests.value == 2)
        _ = try client.shutdown()
    }
}

private func rateLimited(retryAfter: TimeInterval? = nil, code: String? = nil) -> TransportResponse {
    TransportResponse(statusCode: 429, attempts: 1, retryAfter: retryAfter, errorCode: code)
}

private func startClient(_ transport: any Transport) throws -> LogBrewClient {
    let client = try makeClient()
    try client.startAutomaticDelivery(
        transport: transport,
        options: AutomaticDeliveryOptions(interval: 0.05, threshold: 1, retryBaseDelay: 0.01, maxRetryDelay: 0.02),
    )
    return client
}

private final class RequestCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        lock.withLock { count }
    }

    func next() -> Int {
        lock.withLock {
            count += 1
            return count
        }
    }
}

private final class RateLimitURLProtocol: URLProtocol, @unchecked Sendable {
    static let requests = RequestCounter()

    override static func canInit(with _: URLRequest) -> Bool {
        true
    }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else {
            return
        }
        let first = Self.requests.next() == 1
        let headers = first ? ["Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"] : [:]
        let status = first ? 429 : 202
        if let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers) {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: Data(#"{"code":"rate_limited"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
