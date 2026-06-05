import co.logbrew.sdk.ActionAttributes
import co.logbrew.sdk.AndroidContext
import co.logbrew.sdk.AndroidLogPriority
import co.logbrew.sdk.EnvironmentAttributes
import co.logbrew.sdk.HttpTransport
import co.logbrew.sdk.HttpTransportRequest
import co.logbrew.sdk.HttpTransportRequester
import co.logbrew.sdk.IssueAttributes
import co.logbrew.sdk.LogAttributes
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.RecordingTransport
import co.logbrew.sdk.ReleaseAttributes
import co.logbrew.sdk.SdkException
import co.logbrew.sdk.SpanAttributes
import co.logbrew.sdk.TransportException

fun main() {
    run("preview_json_contains_all_supported_event_types", ::previewJsonContainsAllSupportedEventTypes)
    run("flush_success_clears_queue", ::flushSuccessClearsQueue)
    run("empty_flush_is_noop", ::emptyFlushIsNoop)
    run("invalid_timestamp_fails_validation", ::invalidTimestampFailsValidation)
    run("invalid_timestamp_shape_fails_validation", ::invalidTimestampShapeFailsValidation)
    run("invalid_issue_level_fails_validation", ::invalidIssueLevelFailsValidation)
    run("negative_span_duration_fails_validation", ::negativeSpanDurationFailsValidation)
    run("unauthenticated_response_surfaces_clean_error", ::unauthenticatedResponseSurfacesCleanError)
    run("network_failure_retries_before_succeeding", ::networkFailureRetriesBeforeSucceeding)
    run(
        "http_transport_sends_post_json_with_authorization_and_custom_headers",
        ::httpTransportSendsPostJsonWithAuthorizationAndCustomHeaders,
    )
    run("http_transport_validates_endpoint_headers_and_timeouts", ::httpTransportValidatesEndpointHeadersAndTimeouts)
    run("network_failure_returns_error_after_retry_budget", ::networkFailureReturnsErrorAfterRetryBudget)
    run("non_retryable_status_preserves_queue", ::nonRetryableStatusPreservesQueue)
    run("shutdown_flushes_and_prevents_future_events", ::shutdownFlushesAndPreventsFutureEvents)
    run("android_helpers_add_context_metadata", ::androidHelpersAddContextMetadata)
    run("android_log_priority_helper_captures_throwable_safely", ::androidLogPriorityHelperCapturesThrowableSafely)
    run("android_throwable_helper_keeps_stack_trace_opt_in", ::androidThrowableHelperKeepsStackTraceOptIn)
    println("kotlin package tests ok (17 tests)")
}

private fun run(
    name: String,
    test: () -> Unit,
) {
    try {
        test()
    } catch (error: Throwable) {
        throw IllegalStateException("$name failed", error)
    }
}

private fun newClient(maxRetries: Int = 2): LogBrewClient =
    LogBrewClient.create(
        apiKey = "LOGBREW_API_KEY",
        sdkName = "logbrew-kotlin-tests",
        sdkVersion = "0.1.0",
        maxRetries = maxRetries,
    )

private fun enqueueAll(client: LogBrewClient) {
    client.release(
        "evt_release_001",
        "2026-06-02T10:00:00Z",
        ReleaseAttributes.create("1.2.3").withCommit("abc123def456").withNotes("Public release marker"),
    )
    client.environment("evt_environment_001", "2026-06-02T10:00:01Z", EnvironmentAttributes.create("production").withRegion("global"))
    client.issue(
        "evt_issue_001",
        "2026-06-02T10:00:02Z",
        IssueAttributes.create("Checkout timeout", "error").withMessage("Request timed out after retry budget"),
    )
    client.log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes.create("worker started", "info").withLogger("job-runner"))
    client.span(
        "evt_span_001",
        "2026-06-02T10:00:04Z",
        SpanAttributes.create("GET /health", "trace_001", "span_001", "ok").withDurationMs(12.5),
    )
    client.action("evt_action_001", "2026-06-02T10:00:05Z", ActionAttributes.create("deploy", "success"))
}

private fun expect(
    code: String,
    callback: () -> Unit,
) {
    try {
        callback()
    } catch (error: SdkException) {
        check(error.code == code) { "expected $code but got ${error.code}" }
        return
    }
    error("expected $code")
}

private fun previewJsonContainsAllSupportedEventTypes() {
    val client = newClient()
    enqueueAll(client)
    val body = client.previewJson()
    check("\"language\": \"kotlin\"" in body)
    check("\"type\": \"release\"" in body)
    check("\"type\": \"environment\"" in body)
    check("\"type\": \"issue\"" in body)
    check("\"type\": \"log\"" in body)
    check("\"type\": \"span\"" in body)
    check("\"type\": \"action\"" in body)
}

private fun flushSuccessClearsQueue() {
    val client = newClient()
    enqueueAll(client)
    val transport = RecordingTransport.alwaysAccept()
    val response = client.flush(transport)
    check(response.statusCode == 202)
    check(response.attempts == 1)
    check(client.pendingEvents() == 0)
    check(transport.sentBodies.size == 1)
}

private fun emptyFlushIsNoop() {
    val response = newClient().flush(RecordingTransport.alwaysAccept())
    check(response.statusCode == 204)
    check(response.attempts == 0)
}

private fun invalidTimestampFailsValidation() {
    expect("validation_error") {
        newClient().log("evt_bad", "2026-06-02T10:00:03", LogAttributes.create("worker started", "info"))
    }
}

private fun invalidTimestampShapeFailsValidation() {
    expect("validation_error") {
        newClient().log("evt_bad", "not-a-dateZ", LogAttributes.create("worker started", "info"))
    }
}

private fun invalidIssueLevelFailsValidation() {
    expect("validation_error") {
        newClient().issue("evt_bad", "2026-06-02T10:00:03Z", IssueAttributes.create("bad", "fatal"))
    }
}

private fun negativeSpanDurationFailsValidation() {
    expect("validation_error") {
        newClient().span("evt_bad", "2026-06-02T10:00:03Z", SpanAttributes.create("bad", "trace", "span", "ok").withDurationMs(-1.0))
    }
}

private fun unauthenticatedResponseSurfacesCleanError() {
    val client = newClient()
    enqueueAll(client)
    expect("unauthenticated") {
        client.flush(RecordingTransport(listOf(401)))
    }
    check(client.pendingEvents() == 6)
}

private fun networkFailureRetriesBeforeSucceeding() {
    val client = newClient()
    enqueueAll(client)
    val response = client.flush(RecordingTransport(listOf(TransportException.network("temporary outage"), 202)))
    check(response.statusCode == 202)
    check(response.attempts == 2)
    check(client.pendingEvents() == 0)
}

private fun httpTransportSendsPostJsonWithAuthorizationAndCustomHeaders() {
    val client = newClient(maxRetries = 1)
    client.log(
        "evt_http_transport_001",
        "2026-06-02T10:00:03Z",
        LogAttributes.create("http transport sent", "info").withLogger("kotlin-test"),
    )
    val capturedRequests = mutableListOf<HttpTransportRequest>()
    val transport =
        HttpTransport(
            endpoint = "https://example.logbrew.test/v1/events",
            headers = mapOf("x-logbrew-source" to "kotlin-test"),
            connectTimeoutMillis = 3_000,
            readTimeoutMillis = 4_000,
            requester =
                HttpTransportRequester { request ->
                    capturedRequests += request
                    if (capturedRequests.size == 1) 503 else 202
                },
        )

    val response = client.flush(transport)
    val firstRequest = capturedRequests.first()

    check(response.statusCode == 202)
    check(response.attempts == 2)
    check(client.pendingEvents() == 0)
    check(capturedRequests.size == 2)
    check(firstRequest.endpoint == "https://example.logbrew.test/v1/events")
    check(firstRequest.connectTimeoutMillis == 3_000)
    check(firstRequest.readTimeoutMillis == 4_000)
    check(firstRequest.headers["content-type"] == "application/json")
    check(firstRequest.headers["authorization"] == "Bearer LOGBREW_API_KEY")
    check(firstRequest.headers["x-logbrew-source"] == "kotlin-test")
    check("\"id\": \"evt_http_transport_001\"" in firstRequest.body)
}

private fun httpTransportValidatesEndpointHeadersAndTimeouts() {
    expect("configuration_error") {
        HttpTransport(endpoint = "file:///tmp/events")
    }
    expect("configuration_error") {
        HttpTransport(endpoint = "https://example.logbrew.test/v1/events", headers = mapOf("" to "value"))
    }
    expect("configuration_error") {
        HttpTransport(endpoint = "https://example.logbrew.test/v1/events", connectTimeoutMillis = 0)
    }
    expect("configuration_error") {
        HttpTransport(endpoint = "https://example.logbrew.test/v1/events", readTimeoutMillis = 0)
    }
}

private fun networkFailureReturnsErrorAfterRetryBudget() {
    val client = newClient(maxRetries = 1)
    enqueueAll(client)
    expect("network_failure") {
        client.flush(
            RecordingTransport(
                listOf(
                    TransportException.network("temporary outage"),
                    TransportException.network("still down"),
                ),
            ),
        )
    }
    check(client.pendingEvents() == 6)
}

private fun nonRetryableStatusPreservesQueue() {
    val client = newClient()
    enqueueAll(client)
    expect("transport_error") {
        client.flush(RecordingTransport(listOf(400)))
    }
    check(client.pendingEvents() == 6)
}

private fun shutdownFlushesAndPreventsFutureEvents() {
    val client = newClient()
    enqueueAll(client)
    val response = client.shutdown(RecordingTransport.alwaysAccept())
    check(response.statusCode == 202)
    check(client.pendingEvents() == 0)
    expect("shutdown_error") {
        client.action("evt_after_shutdown", "2026-06-02T10:00:06Z", ActionAttributes.create("deploy", "success"))
    }
}

private fun androidHelpersAddContextMetadata() {
    val client = newClient()
    val context =
        AndroidContext
            .create()
            .withActivityName("MainActivity")
            .withScreenName("Checkout")
            .withDeviceModel("Pixel")
            .withOsVersion("Android 15")
            .withSessionId("session_001")
    LogBrewAndroid.captureActivityStarted(client, "evt_activity_started_001", "2026-06-02T10:00:06Z", "MainActivity", context)
    LogBrewAndroid.captureScreenView(client, "evt_screen_view_001", "2026-06-02T10:00:07Z", "Checkout", context)
    LogBrewAndroid.captureLogcat(client, "evt_android_log_001", "2026-06-02T10:00:08Z", "button clicked", "WARN", "Checkout", context)
    LogBrewAndroid.captureException(
        client,
        "evt_android_exception_001",
        "2026-06-02T10:00:09Z",
        "IllegalStateException",
        "stack trace",
        context,
    )
    val body = client.previewJson()
    check("\"activityName\": \"MainActivity\"" in body)
    check("\"screenName\": \"Checkout\"" in body)
    check("\"deviceModel\": \"Pixel\"" in body)
    check("\"androidPriority\": \"WARN\"" in body)
    check("\"source\": \"android\"" in body)
}

private fun androidLogPriorityHelperCapturesThrowableSafely() {
    val client = newClient()
    val context =
        AndroidContext
            .create()
            .withScreenName("Checkout")
            .withDeviceModel("Pixel")
    val throwable = IllegalArgumentException("bad cart")
    LogBrewAndroid.captureAndroidLog(
        client = client,
        id = "evt_android_log_priority_001",
        timestamp = "2026-06-02T10:00:10Z",
        priority = AndroidLogPriority.WARN,
        tag = "CheckoutActivity",
        message = "cart validation warning",
        throwable = throwable,
        context = context,
    )
    val body = client.previewJson()
    check("\"level\": \"warning\"" in body)
    check("\"logger\": \"CheckoutActivity\"" in body)
    check("\"androidPriority\": \"WARN\"" in body)
    check("\"androidPriorityNumber\": 5" in body)
    check("\"throwableName\": \"IllegalArgumentException\"" in body)
    check("\"throwableMessage\": \"bad cart\"" in body)
    check("\"throwableStackTrace\"" !in body)
}

private fun androidThrowableHelperKeepsStackTraceOptIn() {
    val safeClient = newClient()
    val throwable = IllegalStateException("payment failed")
    LogBrewAndroid.captureThrowable(
        client = safeClient,
        id = "evt_android_throwable_001",
        timestamp = "2026-06-02T10:00:11Z",
        throwable = throwable,
    )
    val safeBody = safeClient.previewJson()
    check("\"title\": \"IllegalStateException\"" in safeBody)
    check("\"message\": \"payment failed\"" in safeBody)
    check("\"throwableName\": \"IllegalStateException\"" in safeBody)
    check("\"throwableStackTrace\"" !in safeBody)

    val stackClient = newClient()
    LogBrewAndroid.captureThrowable(
        client = stackClient,
        id = "evt_android_throwable_stack_001",
        timestamp = "2026-06-02T10:00:12Z",
        throwable = throwable,
        includeStackTrace = true,
    )
    check("\"throwableStackTrace\"" in stackClient.previewJson())
}
