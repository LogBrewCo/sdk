package co.logbrew.sdk;

import io.opentelemetry.sdk.trace.SpanProcessor;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import io.opentelemetry.sdk.trace.export.SpanExporter;

/**
 * Optional OpenTelemetry SDK helpers for app-owned provider/exporter setup.
 */
public final class LogBrewOpenTelemetrySdk {
    private LogBrewOpenTelemetrySdk() {
    }

    /**
     * Creates an app-owned OpenTelemetry span exporter that queues ended spans
     * into an existing {@link LogBrewClient}.
     *
     * <p>The exporter copies only valid span IDs, duration, status, primitive
     * allowlisted attributes, small event summaries, and span links. It does not
     * install a global provider or copy baggage, tracestate, URLs, SQL,
     * arbitrary headers, payloads, exception messages, or stack traces.</p>
     */
    public static SpanExporter spanExporter(LogBrewClient client) {
        return LogBrewOpenTelemetrySpanExporter.create(client);
    }

    /**
     * Creates a simple app-owned OpenTelemetry span processor for the LogBrew exporter.
     */
    public static SpanProcessor spanProcessor(LogBrewClient client) {
        return SimpleSpanProcessor.create(spanExporter(client));
    }
}
