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
import co.logbrew.sdk.LogBrewCoroutines
import co.logbrew.sdk.LogBrewOpenTelemetry
import co.logbrew.sdk.LogBrewOpenTelemetrySpanContext
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.LogBrewTraceContext
import co.logbrew.sdk.MetricAttributes
import co.logbrew.sdk.RecordingTransport
import co.logbrew.sdk.ReleaseAttributes
import co.logbrew.sdk.SdkException
import co.logbrew.sdk.SpanAttributes
import co.logbrew.sdk.SpanEventSummary
import co.logbrew.sdk.TransportException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

fun main() {
    run("preview_json_contains_all_supported_event_types", ::previewJsonContainsAllSupportedEventTypes)
    run("flush_success_clears_queue", ::flushSuccessClearsQueue)
    run("concurrent_logging_preserves_queue_and_flushes", ::concurrentLoggingPreservesQueueAndFlushes)
    run("empty_flush_is_noop", ::emptyFlushIsNoop)
    run("invalid_timestamp_fails_validation", ::invalidTimestampFailsValidation)
    run("invalid_timestamp_shape_fails_validation", ::invalidTimestampShapeFailsValidation)
    run("invalid_issue_level_fails_validation", ::invalidIssueLevelFailsValidation)
    run("severity_aliases_normalize_before_preview", ::severityAliasesNormalizeBeforePreview)
    run("negative_span_duration_fails_validation", ::negativeSpanDurationFailsValidation)
    run("too_many_span_events_fail_validation", ::tooManySpanEventsFailValidation)
    run("metric_event_validates_and_serializes_attributes", ::metricEventValidatesAndSerializesAttributes)
    run("metric_value_and_temporality_validation_fails_cleanly", ::metricValueAndTemporalityValidationFailsCleanly)
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
    run("android_timeline_helpers_sanitize_product_and_network_metadata", ::androidTimelineHelpersSanitizeProductAndNetworkMetadata)
    run("android_request_span_helper_correlates_outbound_requests", ::androidRequestSpanHelperCorrelatesOutboundRequests)
    run("android_log_priority_helper_captures_throwable_safely", ::androidLogPriorityHelperCapturesThrowableSafely)
    run("android_throwable_helper_keeps_stack_trace_opt_in", ::androidThrowableHelperKeepsStackTraceOptIn)
    run("trace_context_helpers_validate_and_correlate", ::traceContextHelpersValidateAndCorrelate)
    run("opentelemetry_span_context_helpers_validate_and_correlate", ::openTelemetrySpanContextHelpersValidateAndCorrelate)
    run("opentelemetry_reflection_bridge_returns_null_without_otel_types", ::openTelemetryReflectionBridgeReturnsNullWithoutOtelTypes)
    run(
        "coroutine_reflection_bridge_returns_null_without_kotlinx_coroutines",
        ::coroutineReflectionBridgeReturnsNullWithoutKotlinxCoroutines,
    )
    AndroidRequestSpanTests.runAll()
    OperationTracingTests.runAll()
    println("kotlin package tests ok (32 tests)")
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
    client.metric(
        "evt_metric_001",
        "2026-06-02T10:00:06Z",
        MetricAttributes.create("queue.depth", "gauge", 42.0, "{items}", "instant"),
    )
    val body = client.previewJson()
    check("\"language\": \"kotlin\"" in body)
    check("\"type\": \"release\"" in body)
    check("\"type\": \"environment\"" in body)
    check("\"type\": \"issue\"" in body)
    check("\"type\": \"log\"" in body)
    check("\"type\": \"span\"" in body)
    check("\"type\": \"metric\"" in body)
    check("\"type\": \"action\"" in body)
}

private fun metricEventValidatesAndSerializesAttributes() {
    val client = newClient()
    client.metric(
        "evt_metric_001",
        "2026-06-02T10:00:06Z",
        MetricAttributes
            .create("queue.depth", "gauge", 42.0, "{items}", "instant")
            .withMetadata(mapOf("queue" to "checkout", "shard" to 1)),
    )
    val body = client.previewJson()
    check("\"type\": \"metric\"" in body)
    check("\"name\": \"queue.depth\"" in body)
    check("\"kind\": \"gauge\"" in body)
    check("\"value\": 42.0" in body)
    check("\"unit\": \"{items}\"" in body)
    check("\"temporality\": \"instant\"" in body)
    check("\"queue\": \"checkout\"" in body)
}

private fun metricValueAndTemporalityValidationFailsCleanly() {
    expect("validation_error") {
        newClient().metric(
            "evt_metric_bad_value",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("jobs.completed", "counter", -1.0, "1", "delta"),
        )
    }
    expect("validation_error") {
        newClient().metric(
            "evt_metric_bad_temporality",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("queue.depth", "gauge", 2.0, "{items}", "delta"),
        )
    }
    expect("validation_error") {
        newClient().metric(
            "evt_metric_bad_finite",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("queue.depth", "gauge", Double.NaN, "{items}", "instant"),
        )
    }
}

private fun tooManySpanEventsFailValidation() {
    expect("validation_error") {
        newClient().span(
            "evt_span_many_events",
            "2026-06-02T10:00:04Z",
            SpanAttributes
                .create("GET /health", "trace_001", "span_001", "ok")
                .withEvents(List(9) { index -> SpanEventSummary.create("step.$index") }),
        )
    }
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

private fun concurrentLoggingPreservesQueueAndFlushes() {
    val client = newClient()
    val workerCount = 16
    val eventsPerWorker = 1_000
    val expectedEvents = workerCount * eventsPerWorker
    val executor = Executors.newFixedThreadPool(workerCount)
    val start = CountDownLatch(1)
    val done = CountDownLatch(workerCount)
    val failures = ConcurrentLinkedQueue<Throwable>()

    repeat(workerCount) { worker ->
        executor.execute {
            try {
                check(start.await(10, TimeUnit.SECONDS)) { "timed out waiting for start signal" }
                repeat(eventsPerWorker) { index ->
                    client.log(
                        id = "evt_kotlin_load_${worker}_$index",
                        timestamp = "2026-06-02T10:00:03Z",
                        attributes =
                            LogAttributes
                                .create("high-load log event", "info")
                                .withLogger("kotlin-load-test"),
                    )
                }
            } catch (error: Throwable) {
                failures += error
            } finally {
                done.countDown()
            }
        }
    }

    start.countDown()
    check(done.await(30, TimeUnit.SECONDS)) { "timed out waiting for load workers" }
    executor.shutdown()
    check(executor.awaitTermination(30, TimeUnit.SECONDS)) { "timed out shutting down load executor" }
    failures.poll()?.let { throw it }

    check(client.pendingEvents() == expectedEvents) {
        "expected $expectedEvents queued events but found ${client.pendingEvents()}"
    }
    val body = client.previewJson()
    check("\"id\": \"evt_kotlin_load_0_0\"" in body)
    check("\"id\": \"evt_kotlin_load_${workerCount - 1}_${eventsPerWorker - 1}\"" in body)

    val response = client.flush(RecordingTransport.alwaysAccept())
    check(response.statusCode == 202)
    check(response.attempts == 1)
    check(client.pendingEvents() == 0)
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
        newClient().issue("evt_bad", "2026-06-02T10:00:03Z", IssueAttributes.create("bad", "verbose"))
    }
}

private fun severityAliasesNormalizeBeforePreview() {
    val client = newClient()
    client.issue("evt_issue_alias", "2026-06-02T10:00:02Z", IssueAttributes.create("Checkout timeout", "fatal"))
    client.log("evt_log_debug", "2026-06-02T10:00:03Z", LogAttributes.create("verbose runtime detail", "debug"))
    client.log("evt_log_warn", "2026-06-02T10:00:04Z", LogAttributes.create("legacy warning alias", "warn"))
    val body = client.previewJson()
    check("\"level\": \"critical\"" in body)
    check("\"level\": \"info\"" in body)
    check("\"level\": \"warning\"" in body)
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

private fun androidTimelineHelpersSanitizeProductAndNetworkMetadata() {
    val client = newClient()
    val context =
        AndroidContext
            .create()
            .withActivityName("CheckoutActivity")
            .withScreenName("Checkout")
            .withDeviceModel("Pixel")
            .withOsVersion("Android 15")
            .withSessionId("session_android_001")
    LogBrewAndroid.captureProductAction(
        client = client,
        id = "evt_android_action_001",
        timestamp = "2026-06-02T10:00:10Z",
        name = "checkout.submit",
        context = context,
        metadata = mapOf("funnel" to "checkout", "step" to "submit", "traceId" to "trace_android_001"),
    )
    LogBrewAndroid.captureNetworkMilestone(
        client = client,
        id = "evt_android_network_001",
        timestamp = "2026-06-02T10:00:11Z",
        method = "post",
        routeTemplate = "/api/checkout?itemId=123#pay",
        statusCode = 503,
        durationMs = 42.5,
        context = context,
        metadata = mapOf("funnel" to "checkout", "traceId" to "trace_android_001"),
    )
    val body = client.previewJson()
    check("\"name\": \"checkout.submit\"" in body)
    check("\"source\": \"android.action\"" in body)
    check("\"source\": \"android.network\"" in body)
    check("\"name\": \"POST /api/checkout\"" in body)
    check("\"status\": \"failure\"" in body)
    check("\"method\": \"POST\"" in body)
    check("\"routeTemplate\": \"/api/checkout\"" in body)
    check("\"durationMs\": 42.5" in body)
    check("\"sessionId\": \"session_android_001\"" in body)
    check("?itemId" !in body)
    check("#pay" !in body)

    expect("validation_error") {
        LogBrewAndroid.captureNetworkMilestone(
            client = newClient(),
            id = "evt_android_network_bad_duration",
            timestamp = "2026-06-02T10:00:12Z",
            method = "GET",
            routeTemplate = "/api/cart",
            durationMs = -1.0,
        )
    }
    expect("validation_error") {
        LogBrewAndroid.captureNetworkMilestone(
            client = newClient(),
            id = "evt_android_network_bad_status",
            timestamp = "2026-06-02T10:00:12Z",
            method = "GET",
            routeTemplate = "/api/cart",
            statusCode = 99,
        )
    }
    expect("validation_error") {
        LogBrewAndroid.captureProductAction(
            client = newClient(),
            id = "evt_android_action_bad_metadata",
            timestamp = "2026-06-02T10:00:13Z",
            name = "checkout.submit",
            metadata = mapOf("nested" to mapOf("unsafe" to true)),
        )
    }
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

private fun androidRequestSpanHelperCorrelatesOutboundRequests() {
    val parent =
        LogBrewTrace.continueOrCreate(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        )
    val client = newClient()
    val context =
        AndroidContext
            .create()
            .withActivityName("CheckoutActivity")
            .withScreenName("Checkout")
            .withSessionId("session_android_001")

    LogBrewTrace.use(parent).use {
        val requestSpan =
            LogBrewAndroid.startRequestSpan(
                method = "post",
                routeTemplate = "https://mobile.example.test/api/checkout?card=redacted#pay",
                context = context,
                metadata = mapOf("traceId" to "spoofed_trace", "funnel" to "checkout"),
            )
        check(requestSpan.method == "POST")
        check(requestSpan.routeTemplate == "/api/checkout")
        check(requestSpan.headers.keys == setOf("traceparent"))
        check(requestSpan.traceContext.traceId == parent.traceId)
        check(requestSpan.traceContext.parentSpanId == parent.spanId)
        check(requestSpan.traceContext.spanId != parent.spanId)
        check(requestSpan.traceparent == "00-${parent.traceId}-${requestSpan.traceContext.spanId}-01")

        LogBrewAndroid.captureRequestSpan(
            client = client,
            id = "evt_android_request_span_001",
            timestamp = "2026-06-02T10:00:12Z",
            requestSpan = requestSpan,
            statusCode = 503,
            durationMs = 42.5,
            error = IllegalStateException("retry budget reached"),
            metadata = mapOf("parentSpanId" to "spoofed_parent", "phase" to "payment"),
        )
    }

    val body = client.previewJson()
    check("\"type\": \"span\"" in body)
    check("\"name\": \"POST /api/checkout\"" in body)
    check("\"traceId\": \"${parent.traceId}\"" in body)
    check("\"parentSpanId\": \"${parent.spanId}\"" in body)
    check("\"status\": \"error\"" in body)
    check("\"durationMs\": 42.5" in body)
    check("\"source\": \"android.request\"" in body)
    check("\"method\": \"POST\"" in body)
    check("\"routeTemplate\": \"/api/checkout\"" in body)
    check("\"statusCode\": 503" in body)
    check("\"errorType\": \"IllegalStateException\"" in body)
    check("\"errorMessage\": \"retry budget reached\"" in body)
    check("\"sessionId\": \"session_android_001\"" in body)
    check("card=redacted" !in body)
    check("#pay" !in body)
    check("traceparent" !in body)
    check("spoofed_trace" !in body)
    check("spoofed_parent" !in body)

    expect("validation_error") {
        val requestSpan = LogBrewAndroid.startRequestSpan("GET", "/api/cart")
        LogBrewAndroid.captureRequestSpan(
            client = newClient(),
            id = "evt_android_request_bad_duration",
            timestamp = "2026-06-02T10:00:12Z",
            requestSpan = requestSpan,
            durationMs = -1.0,
        )
    }
    expect("validation_error") {
        val requestSpan = LogBrewAndroid.startRequestSpan("GET", "/api/cart")
        LogBrewAndroid.captureRequestSpan(
            client = newClient(),
            id = "evt_android_request_bad_status",
            timestamp = "2026-06-02T10:00:12Z",
            requestSpan = requestSpan,
            statusCode = 99,
        )
    }
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

private fun traceContextHelpersValidateAndCorrelate() {
    val incoming = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"
    val context = LogBrewTrace.fromTraceparent(incoming) ?: error("expected valid traceparent")
    check(context.traceId == "4bf92f3577b34da6a3ce929d0e0e4736")
    check(context.parentSpanId == "00f067aa0ba902b7")
    check(context.spanId != "00f067aa0ba902b7")
    check(context.traceFlags == "01")
    check(context.sampled)
    check(LogBrewTrace.fromTraceparent("00-${"0".repeat(32)}-00f067aa0ba902b7-01") == null)
    check(LogBrewTrace.fromTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01") == null)
    check(LogBrewTrace.fromTraceparent("not-a-traceparent") == null)
    val fallback = LogBrewTrace.continueOrCreate("not-a-traceparent")
    check(fallback.traceId != context.traceId)
    check(fallback.parentSpanId == null)

    val client = newClient()
    check(LogBrewTrace.currentTraceContext() == null)
    LogBrewTrace.use(context).use {
        check(LogBrewTrace.currentTraceContext() == context)
        val nested = LogBrewTrace.createTraceContext(sampled = false)
        val nestedScope = LogBrewTrace.use(nested)
        check(LogBrewTrace.currentTraceContext() == nested)
        nestedScope.close()
        check(LogBrewTrace.currentTraceContext() == context)

        client.issue(
            "evt_kotlin_trace_issue_001",
            "2026-06-02T10:00:20Z",
            IssueAttributes
                .create("Checkout timeout", "error")
                .withMetadata(mapOf("traceId" to "spoofed_trace", "routeTemplate" to "/checkout/{cart_id}")),
        )
        client.log(
            "evt_kotlin_trace_log_001",
            "2026-06-02T10:00:21Z",
            LogAttributes
                .create("checkout handler failed", "error")
                .withLogger("CheckoutActivity")
                .withMetadata(mapOf("traceSampled" to false)),
        )
        client.action(
            "evt_kotlin_trace_action_001",
            "2026-06-02T10:00:22Z",
            ActionAttributes.create("checkout.submit", "failure").withMetadata(mapOf("spanId" to "spoofed_span")),
        )
        client.span(
            "evt_kotlin_trace_span_001",
            "2026-06-02T10:00:23Z",
            LogBrewTrace.spanAttributes("POST /checkout/{cart_id}", "error", 37.5, mapOf("routeTemplate" to "/checkout/{cart_id}")),
        )
        client.metric(
            "evt_kotlin_trace_metric_001",
            "2026-06-02T10:00:24Z",
            MetricAttributes
                .create("http.server.duration", "histogram", 37.5, "ms", "delta")
                .withMetadata(mapOf("routeTemplate" to "/checkout/{cart_id}")),
        )
        LogBrewAndroid.captureProductAction(
            client,
            "evt_kotlin_trace_product_action_001",
            "2026-06-02T10:00:25Z",
            "checkout.confirm",
            metadata = mapOf("traceId" to "spoofed_trace", "screen" to "Checkout"),
        )
        LogBrewAndroid.captureNetworkMilestone(
            client,
            "evt_kotlin_trace_network_001",
            "2026-06-02T10:00:26Z",
            "post",
            "https://mobile.example.test/api/checkout?card=redacted#pay",
            statusCode = 503,
            durationMs = 37.5,
            metadata = mapOf("parentSpanId" to "spoofed_parent"),
        )
        val headers = LogBrewTrace.outgoingHeaders()
        check(headers["traceparent"] == "00-${context.traceId}-${context.spanId}-01")
    }
    check(LogBrewTrace.currentTraceContext() == null)

    val body = client.previewJson()
    check("\"traceId\": \"${context.traceId}\"" in body)
    check("\"spanId\": \"${context.spanId}\"" in body)
    check("\"parentSpanId\": \"${context.parentSpanId}\"" in body)
    check("\"traceFlags\": \"01\"" in body)
    check("\"traceSampled\": true" in body)
    check("\"name\": \"POST /api/checkout\"" in body)
    check("\"durationMs\": 37.5" in body)
    check("spoofed_trace" !in body)
    check("spoofed_span" !in body)
    check("spoofed_parent" !in body)
    check("traceparent" !in body)
    check("card=redacted" !in body)
    check("#pay" !in body)

    expect("validation_error") {
        LogBrewTrace.use(
            LogBrewTraceContext(
                traceId = "0".repeat(32),
                spanId = "00f067aa0ba902b7",
            ),
        )
    }
}

private fun openTelemetrySpanContextHelpersValidateAndCorrelate() {
    val context =
        LogBrewTrace.fromTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")
            ?: error("expected valid traceparent")
    val parentSpanId = context.parentSpanId ?: error("expected parent span")
    val otelParent =
        LogBrewOpenTelemetrySpanContext.create(
            traceId = "4BF92F3577B34DA6A3CE929D0E0E4736",
            spanId = "00F067AA0BA902B7",
            traceFlags = "01",
        ) ?: error("expected valid OpenTelemetry span context")
    val otelTrace = LogBrewTrace.fromOpenTelemetrySpanContext(otelParent)
    check(otelTrace.traceId == context.traceId)
    check(otelTrace.parentSpanId == context.parentSpanId)
    check(otelTrace.spanId != otelParent.spanId)
    check(otelTrace.traceFlags == "01")
    check(otelTrace.sampled)
    check(LogBrewOpenTelemetrySpanContext.create("0".repeat(32), "00f067aa0ba902b7", "01") == null)
    check(LogBrewOpenTelemetrySpanContext.create(context.traceId, "0".repeat(16), "01") == null)
    check(LogBrewOpenTelemetrySpanContext.create(context.traceId, parentSpanId, "zz") == null)
    val unsampledOtelParent =
        LogBrewOpenTelemetrySpanContext.create(context.traceId, parentSpanId, sampled = false)
            ?: error("expected valid unsampled OpenTelemetry span context")
    val unsampledOtelTrace = LogBrewTrace.fromOpenTelemetrySpanContext(unsampledOtelParent)
    check(unsampledOtelTrace.traceFlags == "00")
    check(!unsampledOtelTrace.sampled)
    val otelSpanAttributes =
        LogBrewTrace.spanAttributesFromOpenTelemetrySpanContext(
            name = "OTel parent span",
            status = "ok",
            durationMs = 12.5,
            metadata = mapOf("spanId" to "spoofed_span", "bridge" to "opentelemetry"),
            context = otelParent,
        )
    check(otelSpanAttributes.traceId == context.traceId)
    check(otelSpanAttributes.parentSpanId == context.parentSpanId)
    check(otelSpanAttributes.spanId != context.parentSpanId)
    check(otelSpanAttributes.metadata["spanId"] == otelSpanAttributes.spanId)
    check(otelSpanAttributes.metadata["bridge"] == "opentelemetry")
}

private fun openTelemetryReflectionBridgeReturnsNullWithoutOtelTypes() {
    check(LogBrewOpenTelemetry.spanContextFromSpan(null) == null)
    check(LogBrewOpenTelemetry.traceContextFromSpan(null) == null)
    check(LogBrewOpenTelemetry.spanContextFromSpan(Any()) == null)
    check(LogBrewOpenTelemetry.traceContextFromSpan(Any()) == null)
    check(LogBrewOpenTelemetry.spanContextFromContext(Any()) == null)
    check(LogBrewOpenTelemetry.traceContextFromContext(Any()) == null)
    check(LogBrewOpenTelemetry.spanContextFromCurrentSpan() == null)
    check(LogBrewOpenTelemetry.traceContextFromCurrentSpan() == null)
}

private fun coroutineReflectionBridgeReturnsNullWithoutKotlinxCoroutines() {
    val trace = LogBrewTrace.createTraceContext()
    check(LogBrewCoroutines.traceContextElement(trace) == null)
    LogBrewTrace.use(trace).use {
        check(LogBrewCoroutines.currentTraceContextElement() == null)
    }
    check(LogBrewTrace.currentTraceContext() == null)
}
