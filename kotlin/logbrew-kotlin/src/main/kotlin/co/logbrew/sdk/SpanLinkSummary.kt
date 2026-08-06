package co.logbrew.sdk

/** Privacy-bounded relationship from a span to another W3C trace context. */
data class SpanLinkSummary(
    val traceId: String,
    val spanId: String,
    val sampled: Boolean? = null,
    val metadata: Map<String, Any?> = emptyMap(),
) {
    fun withMetadata(metadata: Map<String, Any?>): SpanLinkSummary = copy(metadata = metadata)

    internal fun normalized(): SpanLinkSummary {
        val trace =
            TelemetryContext(
                trace = TelemetryTraceContext(traceId = traceId, spanId = spanId, sampled = sampled),
            ).normalized().trace ?: throw SdkException("validation_error", "span link trace is required")
        return SpanLinkSummary(
            traceId = trace.traceId,
            spanId = trace.spanId ?: throw SdkException("validation_error", "span link spanId is required"),
            sampled = trace.sampled,
            metadata = Validation.copyMetadataMap(metadata),
        )
    }

    internal fun toJsonObject(): OrderedJsonObject {
        val value = normalized()
        return OrderedJsonObject()
            .add("traceId", value.traceId)
            .add("spanId", value.spanId)
            .addIfNotNull("sampled", value.sampled)
            .addMetadata(value.metadata)
    }
}

internal fun normalizeSpanLinks(links: List<SpanLinkSummary>): List<SpanLinkSummary> {
    if (links.size > 8) {
        throw SdkException("validation_error", "span links must contain at most 8 entries")
    }
    return links.map { it.normalized() }
}
