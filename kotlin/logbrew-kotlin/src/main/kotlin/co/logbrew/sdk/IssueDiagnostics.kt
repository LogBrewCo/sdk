package co.logbrew.sdk

import java.util.Collections
import java.util.IdentityHashMap
import java.util.Locale

internal const val MAX_ISSUE_STACK_FRAMES = 32
internal const val MAX_ISSUE_BREADCRUMBS = 64
internal const val MAX_ISSUE_EXCEPTIONS = 8
private const val MAX_EXCEPTION_TYPE_LENGTH = 256
private const val MAX_EXCEPTION_MESSAGE_LENGTH = 1024
private const val MAX_EXCEPTION_MODULE_LENGTH = 512
private const val MAX_FRAME_FILENAME_LENGTH = 2048
private const val MAX_FRAME_FUNCTION_LENGTH = 256
private const val MAX_FRAME_MODULE_LENGTH = 512
private const val MAX_BREADCRUMB_NAME_LENGTH = 64
private const val MAX_BREADCRUMB_MESSAGE_LENGTH = 512
private const val MAX_BREADCRUMB_DATA_FIELDS = 8
private const val MAX_BREADCRUMB_DATA_STRING_LENGTH = 256
private val breadcrumbNamePattern = Regex("^[A-Za-z][A-Za-z0-9_.:-]{0,63}$")
private val breadcrumbDataKeyPattern = Regex("^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
private val debugIdPattern =
    Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

/** Runtime path that captured an exception and whether it escaped that path. */
data class IssueExceptionMechanism(
    val type: String,
    val handled: Boolean,
) {
    internal fun toJsonObject(): OrderedJsonObject =
        OrderedJsonObject()
            .add("type", issueMachineName(type, "issue exception mechanism type", breadcrumbNamePattern))
            .add("handled", handled)
}

/** Structured exception identity without a private exception description. */
data class IssueException(
    val type: String,
    val mechanism: IssueExceptionMechanism? = null,
) {
    internal fun toJsonObject(): OrderedJsonObject =
        OrderedJsonObject()
            .add(
                "type",
                issueText(
                    type,
                    "issue exception type",
                    MAX_EXCEPTION_TYPE_LENGTH,
                    disallowLocationDelimiters = true,
                ),
            ).addIfNotNull("mechanism", mechanism?.toJsonObject())
}

/** How one runtime exception relates to its earlier parent node. */
enum class IssueExceptionRelationship(
    internal val wireValue: String,
) {
    REPORTED("reported"),
    CAUSE("cause"),
    CONTEXT("context"),
    AGGREGATE_MEMBER("aggregate_member"),
    SUPPRESSED("suppressed"),
}

/** Explicit capture state for one exception message. */
enum class IssueExceptionMessageState(
    internal val wireValue: String,
) {
    CAPTURED("captured"),
    TRUNCATED("truncated"),
    REDACTED("redacted"),
    NOT_CAPTURED("not_captured"),
}

/** Explicit capture state for one exception stack. */
enum class IssueExceptionStackFramesState(
    internal val wireValue: String,
) {
    CAPTURED("captured"),
    TRUNCATED("truncated"),
    NOT_CAPTURED("not_captured"),
}

/** Privacy-bounded source identity for one issue stack frame. */
data class IssueStackFrame(
    val filename: String,
    val line: Int,
    val column: Int,
    val function: String? = null,
    val module: String? = null,
    val inApp: Boolean? = null,
    val debugId: String? = null,
) {
    internal fun normalized(): IssueStackFrame =
        IssueStackFrame(
            filename = sanitizedIssueFilename(filename),
            line = issueCoordinate(line, "issue stack frame line"),
            column = issueCoordinate(column, "issue stack frame column"),
            function = function?.let { issueText(it, "issue stack frame function", MAX_FRAME_FUNCTION_LENGTH) },
            module =
                module?.let {
                    issueText(
                        it,
                        "issue stack frame module",
                        MAX_FRAME_MODULE_LENGTH,
                        disallowLocationDelimiters = true,
                    )
                },
            inApp = inApp,
            debugId = debugId?.let(::normalizedDebugId),
        )

    internal fun toJsonObject(): OrderedJsonObject {
        val value = normalized()
        return OrderedJsonObject()
            .add("filename", value.filename)
            .add("line", value.line)
            .add("column", value.column)
            .addIfNotNull("function", value.function)
            .addIfNotNull("module", value.module)
            .addIfNotNull("inApp", value.inApp)
            .addIfNotNull("debugId", value.debugId)
    }
}

/** One parent-first runtime exception with its own bounded stack evidence. */
data class IssueExceptionChainEntry(
    val id: Int,
    val relationship: IssueExceptionRelationship,
    val type: String,
    val parentId: Int? = null,
    val message: String? = null,
    val messageState: IssueExceptionMessageState = IssueExceptionMessageState.NOT_CAPTURED,
    val module: String? = null,
    val mechanism: IssueExceptionMechanism? = null,
    val stackFrames: List<IssueStackFrame>? = null,
    val stackFramesState: IssueExceptionStackFramesState = IssueExceptionStackFramesState.NOT_CAPTURED,
) {
    internal fun normalized(): IssueExceptionChainEntry {
        val normalizedMessage =
            when (messageState) {
                IssueExceptionMessageState.CAPTURED,
                IssueExceptionMessageState.TRUNCATED,
                -> {
                    message?.let {
                        issueText(it, "issue exceptionChain message", MAX_EXCEPTION_MESSAGE_LENGTH)
                    } ?: throw issueError("issue exceptionChain message must match messageState")
                }

                IssueExceptionMessageState.REDACTED,
                IssueExceptionMessageState.NOT_CAPTURED,
                -> {
                    if (message != null) {
                        throw issueError("issue exceptionChain message must match messageState")
                    }
                    null
                }
            }
        val normalizedFrames =
            when (stackFramesState) {
                IssueExceptionStackFramesState.CAPTURED,
                IssueExceptionStackFramesState.TRUNCATED,
                -> {
                    normalizeIssueStackFrames(stackFrames)
                        ?: throw issueError("issue exceptionChain stackFrames must match stackFramesState")
                }

                IssueExceptionStackFramesState.NOT_CAPTURED -> {
                    if (stackFrames != null) {
                        throw issueError("issue exceptionChain stackFrames must match stackFramesState")
                    }
                    null
                }
            }
        return copy(
            type =
                issueText(
                    type,
                    "issue exceptionChain type",
                    MAX_EXCEPTION_TYPE_LENGTH,
                    disallowLocationDelimiters = true,
                ),
            message = normalizedMessage,
            module =
                module?.let {
                    issueText(
                        it,
                        "issue exceptionChain module",
                        MAX_EXCEPTION_MODULE_LENGTH,
                        disallowLocationDelimiters = true,
                    )
                },
            mechanism = mechanism?.normalized(),
            stackFrames = normalizedFrames,
        )
    }

    internal fun toJsonObject(): OrderedJsonObject {
        val value = normalized()
        return OrderedJsonObject()
            .add("id", value.id)
            .addIfNotNull("parentId", value.parentId)
            .add("relationship", value.relationship.wireValue)
            .add("type", value.type)
            .addIfNotNull("message", value.message)
            .add("messageState", value.messageState.wireValue)
            .addIfNotNull("module", value.module)
            .addIfNotNull("mechanism", value.mechanism?.toJsonObject())
            .addIfNotNull("stackFrames", value.stackFrames?.map { it.toJsonObject() })
            .add("stackFramesState", value.stackFramesState.wireValue)
    }
}

/** At most eight parent-first runtime exceptions with explicit omission states. */
data class IssueExceptionChain(
    val entries: List<IssueExceptionChainEntry>,
    val truncated: Boolean = false,
) {
    internal fun toJsonObject(
        legacyException: IssueException?,
        legacyFrames: List<IssueStackFrame>?,
    ): OrderedJsonObject {
        if (entries.isEmpty() || entries.size > MAX_ISSUE_EXCEPTIONS) {
            throw issueError("issue exceptionChain entries must contain 1-8 exceptions")
        }
        val normalizedEntries = entries.map { it.normalized() }
        normalizedEntries.forEachIndexed { index, entry ->
            if (entry.id != index) {
                throw issueError("issue exceptionChain ids must be contiguous and match array order")
            }
            if (index == 0) {
                if (entry.relationship != IssueExceptionRelationship.REPORTED || entry.parentId != null) {
                    throw issueError("issue exceptionChain entry 0 must be the parentless reported exception")
                }
            } else if (
                entry.relationship == IssueExceptionRelationship.REPORTED ||
                entry.parentId == null ||
                entry.parentId !in 0 until index
            ) {
                throw issueError("issue exceptionChain parent relationship is invalid")
            }
        }

        val root = normalizedEntries.first()
        val normalizedLegacyException = legacyException?.normalized()
        if (
            normalizedLegacyException == null ||
            root.type != normalizedLegacyException.type ||
            root.mechanism != normalizedLegacyException.mechanism
        ) {
            throw issueError("issue exceptionChain reported exception must match exception")
        }
        val normalizedLegacyFrames = normalizeIssueStackFrames(legacyFrames)
        if (
            (root.stackFramesState == IssueExceptionStackFramesState.NOT_CAPTURED && normalizedLegacyFrames != null) ||
            (root.stackFramesState != IssueExceptionStackFramesState.NOT_CAPTURED && root.stackFrames != normalizedLegacyFrames)
        ) {
            throw issueError("issue exceptionChain reported stack must match stackFrames")
        }

        return OrderedJsonObject()
            .add("entries", normalizedEntries.map { it.toJsonObject() })
            .add("truncated", truncated)
    }
}

enum class IssueBreadcrumbLevel(
    internal val wireValue: String,
) {
    DEBUG("debug"),
    INFO("info"),
    WARNING("warning"),
    ERROR("error"),
    CRITICAL("critical"),
}

/** One oldest-to-newest, privacy-bounded step that happened before an issue. */
data class IssueBreadcrumb(
    val timestamp: String,
    val category: String,
    val type: String? = null,
    val level: IssueBreadcrumbLevel? = null,
    val message: String? = null,
    val data: Map<String, Any?>? = null,
) {
    internal fun normalized(): IssueBreadcrumb {
        Validation.requireTimestamp(timestamp)
        return IssueBreadcrumb(
            timestamp = timestamp,
            category = issueMachineName(category, "issue breadcrumb category", breadcrumbNamePattern),
            type = type?.let { issueMachineName(it, "issue breadcrumb type", breadcrumbNamePattern) },
            level = level,
            message = message?.let { issueText(it, "issue breadcrumb message", MAX_BREADCRUMB_MESSAGE_LENGTH) },
            data = data?.let(::normalizedBreadcrumbData),
        )
    }

    internal fun toJsonObject(): OrderedJsonObject {
        val value = normalized()
        return OrderedJsonObject()
            .add("timestamp", value.timestamp)
            .add("category", value.category)
            .addIfNotNull("type", value.type)
            .addIfNotNull("level", value.level?.wireValue)
            .addIfNotNull("message", value.message)
            .addIfNotNull("data", value.data?.toJsonObject())
    }
}

internal class IssueBreadcrumbStore {
    private val values = ArrayDeque<IssueBreadcrumb>()
    private var truncated = false

    fun add(value: IssueBreadcrumb) {
        val normalized = value.normalized()
        if (values.size == MAX_ISSUE_BREADCRUMBS) {
            values.removeFirst()
            truncated = true
        }
        values.addLast(normalized)
    }

    fun clear() {
        values.clear()
        truncated = false
    }

    fun snapshot(): BreadcrumbSnapshot = BreadcrumbSnapshot(values.toList(), truncated)
}

internal data class BreadcrumbSnapshot(
    val breadcrumbs: List<IssueBreadcrumb>,
    val truncated: Boolean,
)

internal fun issueAttributesFromThrowable(
    throwable: Throwable,
    title: String? = null,
    mechanismType: String = "kotlin.exception",
    handled: Boolean = true,
    message: String? = null,
): IssueAttributes {
    val exceptionType = safeThrowableType(throwable)
    val mechanism = IssueExceptionMechanism(mechanismType, handled)
    val stack = safeThrowableStack(throwable)
    return IssueAttributes(
        title = title ?: exceptionType,
        level = "error",
        message = message,
        exception =
            IssueException(
                type = exceptionType,
                mechanism = mechanism,
            ),
        exceptionChain = exceptionChainFromThrowable(throwable, mechanism, stack),
        stackFrames = stack.frames.takeIf { it.isNotEmpty() },
    )
}

internal fun IssueAttributes.withBreadcrumbSnapshot(snapshot: BreadcrumbSnapshot): IssueAttributes {
    if (snapshot.breadcrumbs.isEmpty()) {
        return this
    }
    val explicit = normalizeIssueBreadcrumbs(breadcrumbs).orEmpty()
    val combined = snapshot.breadcrumbs + explicit
    return copy(
        breadcrumbs = combined.takeLast(MAX_ISSUE_BREADCRUMBS),
        breadcrumbsTruncated =
            breadcrumbsTruncated == true ||
                snapshot.truncated ||
                combined.size > MAX_ISSUE_BREADCRUMBS,
    )
}

internal fun normalizeIssueStackFrames(frames: List<IssueStackFrame>?): List<IssueStackFrame>? {
    if (frames == null) {
        return null
    }
    if (frames.isEmpty() || frames.size > MAX_ISSUE_STACK_FRAMES) {
        throw issueError("issue stackFrames must contain 1-32 frames")
    }
    return frames.map { it.normalized() }
}

internal fun normalizeIssueBreadcrumbs(breadcrumbs: List<IssueBreadcrumb>?): List<IssueBreadcrumb>? {
    if (breadcrumbs == null) {
        return null
    }
    if (breadcrumbs.isEmpty() || breadcrumbs.size > MAX_ISSUE_BREADCRUMBS) {
        throw issueError("issue breadcrumbs must contain 1-64 entries")
    }
    return breadcrumbs.map { it.normalized() }
}

private fun safeThrowableType(throwable: Throwable): String {
    val candidate =
        try {
            throwable.javaClass.simpleName.takeIf { it.isNotBlank() } ?: throwable.javaClass.name.substringAfterLast('.')
        } catch (_: Exception) {
            "Throwable"
        }
    return try {
        issueText(
            candidate,
            "issue exception type",
            MAX_EXCEPTION_TYPE_LENGTH,
            disallowLocationDelimiters = true,
        )
    } catch (_: SdkException) {
        "Throwable"
    }
}

private data class ThrowableStackEvidence(
    val frames: List<IssueStackFrame>,
    val truncated: Boolean,
)

private fun safeThrowableStack(throwable: Throwable): ThrowableStackEvidence {
    val elements =
        try {
            throwable.stackTrace
        } catch (_: Exception) {
            return ThrowableStackEvidence(emptyList(), truncated = false)
        }
    return ThrowableStackEvidence(
        frames = elements.take(MAX_ISSUE_STACK_FRAMES).mapNotNull(::safeStackFrame),
        truncated = elements.size > MAX_ISSUE_STACK_FRAMES,
    )
}

private fun exceptionChainFromThrowable(
    throwable: Throwable,
    rootMechanism: IssueExceptionMechanism,
    rootStack: ThrowableStackEvidence,
): IssueExceptionChain {
    val entries = mutableListOf<IssueExceptionChainEntry>()
    val seen = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
    var truncated = false

    fun add(
        error: Throwable,
        parentId: Int?,
        relationship: IssueExceptionRelationship,
        mechanism: IssueExceptionMechanism,
        knownStack: ThrowableStackEvidence? = null,
    ) {
        if (entries.size >= MAX_ISSUE_EXCEPTIONS) {
            truncated = true
            return
        }
        val id = entries.size
        val stack = knownStack ?: safeThrowableStack(error)
        val messageState =
            if (safeThrowableHasMessage(error)) {
                IssueExceptionMessageState.REDACTED
            } else {
                IssueExceptionMessageState.NOT_CAPTURED
            }
        entries +=
            IssueExceptionChainEntry(
                id = id,
                parentId = parentId,
                relationship = relationship,
                type = safeThrowableType(error),
                messageState = messageState,
                module = safeThrowableModule(error),
                mechanism = mechanism,
                stackFrames = stack.frames.takeIf { it.isNotEmpty() },
                stackFramesState =
                    when {
                        stack.frames.isEmpty() -> IssueExceptionStackFramesState.NOT_CAPTURED
                        stack.truncated -> IssueExceptionStackFramesState.TRUNCATED
                        else -> IssueExceptionStackFramesState.CAPTURED
                    },
            )

        safeThrowableCause(error)?.let { cause ->
            if (seen.add(cause)) {
                add(
                    cause,
                    id,
                    IssueExceptionRelationship.CAUSE,
                    IssueExceptionMechanism("kotlin.cause", handled = true),
                )
            } else {
                truncated = true
            }
        }
        safeThrowableSuppressed(error).forEach { suppressed ->
            if (seen.add(suppressed)) {
                add(
                    suppressed,
                    id,
                    IssueExceptionRelationship.SUPPRESSED,
                    IssueExceptionMechanism("kotlin.suppressed", handled = true),
                )
            } else {
                truncated = true
            }
        }
    }

    seen.add(throwable)
    add(throwable, null, IssueExceptionRelationship.REPORTED, rootMechanism, rootStack)
    return IssueExceptionChain(entries.toList(), truncated)
}

private fun safeThrowableModule(throwable: Throwable): String? =
    try {
        safeIssueText(
            throwable.javaClass.`package`?.name,
            MAX_EXCEPTION_MODULE_LENGTH,
            disallowLocationDelimiters = true,
        )
    } catch (_: Exception) {
        null
    }

private fun safeThrowableHasMessage(throwable: Throwable): Boolean =
    try {
        !throwable.message.isNullOrBlank()
    } catch (_: Exception) {
        false
    }

private fun safeThrowableCause(throwable: Throwable): Throwable? =
    try {
        throwable.cause
    } catch (_: Exception) {
        null
    }

private fun safeThrowableSuppressed(throwable: Throwable): List<Throwable> =
    try {
        throwable.suppressed.toList()
    } catch (_: Exception) {
        emptyList()
    }

private fun safeStackFrame(element: StackTraceElement): IssueStackFrame? {
    val module = safeIssueText(element.className, MAX_FRAME_MODULE_LENGTH, disallowLocationDelimiters = true)
    val function = safeIssueText(element.methodName, MAX_FRAME_FUNCTION_LENGTH)
    val sourceFilename = element.fileName?.takeIf { it.isNotBlank() } ?: return null
    val sourceLine = element.lineNumber.takeIf { it > 0 } ?: return null
    val filename =
        try {
            sanitizedIssueFilename(sourceFilename)
        } catch (_: SdkException) {
            return null
        }
    return IssueStackFrame(
        filename = filename,
        line = sourceLine,
        column = 1,
        function = function,
        module = module,
    )
}

private fun safeIssueText(
    value: String?,
    maximum: Int,
    disallowLocationDelimiters: Boolean = false,
): String? =
    try {
        value?.let { issueText(it, "issue diagnostic identity", maximum, disallowLocationDelimiters) }
    } catch (_: SdkException) {
        null
    }

private fun sanitizedIssueFilename(value: String): String {
    var normalized = value.trim().replace('\\', '/')
    val fileUrl = normalized.lowercase(Locale.ROOT).startsWith("file://")
    if (fileUrl) {
        normalized = normalized.substring("file://".length)
    }
    normalized = normalized.substringBefore('?').substringBefore('#').trim()
    val windowsAbsolute =
        normalized.length >= 3 &&
            normalized[0].isLetter() &&
            normalized[1] == ':' &&
            normalized[2] == '/'
    if (fileUrl || normalized.startsWith('/') || windowsAbsolute) {
        normalized = normalized.trimEnd('/').substringAfterLast('/')
    }
    return issueText(
        normalized,
        "issue stack frame filename",
        MAX_FRAME_FILENAME_LENGTH,
        disallowLocationDelimiters = true,
    )
}

private fun issueCoordinate(
    value: Int,
    label: String,
): Int {
    if (value < 1) {
        throw issueError("$label must be a positive integer")
    }
    return value
}

private fun normalizedDebugId(value: String): String {
    val normalized = value.trim().lowercase(Locale.ROOT)
    if (!debugIdPattern.matches(normalized)) {
        throw issueError("issue stack frame debugId must be a UUID")
    }
    return normalized
}

private fun normalizedBreadcrumbData(data: Map<String, Any?>): Map<String, Any?> {
    if (data.size > MAX_BREADCRUMB_DATA_FIELDS) {
        throw issueError("issue breadcrumb data must contain at most 8 fields")
    }
    val normalized = linkedMapOf<String, Any?>()
    data.forEach { (key, value) ->
        if (!breadcrumbDataKeyPattern.matches(key)) {
            throw issueError("issue breadcrumb data keys must be stable machine names")
        }
        normalized[key] =
            when (value) {
                null, is Boolean, is Int, is Long -> {
                    value
                }

                is Float -> {
                    if (!value.isFinite()) {
                        throw breadcrumbPrimitiveError(key)
                    }
                    value
                }

                is Double -> {
                    if (!value.isFinite()) {
                        throw breadcrumbPrimitiveError(key)
                    }
                    value
                }

                is String -> {
                    issueText(value, "issue breadcrumb data value for $key", MAX_BREADCRUMB_DATA_STRING_LENGTH)
                }

                else -> {
                    throw breadcrumbPrimitiveError(key)
                }
            }
    }
    return normalized.toMap()
}

private fun Map<String, Any?>.toJsonObject(): OrderedJsonObject {
    val value = OrderedJsonObject()
    forEach { (key, item) -> value.add(key, item) }
    return value
}

private fun issueMachineName(
    value: String,
    label: String,
    pattern: Regex,
): String {
    val normalized = value.trim()
    if (
        normalized.codePointCount(0, normalized.length) > MAX_BREADCRUMB_NAME_LENGTH ||
        !pattern.matches(normalized)
    ) {
        throw issueError("$label must be a stable machine name")
    }
    return normalized
}

private fun issueText(
    value: String,
    label: String,
    maximum: Int,
    disallowLocationDelimiters: Boolean = false,
): String {
    val normalized = value.trim()
    if (
        normalized.isEmpty() ||
        normalized.codePointCount(0, normalized.length) > maximum ||
        normalized.hasForbiddenControl() ||
        (disallowLocationDelimiters && ('?' in normalized || '#' in normalized))
    ) {
        throw issueError("$label is invalid or exceeds $maximum characters")
    }
    return normalized
}

private fun breadcrumbPrimitiveError(key: String): SdkException =
    issueError("issue breadcrumb data value for $key must be a finite primitive")

private fun issueError(message: String): SdkException = SdkException("validation_error", message)

private fun IssueExceptionMechanism.normalized(): IssueExceptionMechanism =
    copy(type = issueMachineName(type, "issue exception mechanism type", breadcrumbNamePattern))

private fun IssueException.normalized(): IssueException =
    copy(
        type =
            issueText(
                type,
                "issue exception type",
                MAX_EXCEPTION_TYPE_LENGTH,
                disallowLocationDelimiters = true,
            ),
        mechanism = mechanism?.normalized(),
    )
