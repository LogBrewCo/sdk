import co.logbrew.sdk.ActionAttributes
import co.logbrew.sdk.IssueAttributes
import co.logbrew.sdk.LogAttributes
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.MetricAttributes

fun main() {
    val client =
        LogBrewClient.create(
            apiKey = "LOGBREW_API_KEY",
            sdkName = "logbrew-kotlin-trace",
            sdkVersion = "0.1.0",
        )
    val trace =
        LogBrewTrace.continueOrCreate(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        )

    LogBrewTrace.use(trace).use {
        client.issue(
            "evt_kotlin_trace_issue_001",
            "2026-06-02T10:00:20Z",
            IssueAttributes
                .create("Checkout timeout", "error")
                .withMetadata(mapOf("routeTemplate" to "/checkout/{cart_id}", "traceId" to "spoofed_trace")),
        )
        client.log(
            "evt_kotlin_trace_log_001",
            "2026-06-02T10:00:21Z",
            LogAttributes
                .create("checkout handler failed", "error")
                .withLogger("CheckoutActivity")
                .withMetadata(mapOf("screen" to "Checkout")),
        )
        client.action(
            "evt_kotlin_trace_action_001",
            "2026-06-02T10:00:22Z",
            ActionAttributes.create("checkout.submit", "failure").withMetadata(mapOf("spanId" to "spoofed_span")),
        )
        client.span(
            "evt_kotlin_trace_span_001",
            "2026-06-02T10:00:23Z",
            LogBrewTrace.spanAttributes(
                name = "POST /checkout/{cart_id}",
                status = "error",
                durationMs = 37.5,
                metadata = mapOf("routeTemplate" to "/checkout/{cart_id}"),
            ),
        )
        client.metric(
            "evt_kotlin_trace_metric_001",
            "2026-06-02T10:00:24Z",
            MetricAttributes
                .create("http.server.duration", "histogram", 37.5, "ms", "delta")
                .withMetadata(mapOf("routeTemplate" to "/checkout/{cart_id}")),
        )
        LogBrewAndroid.captureProductAction(
            client = client,
            id = "evt_kotlin_trace_product_action_001",
            timestamp = "2026-06-02T10:00:25Z",
            name = "checkout.confirm",
            metadata = mapOf("screen" to "Checkout", "traceId" to "spoofed_trace"),
        )
        LogBrewAndroid.captureNetworkMilestone(
            client = client,
            id = "evt_kotlin_trace_network_001",
            timestamp = "2026-06-02T10:00:26Z",
            method = "post",
            routeTemplate = "https://mobile.example.test/api/checkout?card=redacted#pay",
            statusCode = 503,
            durationMs = 37.5,
            metadata = mapOf("funnel" to "checkout", "parentSpanId" to "spoofed_parent"),
        )
        val outgoing = LogBrewTrace.outgoingHeaders().getValue("traceparent")
        System.err.println("""{"traceparent":"$outgoing"}""")
    }

    println(client.previewJson())
}
