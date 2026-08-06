package co.logbrew.sdk

import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

private const val TELEMETRY_CONTEXT_SCHEMA_VERSION = 1
private const val MAX_CONTEXT_STRING_LENGTH = 256
private const val MAX_CONTEXT_ID_LENGTH = 200
private const val MAX_CONTEXT_TAGS = 32
private const val TRACE_ID_LENGTH = 32
private const val SPAN_ID_LENGTH = 16
private val tagKeyPattern = Regex("^[A-Za-z][A-Za-z0-9_.-]{0,63}$")

/** A bounded name and optional version shared by resource sections. */
data class TelemetryNamedVersion(
    val name: String,
    val version: String? = null,
)

/** Deployment identity shared across related telemetry signals. */
data class TelemetryDeployment(
    val environment: String? = null,
    val release: String? = null,
)

/** Operating-system identity without host, account, or network identifiers. */
data class TelemetryOperatingSystem(
    val name: String,
    val version: String? = null,
    val build: String? = null,
)

/** Privacy-bounded device class. Never use a unique hardware identifier. */
data class TelemetryDevice(
    val family: String? = null,
    val model: String? = null,
    val architecture: String? = null,
)

/** Application identity shared by issues, logs, traces, metrics, and actions. */
data class TelemetryApplication(
    val name: String? = null,
    val version: String? = null,
    val build: String? = null,
)

/** Stable resource identity shared by every LogBrew signal. */
data class TelemetryResource(
    val service: TelemetryNamedVersion? = null,
    val deployment: TelemetryDeployment? = null,
    val runtime: TelemetryNamedVersion? = null,
    val framework: TelemetryNamedVersion? = null,
    val operatingSystem: TelemetryOperatingSystem? = null,
    val device: TelemetryDevice? = null,
    val application: TelemetryApplication? = null,
)

/** W3C-compatible trace identity shared by non-span telemetry. */
data class TelemetryTraceContext(
    val traceId: String,
    val spanId: String? = null,
    val parentSpanId: String? = null,
    val sampled: Boolean? = null,
)

/** Opaque application-owned session identity. */
data class TelemetrySessionContext(
    val id: String,
    val previousId: String? = null,
)

enum class TelemetrySubjectKind(
    internal val wireValue: String,
) {
    ANONYMOUS("anonymous"),
    USER("user"),
}

/** Explicit app-owned subject identity. Never use names, emails, or IP addresses. */
data class TelemetrySubjectContext(
    val id: String,
    val kind: TelemetrySubjectKind,
)

/** Versioned, privacy-bounded context available on every LogBrew event type. */
data class TelemetryContext(
    val resource: TelemetryResource? = null,
    val trace: TelemetryTraceContext? = null,
    val session: TelemetrySessionContext? = null,
    val subject: TelemetrySubjectContext? = null,
    val tags: Map<String, String>? = null,
) {
    val schemaVersion: Int
        get() = TELEMETRY_CONTEXT_SCHEMA_VERSION

    /** Merge this context with an event-level override using field-level rules. */
    fun merging(override: TelemetryContext): TelemetryContext = merge(this, override) ?: override.normalized()

    internal fun normalized(): TelemetryContext {
        val normalizedResource = resource?.normalized()
        val normalizedTrace = trace?.normalized()
        val normalizedSession = session?.normalized()
        val normalizedSubject = subject?.normalized()
        val normalizedTags = tags?.normalizedTags()
        if (
            normalizedResource == null &&
            normalizedTrace == null &&
            normalizedSession == null &&
            normalizedSubject == null &&
            normalizedTags == null
        ) {
            throw contextError("telemetry context must include resource, trace, session, subject, or tags")
        }
        return TelemetryContext(
            resource = normalizedResource,
            trace = normalizedTrace,
            session = normalizedSession,
            subject = normalizedSubject,
            tags = normalizedTags,
        )
    }

    internal fun toJsonObject(): OrderedJsonObject {
        val value = normalized()
        return OrderedJsonObject()
            .add("schemaVersion", TELEMETRY_CONTEXT_SCHEMA_VERSION)
            .addIfNotNull("resource", value.resource?.toJsonObject())
            .addIfNotNull("trace", value.trace?.toJsonObject())
            .addIfNotNull("session", value.session?.toJsonObject())
            .addIfNotNull("subject", value.subject?.toJsonObject())
            .addIfNotNull("tags", value.tags?.toJsonObject())
    }

    companion object {
        /** Merge contexts; fields from [override] take precedence. */
        fun merge(
            base: TelemetryContext?,
            override: TelemetryContext?,
        ): TelemetryContext? {
            if (base == null) {
                return override?.normalized()
            }
            if (override == null) {
                return base.normalized()
            }
            val normalizedBase = base.normalized()
            val normalizedOverride = override.normalized()
            return TelemetryContext(
                resource = mergeResources(normalizedBase.resource, normalizedOverride.resource),
                trace = normalizedOverride.trace ?: normalizedBase.trace,
                session = normalizedOverride.session ?: normalizedBase.session,
                subject = normalizedOverride.subject ?: normalizedBase.subject,
                tags = mergeTags(normalizedBase.tags, normalizedOverride.tags),
            ).normalized()
        }
    }
}

/** AutoCloseable task/thread-local context scope. */
class LogBrewTelemetryScope internal constructor(
    private val scopeId: Long,
) : AutoCloseable {
    private var closed = false

    override fun close() {
        if (!closed) {
            closed = true
            LogBrewTelemetry.close(scopeId)
        }
    }
}

/** Thread-local context for correlating work without global mutable user state. */
object LogBrewTelemetry {
    private val nextScopeId = AtomicLong(1)
    private val scopes = ThreadLocal.withInitial { mutableListOf<ContextFrame>() }

    @JvmStatic
    fun currentContext(): TelemetryContext? = scopes.get().lastOrNull()?.context

    @JvmStatic
    fun use(context: TelemetryContext): LogBrewTelemetryScope {
        val nested = TelemetryContext.merge(currentContext(), context) ?: context.normalized()
        val scopeId = nextScopeId.getAndIncrement()
        scopes.get().add(ContextFrame(scopeId, nested))
        return LogBrewTelemetryScope(scopeId)
    }

    @JvmStatic
    fun <T> withContext(
        context: TelemetryContext,
        block: () -> T,
    ): T = use(context).use { block() }

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

    private data class ContextFrame(
        val id: Long,
        val context: TelemetryContext,
    )
}

internal fun LogBrewTraceContext.toTelemetryTraceContext(): TelemetryTraceContext =
    TelemetryTraceContext(
        traceId = traceId,
        spanId = spanId,
        parentSpanId = parentSpanId,
        sampled = sampled,
    ).normalized()

private fun TelemetryResource.normalized(): TelemetryResource {
    val value =
        TelemetryResource(
            service = service?.normalized("service"),
            deployment = deployment?.normalized(),
            runtime = runtime?.normalized("runtime"),
            framework = framework?.normalized("framework"),
            operatingSystem = operatingSystem?.normalized(),
            device = device?.normalized(),
            application = application?.normalized(),
        )
    if (
        value.service == null &&
        value.deployment == null &&
        value.runtime == null &&
        value.framework == null &&
        value.operatingSystem == null &&
        value.device == null &&
        value.application == null
    ) {
        throw contextError("telemetry resource must not be empty")
    }
    return value
}

private fun TelemetryResource.toJsonObject(): OrderedJsonObject =
    OrderedJsonObject()
        .addIfNotNull("service", service?.toJsonObject())
        .addIfNotNull("deployment", deployment?.toJsonObject())
        .addIfNotNull("runtime", runtime?.toJsonObject())
        .addIfNotNull("framework", framework?.toJsonObject())
        .addIfNotNull("operatingSystem", operatingSystem?.toJsonObject())
        .addIfNotNull("device", device?.toJsonObject())
        .addIfNotNull("application", application?.toJsonObject())

private fun TelemetryNamedVersion.normalized(label: String): TelemetryNamedVersion =
    TelemetryNamedVersion(
        name = contextString(name, "$label name"),
        version = optionalContextString(version, "$label version"),
    )

private fun TelemetryNamedVersion.toJsonObject(): OrderedJsonObject =
    OrderedJsonObject()
        .add("name", name)
        .addIfNotNull("version", version)

private fun TelemetryDeployment.normalized(): TelemetryDeployment {
    val value =
        TelemetryDeployment(
            environment = optionalContextString(environment, "deployment environment"),
            release = optionalContextString(release, "deployment release"),
        )
    if (value.environment == null && value.release == null) {
        throw contextError("deployment must not be empty")
    }
    return value
}

private fun TelemetryDeployment.toJsonObject(): OrderedJsonObject =
    OrderedJsonObject()
        .addIfNotNull("environment", environment)
        .addIfNotNull("release", release)

private fun TelemetryOperatingSystem.normalized(): TelemetryOperatingSystem =
    TelemetryOperatingSystem(
        name = contextString(name, "operatingSystem name"),
        version = optionalContextString(version, "operatingSystem version"),
        build = optionalContextString(build, "operatingSystem build"),
    )

private fun TelemetryOperatingSystem.toJsonObject(): OrderedJsonObject =
    OrderedJsonObject()
        .add("name", name)
        .addIfNotNull("version", version)
        .addIfNotNull("build", build)

private fun TelemetryDevice.normalized(): TelemetryDevice {
    val value =
        TelemetryDevice(
            family = optionalContextString(family, "device family"),
            model = optionalContextString(model, "device model"),
            architecture = optionalContextString(architecture, "device architecture"),
        )
    if (value.family == null && value.model == null && value.architecture == null) {
        throw contextError("device must not be empty")
    }
    return value
}

private fun TelemetryDevice.toJsonObject(): OrderedJsonObject =
    OrderedJsonObject()
        .addIfNotNull("family", family)
        .addIfNotNull("model", model)
        .addIfNotNull("architecture", architecture)

private fun TelemetryApplication.normalized(): TelemetryApplication {
    val value =
        TelemetryApplication(
            name = optionalContextString(name, "application name"),
            version = optionalContextString(version, "application version"),
            build = optionalContextString(build, "application build"),
        )
    if (value.name == null && value.version == null && value.build == null) {
        throw contextError("application must not be empty")
    }
    return value
}

private fun TelemetryApplication.toJsonObject(): OrderedJsonObject =
    OrderedJsonObject()
        .addIfNotNull("name", name)
        .addIfNotNull("version", version)
        .addIfNotNull("build", build)

private fun TelemetryTraceContext.normalized(): TelemetryTraceContext =
    TelemetryTraceContext(
        traceId = contextHexId(traceId, TRACE_ID_LENGTH, "traceId"),
        spanId = spanId?.let { contextHexId(it, SPAN_ID_LENGTH, "spanId") },
        parentSpanId = parentSpanId?.let { contextHexId(it, SPAN_ID_LENGTH, "parentSpanId") },
        sampled = sampled,
    )

private fun TelemetryTraceContext.toJsonObject(): OrderedJsonObject =
    OrderedJsonObject()
        .add("traceId", traceId)
        .addIfNotNull("spanId", spanId)
        .addIfNotNull("parentSpanId", parentSpanId)
        .addIfNotNull("sampled", sampled)

private fun TelemetrySessionContext.normalized(): TelemetrySessionContext {
    val normalizedId = contextId(id, "session id")
    val normalizedPrevious = previousId?.let { contextId(it, "session previousId") }
    if (normalizedPrevious == normalizedId) {
        throw contextError("session previousId must differ from id")
    }
    return TelemetrySessionContext(normalizedId, normalizedPrevious)
}

private fun TelemetrySessionContext.toJsonObject(): OrderedJsonObject =
    OrderedJsonObject()
        .add("id", id)
        .addIfNotNull("previousId", previousId)

private fun TelemetrySubjectContext.normalized(): TelemetrySubjectContext = TelemetrySubjectContext(contextId(id, "subject id"), kind)

private fun TelemetrySubjectContext.toJsonObject(): OrderedJsonObject =
    OrderedJsonObject()
        .add("id", id)
        .add("kind", kind.wireValue)

private fun Map<String, String>.normalizedTags(): Map<String, String>? {
    if (isEmpty() || size > MAX_CONTEXT_TAGS) {
        throw contextError("tags must contain 1-32 entries")
    }
    val normalized = linkedMapOf<String, String>()
    forEach { (key, value) ->
        if (!tagKeyPattern.matches(key)) {
            throw contextError("tag key is invalid")
        }
        normalized[key] = contextString(value, "tag value for $key")
    }
    return normalized.toMap()
}

private fun Map<String, String>.toJsonObject(): OrderedJsonObject {
    val value = OrderedJsonObject()
    forEach { (key, item) -> value.add(key, item) }
    return value
}

private fun mergeResources(
    base: TelemetryResource?,
    override: TelemetryResource?,
): TelemetryResource? {
    if (base == null) {
        return override
    }
    if (override == null) {
        return base
    }
    return TelemetryResource(
        service = mergeNamedVersion(base.service, override.service),
        deployment = mergeDeployment(base.deployment, override.deployment),
        runtime = mergeNamedVersion(base.runtime, override.runtime),
        framework = mergeNamedVersion(base.framework, override.framework),
        operatingSystem = mergeOperatingSystem(base.operatingSystem, override.operatingSystem),
        device = mergeDevice(base.device, override.device),
        application = mergeApplication(base.application, override.application),
    )
}

private fun mergeNamedVersion(
    base: TelemetryNamedVersion?,
    override: TelemetryNamedVersion?,
): TelemetryNamedVersion? =
    when {
        base == null -> override
        override == null -> base
        else -> TelemetryNamedVersion(override.name, override.version ?: base.version)
    }

private fun mergeDeployment(
    base: TelemetryDeployment?,
    override: TelemetryDeployment?,
): TelemetryDeployment? =
    when {
        base == null -> override
        override == null -> base
        else -> TelemetryDeployment(override.environment ?: base.environment, override.release ?: base.release)
    }

private fun mergeOperatingSystem(
    base: TelemetryOperatingSystem?,
    override: TelemetryOperatingSystem?,
): TelemetryOperatingSystem? =
    when {
        base == null -> {
            override
        }

        override == null -> {
            base
        }

        else -> {
            TelemetryOperatingSystem(
                override.name,
                override.version ?: base.version,
                override.build ?: base.build,
            )
        }
    }

private fun mergeDevice(
    base: TelemetryDevice?,
    override: TelemetryDevice?,
): TelemetryDevice? =
    when {
        base == null -> {
            override
        }

        override == null -> {
            base
        }

        else -> {
            TelemetryDevice(
                override.family ?: base.family,
                override.model ?: base.model,
                override.architecture ?: base.architecture,
            )
        }
    }

private fun mergeApplication(
    base: TelemetryApplication?,
    override: TelemetryApplication?,
): TelemetryApplication? =
    when {
        base == null -> {
            override
        }

        override == null -> {
            base
        }

        else -> {
            TelemetryApplication(
                override.name ?: base.name,
                override.version ?: base.version,
                override.build ?: base.build,
            )
        }
    }

private fun mergeTags(
    base: Map<String, String>?,
    override: Map<String, String>?,
): Map<String, String>? {
    if (base == null) {
        return override
    }
    if (override == null) {
        return base
    }
    return (base + override).normalizedTags()
}

private fun automaticContextString(value: String?): String? =
    try {
        value?.let { contextString(it, "automatic context value") }
    } catch (_: SdkException) {
        null
    }

internal fun automaticTelemetryContext(): TelemetryContext {
    val osName = safeSystemProperty("os.name")
    val osVersion = safeSystemProperty("os.version")
    val architecture = safeSystemProperty("os.arch")
    val javaVersion = safeSystemProperty("java.version")
    val runtimeVersion =
        listOfNotNull(
            "kotlin ${KotlinVersion.CURRENT}",
            javaVersion?.let { "jvm $it" },
        ).joinToString("; ")
    return TelemetryContext(
        resource =
            TelemetryResource(
                runtime = TelemetryNamedVersion("kotlin/jvm", runtimeVersion),
                operatingSystem = osName?.let { TelemetryOperatingSystem(it, osVersion) },
                device = architecture?.let { TelemetryDevice(architecture = it) },
            ),
    ).normalized()
}

private fun safeSystemProperty(key: String): String? =
    try {
        automaticContextString(System.getProperty(key))
    } catch (_: SecurityException) {
        null
    }

private fun contextString(
    value: String,
    label: String,
): String {
    val normalized = value.trim()
    if (
        normalized.isEmpty() ||
        normalized.codePointCount(0, normalized.length) > MAX_CONTEXT_STRING_LENGTH ||
        normalized.hasForbiddenControl()
    ) {
        throw contextError("$label is invalid")
    }
    return normalized
}

private fun optionalContextString(
    value: String?,
    label: String,
): String? = value?.let { contextString(it, label) }

private fun contextId(
    value: String,
    label: String,
): String {
    val normalized = value.trim()
    if (
        normalized.isEmpty() ||
        normalized.codePointCount(0, normalized.length) > MAX_CONTEXT_ID_LENGTH ||
        normalized.hasForbiddenControl()
    ) {
        throw contextError("$label is invalid")
    }
    return normalized
}

private fun contextHexId(
    value: String,
    expectedLength: Int,
    label: String,
): String {
    val normalized = value.trim().lowercase(Locale.ROOT)
    if (
        normalized.length != expectedLength ||
        normalized.all { it == '0' } ||
        normalized.any { it !in '0'..'9' && it !in 'a'..'f' }
    ) {
        throw contextError("$label must be $expectedLength non-zero hex characters")
    }
    return normalized
}

internal fun String.hasForbiddenControl(): Boolean = codePoints().anyMatch { codePoint -> codePoint <= 31 || codePoint in 127..159 }

private fun contextError(message: String): SdkException = SdkException("validation_error", message)
