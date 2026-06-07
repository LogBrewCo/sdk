package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Public payload fields for an explicit, application-owned metric event.
 */
public final class MetricAttributes {
    private final String name;
    private final String kind;
    private final double value;
    private final String unit;
    private final String temporality;
    private Map<String, ?> metadata;

    private MetricAttributes(String name, String kind, double value, String unit, String temporality) {
        this.name = name;
        this.kind = kind;
        this.value = value;
        this.unit = unit;
        this.temporality = temporality;
    }

    /**
     * Creates metric attributes with required metric identity, value, unit, and
     * temporality fields.
     */
    public static MetricAttributes create(String name, String kind, double value, String unit, String temporality) {
        return new MetricAttributes(name, kind, value, unit, temporality);
    }

    /**
     * Sets optional public metadata values. Prefer low-cardinality primitives.
     */
    public MetricAttributes metadata(Map<String, ?> metadata) {
        this.metadata = Validation.copyMetadata(metadata);
        return this;
    }

    Map<String, Object> toMap() {
        Validation.requireNonEmpty("metric name", name);
        Validation.requireAllowedValue("metric kind", kind, LogBrewClient.METRIC_KINDS);
        Validation.requireFiniteNumber("metric value", value);
        Validation.requireNonEmpty("metric unit", unit);
        Validation.requireAllowedValue("metric temporality for " + kind, temporality, allowedTemporalities());
        if (requiresNonNegativeValue() && value < 0.0) {
            throw new SdkException("validation_error", "metric " + kind + " value must be non-negative");
        }

        Map<String, Object> mapped = new LinkedHashMap<>();
        mapped.put("name", name);
        mapped.put("kind", kind);
        mapped.put("value", Double.valueOf(value));
        mapped.put("unit", unit);
        mapped.put("temporality", temporality);
        Validation.putOptionalMetadata(mapped, metadata);
        return mapped;
    }

    private String[] allowedTemporalities() {
        if ("gauge".equals(kind)) {
            return LogBrewClient.INSTANT_TEMPORALITY;
        }
        return LogBrewClient.DELTA_CUMULATIVE_TEMPORALITIES;
    }

    private boolean requiresNonNegativeValue() {
        return "counter".equals(kind) || "histogram".equals(kind);
    }
}
