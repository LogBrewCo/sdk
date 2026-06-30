package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Predicate;

/**
 * Privacy-bounded summary for linking a span to another W3C trace context.
 */
public final class SpanLinkSummary {
    static final int MAX_LINKS = 8;

    private final String traceId;
    private final String spanId;
    private final boolean sampled;
    private Map<String, ?> metadata;

    private SpanLinkSummary(String traceId, String spanId, boolean sampled) {
        this.traceId = traceId;
        this.spanId = spanId;
        this.sampled = sampled;
    }

    /**
     * Creates a span link from explicit W3C trace and span IDs.
     */
    public static SpanLinkSummary create(String traceId, String spanId) {
        return create(traceId, spanId, true);
    }

    /**
     * Creates a span link from explicit W3C trace and span IDs.
     */
    public static SpanLinkSummary create(String traceId, String spanId, boolean sampled) {
        Traceparent.Context context = Traceparent.parse(
            Traceparent.create(traceId, spanId, sampled ? "01" : "00")
        );
        return new SpanLinkSummary(context.traceId(), context.parentSpanId(), context.sampled());
    }

    /**
     * Creates a span link from a validated incoming W3C traceparent value.
     */
    public static SpanLinkSummary fromTraceparent(String traceparent) {
        Traceparent.Context context = Traceparent.parse(traceparent);
        return new SpanLinkSummary(context.traceId(), context.parentSpanId(), context.sampled());
    }

    /**
     * Sets optional primitive link metadata.
     */
    public SpanLinkSummary metadata(Map<String, ?> metadata) {
        this.metadata = Validation.copyMetadata(metadata);
        return this;
    }

    Map<String, Object> toMap() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("traceId", traceId);
        value.put("spanId", spanId);
        value.put("sampled", Boolean.valueOf(sampled));
        Validation.putOptionalMetadata(value, metadata);
        return value;
    }

    SpanLinkSummary filterMetadataKeys(Predicate<String> allowedKey) {
        SpanLinkSummary summary = new SpanLinkSummary(traceId, spanId, sampled);
        Map<String, Object> copied = Validation.copyMetadata(metadata);
        if (copied != null) {
            Map<String, Object> filtered = new LinkedHashMap<>();
            for (Map.Entry<String, Object> entry : copied.entrySet()) {
                if (allowedKey.test(entry.getKey())) {
                    filtered.put(entry.getKey(), entry.getValue());
                }
            }
            if (!filtered.isEmpty()) {
                summary.metadata = filtered;
            }
        }
        return summary;
    }

    static void requireLinkLimit(int count) {
        if (count > MAX_LINKS) {
            throw new SdkException(
                "validation_error",
                "span links must contain at most " + MAX_LINKS + " entries"
            );
        }
    }
}
