package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Dependency-free helper for app-owned HTTP server request spans.
 *
 * <p>The helper records a request span and optional {@code http.server.duration}
 * metric with the same trace/span IDs that logger integrations read from the
 * active trace scope.</p>
 */
public final class LogBrewHttpRequestTelemetry {
    private static final Pattern METHOD_PATTERN = Pattern.compile("^[A-Za-z]+$");

    private final LogBrewClient client;
    private final String method;
    private final String routeTemplate;
    private final LogBrewTraceContext traceContext;
    private final Map<String, Object> metadata;
    private final long startedNanos;
    private boolean finished;

    private LogBrewHttpRequestTelemetry(
        LogBrewClient client,
        String method,
        String routeTemplate,
        LogBrewTraceContext traceContext,
        Map<String, ?> metadata
    ) {
        this.client = Objects.requireNonNull(client, "client");
        this.method = normalizeMethod(method);
        this.routeTemplate = sanitizeRouteTemplate(routeTemplate);
        this.traceContext = Objects.requireNonNull(traceContext, "traceContext");
        Map<String, Object> copiedMetadata = Validation.copyMetadata(metadata);
        this.metadata = copiedMetadata == null ? new LinkedHashMap<>() : copiedMetadata;
        this.startedNanos = System.nanoTime();
    }

    /**
     * Starts request telemetry with a generated local trace.
     */
    public static LogBrewHttpRequestTelemetry start(LogBrewClient client, String method, String routeTemplate) {
        return start(client, method, routeTemplate, LogBrewTraceContext.generate(), null);
    }

    /**
     * Starts request telemetry by continuing an incoming W3C traceparent.
     */
    public static LogBrewHttpRequestTelemetry start(
        LogBrewClient client,
        String method,
        String routeTemplate,
        String traceparent
    ) {
        return start(client, method, routeTemplate, traceContextFromIncomingHeader(traceparent), null);
    }

    /**
     * Starts request telemetry by continuing an incoming W3C traceparent with base metadata.
     */
    public static LogBrewHttpRequestTelemetry start(
        LogBrewClient client,
        String method,
        String routeTemplate,
        String traceparent,
        Map<String, ?> metadata
    ) {
        return start(client, method, routeTemplate, traceContextFromIncomingHeader(traceparent), metadata);
    }

    /**
     * Starts request telemetry from an explicit LogBrew trace context.
     */
    public static LogBrewHttpRequestTelemetry start(
        LogBrewClient client,
        String method,
        String routeTemplate,
        LogBrewTraceContext traceContext
    ) {
        return start(client, method, routeTemplate, traceContext, null);
    }

    /**
     * Starts request telemetry from an explicit LogBrew trace context and base metadata.
     */
    public static LogBrewHttpRequestTelemetry start(
        LogBrewClient client,
        String method,
        String routeTemplate,
        LogBrewTraceContext traceContext,
        Map<String, ?> metadata
    ) {
        return new LogBrewHttpRequestTelemetry(client, method, routeTemplate, traceContext, metadata);
    }

    /**
     * Returns the request trace context.
     */
    public LogBrewTraceContext traceContext() {
        return traceContext;
    }

    /**
     * Makes the request trace active for logs, issues, and explicit metrics.
     */
    public LogBrewTrace.Scope activate() {
        return LogBrewTrace.activate(traceContext);
    }

    /**
     * Returns an outbound carrier containing only W3C {@code traceparent}.
     */
    public Map<String, String> outgoingHeaders() {
        return traceContext.headers();
    }

    /**
     * Records a request span with the elapsed duration.
     */
    public void finishSpan(String eventId, String timestamp, int statusCode) {
        finishSpan(eventId, timestamp, statusCode, elapsedMs());
    }

    /**
     * Records a request span with an explicit duration.
     */
    public void finishSpan(String eventId, String timestamp, int statusCode, double durationMs) {
        ensureNotFinished();
        client.span(eventId, timestamp, spanAttributes(statusCode, durationMs));
        finished = true;
    }

    /**
     * Records a request span and {@code http.server.duration} metric with the same elapsed duration.
     */
    public void finishSpanAndMetric(String spanEventId, String metricEventId, String timestamp, int statusCode) {
        finishSpanAndMetric(spanEventId, metricEventId, timestamp, statusCode, elapsedMs());
    }

    /**
     * Records a request span and {@code http.server.duration} metric with an explicit duration.
     */
    public void finishSpanAndMetric(
        String spanEventId,
        String metricEventId,
        String timestamp,
        int statusCode,
        double durationMs
    ) {
        ensureNotFinished();
        client.span(spanEventId, timestamp, spanAttributes(statusCode, durationMs));
        client.metric(metricEventId, timestamp, metricAttributes(statusCode, durationMs));
        finished = true;
    }

    private SpanAttributes spanAttributes(int statusCode, double durationMs) {
        validateStatusCode(statusCode);
        SpanAttributes attributes = SpanAttributes
            .create(method + " " + routeTemplate, traceContext.traceId(), traceContext.spanId(), spanStatus(statusCode))
            .durationMs(durationMs)
            .metadata(requestMetadata(statusCode));
        if (traceContext.parentSpanId() != null) {
            attributes.parentSpanId(traceContext.parentSpanId());
        }
        return attributes;
    }

    private MetricAttributes metricAttributes(int statusCode, double durationMs) {
        validateStatusCode(statusCode);
        return MetricAttributes
            .create("http.server.duration", "histogram", durationMs, "ms", "delta")
            .metadata(requestMetadata(statusCode));
    }

    private Map<String, Object> requestMetadata(int statusCode) {
        Map<String, Object> values = new LinkedHashMap<>(metadata);
        values.put("method", method);
        values.put("routeTemplate", routeTemplate);
        values.put("statusCode", Integer.valueOf(statusCode));
        return LogBrewTrace.metadataWithTrace(traceContext, values);
    }

    private double elapsedMs() {
        return (System.nanoTime() - startedNanos) / 1_000_000.0;
    }

    private void ensureNotFinished() {
        if (finished) {
            throw new SdkException("validation_error", "request telemetry has already been finished");
        }
    }

    private static String normalizeMethod(String method) {
        Validation.requireNonEmpty("HTTP method", method);
        String normalized = method.trim().toUpperCase(java.util.Locale.ROOT);
        if (!METHOD_PATTERN.matcher(normalized).matches()) {
            throw new SdkException("validation_error", "HTTP method must contain letters only");
        }
        return normalized;
    }

    private static String sanitizeRouteTemplate(String routeTemplate) {
        Validation.requireNonEmpty("routeTemplate", routeTemplate);
        String trimmed = routeTemplate.trim();
        int schemeIndex = trimmed.indexOf("://");
        if (schemeIndex >= 0) {
            int pathStart = trimmed.indexOf('/', schemeIndex + 3);
            trimmed = pathStart >= 0 ? trimmed.substring(pathStart) : "/";
        }
        int queryIndex = trimmed.indexOf('?');
        int hashIndex = trimmed.indexOf('#');
        int end = trimmed.length();
        if (queryIndex >= 0) {
            end = Math.min(end, queryIndex);
        }
        if (hashIndex >= 0) {
            end = Math.min(end, hashIndex);
        }
        String sanitized = trimmed.substring(0, end).trim();
        if (sanitized.isEmpty()) {
            throw new SdkException("validation_error", "routeTemplate must be non-empty after sanitization");
        }
        return sanitized;
    }

    private static void validateStatusCode(int statusCode) {
        if (statusCode < 100 || statusCode > 599) {
            throw new SdkException("validation_error", "HTTP statusCode must be an integer from 100 to 599");
        }
    }

    private static String spanStatus(int statusCode) {
        return statusCode >= 500 ? "error" : "ok";
    }

    private static LogBrewTraceContext traceContextFromIncomingHeader(String traceparent) {
        if (traceparent == null || traceparent.trim().isEmpty()) {
            return LogBrewTraceContext.generate();
        }
        try {
            return LogBrewTraceContext.fromTraceparent(traceparent);
        } catch (SdkException error) {
            return LogBrewTraceContext.generate();
        }
    }
}
