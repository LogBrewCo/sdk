package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Predicate;

/**
 * Privacy-bounded summary for a span event.
 */
public final class SpanEventSummary {
    static final int MAX_EVENTS = 8;

    private final String name;
    private String timestamp;
    private Map<String, ?> metadata;

    private SpanEventSummary(String name) {
        this.name = name;
    }

    /**
     * Creates a span event summary with the required event name.
     */
    public static SpanEventSummary create(String name) {
        return new SpanEventSummary(name);
    }

    /**
     * Sets an optional timestamp with a timezone offset.
     */
    public SpanEventSummary timestamp(String timestamp) {
        this.timestamp = timestamp;
        return this;
    }

    /**
     * Sets optional primitive event metadata.
     */
    public SpanEventSummary metadata(Map<String, ?> metadata) {
        this.metadata = Validation.copyMetadata(metadata);
        return this;
    }

    Map<String, Object> toMap() {
        Validation.requireNonEmpty("span event name", name);
        if (timestamp != null) {
            Validation.requireTimestamp(timestamp);
        }
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("name", name);
        Validation.putOptionalString(value, "timestamp", timestamp);
        Validation.putOptionalMetadata(value, metadata);
        return value;
    }

    SpanEventSummary filterMetadataKeys(Predicate<String> allowedKey) {
        SpanEventSummary summary = SpanEventSummary.create(name);
        summary.timestamp = timestamp;
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

    static void requireEventLimit(int count) {
        if (count > MAX_EVENTS) {
            throw new SdkException(
                "validation_error",
                "span events must contain at most " + MAX_EVENTS + " entries"
            );
        }
    }
}
