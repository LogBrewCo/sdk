package co.logbrew.sdk

import java.net.URI
import java.net.URISyntaxException

object AndroidLogPriority {
    const val VERBOSE: Int = 2
    const val DEBUG: Int = 3
    const val INFO: Int = 4
    const val WARN: Int = 5
    const val ERROR: Int = 6
    const val ASSERT: Int = 7
}

class AndroidRequestSpan internal constructor(
    val method: String,
    val routeTemplate: String,
    val traceContext: LogBrewTraceContext,
    val headers: Map<String, String>,
    internal val metadata: Map<String, Any?>,
) {
    val traceparent: String
        get() = headers.getValue("traceparent")

    fun applyHeadersTo(setHeader: LogBrewHeaderSetter): AndroidRequestSpan {
        headers.forEach { (name, value) -> setHeader.set(name, value) }
        return this
    }

    fun <T> withTrace(block: () -> T): T = LogBrewTrace.withTrace(traceContext, block)
}

fun interface LogBrewHeaderSetter {
    fun set(
        name: String,
        value: String,
    )
}

object LogBrewAndroid {
    private const val SDK_VERSION: String = "0.1.0"

    val sdkVersion: String
        get() = SDK_VERSION

    fun createClient(
        apiKey: String,
        appName: String,
        maxRetries: Int = 2,
    ): LogBrewClient = LogBrewClient.create(apiKey, appName, SDK_VERSION, maxRetries)

    fun captureActivityStarted(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        activityName: String,
        context: AndroidContext = AndroidContext.create(),
    ) {
        Validation.requireNonEmpty("android activityName", activityName)
        val metadata = context.toMetadata() + mapOf("activityName" to activityName, "lifecycle" to "started")
        client.action(id, timestamp, ActionAttributes.create("activity_started", "success").withMetadata(metadata))
    }

    fun captureScreenView(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        screenName: String,
        context: AndroidContext = AndroidContext.create(),
    ) {
        Validation.requireNonEmpty("android screenName", screenName)
        val metadata = context.toMetadata() + mapOf("screenName" to screenName)
        client.action(id, timestamp, ActionAttributes.create("screen_view", "success").withMetadata(metadata))
    }

    fun captureProductAction(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        name: String,
        status: String = "success",
        context: AndroidContext = AndroidContext.create(),
        metadata: Map<String, Any?> = emptyMap(),
    ) {
        val safeMetadata =
            context.toMetadata() +
                compactMetadata(metadata) +
                mapOf("source" to "android.action")
        client.action(id, timestamp, ActionAttributes.create(name, status).withMetadata(safeMetadata))
    }

    fun captureNetworkMilestone(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        method: String,
        routeTemplate: String,
        statusCode: Int? = null,
        durationMs: Double? = null,
        status: String? = null,
        context: AndroidContext = AndroidContext.create(),
        metadata: Map<String, Any?> = emptyMap(),
    ) {
        val safeMethod = normalizedMethod(method)
        val safeRouteTemplate = routeTemplatePath(routeTemplate)
        val safeStatusCode = checkedStatusCode(statusCode)
        val safeDurationMs = checkedDurationMs(durationMs)
        val actionStatus = status ?: statusFromStatusCode(safeStatusCode)
        val timelineMetadata =
            context.toMetadata() +
                compactMetadata(metadata) +
                mapOf(
                    "source" to "android.network",
                    "method" to safeMethod,
                    "routeTemplate" to safeRouteTemplate,
                ) +
                optionalMetadata("statusCode", safeStatusCode) +
                optionalMetadata("durationMs", safeDurationMs)
        client.action(
            id,
            timestamp,
            ActionAttributes.create("$safeMethod $safeRouteTemplate", actionStatus).withMetadata(timelineMetadata),
        )
    }

    fun startRequestSpan(
        method: String,
        routeTemplate: String,
        context: AndroidContext = AndroidContext.create(),
        traceContext: LogBrewTraceContext? = null,
        metadata: Map<String, Any?> = emptyMap(),
    ): AndroidRequestSpan {
        val safeMethod = normalizedMethod(method)
        val safeRouteTemplate = routeTemplatePath(routeTemplate)
        val parentContext = traceContext ?: LogBrewTrace.currentTraceContext()
        val requestContext = LogBrewTrace.childContext(parentContext)
        val safeMetadata =
            context.toMetadata() +
                compactMetadata(metadata) +
                mapOf(
                    "source" to "android.request",
                    "method" to safeMethod,
                    "routeTemplate" to safeRouteTemplate,
                )
        return AndroidRequestSpan(
            method = safeMethod,
            routeTemplate = safeRouteTemplate,
            traceContext = requestContext,
            headers = LogBrewTrace.outgoingHeaders(requestContext),
            metadata = safeMetadata,
        )
    }

    fun captureRequestSpan(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        requestSpan: AndroidRequestSpan,
        statusCode: Int? = null,
        durationMs: Double? = null,
        error: Throwable? = null,
        status: String? = null,
        metadata: Map<String, Any?> = emptyMap(),
    ) {
        val safeStatusCode = checkedStatusCode(statusCode)
        val safeDurationMs = checkedDurationMs(durationMs)
        val spanStatus = status ?: if (error != null || (safeStatusCode != null && safeStatusCode >= 400)) "error" else "ok"
        val spanMetadata =
            requestSpan.metadata +
                compactMetadata(metadata) +
                optionalMetadata("statusCode", safeStatusCode) +
                (error?.let { requestErrorMetadata(it) } ?: emptyMap())
        client.span(
            id,
            timestamp,
            LogBrewTrace.spanAttributes(
                name = "${requestSpan.method} ${requestSpan.routeTemplate}",
                status = spanStatus,
                durationMs = safeDurationMs,
                metadata = spanMetadata,
                context = requestSpan.traceContext,
            ),
        )
    }

    fun captureLogcat(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        message: String,
        priority: String,
        tag: String = "android",
        context: AndroidContext = AndroidContext.create(),
    ) {
        Validation.requireNonEmpty("android priority", priority)
        Validation.requireNonEmpty("android tag", tag)
        val metadata = context.toMetadata() + mapOf("androidPriority" to priority)
        client.log(id, timestamp, LogAttributes.create(message, mapLogLevel(priority)).withLogger(tag).withMetadata(metadata))
    }

    fun captureAndroidLog(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        priority: Int,
        tag: String,
        message: String,
        throwable: Throwable? = null,
        context: AndroidContext = AndroidContext.create(),
        includeStackTrace: Boolean = false,
    ) {
        client.log(
            id,
            timestamp,
            logAttributesFromAndroidLog(
                priority = priority,
                tag = tag,
                message = message,
                throwable = throwable,
                context = context,
                includeStackTrace = includeStackTrace,
            ),
        )
    }

    fun captureException(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        title: String,
        stackTrace: String,
        context: AndroidContext = AndroidContext.create(),
    ) {
        val metadata = context.toMetadata() + mapOf("source" to "android")
        client.issue(id, timestamp, IssueAttributes.create(title, "error").withMessage(stackTrace).withMetadata(metadata))
    }

    fun captureThrowable(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        throwable: Throwable,
        context: AndroidContext = AndroidContext.create(),
        title: String = throwableTitle(throwable),
        includeStackTrace: Boolean = false,
    ) {
        Validation.requireNonEmpty("android throwable title", title)
        val metadata = context.toMetadata() + throwableMetadata(throwable, includeStackTrace) + mapOf("source" to "android")
        val message = throwable.message?.takeIf { it.isNotBlank() } ?: title
        client.issue(id, timestamp, IssueAttributes.create(title, "error").withMessage(message).withMetadata(metadata))
    }

    fun logAttributesFromAndroidLog(
        priority: Int,
        tag: String,
        message: String,
        throwable: Throwable? = null,
        context: AndroidContext = AndroidContext.create(),
        includeStackTrace: Boolean = false,
    ): LogAttributes {
        Validation.requireNonEmpty("android tag", tag)
        val priorityName = androidPriorityName(priority)
        val metadata =
            context.toMetadata() +
                mapOf(
                    "androidPriority" to priorityName,
                    "androidPriorityNumber" to priority,
                    "source" to "android",
                ) +
                (throwable?.let { throwableMetadata(it, includeStackTrace) } ?: emptyMap())
        return LogAttributes.create(message, logLevelFromAndroidPriority(priority)).withLogger(tag).withMetadata(metadata)
    }

    private fun mapLogLevel(priority: String): String =
        when (priority.uppercase()) {
            "VERBOSE", "DEBUG" -> "info"
            "INFO" -> "info"
            "WARN", "WARNING" -> "warning"
            "ERROR", "ASSERT", "WTF" -> "error"
            else -> "info"
        }

    private fun logLevelFromAndroidPriority(priority: Int): String =
        when (priority) {
            AndroidLogPriority.VERBOSE, AndroidLogPriority.DEBUG -> "info"
            AndroidLogPriority.INFO -> "info"
            AndroidLogPriority.WARN -> "warning"
            AndroidLogPriority.ERROR, AndroidLogPriority.ASSERT -> "error"
            else -> "info"
        }

    private fun androidPriorityName(priority: Int): String =
        when (priority) {
            AndroidLogPriority.VERBOSE -> "VERBOSE"
            AndroidLogPriority.DEBUG -> "DEBUG"
            AndroidLogPriority.INFO -> "INFO"
            AndroidLogPriority.WARN -> "WARN"
            AndroidLogPriority.ERROR -> "ERROR"
            AndroidLogPriority.ASSERT -> "ASSERT"
            else -> "UNKNOWN"
        }

    private fun normalizedMethod(method: String): String {
        Validation.requireNonEmpty("android network method", method)
        return method.trim().uppercase()
    }

    private fun routeTemplatePath(routeTemplate: String): String {
        Validation.requireNonEmpty("android network routeTemplate", routeTemplate)
        val withoutQueryOrHash =
            routeTemplate
                .trim()
                .substringBefore("#")
                .substringBefore("?")
        val path =
            if (withoutQueryOrHash.startsWith("http://") || withoutQueryOrHash.startsWith("https://")) {
                try {
                    URI(withoutQueryOrHash)
                        .rawPath
                        .takeIf { it.isNotBlank() } ?: "/"
                } catch (error: URISyntaxException) {
                    throw SdkException("validation_error", "android network routeTemplate must be a path or URL")
                }
            } else {
                withoutQueryOrHash
            }
        val normalized = if (path.startsWith("/")) path else "/$path"
        Validation.requireNonEmpty("android network routeTemplate", normalized)
        return normalized
    }

    private fun checkedStatusCode(statusCode: Int?): Int? {
        if (statusCode != null && statusCode !in 100..599) {
            throw SdkException("validation_error", "android network statusCode must be an HTTP status code")
        }
        return statusCode
    }

    private fun checkedDurationMs(durationMs: Double?): Double? {
        if (durationMs != null && (durationMs < 0 || durationMs.isNaN() || durationMs.isInfinite())) {
            throw SdkException("validation_error", "android network durationMs must be non-negative")
        }
        return durationMs
    }

    private fun statusFromStatusCode(statusCode: Int?): String = if (statusCode != null && statusCode >= 400) "failure" else "success"

    private fun compactMetadata(metadata: Map<String, Any?>): Map<String, Any?> =
        metadata.mapValues { (key, value) -> Validation.requireMetadataValue(key, value) }

    private fun optionalMetadata(
        key: String,
        value: Any?,
    ): Map<String, Any?> = if (value == null) emptyMap() else mapOf(key to value)

    private fun requestErrorMetadata(error: Throwable): Map<String, Any?> =
        mapOf(
            "errorType" to throwableTitle(error),
        ) + optionalMetadata("errorMessage", error.message?.takeIf { it.isNotBlank() })

    private fun throwableTitle(throwable: Throwable): String =
        throwable::class.java.simpleName.takeIf { it.isNotBlank() } ?: throwable::class.java.name

    private fun throwableMetadata(
        throwable: Throwable,
        includeStackTrace: Boolean,
    ): Map<String, Any?> {
        val metadata =
            mutableMapOf<String, Any?>(
                "throwableName" to throwableTitle(throwable),
            )
        throwable.message?.takeIf { it.isNotBlank() }?.let {
            metadata["throwableMessage"] = it
        }
        if (includeStackTrace) {
            metadata["throwableStackTrace"] = throwable.stackTraceToString()
        }
        return metadata
    }
}
