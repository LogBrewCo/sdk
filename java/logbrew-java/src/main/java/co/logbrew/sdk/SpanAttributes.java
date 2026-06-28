package co.logbrew.sdk;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Public payload fields for a span event.
 */
public final class SpanAttributes {
    private final String name;
    private final String traceId;
    private final String spanId;
    private final String status;
    private String parentSpanId;
    private Double durationMs;
    private Map<String, ?> metadata;
    private List<SpanEventSummary> events;

    private SpanAttributes(String name, String traceId, String spanId, String status) {
        this.name = name;
        this.traceId = traceId;
        this.spanId = spanId;
        this.status = status;
    }

    /**
     * Creates span attributes with required identity and status fields.
     */
    public static SpanAttributes create(String name, String traceId, String spanId, String status) {
        return new SpanAttributes(name, traceId, spanId, status);
    }

    /**
     * Sets the optional parent span ID.
     */
    public SpanAttributes parentSpanId(String parentSpanId) {
        this.parentSpanId = parentSpanId;
        return this;
    }

    /**
     * Sets the optional span duration in milliseconds.
     */
    public SpanAttributes durationMs(double durationMs) {
        this.durationMs = Double.valueOf(durationMs);
        return this;
    }

    /**
     * Sets optional public metadata values.
     */
    public SpanAttributes metadata(Map<String, ?> metadata) {
        this.metadata = Validation.copyMetadata(metadata);
        return this;
    }

    /**
     * Adds one optional privacy-bounded span event summary.
     */
    public SpanAttributes event(SpanEventSummary event) {
        if (event == null) {
            throw new SdkException("validation_error", "span event summary must be provided");
        }
        if (events == null) {
            events = new ArrayList<>();
        }
        events.add(event);
        SpanEventSummary.requireEventLimit(events.size());
        return this;
    }

    /**
     * Sets optional privacy-bounded span event summaries.
     */
    public SpanAttributes events(Iterable<SpanEventSummary> summaries) {
        if (summaries == null) {
            throw new SdkException("validation_error", "span events must be provided");
        }
        List<SpanEventSummary> copied = new ArrayList<>();
        for (SpanEventSummary summary : summaries) {
            if (summary == null) {
                throw new SdkException("validation_error", "span event summary must be provided");
            }
            copied.add(summary);
            SpanEventSummary.requireEventLimit(copied.size());
        }
        this.events = copied;
        return this;
    }

    Map<String, Object> toMap() {
        Validation.requireNonEmpty("span name", name);
        Validation.requireNonEmpty("span traceId", traceId);
        Validation.requireNonEmpty("span spanId", spanId);
        Validation.requireAllowedValue("span status", status, LogBrewClient.SPAN_STATUSES);
        if (parentSpanId != null) {
            Validation.requireNonEmpty("span parentSpanId", parentSpanId);
        }
        Validation.requireNonNegativeNumber("span durationMs", durationMs);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("name", name);
        value.put("traceId", traceId);
        value.put("spanId", spanId);
        Validation.putOptionalString(value, "parentSpanId", parentSpanId);
        value.put("status", status);
        if (durationMs != null) {
            value.put("durationMs", durationMs);
        }
        Validation.putOptionalMetadata(value, metadata);
        if (events != null && !events.isEmpty()) {
            List<Map<String, Object>> mappedEvents = new ArrayList<>();
            for (SpanEventSummary event : events) {
                mappedEvents.add(event.toMap());
            }
            value.put("events", mappedEvents);
        }
        return value;
    }
}
