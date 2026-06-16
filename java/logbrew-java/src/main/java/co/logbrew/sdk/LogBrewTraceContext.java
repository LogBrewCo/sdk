package co.logbrew.sdk;

import java.security.SecureRandom;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Immutable LogBrew trace identity for correlating Java spans, logs, issues,
 * and explicit metrics.
 */
public final class LogBrewTraceContext {
    private static final Pattern TRACE_ID_PATTERN = Pattern.compile("^[0-9a-fA-F]{32}$");
    private static final Pattern SPAN_ID_PATTERN = Pattern.compile("^[0-9a-fA-F]{16}$");
    private static final Pattern FLAGS_PATTERN = Pattern.compile("^[0-9a-fA-F]{2}$");
    private static final String ZERO_TRACE_ID = "00000000000000000000000000000000";
    private static final String ZERO_SPAN_ID = "0000000000000000";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private final String traceId;
    private final String spanId;
    private final String parentSpanId;
    private final String traceFlags;
    private final boolean sampled;

    private LogBrewTraceContext(String traceId, String spanId, String parentSpanId, String traceFlags) {
        this.traceId = normalizeTraceId(traceId);
        this.spanId = normalizeSpanId("spanId", spanId);
        this.parentSpanId = parentSpanId == null ? null : normalizeSpanId("parentSpanId", parentSpanId);
        this.traceFlags = normalizeTraceFlags(traceFlags == null || traceFlags.trim().isEmpty() ? "01" : traceFlags);
        this.sampled = (Integer.parseInt(this.traceFlags, 16) & 1) == 1;
    }

    /**
     * Generates a new sampled trace context with W3C-shaped trace and span IDs.
     */
    public static LogBrewTraceContext generate() {
        return create(randomHex(16), randomHex(8));
    }

    /**
     * Creates a sampled trace context from explicit trace and span IDs.
     */
    public static LogBrewTraceContext create(String traceId, String spanId) {
        return create(traceId, spanId, null, "01");
    }

    /**
     * Creates a trace context from explicit IDs and W3C flags.
     */
    public static LogBrewTraceContext create(
        String traceId,
        String spanId,
        String parentSpanId,
        String traceFlags
    ) {
        return new LogBrewTraceContext(traceId, spanId, parentSpanId, traceFlags);
    }

    /**
     * Continues an incoming W3C traceparent with a generated child span ID.
     */
    public static LogBrewTraceContext fromTraceparent(String traceparent) {
        return fromTraceparent(traceparent, randomHex(8));
    }

    /**
     * Continues an incoming W3C traceparent with an app-owned child span ID.
     */
    public static LogBrewTraceContext fromTraceparent(String traceparent, String spanId) {
        Traceparent.Context context = Traceparent.parse(traceparent);
        return create(context.traceId(), spanId, context.parentSpanId(), context.traceFlags());
    }

    /**
     * Returns the normalized 32-character W3C trace ID.
     */
    public String traceId() {
        return traceId;
    }

    /**
     * Returns the normalized current span ID.
     */
    public String spanId() {
        return spanId;
    }

    /**
     * Returns the normalized parent span ID, or null for local root spans.
     */
    public String parentSpanId() {
        return parentSpanId;
    }

    /**
     * Returns the normalized W3C trace flags.
     */
    public String traceFlags() {
        return traceFlags;
    }

    /**
     * Returns whether the sampled flag is set.
     */
    public boolean sampled() {
        return sampled;
    }

    /**
     * Returns an outbound W3C traceparent value for the current span.
     */
    public String traceparent() {
        return Traceparent.create(traceId, spanId, traceFlags);
    }

    /**
     * Returns an outbound carrier containing only {@code traceparent}.
     */
    public Map<String, String> headers() {
        return Traceparent.createHeaders(traceId, spanId, traceFlags);
    }

    /**
     * Returns primitive metadata for correlating logs, issues, and metrics.
     */
    public Map<String, Object> metadata() {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("traceId", traceId);
        values.put("spanId", spanId);
        if (parentSpanId != null) {
            values.put("parentSpanId", parentSpanId);
        }
        values.put("traceFlags", traceFlags);
        values.put("traceSampled", Boolean.valueOf(sampled));
        return Collections.unmodifiableMap(values);
    }

    private static String normalizeTraceId(String traceId) {
        Validation.requireNonEmpty("traceId", traceId);
        String normalized = traceId.trim().toLowerCase(Locale.ROOT);
        if (!TRACE_ID_PATTERN.matcher(normalized).matches()) {
            throw new SdkException("validation_error", "traceId must be 32 hex characters");
        }
        if (ZERO_TRACE_ID.equals(normalized)) {
            throw new SdkException("validation_error", "traceId must not be all zeros");
        }
        return normalized;
    }

    private static String normalizeSpanId(String label, String spanId) {
        Validation.requireNonEmpty(label, spanId);
        String normalized = spanId.trim().toLowerCase(Locale.ROOT);
        if (!SPAN_ID_PATTERN.matcher(normalized).matches()) {
            throw new SdkException("validation_error", label + " must be 16 hex characters");
        }
        if (ZERO_SPAN_ID.equals(normalized)) {
            throw new SdkException("validation_error", label + " must not be all zeros");
        }
        return normalized;
    }

    private static String normalizeTraceFlags(String traceFlags) {
        String normalized = traceFlags.trim().toLowerCase(Locale.ROOT);
        if (!FLAGS_PATTERN.matcher(normalized).matches()) {
            throw new SdkException("validation_error", "traceFlags must be two hex characters");
        }
        return normalized;
    }

    private static String randomHex(int byteCount) {
        byte[] bytes = new byte[byteCount];
        do {
            RANDOM.nextBytes(bytes);
        } while (isAllZero(bytes));

        char[] chars = new char[byteCount * 2];
        for (int index = 0; index < bytes.length; index++) {
            int value = bytes[index] & 0xff;
            chars[index * 2] = HEX[value >>> 4];
            chars[index * 2 + 1] = HEX[value & 0x0f];
        }
        return new String(chars);
    }

    private static boolean isAllZero(byte[] bytes) {
        for (byte value : bytes) {
            if (value != 0) {
                return false;
            }
        }
        return true;
    }
}
