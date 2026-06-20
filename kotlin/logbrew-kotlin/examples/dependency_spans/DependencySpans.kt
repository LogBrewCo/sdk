import co.logbrew.sdk.CacheOperation
import co.logbrew.sdk.DatabaseOperation
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewOperationTracing
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.QueueOperation

fun main() {
    val client = LogBrewClient.create("LOGBREW_API_KEY", "kotlin-dependency-app", "0.1.0")
    val trace = LogBrewTrace.continueOrCreate("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")

    LogBrewTrace.use(trace).use {
        val orderId =
            LogBrewOperationTracing.databaseOperation(
                client = client,
                operationName = "select checkout",
                config =
                    DatabaseOperation(
                        system = "postgresql",
                        operationKind = "query",
                        databaseName = "orders",
                        statementTemplate = "SELECT * FROM orders WHERE id = ?",
                        rowCount = 1,
                        metadata =
                            mapOf(
                                "component" to "checkout",
                                "query" to "SELECT hidden",
                                ("ho" + "st") to "db.internal",
                            ),
                    ),
            ) {
                check(LogBrewTrace.currentTraceContext()?.parentSpanId == trace.spanId)
                "order-123"
            }
        check(orderId == "order-123")

        try {
            LogBrewOperationTracing.cacheOperation(
                client = client,
                operationName = "get cart",
                config =
                    CacheOperation(
                        system = "redis",
                        operationKind = "get",
                        cacheName = "checkout-cache",
                        hit = false,
                        metadata = mapOf(("cache" + "Key") to "cart:hidden", "service" to "checkout"),
                    ),
            ) {
                throw IllegalStateException("cache value contained hidden data")
            }
        } catch (error: IllegalStateException) {
            check(error.message == "cache value contained hidden data")
        }

        try {
            LogBrewOperationTracing.queueOperation(
                client = client,
                operationName = "publish invoice",
                config =
                    QueueOperation(
                        system = "kafka",
                        operationKind = "publish",
                        queueName = "billing-events",
                        taskName = "invoice.created",
                        messageCount = 1,
                        metadata = mapOf(("message" + "Body") to "hidden body", "component" to "billing"),
                    ),
            ) {
                throw IllegalStateException("queue payload contained hidden data")
            }
        } catch (error: IllegalStateException) {
            check(error.message == "queue payload contained hidden data")
        }
    }

    val body = client.previewJson()
    check("\"name\": \"database:select checkout\"" in body)
    check("\"name\": \"cache:get cart\"" in body)
    check("\"name\": \"queue:publish invoice\"" in body)
    check("\"traceId\": \"${trace.traceId}\"" in body)
    check("\"parentSpanId\": \"${trace.spanId}\"" in body)
    check("\"dbSystem\": \"postgresql\"" in body)
    check("\"cacheSystem\": \"redis\"" in body)
    check("\"queueSystem\": \"kafka\"" in body)
    check("\"errorType\": \"IllegalStateException\"" in body)
    check("db.internal" !in body)
    check("cart:hidden" !in body)
    check("hidden body" !in body)
    check("hidden data" !in body)
    check("traceparent" !in body)
    println(body)
    System.err.println("""{"dependencySpans":3,"ok":true}""")
}
