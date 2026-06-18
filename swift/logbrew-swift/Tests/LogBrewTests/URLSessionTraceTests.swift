import Foundation
@testable import LogBrew
import Testing

@Suite("LogBrew Swift URLSession trace")
struct URLSessionTraceTests {
    @Test("URLSession span helper injects child traceparent and captures sanitized span")
    func urlSessionSpanHelperCapturesSanitizedChildSpan() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        let context = try fixedTraceContext()
        let requestURL = try #require(URL(string: "https://api.example.com/api/checkout?cart_id=123#pay"))
        var request = URLRequest(url: requestURL)
        request.httpMethod = "post"
        request.setValue("app-owned-header-value", forHTTPHeaderField: "x-app-context")

        try LogBrewTrace.withContext(context) {
            let span = try LogBrewTrace.startURLSessionSpan(for: request)
            #expect(span.method == "POST")
            #expect(span.routeTemplate == "/api/checkout")
            #expect(span.traceContext.traceId == context.traceId)
            #expect(span.traceContext.parentSpanId == context.spanId)
            #expect(span.traceContext.spanId != context.spanId)
            #expect(span.request.value(forHTTPHeaderField: "traceparent") == span.traceContext.traceparent)
            #expect(span.request.value(forHTTPHeaderField: "x-app-context") == "app-owned-header-value")

            try client.captureURLSessionSpan(
                "evt_urlsession_span_001",
                timestamp: "2026-06-02T10:00:07Z",
                span: span,
                statusCode: 503,
                durationMs: 184.5,
                metadata: ["component": "pay-api"],
            )
        }

        let preview = try client.previewJSON()
        let event = try capturedEvent(from: preview, id: "evt_urlsession_span_001")
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        let childSpanId = try #require(attributes["spanId"] as? String)

        assertSanitizedURLSessionSpan(attributes, metadata: metadata, childSpanId: childSpanId, context: context)
        #expect(!preview.contains("cart_id"))
        #expect(!preview.contains("#pay"))
        #expect(!preview.contains("app-owned-header-value"))
        #expect(!preview.contains("traceparent"))
    }

    @Test("URLSession span helper records app-owned task timing metadata")
    func urlSessionSpanHelperRecordsTaskTimingMetadata() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        let context = try fixedTraceContext()
        let requestURL = try #require(URL(string: "https://api.example.com/api/checkout?cart_id=123#pay"))
        let request = URLRequest(url: requestURL)
        let timings = try LogBrewURLSessionTimings(
            fetchMs: 188.5,
            redirectMs: 3.25,
            nameLookupMs: 2.5,
            connectMs: 10,
            tlsMs: 6.5,
            sendMs: 4,
            waitMs: 120.25,
            receiveMs: 25,
            requestBodyBytes: 512,
            responseBodyBytes: 4096,
        )

        try LogBrewTrace.withContext(context) {
            let span = try LogBrewTrace.startURLSessionSpan(for: request)
            try client.captureURLSessionSpan(
                "evt_urlsession_timing_span_001",
                timestamp: "2026-06-02T10:00:07Z",
                span: span,
                statusCode: 202,
                durationMs: 188.5,
                metadata: ["component": "pay-api", "requestWaitMs": 999, "responseBodyBytes": 999],
                timings: timings,
            )
        }

        let preview = try client.previewJSON()
        let event = try capturedEvent(from: preview, id: "evt_urlsession_timing_span_001")
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(metadata["source"] as? String == "swift.urlsession")
        #expect(metadata["component"] as? String == "pay-api")
        assertTimingMetadata(metadata)
        #expect(!preview.contains("cart_id"))
        #expect(!preview.contains("#pay"))
        #expect(!preview.contains("traceparent"))
    }

    private func assertSanitizedURLSessionSpan(
        _ attributes: [String: Any],
        metadata: [String: Any],
        childSpanId: String,
        context: LogBrewTraceContext,
    ) {
        #expect(attributes["name"] as? String == "POST /api/checkout")
        #expect(attributes["traceId"] as? String == context.traceId)
        #expect(attributes["parentSpanId"] as? String == context.spanId)
        #expect(childSpanId != context.spanId)
        #expect(attributes["status"] as? String == "error")
        #expect(attributes["durationMs"] as? Double == 184.5)
        #expect(metadata["source"] as? String == "swift.urlsession")
        #expect(metadata["method"] as? String == "POST")
        #expect(metadata["routeTemplate"] as? String == "/api/checkout")
        #expect(metadata["statusCode"] as? Int == 503)
        #expect(metadata["component"] as? String == "pay-api")
        #expect(metadata["spanId"] as? String == childSpanId)
        #expect(metadata["parentSpanId"] as? String == context.spanId)
    }

    private func assertTimingMetadata(_ metadata: [String: Any]) {
        #expect(metadata["requestFetchMs"] as? Double == 188.5)
        #expect(metadata["requestRedirectMs"] as? Double == 3.25)
        #expect(metadata["requestNameLookupMs"] as? Double == 2.5)
        #expect(metadata["requestConnectMs"] as? Double == 10)
        #expect(metadata["requestTlsMs"] as? Double == 6.5)
        #expect(metadata["requestSendMs"] as? Double == 4)
        #expect(metadata["requestWaitMs"] as? Double == 120.25)
        #expect(metadata["requestReceiveMs"] as? Double == 25)
        #expect(metadata["requestBodyBytes"] as? Int == 512)
        #expect(metadata["responseBodyBytes"] as? Int == 4096)
    }

    private func capturedEvent(from preview: String, id: String) throws -> [String: Any] {
        let payload = try parsePayload(preview)
        let events = try #require(payload["events"] as? [[String: Any]])
        return try #require(events.first { $0["id"] as? String == id })
    }

    private func fixedTraceContext() throws -> LogBrewTraceContext {
        try LogBrewTraceContext(
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "aaaaaaaaaaaaaaaa",
            parentSpanId: "00f067aa0ba902b7",
            traceFlags: "01",
        )
    }
}
