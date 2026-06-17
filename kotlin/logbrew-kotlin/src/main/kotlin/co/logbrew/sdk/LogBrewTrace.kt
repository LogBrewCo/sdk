package co.logbrew.sdk

import java.security.SecureRandom
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

data class LogBrewTraceContext(
    val traceId: String,
    val spanId: String,
    val parentSpanId: String? = null,
    val traceFlags: String = "01",
    val sampled: Boolean = true,
) {
    fun traceparent(): String {
        LogBrewTrace.validateContext(this)
        return "00-$traceId-$spanId-$traceFlags"
    }
}

class LogBrewTraceScope internal constructor(
    private val scopeId: Long,
) : AutoCloseable {
    private var closed = false

    override fun close() {
        if (!closed) {
            closed = true
            LogBrewTrace.close(scopeId)
        }
    }
}

object LogBrewTrace {
    private const val TRACE_ID_LENGTH = 32
    private const val SPAN_ID_LENGTH = 16
    private const val TRACE_FLAGS_LENGTH = 2
    private const val TRACEPARENT_LENGTH = 55

    private val hex = "0123456789abcdef".toCharArray()
    private val random = SecureRandom()
    private val nextScopeId = AtomicLong(1)
    private val scopes = ThreadLocal.withInitial { mutableListOf<TraceFrame>() }
    private val traceMetadataKeys = setOf("traceId", "spanId", "parentSpanId", "traceFlags", "traceSampled")

    fun createTraceContext(sampled: Boolean = true): LogBrewTraceContext =
        LogBrewTraceContext(
            traceId = randomTraceId(),
            spanId = randomSpanId(),
            traceFlags = if (sampled) "01" else "00",
            sampled = sampled,
        )

    fun fromTraceparent(traceparent: String): LogBrewTraceContext? {
        val value = traceparent.trim().lowercase(Locale.ROOT)
        if (value.length != TRACEPARENT_LENGTH) {
            return null
        }
        if (value[2] != '-' || value[35] != '-' || value[52] != '-') {
            return null
        }
        val version = value.substring(0, 2)
        val traceId = value.substring(3, 35)
        val parentSpanId = value.substring(36, 52)
        val traceFlags = value.substring(53, 55)
        if (version != "00") {
            return null
        }
        if (!isLowerHex(traceId) || !isLowerHex(parentSpanId) || !isLowerHex(traceFlags)) {
            return null
        }
        if (isAllZeros(traceId) || isAllZeros(parentSpanId)) {
            return null
        }
        return LogBrewTraceContext(
            traceId = traceId,
            spanId = randomSpanId(),
            parentSpanId = parentSpanId,
            traceFlags = traceFlags,
            sampled = traceFlags.toInt(radix = 16).and(1) == 1,
        )
    }

    fun continueOrCreate(traceparent: String?): LogBrewTraceContext = traceparent?.let { fromTraceparent(it) } ?: createTraceContext()

    fun currentTraceContext(): LogBrewTraceContext? = scopes.get().lastOrNull()?.context

    internal fun childContext(parentContext: LogBrewTraceContext?): LogBrewTraceContext {
        if (parentContext == null) {
            return createTraceContext()
        }
        validateContext(parentContext)
        return LogBrewTraceContext(
            traceId = parentContext.traceId,
            spanId = randomSpanId(),
            parentSpanId = parentContext.spanId,
            traceFlags = parentContext.traceFlags,
            sampled = parentContext.sampled,
        )
    }

    fun use(context: LogBrewTraceContext): LogBrewTraceScope {
        validateContext(context)
        val scopeId = nextScopeId.getAndIncrement()
        scopes.get().add(TraceFrame(scopeId, context))
        return LogBrewTraceScope(scopeId)
    }

    fun <T> withTrace(
        context: LogBrewTraceContext,
        block: () -> T,
    ): T = use(context).use { block() }

    fun traceMetadata(context: LogBrewTraceContext? = currentTraceContext()): Map<String, Any?> {
        if (context == null) {
            return emptyMap()
        }
        validateContext(context)
        val metadata =
            linkedMapOf<String, Any?>(
                "traceId" to context.traceId,
                "spanId" to context.spanId,
                "traceFlags" to context.traceFlags,
                "traceSampled" to context.sampled,
            )
        context.parentSpanId?.let { metadata["parentSpanId"] = it }
        return metadata
    }

    fun spanAttributes(
        name: String,
        status: String = "ok",
        durationMs: Double? = null,
        metadata: Map<String, Any?> = emptyMap(),
        context: LogBrewTraceContext = currentTraceContext() ?: createTraceContext(),
    ): SpanAttributes {
        validateContext(context)
        var attributes =
            SpanAttributes
                .create(name, context.traceId, context.spanId, status)
                .withMetadata(mergeTraceMetadata(metadata, context))
        context.parentSpanId?.let {
            attributes = attributes.withParentSpanId(it)
        }
        durationMs?.let {
            attributes = attributes.withDurationMs(it)
        }
        return attributes
    }

    fun outgoingHeaders(context: LogBrewTraceContext = currentTraceContext() ?: createTraceContext()): Map<String, String> {
        validateContext(context)
        return mapOf("traceparent" to context.traceparent())
    }

    internal fun mergeTraceMetadata(
        metadata: Map<String, Any?>,
        context: LogBrewTraceContext? = currentTraceContext(),
    ): Map<String, Any?> {
        if (context == null) {
            return metadata
        }
        validateContext(context)
        val merged = linkedMapOf<String, Any?>()
        metadata.forEach { (key, value) ->
            if (key !in traceMetadataKeys) {
                merged[key] = value
            }
        }
        merged.putAll(traceMetadata(context))
        return merged
    }

    internal fun validateContext(context: LogBrewTraceContext) {
        requireHexId("trace traceId", context.traceId, TRACE_ID_LENGTH)
        requireHexId("trace spanId", context.spanId, SPAN_ID_LENGTH)
        context.parentSpanId?.let { requireHexId("trace parentSpanId", it, SPAN_ID_LENGTH) }
        if (context.traceFlags.length != TRACE_FLAGS_LENGTH || !isLowerHex(context.traceFlags)) {
            throw SdkException("validation_error", "trace traceFlags must be two lowercase hex characters")
        }
        if (context.sampled != (context.traceFlags.toInt(radix = 16).and(1) == 1)) {
            throw SdkException("validation_error", "trace sampled must match traceFlags")
        }
    }

    internal fun close(scopeId: Long) {
        val stack = scopes.get()
        val index = stack.indexOfLast { it.id == scopeId }
        if (index >= 0) {
            stack.removeAt(index)
        }
        if (stack.isEmpty()) {
            scopes.remove()
        }
    }

    private fun requireHexId(
        label: String,
        value: String,
        length: Int,
    ) {
        if (value.length != length || !isLowerHex(value) || isAllZeros(value)) {
            throw SdkException("validation_error", "$label must be $length lowercase hex characters and non-zero")
        }
    }

    private fun randomTraceId(): String {
        var value = randomHex(TRACE_ID_LENGTH)
        while (isAllZeros(value)) {
            value = randomHex(TRACE_ID_LENGTH)
        }
        return value
    }

    private fun randomSpanId(): String {
        var value = randomHex(SPAN_ID_LENGTH)
        while (isAllZeros(value)) {
            value = randomHex(SPAN_ID_LENGTH)
        }
        return value
    }

    private fun randomHex(length: Int): String =
        buildString(length) {
            repeat(length) {
                append(hex[random.nextInt(hex.size)])
            }
        }

    private fun isLowerHex(value: String): Boolean = value.all { it in '0'..'9' || it in 'a'..'f' }

    private fun isAllZeros(value: String): Boolean = value.all { it == '0' }

    private data class TraceFrame(
        val id: Long,
        val context: LogBrewTraceContext,
    )
}
