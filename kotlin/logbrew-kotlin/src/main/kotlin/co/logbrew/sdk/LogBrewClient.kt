package co.logbrew.sdk

class LogBrewClient private constructor(
    private val apiKey: String,
    sdkName: String,
    sdkVersion: String,
    private val maxRetries: Int,
    private val context: TelemetryContext?,
) {
    private val sdk =
        OrderedJsonObject()
            .add("name", sdkName)
            .add("language", "kotlin")
            .add("version", sdkVersion)
    private val stateLock = Any()
    private val events = mutableListOf<Event>()
    private val breadcrumbStore = IssueBreadcrumbStore()
    private var closed = false

    fun pendingEvents(): Int = synchronized(stateLock) { events.size }

    fun previewJson(): String = synchronized(stateLock) { previewJsonLocked() }

    private fun previewJsonLocked(): String =
        JsonWriter.write(
            OrderedJsonObject()
                .add("sdk", sdk)
                .add("events", events.map { it.toJsonObject() }),
        )

    fun release(
        id: String,
        timestamp: String,
        attributes: ReleaseAttributes,
    ) {
        pushEvent("release", id, timestamp, attributes.copy(context = resolvedContext(attributes.context)).toJsonObject())
    }

    fun environment(
        id: String,
        timestamp: String,
        attributes: EnvironmentAttributes,
    ) {
        pushEvent("environment", id, timestamp, attributes.copy(context = resolvedContext(attributes.context)).toJsonObject())
    }

    fun issue(
        id: String,
        timestamp: String,
        attributes: IssueAttributes,
    ) {
        val snapshot = synchronized(stateLock) { breadcrumbStore.snapshot() }
        val resolvedContext = resolvedContext(attributes.context)
        val resolved =
            attributes
                .withBreadcrumbSnapshot(snapshot)
                .withResolvedTraceMetadata(resolvedContext?.trace)
                .copy(context = resolvedContext)
        pushEvent("issue", id, timestamp, resolved.toJsonObject())
    }

    fun log(
        id: String,
        timestamp: String,
        attributes: LogAttributes,
    ) {
        val resolvedContext = resolvedContext(attributes.context)
        val resolved =
            attributes
                .withResolvedTraceMetadata(resolvedContext?.trace)
                .copy(context = resolvedContext)
        pushEvent("log", id, timestamp, resolved.toJsonObject())
    }

    fun span(
        id: String,
        timestamp: String,
        attributes: SpanAttributes,
    ) {
        val resolvedContext = resolvedSpanContext(attributes.context, attributes.telemetryTraceContext())
        pushEvent("span", id, timestamp, attributes.copy(context = resolvedContext).toJsonObject())
    }

    fun metric(
        id: String,
        timestamp: String,
        attributes: MetricAttributes,
    ) {
        val resolvedContext = resolvedContext(attributes.context)
        val resolved =
            attributes
                .withResolvedTraceMetadata(resolvedContext?.trace)
                .copy(context = resolvedContext)
        pushEvent("metric", id, timestamp, resolved.toJsonObject())
    }

    fun action(
        id: String,
        timestamp: String,
        attributes: ActionAttributes,
    ) {
        val resolvedContext = resolvedContext(attributes.context)
        val resolved =
            attributes
                .withResolvedTraceMetadata(resolvedContext?.trace)
                .copy(context = resolvedContext)
        pushEvent("action", id, timestamp, resolved.toJsonObject())
    }

    /** Adds one privacy-bounded breadcrumb to future issue snapshots. */
    fun addBreadcrumb(breadcrumb: IssueBreadcrumb) {
        synchronized(stateLock) {
            requireOpen()
            breadcrumbStore.add(breadcrumb)
        }
    }

    /** Clears all client breadcrumbs and their truncation marker. */
    fun clearBreadcrumbs() {
        synchronized(stateLock) {
            requireOpen()
            breadcrumbStore.clear()
        }
    }

    fun flush(transport: Transport): TransportResponse {
        synchronized(stateLock) {
            if (closed) {
                throw SdkException("shutdown_error", "client is already shut down")
            }
            return flushInternal(transport)
        }
    }

    fun shutdown(transport: Transport): TransportResponse {
        synchronized(stateLock) {
            if (closed) {
                throw SdkException("shutdown_error", "client is already shut down")
            }
            val response = flushInternal(transport)
            closed = true
            return response
        }
    }

    private fun pushEvent(
        type: String,
        id: String,
        timestamp: String,
        attributes: OrderedJsonObject,
    ) {
        Validation.requireNonEmpty("event id", id)
        Validation.requireTimestamp(timestamp)
        synchronized(stateLock) {
            requireOpen()
            events += Event(type, timestamp, id, attributes)
        }
    }

    private fun resolvedContext(eventContext: TelemetryContext?): TelemetryContext? {
        var value = context
        value = TelemetryContext.merge(value, LogBrewTelemetry.currentContext())
        val activeTrace = LogBrewTrace.currentTraceContext()?.toTelemetryTraceContext()
        if (activeTrace != null) {
            value = TelemetryContext.merge(value, TelemetryContext(trace = activeTrace))
        }
        return TelemetryContext.merge(value, eventContext)
    }

    private fun resolvedSpanContext(
        eventContext: TelemetryContext?,
        signalTrace: TelemetryTraceContext?,
    ): TelemetryContext? {
        var value = TelemetryContext.merge(context.withoutTrace(), LogBrewTelemetry.currentContext().withoutTrace())
        value = TelemetryContext.merge(value, eventContext.withoutTrace())
        return TelemetryContext.merge(value, signalTrace?.let { TelemetryContext(trace = it) })
    }

    private fun requireOpen() {
        if (closed) {
            throw SdkException("shutdown_error", "client is already shut down")
        }
    }

    private fun flushInternal(transport: Transport): TransportResponse {
        if (events.isEmpty()) {
            return TransportResponse(204, 0)
        }

        val body = previewJsonLocked()
        val maxAttempts = maxRetries + 1
        for (attempt in 1..maxAttempts) {
            try {
                val response = transport.send(apiKey, body)
                if (response.statusCode == 401) {
                    throw SdkException("unauthenticated", "transport rejected the API key")
                }
                if (response.statusCode in 200..299) {
                    events.clear()
                    return response.copy(attempts = attempt)
                }
                if (response.statusCode >= 500 && attempt < maxAttempts) {
                    continue
                }
                throw SdkException("transport_error", "unexpected transport status ${response.statusCode}")
            } catch (error: TransportException) {
                if (error.retryable && attempt < maxAttempts) {
                    continue
                }
                throw SdkException(error.code, error.message ?: error.code)
            }
        }

        throw SdkException("transport_error", "exhausted retries")
    }

    companion object {
        internal val severityValues = setOf("trace", "debug", "info", "warn", "warning", "error", "fatal", "critical")
        internal val spanStatuses = setOf("ok", "error")
        internal val actionStatuses = setOf("queued", "running", "success", "failure")
        internal val metricKinds = setOf("counter", "gauge", "histogram")
        internal val instantTemporality = setOf("instant")
        internal val deltaCumulativeTemporalities = setOf("delta", "cumulative")

        @JvmOverloads
        fun create(
            apiKey: String,
            sdkName: String,
            sdkVersion: String,
            maxRetries: Int = 2,
            context: TelemetryContext? = null,
            includeAutomaticContext: Boolean = true,
        ): LogBrewClient {
            Validation.requireNonEmpty("api_key", apiKey)
            Validation.requireNonEmpty("sdk_name", sdkName)
            Validation.requireNonEmpty("sdk_version", sdkVersion)
            if (maxRetries < 0) {
                throw SdkException("validation_error", "max_retries must be non-negative")
            }
            val baseContext =
                TelemetryContext.merge(
                    if (includeAutomaticContext) automaticTelemetryContext() else null,
                    context,
                )
            return LogBrewClient(apiKey, sdkName, sdkVersion, maxRetries, baseContext)
        }
    }
}

private fun TelemetryContext?.withoutTrace(): TelemetryContext? {
    if (this == null || trace == null) {
        return this
    }
    if (resource == null && session == null && subject == null && tags == null) {
        return null
    }
    return copy(trace = null).normalized()
}

private fun IssueAttributes.withResolvedTraceMetadata(trace: TelemetryTraceContext?): IssueAttributes =
    copy(metadata = resolvedTraceMetadata(metadata, trace))

private fun LogAttributes.withResolvedTraceMetadata(trace: TelemetryTraceContext?): LogAttributes =
    copy(metadata = resolvedTraceMetadata(metadata, trace))

private fun MetricAttributes.withResolvedTraceMetadata(trace: TelemetryTraceContext?): MetricAttributes =
    copy(metadata = resolvedTraceMetadata(metadata, trace))

private fun ActionAttributes.withResolvedTraceMetadata(trace: TelemetryTraceContext?): ActionAttributes =
    copy(metadata = resolvedTraceMetadata(metadata, trace))

private fun SpanAttributes.telemetryTraceContext(): TelemetryTraceContext? {
    val active = LogBrewTrace.currentTraceContext()
    if (
        active != null &&
        active.traceId.equals(traceId, ignoreCase = true) &&
        active.spanId.equals(spanId, ignoreCase = true) &&
        active.parentSpanId.equals(parentSpanId, ignoreCase = true)
    ) {
        return active.toTelemetryTraceContext()
    }
    return try {
        TelemetryContext(
            trace =
                TelemetryTraceContext(
                    traceId = traceId,
                    spanId = spanId,
                    parentSpanId = parentSpanId,
                ),
        ).normalized().trace
    } catch (_: SdkException) {
        null
    }
}

private fun resolvedTraceMetadata(
    metadata: Map<String, Any?>,
    trace: TelemetryTraceContext?,
): Map<String, Any?> {
    if (trace == null) {
        return metadata
    }
    val traceKeys = setOf("traceId", "spanId", "parentSpanId", "traceFlags", "traceSampled")
    val merged = linkedMapOf<String, Any?>()
    metadata.forEach { (key, value) -> if (key !in traceKeys) merged[key] = value }
    merged["traceId"] = trace.traceId
    trace.spanId?.let { merged["spanId"] = it }
    trace.parentSpanId?.let { merged["parentSpanId"] = it }
    trace.sampled?.let { sampled ->
        merged["traceFlags"] = if (sampled) "01" else "00"
        merged["traceSampled"] = sampled
    }
    return merged.toMap()
}

private data class Event(
    val type: String,
    val timestamp: String,
    val id: String,
    val attributes: OrderedJsonObject,
) {
    fun toJsonObject(): OrderedJsonObject =
        OrderedJsonObject()
            .add("type", type)
            .add("timestamp", timestamp)
            .add("id", id)
            .add("attributes", attributes)
}
