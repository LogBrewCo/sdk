import co.logbrew.sdk.ActionAttributes
import co.logbrew.sdk.AndroidContext
import co.logbrew.sdk.LogAttributes
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewTrace
import java.net.HttpURLConnection
import java.net.URL

object AndroidRequestSpanTests {
    fun runAll() {
        run("android_request_span_applies_headers_and_scopes_child_trace", ::androidRequestSpanAppliesHeadersAndScopesChildTrace)
        run(
            "http_url_connection_span_applies_header_scopes_and_captures_status",
            ::httpUrlConnectionSpanAppliesHeaderScopesAndCapturesStatus,
        )
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

    private fun androidRequestSpanAppliesHeadersAndScopesChildTrace() {
        val parent =
            LogBrewTrace.continueOrCreate(
                "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
            )
        val client =
            LogBrewClient.create(
                apiKey = "LOGBREW_API_KEY",
                sdkName = "logbrew-kotlin-okhttp-tests",
                sdkVersion = "0.1.0",
            )
        val capturedHeaders = linkedMapOf<String, String>()

        LogBrewTrace.use(parent).use {
            val requestSpan =
                LogBrewAndroid.startRequestSpan(
                    method = "post",
                    routeTemplate = "https://mobile.example.test/api/checkout?cart=123#pay",
                    context = AndroidContext.create().withScreenName("Checkout"),
                    metadata = mapOf("routeTemplate" to "/spoofed", "screenStep" to "pay"),
                )

            val returnedSpan =
                requestSpan.applyHeadersTo { name, value ->
                    capturedHeaders[name] = value
                }
            check(returnedSpan === requestSpan)
            check(capturedHeaders.keys == setOf("traceparent"))
            check(capturedHeaders.getValue("traceparent") == requestSpan.traceparent)

            requestSpan.withTrace {
                check(LogBrewTrace.currentTraceContext() == requestSpan.traceContext)
                client.log(
                    "evt_android_request_log_001",
                    "2026-06-02T10:00:12Z",
                    LogAttributes
                        .create("checkout request started", "info")
                        .withLogger("OkHttp")
                        .withMetadata(mapOf("spanId" to "spoofed_span")),
                )
                client.action(
                    "evt_android_request_action_001",
                    "2026-06-02T10:00:13Z",
                    ActionAttributes.create("checkout.request", "success"),
                )
            }
            check(LogBrewTrace.currentTraceContext() == parent)
        }
        check(LogBrewTrace.currentTraceContext() == null)

        val body = client.previewJson()
        check("\"traceId\": \"${parent.traceId}\"" in body)
        check("\"spanId\": \"${parent.spanId}\"" !in body)
        check("\"spanId\": \"${capturedHeaders.getValue("traceparent").substring(36, 52)}\"" in body)
        check("\"parentSpanId\": \"${parent.spanId}\"" in body)
        check("\"screenStep\": \"pay\"" !in body)
        check("spoofed_span" !in body)
        check("cart=123" !in body)
        check("#pay" !in body)
        check("traceparent" !in body)
    }

    private fun httpUrlConnectionSpanAppliesHeaderScopesAndCapturesStatus() {
        val parent =
            LogBrewTrace.continueOrCreate(
                "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
            )
        val client =
            LogBrewClient.create(
                apiKey = "LOGBREW_API_KEY",
                sdkName = "logbrew-kotlin-http-url-connection-tests",
                sdkVersion = "0.1.0",
            )
        val connection = FakeHttpURLConnection(URL("https://mobile.example.test/api/checkout?cart=123#pay"), 202)

        LogBrewTrace.use(parent).use {
            val result =
                LogBrewAndroid.withHttpURLConnectionSpan(
                    client = client,
                    id = "evt_android_http_url_connection_span_001",
                    timestamp = "2026-06-02T10:00:14Z",
                    connection = connection,
                    context = AndroidContext.create().withScreenName("Checkout"),
                    metadata = mapOf("routeTemplate" to "/spoofed", "screenStep" to "pay"),
                ) { activeConnection ->
                    check(LogBrewTrace.currentTraceContext()?.parentSpanId == parent.spanId)
                    check(activeConnection.getRequestProperty("traceparent") == connection.capturedTraceparent)
                    client.log(
                        "evt_android_http_url_connection_log_001",
                        "2026-06-02T10:00:15Z",
                        LogAttributes
                            .create("HttpURLConnection resumed with request trace", "info")
                            .withLogger("HttpURLConnection")
                            .withMetadata(mapOf("spanId" to "spoofed_span")),
                    )
                    "ok"
                }

            check(result == "ok")
            check(LogBrewTrace.currentTraceContext() == parent)
        }
        check(LogBrewTrace.currentTraceContext() == null)
        check(connection.capturedTraceparent?.startsWith("00-${parent.traceId}-") == true)

        val body = client.previewJson()
        check("\"name\": \"GET /api/checkout\"" in body)
        check("\"statusCode\": 202" in body)
        check("\"durationMs\"" in body)
        check("\"traceId\": \"${parent.traceId}\"" in body)
        check("\"parentSpanId\": \"${parent.spanId}\"" in body)
        check("spoofed_span" !in body)
        check("/spoofed" !in body)
        check("cart=123" !in body)
        check("#pay" !in body)
        check("traceparent" !in body)
    }

    private class FakeHttpURLConnection(
        url: URL,
        private val code: Int,
    ) : HttpURLConnection(url) {
        var capturedTraceparent: String? = null

        override fun disconnect() = Unit

        override fun usingProxy(): Boolean = false

        override fun connect() {
            connected = true
        }

        override fun setRequestProperty(
            key: String,
            value: String,
        ) {
            super.setRequestProperty(key, value)
            if (key == "traceparent") {
                capturedTraceparent = value
            }
        }

        override fun getResponseCode(): Int = code
    }
}
