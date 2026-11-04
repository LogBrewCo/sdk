import co.logbrew.sdk.AndroidContext
import co.logbrew.sdk.AndroidLogPriority
import co.logbrew.sdk.HttpTransport
import co.logbrew.sdk.IssueBreadcrumb
import co.logbrew.sdk.IssueBreadcrumbLevel
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewCoroutines
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.MetricAttributes
import co.logbrew.sdk.TelemetryContext
import co.logbrew.sdk.TelemetryDeployment
import co.logbrew.sdk.TelemetryNamedVersion
import co.logbrew.sdk.TelemetryResource
import co.logbrew.sdk.TelemetrySessionContext
import co.logbrew.sdk.TelemetrySubjectContext
import co.logbrew.sdk.TelemetrySubjectKind
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URL
import java.time.Instant
import kotlin.coroutines.EmptyCoroutineContext

private const val TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

private fun now(): String = Instant.now().toString()

fun main() {
    val api = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    api.createContext("/api/checkout") { exchange -> exchange.sendResponseHeaders(200, -1); exchange.close() }
    api.createContext("/api/payment") { exchange -> exchange.sendResponseHeaders(503, -1); exchange.close() }
    api.start()
    val base = "http://127.0.0.1:${api.address.port}"

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
    val screen = AndroidContext.create().withActivityName("CheckoutActivity").withScreenName("Checkout")
    val trace = LogBrewTrace.continueOrCreate(TRACEPARENT)
    val session = TelemetryContext(session = TelemetrySessionContext("sess_123"))
    val coroutineContext =
        Dispatchers.IO +
            (LogBrewCoroutines.traceContextElement(trace) ?: EmptyCoroutineContext) +
            (LogBrewCoroutines.telemetryContextElement(session) ?: EmptyCoroutineContext)

    runBlocking {
        withContext(coroutineContext) {
            LogBrewAndroid.captureScreenView(client, "evt_screen_001", now(), "Checkout", screen)
            client.addBreadcrumb(
                IssueBreadcrumb(now(), "navigation", "screen", IssueBreadcrumbLevel.INFO, "Checkout opened", mapOf("screen" to "Checkout")),
            )
            LogBrewAndroid.withHttpURLConnectionSpan(
                client,
                "evt_request_001",
                now(),
                URL("$base/api/checkout").openConnection() as HttpURLConnection,
                routeTemplate = "/api/checkout",
                context = screen,
            ) { connection -> connection.inputStream.use { it.readBytes() } }
            LogBrewAndroid.captureAndroidLog(client, "evt_log_001", now(), AndroidLogPriority.INFO, "CheckoutActivity", "checkout started", context = screen)
            client.metric(
                "evt_metric_001",
                now(),
                MetricAttributes.create("checkout.duration", "histogram", 120.0, "ms", "delta"),
            )
            try {
                LogBrewAndroid.withHttpURLConnectionSpan(
                    client,
                    "evt_request_002",
                    now(),
                    URL("$base/api/payment").openConnection() as HttpURLConnection,
                    routeTemplate = "/api/payment",
                    context = screen,
                ) { connection -> connection.inputStream.use { it.readBytes() } }
            } catch (error: IOException) {
                LogBrewAndroid.captureAndroidLog(
                    client, "evt_log_002", now(), AndroidLogPriority.WARN, "CheckoutActivity", "payment failed", error, screen,
                )
                LogBrewAndroid.captureThrowable(client, "evt_issue_001", now(), error, screen)
            }
        }
    }
    client.shutdown(HttpTransport(endpoint = System.getenv("LOGBREW_CAPTURE_ENDPOINT")))
    api.stop(0)
}
