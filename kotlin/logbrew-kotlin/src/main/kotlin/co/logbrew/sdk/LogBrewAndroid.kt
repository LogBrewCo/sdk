package co.logbrew.sdk

import java.net.HttpURLConnection
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
    internal val context: AndroidContext,
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

class AndroidLifecycleTracker internal constructor(
    initialState: String,
    initialRealtimeMs: Double,
    private val baseContext: AndroidContext,
    private val parentTraceContext: LogBrewTraceContext,
    private val baseMetadata: Map<String, Any?>,
) {
    private var currentState = initialState
    private var currentStateStartedAtMs = initialRealtimeMs

    fun captureTransition(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        nextState: String,
        realtimeMs: Double,
        context: AndroidContext? = null,
        metadata: Map<String, Any?> = emptyMap(),
    ): Boolean {
        val safeNextState = checkedLifecycleState("android lifecycle nextState", nextState)
        val safeRealtimeMs = checkedLifecycleRealtimeMs("android lifecycle realtimeMs", realtimeMs)
        if (safeNextState == currentState) {
            return false
        }

        val previousState = currentState
        val durationMs = (safeRealtimeMs - currentStateStartedAtMs).coerceAtLeast(0.0)
        val spanContext = LogBrewTrace.childContext(parentTraceContext)
        val combinedContext = baseContext.merging(context)
        val safeMetadata =
            combinedContext.toMetadata() +
                baseMetadata +
                compactMetadata(metadata) +
                mapOf(
                    "source" to "android.lifecycle",
                    "previousState" to previousState,
                    "nextState" to safeNextState,
                )

        client.span(
            id,
            timestamp,
            LogBrewTrace
                .spanAttributes(
                    name = "android.lifecycle:$previousState->$safeNextState",
                    status = "ok",
                    durationMs = durationMs,
                    metadata = safeMetadata,
                    context = spanContext,
                ).withAndroidContext(combinedContext),
        )

        currentState = safeNextState
        currentStateStartedAtMs = safeRealtimeMs
        return true
    }
}

object LogBrewAndroid {
    private const val SDK_VERSION: String = "0.2.0"
    private const val PRODUCT_ANALYTICS_SCHEMA_VERSION: Int = 1
    private const val MAX_PRODUCT_ANALYTICS_SURFACE_LENGTH: Int = 256

    val sdkVersion: String
        get() = SDK_VERSION

    @JvmOverloads
    fun createClient(
        apiKey: String,
        appName: String,
        maxRetries: Int = 2,
        context: TelemetryContext? = null,
        includeAutomaticContext: Boolean = true,
    ): LogBrewClient {
        val androidContext =
            TelemetryContext(
                resource =
                    TelemetryResource(
                        framework = TelemetryNamedVersion("android"),
                        application = TelemetryApplication(name = appName),
                    ),
            )
        return LogBrewClient.create(
            apiKey = apiKey,
            sdkName = appName,
            sdkVersion = SDK_VERSION,
            maxRetries = maxRetries,
            context = TelemetryContext.merge(androidContext, context),
            includeAutomaticContext = includeAutomaticContext,
        )
    }

    fun captureActivityStarted(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        activityName: String,
        context: AndroidContext = AndroidContext.create(),
    ) {
        Validation.requireNonEmpty("android activityName", activityName)
        val metadata = context.toMetadata() + mapOf("activityName" to activityName, "lifecycle" to "started")
        client.action(
            id,
            timestamp,
            ActionAttributes.create("activity_started", "success").withMetadata(metadata).withAndroidContext(context),
        )
    }

    fun captureScreenView(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        screenName: String,
        context: AndroidContext = AndroidContext.create(),
    ) {
        Validation.requireNonEmpty("android screenName", screenName)
        val analyticsMetadata = productAnalyticsMetadata("screen_view", screenName)
        val mergedMetadata =
            context.toMetadata() +
                mapOf("screenName" to screenName) +
                analyticsMetadata
        val metadata =
            if ("analyticsSurface" in analyticsMetadata) mergedMetadata else mergedMetadata - "analyticsSurface"
        client.action(
            id,
            timestamp,
            ActionAttributes.create("screen_view", "success").withMetadata(metadata).withAndroidContext(context),
        )
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
        val appMetadata = compactMetadata(metadata)
        val surface = context.toMetadata()["screenName"] as? String
        val analyticsMetadata = productAnalyticsMetadata("interaction", surface)
        val mergedMetadata =
            context.toMetadata() +
                appMetadata +
                mapOf("source" to "android.action") +
                analyticsMetadata
        val safeMetadata =
            if ("analyticsSurface" in analyticsMetadata) mergedMetadata else mergedMetadata - "analyticsSurface"
        client.action(id, timestamp, ActionAttributes.create(name, status).withMetadata(safeMetadata).withAndroidContext(context))
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
            ActionAttributes
                .create("$safeMethod $safeRouteTemplate", actionStatus)
                .withMetadata(timelineMetadata)
                .withAndroidContext(context),
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
                    "http.request.method" to safeMethod,
                    "http.route" to safeRouteTemplate,
                )
        return AndroidRequestSpan(
            method = safeMethod,
            routeTemplate = safeRouteTemplate,
            traceContext = requestContext,
            headers = LogBrewTrace.outgoingHeaders(requestContext),
            metadata = safeMetadata,
            context = context,
        )
    }

    fun createLifecycleTracker(
        initialState: String,
        realtimeMs: Double,
        context: AndroidContext = AndroidContext.create(),
        traceContext: LogBrewTraceContext? = null,
        metadata: Map<String, Any?> = emptyMap(),
    ): AndroidLifecycleTracker {
        val safeInitialState = checkedLifecycleState("android lifecycle initialState", initialState)
        val safeRealtimeMs = checkedLifecycleRealtimeMs("android lifecycle realtimeMs", realtimeMs)
        val parentContext = traceContext ?: LogBrewTrace.currentTraceContext() ?: LogBrewTrace.createTraceContext()
        return AndroidLifecycleTracker(
            initialState = safeInitialState,
            initialRealtimeMs = safeRealtimeMs,
            baseContext = context,
            parentTraceContext = parentContext,
            baseMetadata = compactMetadata(metadata),
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
                optionalMetadata("http.response.status_code", safeStatusCode) +
                (error?.let { requestErrorMetadata(it) } ?: emptyMap())
        client.span(
            id,
            timestamp,
            LogBrewTrace
                .spanAttributes(
                    name = "${requestSpan.method} ${requestSpan.routeTemplate}",
                    status = spanStatus,
                    durationMs = safeDurationMs,
                    metadata = spanMetadata,
                    context = requestSpan.traceContext,
                ).withAndroidContext(requestSpan.context),
        )
    }

    fun <T> withHttpURLConnectionSpan(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        connection: HttpURLConnection,
        routeTemplate: String = connection.url.toString(),
        context: AndroidContext = AndroidContext.create(),
        traceContext: LogBrewTraceContext? = null,
        metadata: Map<String, Any?> = emptyMap(),
        block: (HttpURLConnection) -> T,
    ): T {
        val requestSpan =
            startRequestSpan(
                method = connection.requestMethod,
                routeTemplate = routeTemplate,
                context = context,
                traceContext = traceContext,
                metadata = metadata,
            )
        requestSpan.applyHeadersTo(connection::setRequestProperty)

        val startedAtMs = monotonicTimeMs()
        var statusCode: Int? = null
        var error: Throwable? = null

        try {
            val result = requestSpan.withTrace { block(connection) }
            statusCode = responseCodeOrNull(connection)
            return result
        } catch (thrown: Throwable) {
            error = thrown
            throw thrown
        } finally {
            captureRequestSpan(
                client = client,
                id = id,
                timestamp = timestamp,
                requestSpan = requestSpan,
                statusCode = statusCode,
                durationMs = (monotonicTimeMs() - startedAtMs).coerceAtLeast(0.0),
                error = error,
            )
        }
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
        client.log(
            id,
            timestamp,
            LogAttributes
                .create(message, mapLogLevel(priority))
                .withLogger(tag)
                .withMetadata(metadata)
                .withAndroidContext(context),
        )
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
        includeThrowableMessage: Boolean = false,
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
                includeThrowableMessage = includeThrowableMessage,
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
        client.issue(
            id,
            timestamp,
            IssueAttributes
                .create(title, "error")
                .withMessage(stackTrace)
                .withMetadata(metadata)
                .withAndroidContext(context),
        )
    }

    fun captureThrowable(
        client: LogBrewClient,
        id: String,
        timestamp: String,
        throwable: Throwable,
        context: AndroidContext = AndroidContext.create(),
        title: String = throwableTitle(throwable),
        includeStackTrace: Boolean = false,
        includeMessage: Boolean = false,
    ) {
        Validation.requireNonEmpty("android throwable title", title)
        val metadata =
            context.toMetadata() +
                mapOf("source" to "android") +
                if (includeStackTrace) mapOf("throwableStackTrace" to stackTraceWithoutMessage(throwable)) else emptyMap()
        val message = if (includeMessage) throwable.message?.takeIf { it.isNotBlank() } else null
        client.issue(
            id,
            timestamp,
            IssueAttributes
                .fromThrowable(
                    throwable = throwable,
                    title = title,
                    mechanismType = "android.exception",
                    handled = true,
                    message = message,
                ).withMetadata(metadata)
                .withAndroidContext(context),
        )
    }

    fun logAttributesFromAndroidLog(
        priority: Int,
        tag: String,
        message: String,
        throwable: Throwable? = null,
        context: AndroidContext = AndroidContext.create(),
        includeStackTrace: Boolean = false,
        includeThrowableMessage: Boolean = false,
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
                (throwable?.let { throwableMetadata(it, includeStackTrace, includeThrowableMessage) } ?: emptyMap())
        return LogAttributes
            .create(message, logLevelFromAndroidPriority(priority))
            .withLogger(tag)
            .withMetadata(metadata)
            .withAndroidContext(context)
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

    private fun optionalMetadata(
        key: String,
        value: Any?,
    ): Map<String, Any?> = if (value == null) emptyMap() else mapOf(key to value)

    private fun productAnalyticsMetadata(
        kind: String,
        surface: String?,
    ): Map<String, Any?> =
        mapOf(
            "analyticsSchemaVersion" to PRODUCT_ANALYTICS_SCHEMA_VERSION,
            "analyticsKind" to kind,
        ) + optionalMetadata("analyticsSurface", boundedProductAnalyticsSurface(surface))

    private fun boundedProductAnalyticsSurface(surface: String?): String? {
        val normalized = surface?.trim() ?: return null
        if (
            normalized.isEmpty() ||
            normalized.codePointCount(0, normalized.length) > MAX_PRODUCT_ANALYTICS_SURFACE_LENGTH ||
            normalized.any { character -> character.code <= 31 || character.code in 127..159 }
        ) {
            return null
        }
        return normalized
    }

    private fun requestErrorMetadata(error: Throwable): Map<String, Any?> =
        mapOf(
            "errorType" to throwableTitle(error),
        )

    private fun responseCodeOrNull(connection: HttpURLConnection): Int? =
        try {
            connection.responseCode
        } catch (_: Exception) {
            null
        }

    private fun monotonicTimeMs(): Double = System.nanoTime().toDouble() / 1_000_000.0

    private fun throwableTitle(throwable: Throwable): String =
        throwable::class.java.simpleName.takeIf { it.isNotBlank() } ?: throwable::class.java.name

    private fun throwableMetadata(
        throwable: Throwable,
        includeStackTrace: Boolean,
        includeMessage: Boolean,
    ): Map<String, Any?> {
        val metadata =
            mutableMapOf<String, Any?>(
                "throwableName" to throwableTitle(throwable),
            )
        if (includeMessage) {
            throwable.message?.takeIf { it.isNotBlank() }?.let {
                metadata["throwableMessage"] = it
            }
        }
        if (includeStackTrace) {
            metadata["throwableStackTrace"] = stackTraceWithoutMessage(throwable)
        }
        return metadata
    }

    private fun stackTraceWithoutMessage(throwable: Throwable): String =
        buildString {
            append(throwableTitle(throwable))
            throwable.stackTrace.forEach { frame ->
                append("\n\tat ")
                append(frame)
            }
        }
}

private fun ActionAttributes.withAndroidContext(context: AndroidContext): ActionAttributes =
    context.toTelemetryContext()?.let(::withContext) ?: this

private fun IssueAttributes.withAndroidContext(context: AndroidContext): IssueAttributes =
    context.toTelemetryContext()?.let(::withContext) ?: this

private fun LogAttributes.withAndroidContext(context: AndroidContext): LogAttributes =
    context.toTelemetryContext()?.let(::withContext) ?: this

private fun SpanAttributes.withAndroidContext(context: AndroidContext): SpanAttributes =
    context.toTelemetryContext()?.let(::withContext) ?: this

private fun checkedLifecycleState(
    label: String,
    state: String,
): String {
    Validation.requireNonEmpty(label, state)
    return state.trim()
}

private fun checkedLifecycleRealtimeMs(
    label: String,
    realtimeMs: Double,
): Double {
    if (realtimeMs < 0 || realtimeMs.isNaN() || realtimeMs.isInfinite()) {
        throw SdkException("validation_error", "$label must be non-negative")
    }
    return realtimeMs
}

private fun compactMetadata(metadata: Map<String, Any?>): Map<String, Any?> =
    metadata.mapValues { (key, value) -> Validation.requireMetadataValue(key, value) }
