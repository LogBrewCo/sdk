package co.logbrew.sdk

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets

class SdkException(
    val code: String,
    val detailMessage: String,
) : RuntimeException("$code: $detailMessage")

class TransportException(
    val code: String,
    message: String,
    val retryable: Boolean = false,
) : RuntimeException(message) {
    companion object {
        fun network(message: String): TransportException = TransportException("network_failure", message, retryable = true)
    }
}

data class TransportResponse(
    val statusCode: Int,
    val attempts: Int,
)

fun interface Transport {
    fun send(
        apiKey: String,
        body: String,
    ): TransportResponse
}

data class HttpTransportRequest(
    val endpoint: String,
    val headers: Map<String, String>,
    val body: String,
    val connectTimeoutMillis: Int,
    val readTimeoutMillis: Int,
)

fun interface HttpTransportRequester {
    fun send(request: HttpTransportRequest): Int
}

class HttpTransport(
    endpoint: String = DEFAULT_ENDPOINT,
    headers: Map<String, String> = emptyMap(),
    connectTimeoutMillis: Int = DEFAULT_TIMEOUT_MILLIS,
    readTimeoutMillis: Int = DEFAULT_TIMEOUT_MILLIS,
    private val requester: HttpTransportRequester? = null,
) : Transport {
    val endpoint: String = endpoint
    val headers: Map<String, String> = copyHeaders(headers)
    val connectTimeoutMillis: Int = validateTimeout("HTTP connect timeout", connectTimeoutMillis)
    val readTimeoutMillis: Int = validateTimeout("HTTP read timeout", readTimeoutMillis)

    private val endpointUrl: URL = parseEndpoint(endpoint)

    override fun send(
        apiKey: String,
        body: String,
    ): TransportResponse {
        Validation.requireNonEmpty("api_key", apiKey)
        Validation.requireNonEmpty("body", body)
        val request =
            HttpTransportRequest(
                endpoint = endpoint,
                headers = requestHeaders(apiKey),
                body = body,
                connectTimeoutMillis = connectTimeoutMillis,
                readTimeoutMillis = readTimeoutMillis,
            )
        val statusCode = requester?.send(request) ?: sendWithHttpURLConnection(request)
        return TransportResponse(statusCode, 1)
    }

    private fun requestHeaders(apiKey: String): Map<String, String> {
        val values =
            linkedMapOf(
                "content-type" to "application/json",
                "authorization" to "Bearer $apiKey",
            )
        values.putAll(headers)
        return values
    }

    private fun sendWithHttpURLConnection(request: HttpTransportRequest): Int {
        val connection = endpointUrl.openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.connectTimeout = request.connectTimeoutMillis
            connection.readTimeout = request.readTimeoutMillis
            request.headers.forEach { (name, value) ->
                connection.setRequestProperty(name, value)
            }
            val bytes = request.body.toByteArray(StandardCharsets.UTF_8)
            connection.outputStream.use { output ->
                output.write(bytes)
            }
            return connection.responseCode
        } catch (error: IOException) {
            throw TransportException.network("http transport failed: ${error.message ?: error.javaClass.simpleName}")
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        const val DEFAULT_ENDPOINT: String = "https://api.logbrew.com/v1/events"
        const val DEFAULT_TIMEOUT_MILLIS: Int = 10_000

        private fun parseEndpoint(endpoint: String): URL {
            requireConfigurationNonEmpty("HTTP transport endpoint", endpoint)
            val uri =
                try {
                    URI(endpoint)
                } catch (error: Exception) {
                    throw SdkException("configuration_error", "HTTP transport endpoint must be a valid URI")
                }
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") {
                throw SdkException("configuration_error", "HTTP transport endpoint must use http or https")
            }
            if (uri.host.isNullOrBlank()) {
                throw SdkException("configuration_error", "HTTP transport endpoint must include a host")
            }
            return try {
                uri.toURL()
            } catch (error: Exception) {
                throw SdkException("configuration_error", "HTTP transport endpoint must be a valid URL")
            }
        }

        private fun validateTimeout(
            label: String,
            timeoutMillis: Int,
        ): Int {
            if (timeoutMillis <= 0) {
                throw SdkException("configuration_error", "$label must be positive")
            }
            return timeoutMillis
        }

        private fun copyHeaders(headers: Map<String, String>): Map<String, String> {
            val safeHeaders = linkedMapOf<String, String>()
            headers.forEach { (name, value) ->
                requireConfigurationNonEmpty("HTTP header name", name)
                requireConfigurationNonEmpty("HTTP header value", value)
                safeHeaders[name] = value
            }
            return safeHeaders.toMap()
        }

        private fun requireConfigurationNonEmpty(
            label: String,
            value: String,
        ) {
            if (value.isBlank()) {
                throw SdkException("configuration_error", "$label must be non-empty")
            }
        }
    }
}

class RecordingTransport(
    scriptedResponses: Iterable<Any> = listOf(202),
) : Transport {
    private val responses = ArrayDeque(scriptedResponses.toList().ifEmpty { listOf(202) })
    private val mutableSentBodies = mutableListOf<String>()

    val sentBodies: List<String>
        get() = mutableSentBodies.toList()

    val lastBody: String?
        get() = mutableSentBodies.lastOrNull()

    override fun send(
        apiKey: String,
        body: String,
    ): TransportResponse {
        Validation.requireNonEmpty("api_key", apiKey)
        Validation.requireNonEmpty("body", body)
        mutableSentBodies += body
        return when (val next = responses.removeFirstOrNull() ?: 202) {
            is TransportException -> throw next
            is SdkException -> throw next
            is TransportResponse -> next.copy(attempts = 1)
            is Int -> TransportResponse(next, 1)
            else -> throw SdkException("transport_error", "invalid scripted transport response")
        }
    }

    companion object {
        fun alwaysAccept(): RecordingTransport = RecordingTransport(listOf(202))
    }
}

data class AndroidContext(
    private val values: Map<String, Any?>,
) {
    fun withActivityName(activityName: String): AndroidContext = withMetadata("activityName", activityName)

    fun withScreenName(screenName: String): AndroidContext = withMetadata("screenName", screenName)

    fun withDeviceModel(deviceModel: String): AndroidContext = withMetadata("deviceModel", deviceModel)

    fun withOsVersion(osVersion: String): AndroidContext = withMetadata("osVersion", osVersion)

    fun withSessionId(sessionId: String): AndroidContext = withMetadata("sessionId", sessionId)

    fun withMetadata(
        key: String,
        value: Any?,
    ): AndroidContext {
        Validation.requireNonEmpty("android metadata key", key)
        return AndroidContext(values + (key to Validation.requireMetadataValue(key, value)))
    }

    internal fun toMetadata(): Map<String, Any?> = values.toMap()

    companion object {
        fun create(): AndroidContext = AndroidContext(emptyMap())
    }
}

data class ReleaseAttributes(
    val version: String,
    val commit: String? = null,
    val notes: String? = null,
    val metadata: Map<String, Any?> = emptyMap(),
) {
    fun withCommit(commit: String): ReleaseAttributes = copy(commit = commit)

    fun withNotes(notes: String): ReleaseAttributes = copy(notes = notes)

    fun withMetadata(metadata: Map<String, Any?>): ReleaseAttributes = copy(metadata = metadata)

    internal fun toJsonObject(): OrderedJsonObject {
        Validation.requireNonEmpty("release version", version)
        commit?.let { Validation.requireNonEmpty("release commit", it) }
        return OrderedJsonObject()
            .add("version", version)
            .addIfNotNull("commit", commit)
            .addIfNotNull("notes", notes)
            .addMetadata(metadata)
    }

    companion object {
        fun create(version: String): ReleaseAttributes = ReleaseAttributes(version)
    }
}

data class EnvironmentAttributes(
    val name: String,
    val region: String? = null,
    val metadata: Map<String, Any?> = emptyMap(),
) {
    fun withRegion(region: String): EnvironmentAttributes = copy(region = region)

    fun withMetadata(metadata: Map<String, Any?>): EnvironmentAttributes = copy(metadata = metadata)

    internal fun toJsonObject(): OrderedJsonObject {
        Validation.requireNonEmpty("environment name", name)
        return OrderedJsonObject()
            .add("name", name)
            .addIfNotNull("region", region)
            .addMetadata(metadata)
    }

    companion object {
        fun create(name: String): EnvironmentAttributes = EnvironmentAttributes(name)
    }
}

data class IssueAttributes(
    val title: String,
    val level: String,
    val message: String? = null,
    val metadata: Map<String, Any?> = emptyMap(),
) {
    fun withMessage(message: String): IssueAttributes = copy(message = message)

    fun withMetadata(metadata: Map<String, Any?>): IssueAttributes = copy(metadata = metadata)

    internal fun toJsonObject(): OrderedJsonObject {
        Validation.requireNonEmpty("issue title", title)
        Validation.requireAllowedValue("issue level", level, LogBrewClient.issueLevels)
        return OrderedJsonObject()
            .add("title", title)
            .add("level", level)
            .addIfNotNull("message", message)
            .addMetadata(metadata)
    }

    companion object {
        fun create(
            title: String,
            level: String,
        ): IssueAttributes = IssueAttributes(title, level)
    }
}

data class LogAttributes(
    val message: String,
    val level: String,
    val logger: String? = null,
    val metadata: Map<String, Any?> = emptyMap(),
) {
    fun withLogger(logger: String): LogAttributes = copy(logger = logger)

    fun withMetadata(metadata: Map<String, Any?>): LogAttributes = copy(metadata = metadata)

    internal fun toJsonObject(): OrderedJsonObject {
        Validation.requireNonEmpty("log message", message)
        Validation.requireAllowedValue("log level", level, LogBrewClient.logLevels)
        return OrderedJsonObject()
            .add("message", message)
            .add("level", level)
            .addIfNotNull("logger", logger)
            .addMetadata(metadata)
    }

    companion object {
        fun create(
            message: String,
            level: String,
        ): LogAttributes = LogAttributes(message, level)
    }
}

data class SpanAttributes(
    val name: String,
    val traceId: String,
    val spanId: String,
    val status: String,
    val parentSpanId: String? = null,
    val durationMs: Double? = null,
    val metadata: Map<String, Any?> = emptyMap(),
) {
    fun withParentSpanId(parentSpanId: String): SpanAttributes = copy(parentSpanId = parentSpanId)

    fun withDurationMs(durationMs: Double): SpanAttributes = copy(durationMs = durationMs)

    fun withMetadata(metadata: Map<String, Any?>): SpanAttributes = copy(metadata = metadata)

    internal fun toJsonObject(): OrderedJsonObject {
        Validation.requireNonEmpty("span name", name)
        Validation.requireNonEmpty("span traceId", traceId)
        Validation.requireNonEmpty("span spanId", spanId)
        Validation.requireAllowedValue("span status", status, LogBrewClient.spanStatuses)
        parentSpanId?.let { Validation.requireNonEmpty("span parentSpanId", it) }
        if (durationMs != null && (durationMs < 0 || durationMs.isNaN() || durationMs.isInfinite())) {
            throw SdkException("validation_error", "span durationMs must be non-negative")
        }

        return OrderedJsonObject()
            .add("name", name)
            .add("traceId", traceId)
            .add("spanId", spanId)
            .addIfNotNull("parentSpanId", parentSpanId)
            .add("status", status)
            .also { payload ->
                if (durationMs != null) {
                    payload.add("durationMs", durationMs)
                }
            }.addMetadata(metadata)
    }

    companion object {
        fun create(
            name: String,
            traceId: String,
            spanId: String,
            status: String,
        ): SpanAttributes = SpanAttributes(name, traceId, spanId, status)
    }
}

data class ActionAttributes(
    val name: String,
    val status: String,
    val metadata: Map<String, Any?> = emptyMap(),
) {
    fun withMetadata(metadata: Map<String, Any?>): ActionAttributes = copy(metadata = metadata)

    internal fun toJsonObject(): OrderedJsonObject {
        Validation.requireNonEmpty("action name", name)
        Validation.requireAllowedValue("action status", status, LogBrewClient.actionStatuses)
        return OrderedJsonObject()
            .add("name", name)
            .add("status", status)
            .addMetadata(metadata)
    }

    companion object {
        fun create(
            name: String,
            status: String,
        ): ActionAttributes = ActionAttributes(name, status)
    }
}
