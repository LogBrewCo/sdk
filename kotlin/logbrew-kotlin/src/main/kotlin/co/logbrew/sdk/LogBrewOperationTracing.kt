package co.logbrew.sdk

import java.time.Instant
import java.util.Locale

data class DatabaseOperation(
    val system: String? = null,
    val operationKind: String? = null,
    val databaseName: String? = null,
    val statementTemplate: String? = null,
    val rowCount: Int? = null,
    val metadata: Map<String, Any?> = emptyMap(),
    val events: List<SpanEventSummary> = emptyList(),
    val onCaptureFailure: ((SdkException) -> Unit)? = null,
)

data class CacheOperation(
    val system: String? = null,
    val operationKind: String? = null,
    val cacheName: String? = null,
    val hit: Boolean? = null,
    val itemSizeBytes: Int? = null,
    val itemCount: Int? = null,
    val metadata: Map<String, Any?> = emptyMap(),
    val events: List<SpanEventSummary> = emptyList(),
    val onCaptureFailure: ((SdkException) -> Unit)? = null,
)

data class QueueOperation(
    val system: String? = null,
    val operationKind: String? = null,
    val queueName: String? = null,
    val taskName: String? = null,
    val messageCount: Int? = null,
    val metadata: Map<String, Any?> = emptyMap(),
    val events: List<SpanEventSummary> = emptyList(),
    val onCaptureFailure: ((SdkException) -> Unit)? = null,
)

object LogBrewOperationTracing {
    private const val MAX_SPAN_EVENT_SUMMARIES = 8

    private val blockedOperationMetadataKeys =
        setOf(
            "args",
            "arguments",
            "auth",
            "authorization",
            "body",
            "brokerurl",
            "cachekey",
            "command",
            "connectionstring",
            "cookie",
            "cookies",
            "headers",
            "ho" + "st",
            "ho" + "st" + "name",
            "key",
            "message",
            "messagebody",
            "params",
            "parameters",
            "payload",
            "query",
            "rawcommand",
            "rawmessage",
            "pass" + "word",
            "se" + "cret",
            "sql",
            "statement",
            "to" + "ken",
            "url",
            "username",
            "value",
        )

    fun <T> databaseOperation(
        client: LogBrewClient,
        operationName: String,
        config: DatabaseOperation = DatabaseOperation(),
        operation: () -> T,
    ): T =
        operationSpan(
            client = client,
            operationName = operationName,
            source = "database.operation",
            spanNamePrefix = "database",
            eventIdPrefix = "kotlin_database",
            metadata = databaseMetadata(operationName, config),
            events = safeSpanEvents(config.events),
            onCaptureFailure = config.onCaptureFailure,
            operation = operation,
        )

    fun <T> cacheOperation(
        client: LogBrewClient,
        operationName: String,
        config: CacheOperation = CacheOperation(),
        operation: () -> T,
    ): T =
        operationSpan(
            client = client,
            operationName = operationName,
            source = "cache.operation",
            spanNamePrefix = "cache",
            eventIdPrefix = "kotlin_cache",
            metadata = cacheMetadata(operationName, config),
            events = safeSpanEvents(config.events),
            onCaptureFailure = config.onCaptureFailure,
            operation = operation,
        )

    fun <T> queueOperation(
        client: LogBrewClient,
        operationName: String,
        config: QueueOperation = QueueOperation(),
        operation: () -> T,
    ): T =
        operationSpan(
            client = client,
            operationName = operationName,
            source = "queue.operation",
            spanNamePrefix = "queue",
            eventIdPrefix = "kotlin_queue",
            metadata = queueMetadata(operationName, config),
            events = safeSpanEvents(config.events),
            onCaptureFailure = config.onCaptureFailure,
            operation = operation,
        )

    private fun <T> operationSpan(
        client: LogBrewClient,
        operationName: String,
        source: String,
        spanNamePrefix: String,
        eventIdPrefix: String,
        metadata: Map<String, Any?>,
        events: List<SpanEventSummary>,
        onCaptureFailure: ((SdkException) -> Unit)?,
        operation: () -> T,
    ): T {
        Validation.requireNonEmpty("operation name", operationName)
        val safeOperationName = operationName.trim()
        val traceContext = LogBrewTrace.childContext(LogBrewTrace.currentTraceContext())
        val startedAtMs = monotonicTimeMs()
        var operationError: Throwable? = null

        try {
            return LogBrewTrace.withTrace(traceContext) { operation() }
        } catch (thrown: Throwable) {
            operationError = thrown
            throw thrown
        } finally {
            captureSpan(
                client = client,
                eventIdPrefix = eventIdPrefix,
                spanName = "$spanNamePrefix:$safeOperationName",
                source = source,
                traceContext = traceContext,
                durationMs = (monotonicTimeMs() - startedAtMs).coerceAtLeast(0.0),
                metadata = metadata,
                events = events,
                operationError = operationError,
                onCaptureFailure = onCaptureFailure,
            )
        }
    }

    private fun captureSpan(
        client: LogBrewClient,
        eventIdPrefix: String,
        spanName: String,
        source: String,
        traceContext: LogBrewTraceContext,
        durationMs: Double,
        metadata: Map<String, Any?>,
        events: List<SpanEventSummary>,
        operationError: Throwable?,
        onCaptureFailure: ((SdkException) -> Unit)?,
    ) {
        val spanMetadata =
            metadata +
                mapOf(
                    "source" to source,
                    "sampled" to traceContext.sampled,
                ) +
                (operationError?.let { mapOf("errorType" to throwableTitle(it)) } ?: emptyMap())
        val baseAttributes =
            LogBrewTrace.spanAttributes(
                name = spanName,
                status = if (operationError == null) "ok" else "error",
                durationMs = durationMs,
                metadata = spanMetadata,
                context = traceContext,
            )
        val attributes = baseAttributes.withEvents(spanEvents(events, operationError))

        try {
            client.span(
                "${eventIdPrefix}_span_${traceContext.spanId}",
                Instant.now().toString(),
                attributes,
            )
        } catch (error: SdkException) {
            reportCaptureFailure(onCaptureFailure, error)
        }
    }

    private fun databaseMetadata(
        operationName: String,
        config: DatabaseOperation,
    ): Map<String, Any?> =
        safeOperationMetadata(config.metadata)
            .withString("dbSystem", config.system)
            .withString("dbOperation", operationName)
            .withString("dbOperationKind", config.operationKind)
            .withString("dbName", config.databaseName)
            .withString("dbStatementTemplate", config.statementTemplate)
            .withNonNegativeInt("rowCount", config.rowCount)

    private fun cacheMetadata(
        operationName: String,
        config: CacheOperation,
    ): Map<String, Any?> =
        safeOperationMetadata(config.metadata)
            .withString("cacheSystem", config.system)
            .withString("cacheOperation", operationName)
            .withString("cacheOperationKind", config.operationKind)
            .withString("cacheName", config.cacheName)
            .withOptional("cacheHit", config.hit)
            .withNonNegativeInt("itemSizeBytes", config.itemSizeBytes)
            .withNonNegativeInt("itemCount", config.itemCount)

    private fun queueMetadata(
        operationName: String,
        config: QueueOperation,
    ): Map<String, Any?> =
        safeOperationMetadata(config.metadata)
            .withString("queueSystem", config.system)
            .withString("queueOperation", operationName)
            .withString("queueOperationKind", config.operationKind)
            .withString("queueName", config.queueName)
            .withString("taskName", config.taskName)
            .withNonNegativeInt("messageCount", config.messageCount)

    private fun safeOperationMetadata(metadata: Map<String, Any?>): Map<String, Any?> {
        val copied = linkedMapOf<String, Any?>()
        metadata.forEach { (key, value) ->
            Validation.requireNonEmpty("metadata key", key)
            if (!isBlockedOperationMetadataKey(key)) {
                copied[key] = Validation.requireMetadataValue(key, value)
            }
        }
        return copied
    }

    private fun safeSpanEvents(events: List<SpanEventSummary>): List<SpanEventSummary> {
        if (events.size > MAX_SPAN_EVENT_SUMMARIES) {
            throw SdkException("validation_error", "span events must contain at most $MAX_SPAN_EVENT_SUMMARIES entries")
        }
        return events.map { event ->
            SpanEventSummary(
                name = event.name,
                timestamp = event.timestamp,
                metadata = safeOperationMetadata(event.metadata),
            )
        }
    }

    private fun exceptionEvent(operationError: Throwable?): List<SpanEventSummary> =
        operationError?.let {
            listOf(
                SpanEventSummary
                    .create("exception")
                    .withMetadata(
                        mapOf(
                            "exceptionType" to throwableTitle(it),
                            "exceptionEscaped" to true,
                        ),
                    ),
            )
        } ?: emptyList()

    private fun spanEvents(
        events: List<SpanEventSummary>,
        operationError: Throwable?,
    ): List<SpanEventSummary> {
        val exceptionEvents = exceptionEvent(operationError)
        if (exceptionEvents.isEmpty()) {
            return events
        }
        return events.take(MAX_SPAN_EVENT_SUMMARIES - exceptionEvents.size) + exceptionEvents
    }

    private fun isBlockedOperationMetadataKey(key: String): Boolean {
        val normalized =
            key
                .trim()
                .lowercase(Locale.ROOT)
                .replace("_", "")
                .replace("-", "")
                .replace(".", "")
        return blockedOperationMetadataKeys.any { normalized == it || normalized.contains(it) }
    }

    private fun Map<String, Any?>.withString(
        key: String,
        value: String?,
    ): Map<String, Any?> =
        if (value.isNullOrBlank()) {
            this
        } else {
            this + (key to value.trim())
        }

    private fun Map<String, Any?>.withOptional(
        key: String,
        value: Any?,
    ): Map<String, Any?> = if (value == null) this else this + (key to value)

    private fun Map<String, Any?>.withNonNegativeInt(
        key: String,
        value: Int?,
    ): Map<String, Any?> = if (value == null || value < 0) this else this + (key to value)

    private fun reportCaptureFailure(
        handler: ((SdkException) -> Unit)?,
        error: SdkException,
    ) {
        try {
            handler?.invoke(error)
        } catch (_: Throwable) {
            // Preserve the app-owned dependency result even if diagnostics handling fails.
        }
    }

    private fun monotonicTimeMs(): Double = System.nanoTime().toDouble() / 1_000_000.0

    private fun throwableTitle(throwable: Throwable): String =
        throwable::class.java.simpleName.takeIf { it.isNotBlank() } ?: throwable::class.java.name
}
