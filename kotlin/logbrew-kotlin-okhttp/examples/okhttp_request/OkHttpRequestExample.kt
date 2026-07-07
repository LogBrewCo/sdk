import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.okhttp.LogBrewOkHttpCallFactory
import co.logbrew.sdk.okhttp.LogBrewOkHttpEventIdProvider
import co.logbrew.sdk.okhttp.LogBrewOkHttpInterceptor
import co.logbrew.sdk.okhttp.LogBrewOkHttpPhaseTimings
import co.logbrew.sdk.okhttp.LogBrewOkHttpRouteTemplates
import co.logbrew.sdk.okhttp.LogBrewOkHttpTimestampProvider
import com.sun.net.httpserver.HttpServer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

fun main() {
    val client = LogBrewClient.create("LOGBREW_API_KEY", "kotlin-okhttp-app", "0.1.0")
    val parent = LogBrewTrace.continueOrCreate("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")
    val capturedTraceparent = AtomicReference<String?>()
    val callbackTraceSpanId = AtomicReference<String?>()
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/api/orders") { exchange ->
        capturedTraceparent.set(exchange.requestHeaders.getFirst("traceparent"))
        val body = "accepted".toByteArray(Charsets.UTF_8)
        exchange.sendResponseHeaders(202, body.size.toLong())
        exchange.responseBody.use { it.write(body) }
    }
    server.createContext("/api/redirect") { exchange ->
        exchange.responseHeaders.add("Location", "/api/orders?redirect_marker=opaque")
        exchange.sendResponseHeaders(302, -1)
        exchange.close()
    }
    server.start()

    try {
        val port = server.address.port
        val nextEventId = AtomicInteger(1)
        val okHttp =
            OkHttpClient
                .Builder()
                .addInterceptor(
                    LogBrewOkHttpInterceptor(
                        client = client,
                        finishSpanOnResponseBodyClose = true,
                        eventIdProvider =
                            LogBrewOkHttpEventIdProvider {
                                "evt_okhttp_installed_%03d".format(nextEventId.getAndIncrement())
                            },
                        timestampProvider = LogBrewOkHttpTimestampProvider { "2026-06-02T10:00:35Z" },
                    ),
                ).eventListenerFactory(LogBrewOkHttpPhaseTimings.eventListenerFactory())
                .build()
        val tracedCalls = LogBrewOkHttpCallFactory(okHttp)
        val latch = CountDownLatch(1)

        LogBrewTrace.use(parent).use {
            tracedCalls
                .newCall(
                    LogBrewOkHttpRouteTemplates.tag(
                        Request
                            .Builder()
                            .url("http://127.0.0.1:$port/api/orders?cart=123#pay")
                            .build(),
                        "/api/orders/{order_id}",
                    ),
                ).execute()
                .use { response ->
                    check(response.code == 202)
                    check(response.body?.string() == "accepted")
                }

            tracedCalls
                .newCall(
                    LogBrewOkHttpRouteTemplates.tag(
                        Request
                            .Builder()
                            .url("http://127.0.0.1:$port/api/redirect?redirect_marker=opaque#jump")
                            .build(),
                        "/api/redirect",
                    ),
                ).execute()
                .use { response ->
                    check(response.code == 202)
                    check(response.body?.string() == "accepted")
                }

            tracedCalls
                .newCall(
                    LogBrewOkHttpRouteTemplates.tag(
                        Request
                            .Builder()
                            .url("http://127.0.0.1:$port/api/orders?cart=456#async")
                            .build(),
                        "/api/orders/{order_id}",
                    ),
                ).enqueue(
                    object : Callback {
                        override fun onFailure(
                            call: Call,
                            e: IOException,
                        ) {
                            callbackTraceSpanId.set(LogBrewTrace.currentTraceContext()?.spanId)
                            latch.countDown()
                        }

                        override fun onResponse(
                            call: Call,
                            response: Response,
                        ) {
                            response.use {
                                check(it.code == 202)
                                check(it.body?.string() == "accepted")
                                callbackTraceSpanId.set(LogBrewTrace.currentTraceContext()?.spanId)
                            }
                            latch.countDown()
                        }
                    },
                )
            check(latch.await(5, TimeUnit.SECONDS))
            check(LogBrewTrace.currentTraceContext() == parent)
        }
    } finally {
        server.stop(0)
    }

    val body = client.previewJson()
    check(capturedTraceparent.get()?.startsWith("00-${parent.traceId}-") == true)
    check(callbackTraceSpanId.get() == parent.spanId)
    check("\"id\": \"evt_okhttp_installed_001\"" in body)
    check("\"id\": \"evt_okhttp_installed_002\"" in body)
    check("\"id\": \"evt_okhttp_installed_003\"" in body)
    check("\"name\": \"GET /api/orders/{order_id}\"" in body)
    check("\"name\": \"GET /api/redirect\"" in body)
    check("\"statusCode\": 202" in body)
    check("\"durationMs\"" in body)
    check("\"okhttp.phase.recorded\": true" in body)
    check("\"okhttp.phase.requestHeadersMs\"" in body)
    check("\"okhttp.phase.responseHeadersMs\"" in body)
    check("\"okhttp.phase.responseBodyMs\"" in body)
    check("\"okhttp.responseBodyCompletion\": \"eof\"" in body)
    check("\"okhttp.priorResponseCount\": 1" in body)
    check("\"okhttp.redirectCount\": 1" in body)
    check("\"okhttp.retryCount\": 0" in body)
    check("\"traceId\": \"${parent.traceId}\"" in body)
    check("\"parentSpanId\": \"${parent.spanId}\"" in body)
    check("cart=123" !in body)
    check("cart=456" !in body)
    check("redirect_marker=opaque" !in body)
    check("Location" !in body)
    check("#jump" !in body)
    check("#pay" !in body)
    check("#async" !in body)
    check("traceparent" !in body)
    check("127.0.0.1" !in body)
    check("HTTP_1_1" !in body)
    println("okhttp bridge ok")
}
