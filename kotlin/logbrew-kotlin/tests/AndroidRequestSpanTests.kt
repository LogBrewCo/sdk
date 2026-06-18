import co.logbrew.sdk.ActionAttributes
import co.logbrew.sdk.AndroidContext
import co.logbrew.sdk.LogAttributes
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewTrace

object AndroidRequestSpanTests {
    fun runAll() {
        run("android_request_span_applies_headers_and_scopes_child_trace", ::androidRequestSpanAppliesHeadersAndScopesChildTrace)
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
}
