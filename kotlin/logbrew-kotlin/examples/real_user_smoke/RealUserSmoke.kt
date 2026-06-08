import co.logbrew.sdk.AndroidContext
import co.logbrew.sdk.AndroidLogPriority
import co.logbrew.sdk.HttpTransport
import co.logbrew.sdk.HttpTransportRequester
import co.logbrew.sdk.LogAttributes
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.MetricAttributes
import co.logbrew.sdk.RecordingTransport
import co.logbrew.sdk.TransportException

fun main() {
    val client =
        LogBrewClient.create(
            apiKey = "LOGBREW_API_KEY",
            sdkName = "logbrew-kotlin",
            sdkVersion = "0.1.0",
        )
    enqueueCanonicalEvents(client)
    println(client.previewJson())
    val response =
        client.flush(
            RecordingTransport(
                listOf(
                    TransportException.network("temporary outage"),
                    202,
                ),
            ),
        )

    val helperClient = LogBrewAndroid.createClient("LOGBREW_API_KEY", "android-helper")
    val context =
        AndroidContext
            .create()
            .withActivityName("MainActivity")
            .withScreenName("Checkout")
            .withDeviceModel("Pixel")
            .withOsVersion("Android 15")
            .withSessionId("session_001")
    LogBrewAndroid.captureActivityStarted(helperClient, "evt_activity_started_001", "2026-06-02T10:00:06Z", "MainActivity", context)
    LogBrewAndroid.captureAndroidLog(
        helperClient,
        "evt_android_log_001",
        "2026-06-02T10:00:07Z",
        AndroidLogPriority.INFO,
        "Checkout",
        "button clicked",
        IllegalStateException("tap handler warning"),
        context,
    )
    LogBrewAndroid.captureThrowable(
        helperClient,
        "evt_android_exception_001",
        "2026-06-02T10:00:08Z",
        IllegalStateException("checkout failed"),
        context,
    )
    val helperPreview = helperClient.previewJson()
    check("\"activityName\": \"MainActivity\"" in helperPreview)
    check("\"androidPriority\": \"INFO\"" in helperPreview)
    check("\"throwableName\": \"IllegalStateException\"" in helperPreview)
    check("\"throwableStackTrace\"" !in helperPreview)
    check("\"source\": \"android\"" in helperPreview)

    val timelineClient = LogBrewAndroid.createClient("LOGBREW_API_KEY", "android-timeline")
    LogBrewAndroid.captureProductAction(
        timelineClient,
        "evt_android_action_001",
        "2026-06-02T10:00:09Z",
        "checkout.submit",
        context = context,
        metadata = mapOf("funnel" to "checkout", "step" to "submit", "traceId" to "trace_android_001"),
    )
    LogBrewAndroid.captureNetworkMilestone(
        timelineClient,
        "evt_android_network_001",
        "2026-06-02T10:00:10Z",
        "post",
        "/api/checkout?itemId=123#pay",
        statusCode = 503,
        durationMs = 42.5,
        context = context,
        metadata = mapOf("funnel" to "checkout", "traceId" to "trace_android_001"),
    )
    val timelinePreview = timelineClient.previewJson()
    check("\"source\": \"android.action\"" in timelinePreview)
    check("\"source\": \"android.network\"" in timelinePreview)
    check("\"name\": \"POST /api/checkout\"" in timelinePreview)
    check("\"status\": \"failure\"" in timelinePreview)
    check("\"routeTemplate\": \"/api/checkout\"" in timelinePreview)
    check("\"durationMs\": 42.5" in timelinePreview)
    check("?itemId" !in timelinePreview)
    check("#pay" !in timelinePreview)

    val metricClient = LogBrewClient.create("LOGBREW_API_KEY", "logbrew-kotlin-metrics", "0.1.0")
    metricClient.metric(
        "evt_metric_001",
        "2026-06-02T10:00:06Z",
        MetricAttributes
            .create("queue.depth", "gauge", 42.0, "{items}", "instant")
            .withMetadata(mapOf("queue" to "checkout")),
    )
    val metricPreview = metricClient.previewJson()
    check("\"type\": \"metric\"" in metricPreview)
    check("\"name\": \"queue.depth\"" in metricPreview)
    check("\"temporality\": \"instant\"" in metricPreview)
    check("\"queue\": \"checkout\"" in metricPreview)

    val httpClient =
        LogBrewClient.create(
            apiKey = "LOGBREW_API_KEY",
            sdkName = "logbrew-kotlin-http",
            sdkVersion = "0.1.0",
            maxRetries = 1,
        )
    httpClient.log(
        "evt_kotlin_http_transport",
        "2026-06-02T10:00:09Z",
        LogAttributes.create("kotlin http transport sent", "info").withLogger("kotlin-http"),
    )
    var capturedAuthorization = ""
    val httpResponse =
        httpClient.flush(
            HttpTransport(
                endpoint = "https://example.logbrew.test/v1/events",
                headers = mapOf("x-logbrew-source" to "kotlin-smoke"),
                requester =
                    HttpTransportRequester { request ->
                        capturedAuthorization = request.headers["authorization"].orEmpty()
                        check(request.headers["content-type"] == "application/json")
                        check(request.headers["x-logbrew-source"] == "kotlin-smoke")
                        check("evt_kotlin_http_transport" in request.body)
                        if (capturedAuthorization.isEmpty()) 500 else 202
                    },
            ),
        )
    check(capturedAuthorization == "Bearer LOGBREW_API_KEY")

    System.err.println(
        """{"ok":true,"status":${response.statusCode},"retryAttempts":${response.attempts},"androidHelperEvents":3,"androidTimelineEvents":2,"androidNetworkAction":"POST /api/checkout","metricEvents":1,"httpAttempts":${httpResponse.attempts}}""",
    )
}
