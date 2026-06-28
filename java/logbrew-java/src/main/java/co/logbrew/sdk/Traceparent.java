package co.logbrew.sdk;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Dependency-free helpers for explicit W3C traceparent interoperability.
 *
 * <p>The helpers validate and normalize incoming trace context, derive
 * LogBrew span attributes from app-owned child span IDs, and create outbound
 * traceparent carriers. They do not install OpenTelemetry or patch HTTP
 * clients.</p>
 */
public final class Traceparent {
    private static final Pattern TRACEPARENT_PATTERN = Pattern.compile(
        "^([0-9a-fA-F]{2})-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-([0-9a-fA-F]{2})$"
    );
    private static final Pattern TRACE_ID_PATTERN = Pattern.compile("^[0-9a-fA-F]{32}$");
    private static final Pattern SPAN_ID_PATTERN = Pattern.compile("^[0-9a-fA-F]{16}$");
    private static final Pattern FLAGS_PATTERN = Pattern.compile("^[0-9a-fA-F]{2}$");
    private static final String ZERO_TRACE_ID = "00000000000000000000000000000000";
    private static final String ZERO_SPAN_ID = "0000000000000000";

    private Traceparent() {
    }

    /**
     * Parsed W3C traceparent context after validation and normalization.
     */
    public static final class Context {
        private final String version;
        private final String traceId;
        private final String parentSpanId;
        private final String traceFlags;
        private final boolean sampled;

        private Context(String version, String traceId, String parentSpanId, String traceFlags) {
            this.version = version;
            this.traceId = traceId;
            this.parentSpanId = parentSpanId;
            this.traceFlags = traceFlags;
            this.sampled = (Integer.parseInt(traceFlags, 16) & 1) == 1;
        }

        /**
         * Returns the normalized W3C version field.
         */
        public String version() {
            return version;
        }

        /**
         * Returns the normalized 32-character trace ID.
         */
        public String traceId() {
            return traceId;
        }

        /**
         * Returns the normalized upstream parent span ID.
         */
        public String parentSpanId() {
            return parentSpanId;
        }

        /**
         * Returns the normalized two-character trace flags field.
         */
        public String traceFlags() {
            return traceFlags;
        }

        /**
         * Returns whether the W3C sampled bit is set.
         */
        public boolean sampled() {
            return sampled;
        }
    }

    /**
     * Inputs used to derive LogBrew span attributes from an incoming traceparent.
     */
    public static final class SpanInput {
        private final String name;
        private final String spanId;
        private final String status;
        private Double durationMs;
        private Map<String, ?> metadata;
        private List<SpanEventSummary> events;

        private SpanInput(String name, String spanId, String status) {
            this.name = name;
            this.spanId = spanId;
            this.status = status;
        }

        /**
         * Creates span input with required span identity and status fields.
         */
        public static SpanInput create(String name, String spanId, String status) {
            return new SpanInput(name, spanId, status);
        }

        /**
         * Sets optional span duration in milliseconds.
         */
        public SpanInput durationMs(double durationMs) {
            this.durationMs = Double.valueOf(durationMs);
            return this;
        }

        /**
         * Sets optional primitive metadata. Nested objects are rejected.
         */
        public SpanInput metadata(Map<String, ?> metadata) {
            this.metadata = Validation.copyMetadata(metadata);
            return this;
        }

        /**
         * Adds one optional privacy-bounded span event summary.
         */
        public SpanInput event(SpanEventSummary event) {
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
        public SpanInput events(Iterable<SpanEventSummary> summaries) {
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
    }

    /**
     * Parses, validates, and normalizes a W3C traceparent header value.
     */
    public static Context parse(String traceparent) {
        Validation.requireNonEmpty("traceparent", traceparent);
        Matcher matcher = TRACEPARENT_PATTERN.matcher(traceparent.trim());
        if (!matcher.matches()) {
            throw new SdkException(
                "validation_error",
                "traceparent must match W3C version-traceid-parentid-flags shape"
            );
        }

        String version = normalize(matcher.group(1));
        String traceId = normalize(matcher.group(2));
        String parentSpanId = normalize(matcher.group(3));
        String traceFlags = normalize(matcher.group(4));
        if ("ff".equals(version)) {
            throw new SdkException("validation_error", "traceparent version ff is forbidden");
        }
        requireTraceId(traceId);
        requireSpanId("traceparent parent span id", parentSpanId);
        requireTraceFlags(traceFlags);
        return new Context(version, traceId, parentSpanId, traceFlags);
    }

    /**
     * Creates a normalized sampled W3C traceparent header from explicit IDs.
     */
    public static String create(String traceId, String spanId) {
        return create(traceId, spanId, "01");
    }

    /**
     * Creates a normalized W3C traceparent header from explicit IDs and flags.
     */
    public static String create(String traceId, String spanId, String traceFlags) {
        String normalizedTraceId = normalizeRequired("traceId", traceId);
        String normalizedSpanId = normalizeRequired("spanId", spanId);
        String normalizedFlags = traceFlags == null || traceFlags.trim().isEmpty()
            ? "01"
            : normalize(traceFlags);
        requireTraceId(normalizedTraceId);
        requireSpanId("spanId", normalizedSpanId);
        requireTraceFlags(normalizedFlags);
        return "00-" + normalizedTraceId + "-" + normalizedSpanId + "-" + normalizedFlags;
    }

    /**
     * Creates a one-header outbound carrier containing only {@code traceparent}.
     */
    public static Map<String, String> createHeaders(String traceId, String spanId) {
        return createHeaders(traceId, spanId, "01");
    }

    /**
     * Creates a one-header outbound carrier containing only {@code traceparent}.
     */
    public static Map<String, String> createHeaders(String traceId, String spanId, String traceFlags) {
        return Collections.singletonMap("traceparent", create(traceId, spanId, traceFlags));
    }

    /**
     * Builds LogBrew span attributes that continue an incoming W3C traceparent.
     */
    public static SpanAttributes spanAttributesFromTraceparent(String traceparent, SpanInput input) {
        if (input == null) {
            throw new SdkException("validation_error", "traceparent span input must be provided");
        }
        Context context = parse(traceparent);
        String spanId = normalizeRequired("spanId", input.spanId);
        requireSpanId("spanId", spanId);
        SpanAttributes attributes = SpanAttributes
            .create(input.name, context.traceId(), spanId, input.status)
            .parentSpanId(context.parentSpanId());
        if (input.durationMs != null) {
            attributes.durationMs(input.durationMs.doubleValue());
        }
        if (input.metadata != null) {
            attributes.metadata(input.metadata);
        }
        if (input.events != null) {
            attributes.events(input.events);
        }
        return attributes;
    }

    private static String normalizeRequired(String label, String value) {
        Validation.requireNonEmpty(label, value);
        return normalize(value);
    }

    private static String normalize(String value) {
        return value.trim().toLowerCase(Locale.ROOT);
    }

    private static void requireTraceId(String traceId) {
        if (!TRACE_ID_PATTERN.matcher(traceId).matches()) {
            throw new SdkException("validation_error", "traceparent traceId must be 32 hex characters");
        }
        if (ZERO_TRACE_ID.equals(traceId)) {
            throw new SdkException("validation_error", "traceparent traceId must not be all zeros");
        }
    }

    private static void requireSpanId(String label, String spanId) {
        if (!SPAN_ID_PATTERN.matcher(spanId).matches()) {
            throw new SdkException("validation_error", label + " must be 16 hex characters");
        }
        if (ZERO_SPAN_ID.equals(spanId)) {
            throw new SdkException("validation_error", label + " must not be all zeros");
        }
    }

    private static void requireTraceFlags(String traceFlags) {
        if (!FLAGS_PATTERN.matcher(traceFlags).matches()) {
            throw new SdkException("validation_error", "traceparent flags must be two hex characters");
        }
    }
}
