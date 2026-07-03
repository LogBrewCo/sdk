package co.logbrew.sdk;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.context.Context;
import java.util.Optional;

/**
 * Optional OpenTelemetry API helpers for apps that already install OpenTelemetry.
 *
 * <p>The helpers copy only valid trace ID, span ID, and trace flags into a
 * LogBrew child trace context. They do not own OpenTelemetry SDK providers,
 * exporters, processors, attributes, links, events, baggage, or tracestate.</p>
 */
public final class LogBrewOpenTelemetry {
    private LogBrewOpenTelemetry() {
    }

    /**
     * Copies the current OpenTelemetry span into a LogBrew child context.
     */
    public static Optional<LogBrewTraceContext> traceContextFromCurrentSpan() {
        return traceContextFromSpan(Span.current());
    }

    /**
     * Copies the current OpenTelemetry span into a LogBrew child context with an app-owned span ID.
     */
    public static Optional<LogBrewTraceContext> traceContextFromCurrentSpan(String spanId) {
        return traceContextFromSpan(Span.current(), spanId);
    }

    /**
     * Copies a span from an explicit OpenTelemetry context into a LogBrew child context.
     */
    public static Optional<LogBrewTraceContext> traceContextFromContext(Context context) {
        if (context == null) {
            return Optional.empty();
        }
        return traceContextFromSpan(Span.fromContext(context));
    }

    /**
     * Copies a span from an explicit OpenTelemetry context into a LogBrew child context.
     */
    public static Optional<LogBrewTraceContext> traceContextFromContext(Context context, String spanId) {
        if (context == null) {
            return Optional.empty();
        }
        return traceContextFromSpan(Span.fromContext(context), spanId);
    }

    /**
     * Copies an OpenTelemetry span into a LogBrew child context.
     */
    public static Optional<LogBrewTraceContext> traceContextFromSpan(Span span) {
        if (span == null) {
            return Optional.empty();
        }
        return traceContextFromSpanContext(span.getSpanContext());
    }

    /**
     * Copies an OpenTelemetry span into a LogBrew child context with an app-owned span ID.
     */
    public static Optional<LogBrewTraceContext> traceContextFromSpan(Span span, String spanId) {
        if (span == null) {
            return Optional.empty();
        }
        return traceContextFromSpanContext(span.getSpanContext(), spanId);
    }

    /**
     * Copies an OpenTelemetry span context into a LogBrew child context.
     */
    public static Optional<LogBrewTraceContext> traceContextFromSpanContext(SpanContext spanContext) {
        if (spanContext == null || !spanContext.isValid()) {
            return Optional.empty();
        }
        return Optional.of(LogBrewTraceContext.fromTraceparent(parentTraceparent(spanContext)));
    }

    /**
     * Copies an OpenTelemetry span context into a LogBrew child context with an app-owned span ID.
     */
    public static Optional<LogBrewTraceContext> traceContextFromSpanContext(
        SpanContext spanContext,
        String spanId
    ) {
        if (spanContext == null || !spanContext.isValid()) {
            return Optional.empty();
        }
        return Optional.of(LogBrewTraceContext.fromTraceparent(parentTraceparent(spanContext), spanId));
    }

    private static String parentTraceparent(SpanContext spanContext) {
        return Traceparent.create(
            spanContext.getTraceId(),
            spanContext.getSpanId(),
            spanContext.getTraceFlags().asHex()
        );
    }
}
