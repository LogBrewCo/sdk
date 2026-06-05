package co.logbrew.sdk

object AndroidLogPriority {
    const val VERBOSE: Int = 2
    const val DEBUG: Int = 3
    const val INFO: Int = 4
    const val WARN: Int = 5
    const val ERROR: Int = 6
    const val ASSERT: Int = 7
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
            "VERBOSE", "DEBUG" -> "debug"
            "INFO" -> "info"
            "WARN", "WARNING" -> "warning"
            "ERROR", "ASSERT", "WTF" -> "error"
            else -> "info"
        }

    private fun logLevelFromAndroidPriority(priority: Int): String =
        when (priority) {
            AndroidLogPriority.VERBOSE, AndroidLogPriority.DEBUG -> "debug"
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
