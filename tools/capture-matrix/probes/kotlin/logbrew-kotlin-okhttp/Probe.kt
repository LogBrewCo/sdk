import co.logbrew.sdk.AndroidLogPriority
import co.logbrew.sdk.HttpTransport
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewTelemetry
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.TelemetryContext
import co.logbrew.sdk.TelemetryDeployment
import co.logbrew.sdk.TelemetryNamedVersion
import co.logbrew.sdk.TelemetryResource
import co.logbrew.sdk.TelemetrySessionContext
import co.logbrew.sdk.TelemetrySubjectContext
import co.logbrew.sdk.TelemetrySubjectKind
import co.logbrew.sdk.okhttp.LogBrewOkHttpCallFactory
import co.logbrew.sdk.okhttp.LogBrewOkHttpInterceptor
import co.logbrew.sdk.okhttp.LogBrewOkHttpPhaseTimings
import co.logbrew.sdk.okhttp.LogBrewOkHttpRouteTemplates
import com.sun.net.httpserver.HttpServer
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.time.Instant

private const val TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

fun main() {
    val api = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    api.createContext("/api/checkout") { exchange -> exchange.sendResponseHeaders(200, -1); exchange.close() }
    api.start()
    val closedPort = ServerSocket(0).use { it.localPort }

    val client =
        LogBrewAndroid.createClient(
            apiKey = "LOGBREW_API_KEY",
            appName = "checkout-android",
            context =
                TelemetryContext(
                    resource =
                        TelemetryResource(
                            service = TelemetryNamedVersion("checkout-android", "1.2.3"),
                            deployment = TelemetryDeployment(environment = "production", release = "checkout@1.2.3"),
                        ),
                    subject = TelemetrySubjectContext("user_123", TelemetrySubjectKind.USER),
                ),
        )
    val okHttp =
        OkHttpClient
            .Builder()
            .addInterceptor(LogBrewOkHttpInterceptor(client))
            .eventListenerFactory(LogBrewOkHttpPhaseTimings.eventListenerFactory())
            .build()
    val calls = LogBrewOkHttpCallFactory(okHttp)

    LogBrewTelemetry.use(TelemetryContext(session = TelemetrySessionContext("sess_123"))).use {
        LogBrewTrace.use(LogBrewTrace.continueOrCreate(TRACEPARENT)).use {
            val checkout = Request.Builder().url("http://127.0.0.1:${api.address.port}/api/checkout/cart-1?coupon=x").build()
            calls.newCall(LogBrewOkHttpRouteTemplates.tag(checkout, "/api/checkout/{cart_id}")).execute().close()
            LogBrewAndroid.captureAndroidLog(client, "evt_log_001", Instant.now().toString(), AndroidLogPriority.INFO, "CheckoutActivity", "checkout loaded")
            val payment = Request.Builder().url("http://127.0.0.1:$closedPort/api/payment").build()
            try {
                calls.newCall(LogBrewOkHttpRouteTemplates.tag(payment, "/api/payment")).execute().close()
            } catch (error: IOException) {
                LogBrewAndroid.captureAndroidLog(
                    client, "evt_log_002", Instant.now().toString(), AndroidLogPriority.WARN, "CheckoutActivity", "payment call failed", error,
                )
            }
        }
    }
    client.shutdown(HttpTransport(endpoint = System.getenv("LOGBREW_CAPTURE_ENDPOINT")))
    api.stop(0)
    okHttp.dispatcher.executorService.shutdown()
    okHttp.connectionPool.evictAll()
}
