import co.logbrew.sdk.CacheOperation
import co.logbrew.sdk.DatabaseOperation
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewOperationTracing
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.LogBrewTraceContext
import co.logbrew.sdk.QueueOperation
import co.logbrew.sdk.RecordingTransport
import co.logbrew.sdk.SdkException

object OperationTracingTests {
    fun runAll() {
        run("dependency_spans_correlate_and_sanitize_metadata", ::dependencySpansCorrelateAndSanitizeMetadata)
        run("dependency_spans_preserve_original_errors", ::dependencySpansPreserveOriginalErrors)
        run("dependency_span_capture_failure_does_not_replace_result", ::dependencySpanCaptureFailureDoesNotReplaceResult)
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

    private fun dependencySpansCorrelateAndSanitizeMetadata() {
        val parent =
            LogBrewTrace.continueOrCreate(
                "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
            )
        val client = newClient()
        var activeContext: LogBrewTraceContext? = null

        val result =
            LogBrewTrace.use(parent).use {
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
                                    "query" to "SELECT * FROM orders WHERE id = 'private'",
                                    "params" to "private",
                                    "host" to "db.internal",
                                    "traceId" to "spoofed_trace",
                                    "spanId" to "spoofed_span",
                                ),
                        ),
                ) {
                    activeContext = LogBrewTrace.currentTraceContext()
                    "order-123"
                }
            }

        check(result == "order-123")
        val child = activeContext ?: error("expected active dependency child trace")
        check(child.traceId == parent.traceId)
        check(child.parentSpanId == parent.spanId)
        check(child.spanId != parent.spanId)
        check(LogBrewTrace.currentTraceContext() == null)

        val body = client.previewJson()
        check("\"type\": \"span\"" in body)
        check("\"name\": \"database:select checkout\"" in body)
        check("\"traceId\": \"${parent.traceId}\"" in body)
        check("\"parentSpanId\": \"${parent.spanId}\"" in body)
        check("\"status\": \"ok\"" in body)
        check("\"durationMs\"" in body)
        check("\"source\": \"database.operation\"" in body)
        check("\"dbSystem\": \"postgresql\"" in body)
        check("\"dbOperation\": \"select checkout\"" in body)
        check("\"dbOperationKind\": \"query\"" in body)
        check("\"dbName\": \"orders\"" in body)
        check("\"dbStatementTemplate\": \"SELECT * FROM orders WHERE id = ?\"" in body)
        check("\"rowCount\": 1" in body)
        check("\"component\": \"checkout\"" in body)
        check("db.internal" !in body)
        check("private" !in body)
        check("params" !in body)
        check("spoofed" !in body)
    }

    private fun dependencySpansPreserveOriginalErrors() {
        val client = newClient()
        val original = IllegalStateException("broker payload contained private order")

        val cacheError =
            expect<IllegalStateException> {
                LogBrewOperationTracing.cacheOperation(
                    client = client,
                    operationName = "get cart",
                    config =
                        CacheOperation(
                            system = "redis",
                            operationKind = "get",
                            cacheName = "checkout-cache",
                            hit = false,
                            metadata =
                                mapOf(
                                    "cacheKey" to "cart:private",
                                    "value" to "sensitive",
                                    "service" to "checkout",
                                ),
                        ),
                ) {
                    throw original
                }
            }
        check(cacheError === original)

        val queueError =
            expect<IllegalStateException> {
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
                            metadata =
                                mapOf(
                                    "messageBody" to "private body",
                                    "brokerUrl" to "kafka://private",
                                    "component" to "billing",
                                ),
                        ),
                ) {
                    throw original
                }
            }
        check(queueError === original)

        val body = client.previewJson()
        check("\"source\": \"cache.operation\"" in body)
        check("\"cacheSystem\": \"redis\"" in body)
        check("\"cacheOperation\": \"get cart\"" in body)
        check("\"cacheName\": \"checkout-cache\"" in body)
        check("\"cacheHit\": false" in body)
        check("\"source\": \"queue.operation\"" in body)
        check("\"queueSystem\": \"kafka\"" in body)
        check("\"queueName\": \"billing-events\"" in body)
        check("\"taskName\": \"invoice.created\"" in body)
        check("\"messageCount\": 1" in body)
        check("\"errorType\": \"IllegalStateException\"" in body)
        check("cart:private" !in body)
        check("sensitive" !in body)
        check("private body" !in body)
        check("kafka://private" !in body)
        check("broker payload" !in body)
    }

    private fun dependencySpanCaptureFailureDoesNotReplaceResult() {
        val client = newClient()
        client.shutdown(RecordingTransport.alwaysAccept())
        var reported: SdkException? = null

        val result =
            LogBrewOperationTracing.databaseOperation(
                client = client,
                operationName = "select checkout",
                config = DatabaseOperation(onCaptureFailure = { reported = it }),
            ) {
                "order-123"
            }

        check(result == "order-123")
        val captureFailure = reported ?: error("expected capture failure")
        check(captureFailure.code == "shutdown_error")
        check((captureFailure.message ?: "").contains("client is already shut down"))
    }

    private fun newClient(): LogBrewClient =
        LogBrewClient.create(
            apiKey = "LOGBREW_API_KEY",
            sdkName = "logbrew-kotlin-operation-tests",
            sdkVersion = "0.1.0",
        )

    private inline fun <reified T : Throwable> expect(callback: () -> Unit): T {
        try {
            callback()
        } catch (error: Throwable) {
            if (error is T) {
                return error
            }
            throw AssertionError("expected ${T::class.java.simpleName} but got $error", error)
        }
        throw AssertionError("expected ${T::class.java.simpleName}")
    }
}
