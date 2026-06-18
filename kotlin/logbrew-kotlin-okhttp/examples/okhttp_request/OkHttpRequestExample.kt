import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.okhttp.LogBrewOkHttpEventIdProvider
import co.logbrew.sdk.okhttp.LogBrewOkHttpInterceptor
import co.logbrew.sdk.okhttp.LogBrewOkHttpTimestampProvider
import com.sun.net.httpserver.HttpServer
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicReference

fun main() {
    val client = LogBrewClient.create("LOGBREW_API_KEY", "kotlin-okhttp-app", "0.1.0")
    val parent = LogBrewTrace.continueOrCreate("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")
    val capturedTraceparent = AtomicReference<String?>()
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/api/orders") { exchange ->
        capturedTraceparent.set(exchange.requestHeaders.getFirst("traceparent"))
        exchange.sendResponseHeaders(202, 0)
        exchange.responseBody.close()
    }
    server.start()

    try {
        val port = server.address.port
        val okHttp =
            OkHttpClient
                .Builder()
                .addInterceptor(
                    LogBrewOkHttpInterceptor(
                        client = client,
                        routeTemplate = "/api/orders/{order_id}",
                        eventIdProvider = LogBrewOkHttpEventIdProvider { "evt_okhttp_installed_001" },
                        timestampProvider = LogBrewOkHttpTimestampProvider { "2026-06-02T10:00:35Z" },
                    ),
                ).build()

        LogBrewTrace.use(parent).use {
            okHttp
                .newCall(
                    Request
                        .Builder()
                        .url("http://127.0.0.1:$port/api/orders?cart=123#pay")
                        .build(),
                ).execute()
                .use { response -> check(response.code == 202) }
            check(LogBrewTrace.currentTraceContext() == parent)
        }
    } finally {
        server.stop(0)
    }

    val body = client.previewJson()
    check(capturedTraceparent.get()?.startsWith("00-${parent.traceId}-") == true)
    check("\"id\": \"evt_okhttp_installed_001\"" in body)
    check("\"name\": \"GET /api/orders/{order_id}\"" in body)
    check("\"statusCode\": 202" in body)
    check("\"durationMs\"" in body)
    check("\"traceId\": \"${parent.traceId}\"" in body)
    check("\"parentSpanId\": \"${parent.spanId}\"" in body)
    check("cart=123" !in body)
    check("#pay" !in body)
    check("traceparent" !in body)
    println("okhttp bridge ok")
}
