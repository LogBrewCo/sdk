package co.logbrew.sdk

class LogBrewClient private constructor(
    private val apiKey: String,
    sdkName: String,
    sdkVersion: String,
    private val maxRetries: Int,
) {
    private val sdk =
        OrderedJsonObject()
            .add("name", sdkName)
            .add("language", "kotlin")
            .add("version", sdkVersion)
    private val events = mutableListOf<Event>()
    private var closed = false

    fun pendingEvents(): Int = events.size

    fun previewJson(): String =
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
        pushEvent("release", id, timestamp, attributes.toJsonObject())
    }

    fun environment(
        id: String,
        timestamp: String,
        attributes: EnvironmentAttributes,
    ) {
        pushEvent("environment", id, timestamp, attributes.toJsonObject())
    }

    fun issue(
        id: String,
        timestamp: String,
        attributes: IssueAttributes,
    ) {
        pushEvent("issue", id, timestamp, attributes.toJsonObject())
    }

    fun log(
        id: String,
        timestamp: String,
        attributes: LogAttributes,
    ) {
        pushEvent("log", id, timestamp, attributes.toJsonObject())
    }

    fun span(
        id: String,
        timestamp: String,
        attributes: SpanAttributes,
    ) {
        pushEvent("span", id, timestamp, attributes.toJsonObject())
    }

    fun metric(
        id: String,
        timestamp: String,
        attributes: MetricAttributes,
    ) {
        pushEvent("metric", id, timestamp, attributes.toJsonObject())
    }

    fun action(
        id: String,
        timestamp: String,
        attributes: ActionAttributes,
    ) {
        pushEvent("action", id, timestamp, attributes.toJsonObject())
    }

    fun flush(transport: Transport): TransportResponse {
        if (closed) {
            throw SdkException("shutdown_error", "client is already shut down")
        }
        return flushInternal(transport)
    }

    fun shutdown(transport: Transport): TransportResponse {
        if (closed) {
            throw SdkException("shutdown_error", "client is already shut down")
        }
        val response = flushInternal(transport)
        closed = true
        return response
    }

    private fun pushEvent(
        type: String,
        id: String,
        timestamp: String,
        attributes: OrderedJsonObject,
    ) {
        if (closed) {
            throw SdkException("shutdown_error", "client is already shut down")
        }
        Validation.requireNonEmpty("event id", id)
        Validation.requireTimestamp(timestamp)
        events += Event(type, timestamp, id, attributes)
    }

    private fun flushInternal(transport: Transport): TransportResponse {
        if (events.isEmpty()) {
            return TransportResponse(204, 0)
        }

        val body = previewJson()
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

        fun create(
            apiKey: String,
            sdkName: String,
            sdkVersion: String,
            maxRetries: Int = 2,
        ): LogBrewClient {
            Validation.requireNonEmpty("api_key", apiKey)
            Validation.requireNonEmpty("sdk_name", sdkName)
            Validation.requireNonEmpty("sdk_version", sdkVersion)
            if (maxRetries < 0) {
                throw SdkException("validation_error", "max_retries must be non-negative")
            }
            return LogBrewClient(apiKey, sdkName, sdkVersion, maxRetries)
        }
    }
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
