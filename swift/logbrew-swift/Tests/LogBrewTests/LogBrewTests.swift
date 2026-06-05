import Foundation
import LogBrew
import Testing

@Suite("LogBrew Swift SDK flow")
struct LogBrewTests {
    @Test("preview JSON contains all supported event types")
    func previewJSONContainsAllSupportedEventTypes() throws {
        let client = try makeFullClient()

        let payload = try parsePayload(client.previewJSON())
        let events = try #require(payload["events"] as? [[String: Any]])

        #expect(events.count == 6)
        #expect(events.compactMap { $0["type"] as? String } == [
            "release",
            "environment",
            "issue",
            "log",
            "span",
            "action",
        ])
    }

    @Test("flush success clears the queue")
    func flushSuccessClearsQueue() throws {
        let client = try makeFullClient()
        let transport = RecordingTransport.alwaysAccept()

        let response = try client.flush(transport: transport)

        #expect(response == TransportResponse(statusCode: 202, attempts: 1))
        #expect(client.pendingEvents() == 0)
        #expect(transport.lastBody()?.contains("\"type\" : \"release\"") == true)
    }

    @Test("empty flush is a no-op")
    func emptyFlushIsNoOp() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        let response = try client.flush(transport: RecordingTransport.alwaysAccept())

        #expect(response == TransportResponse(statusCode: 204, attempts: 0))
    }

    @Test("invalid timestamp fails validation")
    func invalidTimestampFailsValidation() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")

        do {
            try client.log(
                "evt_log_001",
                timestamp: "2026-06-02T10:00:03",
                attributes: LogAttributes(message: "worker started", level: .info),
            )
            Issue.record("expected invalid timestamp to fail")
        } catch let error as SdkError {
            #expect(error.code == "validation_error")
            #expect(error.message.contains("timezone offset"))
        }
    }

    @Test("negative span duration fails validation")
    func negativeSpanDurationFailsValidation() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")

        do {
            try client.span(
                "evt_span_001",
                timestamp: "2026-06-02T10:00:04Z",
                attributes: SpanAttributes(
                    name: "GET /health",
                    traceId: "trace_001",
                    spanId: "span_001",
                    status: .ok,
                    durationMs: -1,
                ),
            )
            Issue.record("expected negative duration to fail")
        } catch let error as SdkError {
            #expect(error.code == "validation_error")
            #expect(error.message == "span durationMs must be non-negative")
        }
    }

    @Test("unauthenticated response surfaces clean error")
    func unauthenticatedResponseSurfacesCleanError() throws {
        let client = try makeFullClient()
        let transport = RecordingTransport(scriptedResponses: [.status(401)])

        do {
            _ = try client.flush(transport: transport)
            Issue.record("expected unauthenticated flush to fail")
        } catch let error as SdkError {
            #expect(error.code == "unauthenticated")
            #expect(error.message == "transport rejected the API key")
        }
    }

    @Test("network failure retries before succeeding")
    func networkFailureRetriesBeforeSucceeding() throws {
        let client = try makeFullClient()
        let transport = RecordingTransport(scriptedResponses: [
            .failure(.network("temporary network failure")),
            .status(202),
        ])

        let response = try client.flush(transport: transport)

        #expect(response == TransportResponse(statusCode: 202, attempts: 2))
        #expect(client.pendingEvents() == 0)
        #expect(transport.sentBodies.count == 2)
    }

    @Test("HTTP transport sends POST JSON with authorization and custom headers")
    func httpTransportSendsPostJSONWithAuthorizationAndCustomHeaders() throws {
        let client = try LogBrewClient.create(
            apiKey: "LOGBREW_API_KEY",
            sdkName: "test",
            sdkVersion: "0.1.0",
            maxRetries: 1,
        )
        try client.log(
            "evt_http_transport_001",
            timestamp: "2026-06-02T10:00:03Z",
            attributes: LogAttributes(message: "http transport sent", level: .info, logger: "swift-test"),
        )

        var capturedRequests: [URLRequest] = []
        let transport = try HTTPTransport(
            endpoint: #require(URL(string: "https://example.logbrew.test/v1/events")),
            headers: ["x-logbrew-source": "swift-test"],
            timeout: 3,
            requester: { request in
                capturedRequests.append(request)
                return capturedRequests.count == 1 ? 503 : 202
            },
        )

        let response = try client.flush(transport: transport)
        let firstRequest = try #require(capturedRequests.first)
        let body = try #require(firstRequest.httpBody.flatMap { String(data: $0, encoding: .utf8) })

        #expect(response == TransportResponse(statusCode: 202, attempts: 2))
        #expect(client.pendingEvents() == 0)
        #expect(capturedRequests.count == 2)
        #expect(firstRequest.url?.absoluteString == "https://example.logbrew.test/v1/events")
        #expect(firstRequest.httpMethod == "POST")
        #expect(firstRequest.timeoutInterval == 3)
        #expect(firstRequest.value(forHTTPHeaderField: "content-type") == "application/json")
        #expect(firstRequest.value(forHTTPHeaderField: "authorization") == "Bearer LOGBREW_API_KEY")
        #expect(firstRequest.value(forHTTPHeaderField: "x-logbrew-source") == "swift-test")
        #expect(body.contains(#""id" : "evt_http_transport_001""#))
    }

    @Test("HTTP transport validates endpoint headers and timeout")
    func httpTransportValidatesEndpointHeadersAndTimeout() throws {
        #expect(throws: SdkError.self) {
            _ = try HTTPTransport(endpoint: #require(URL(string: "file:///tmp/events")))
        }
        #expect(throws: SdkError.self) {
            _ = try HTTPTransport(
                endpoint: #require(URL(string: "https://example.logbrew.test/v1/events")),
                headers: ["": "value"],
            )
        }
        #expect(throws: SdkError.self) {
            _ = try HTTPTransport(
                endpoint: #require(URL(string: "https://example.logbrew.test/v1/events")),
                timeout: 0,
            )
        }
    }

    @Test("network failure returns error after retry budget")
    func networkFailureReturnsErrorAfterRetryBudget() throws {
        let client = try LogBrewClient.create(
            apiKey: "LOGBREW_API_KEY",
            sdkName: "test",
            sdkVersion: "0.1.0",
            maxRetries: 1,
        )
        try client.log(
            "evt_log_001",
            timestamp: "2026-06-02T10:00:03Z",
            attributes: LogAttributes(message: "worker started", level: .info),
        )
        let transport = RecordingTransport(scriptedResponses: [
            .failure(.network("temporary network failure")),
            .failure(.network("still down")),
        ])

        do {
            _ = try client.flush(transport: transport)
            Issue.record("expected retry budget exhaustion to fail")
        } catch let error as SdkError {
            #expect(error.code == "network_failure")
            #expect(error.message == "still down")
            #expect(client.pendingEvents() == 1)
        }
    }

    @Test("non-retryable transport status fails without clearing queue")
    func nonRetryableTransportStatusFailsWithoutClearingQueue() throws {
        let client = try makeFullClient()
        let transport = RecordingTransport(scriptedResponses: [.status(400)])

        do {
            _ = try client.flush(transport: transport)
            Issue.record("expected non-retryable status to fail")
        } catch let error as SdkError {
            #expect(error.code == "transport_error")
            #expect(error.message == "unexpected transport status 400")
            #expect(client.pendingEvents() == 6)
        }
    }

    @Test("shutdown flushes and prevents future events")
    func shutdownFlushesAndPreventsFutureEvents() throws {
        let client = try makeFullClient()

        let response = try client.shutdown(transport: RecordingTransport.alwaysAccept())
        #expect(response == TransportResponse(statusCode: 202, attempts: 1))
        #expect(client.pendingEvents() == 0)

        do {
            try client.log(
                "evt_after_shutdown",
                timestamp: "2026-06-02T10:00:06Z",
                attributes: LogAttributes(message: "too late", level: .info),
            )
            Issue.record("expected post-shutdown event to fail")
        } catch let error as SdkError {
            #expect(error.code == "shutdown_error")
        }
    }

    @Test("Swift logger captures Apple-style level metadata")
    func swiftLoggerCapturesAppleStyleLevelMetadata() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        let logger = try LogBrewLogger(
            client: client,
            subsystem: "co.logbrew.app",
            category: "checkout",
            eventIDPrefix: "ios_log",
            metadata: ["build": "debug"],
            timestampProvider: { "2026-06-02T10:00:06Z" },
        )

        logger.warn("checkout button tapped", metadata: ["screen": "Checkout"])

        let payload = try parsePayload(client.previewJSON())
        let events = try #require(payload["events"] as? [[String: Any]])
        let event = try #require(events.first)
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])

        #expect(event["id"] as? String == "ios_log_1")
        #expect(event["timestamp"] as? String == "2026-06-02T10:00:06Z")
        #expect(attributes["message"] as? String == "checkout button tapped")
        #expect(attributes["level"] as? String == "warning")
        #expect(attributes["logger"] as? String == "checkout")
        #expect(metadata["source"] as? String == "swift")
        #expect(metadata["swiftLogLevel"] as? String == "warning")
        #expect(metadata["swiftSubsystem"] as? String == "co.logbrew.app")
        #expect(metadata["swiftCategory"] as? String == "checkout")
        #expect(metadata["build"] as? String == "debug")
        #expect(metadata["screen"] as? String == "Checkout")
    }

    @Test("Swift logger keeps logging calls non-throwing on capture failure")
    func swiftLoggerKeepsLoggingCallsNonThrowingOnCaptureFailure() throws {
        let client = try LogBrewClient.create(apiKey: "LOGBREW_API_KEY", sdkName: "test", sdkVersion: "0.1.0")
        _ = try client.shutdown(transport: RecordingTransport.alwaysAccept())
        var capturedError: SdkError?
        let logger = try LogBrewLogger(
            client: client,
            timestampProvider: { "2026-06-02T10:00:06Z" },
            onError: { error in
                capturedError = error as? SdkError
            },
        )

        logger.info("app kept running")

        #expect(capturedError?.code == "shutdown_error")
        #expect(client.pendingEvents() == 0)
    }
}

private func makeFullClient() throws -> LogBrewClient {
    let client = try LogBrewClient.create(
        apiKey: "LOGBREW_API_KEY",
        sdkName: "logbrew-swift",
        sdkVersion: "0.1.0",
    )
    try client.release(
        "evt_release_001",
        timestamp: "2026-06-02T10:00:00Z",
        attributes: ReleaseAttributes(version: "1.2.3", commit: "abc123def456", notes: "Public release marker"),
    )
    try client.environment(
        "evt_environment_001",
        timestamp: "2026-06-02T10:00:01Z",
        attributes: EnvironmentAttributes(name: "production", region: "global"),
    )
    try client.issue(
        "evt_issue_001",
        timestamp: "2026-06-02T10:00:02Z",
        attributes: IssueAttributes(
            title: "Checkout timeout",
            level: .error,
            message: "Request timed out after retry budget",
        ),
    )
    try client.log(
        "evt_log_001",
        timestamp: "2026-06-02T10:00:03Z",
        attributes: LogAttributes(message: "worker started", level: .info, logger: "job-runner"),
    )
    try client.span(
        "evt_span_001",
        timestamp: "2026-06-02T10:00:04Z",
        attributes: SpanAttributes(
            name: "GET /health",
            traceId: "trace_001",
            spanId: "span_001",
            status: .ok,
            durationMs: 12.5,
        ),
    )
    try client.action(
        "evt_action_001",
        timestamp: "2026-06-02T10:00:05Z",
        attributes: ActionAttributes(name: "deploy", status: .success),
    )
    return client
}

private func parsePayload(_ json: String) throws -> [String: Any] {
    let value = try JSONSerialization.jsonObject(with: Data(json.utf8))
    return try #require(value as? [String: Any])
}
