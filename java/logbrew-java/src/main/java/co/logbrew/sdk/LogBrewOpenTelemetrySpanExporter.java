package co.logbrew.sdk;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.AttributeType;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.common.InstrumentationScopeInfo;
import io.opentelemetry.sdk.trace.data.EventData;
import io.opentelemetry.sdk.trace.data.LinkData;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * App-owned OpenTelemetry exporter that converts ended spans into LogBrew span events.
 */
public final class LogBrewOpenTelemetrySpanExporter implements SpanExporter {
    private static final int MAX_SUMMARY_ITEMS = 8;

    private final LogBrewClient client;
    private final AtomicBoolean shutdown;

    private LogBrewOpenTelemetrySpanExporter(LogBrewClient client) {
        this.client = Objects.requireNonNull(client, "client");
        this.shutdown = new AtomicBoolean();
    }

    /**
     * Creates a LogBrew span exporter for an app-owned OpenTelemetry SDK provider.
     */
    public static LogBrewOpenTelemetrySpanExporter create(LogBrewClient client) {
        return new LogBrewOpenTelemetrySpanExporter(client);
    }

    @Override
    public CompletableResultCode export(Collection<SpanData> spans) {
        if (shutdown.get() || spans == null) {
            return CompletableResultCode.ofFailure();
        }
        try {
            for (SpanData span : spans) {
                exportSpan(span);
            }
            return CompletableResultCode.ofSuccess();
        } catch (RuntimeException error) {
            return CompletableResultCode.ofFailure();
        }
    }

    @Override
    public CompletableResultCode flush() {
        return shutdown.get() ? CompletableResultCode.ofFailure() : CompletableResultCode.ofSuccess();
    }

    @Override
    public CompletableResultCode shutdown() {
        shutdown.set(true);
        return CompletableResultCode.ofSuccess();
    }

    private void exportSpan(SpanData span) {
        if (span == null) {
            return;
        }
        SpanContext context = span.getSpanContext();
        if (context == null || !context.isValid()) {
            return;
        }

        Map<String, Object> metadata = spanMetadata(span, context);
        SpanAttributes attributes = SpanAttributes
            .create(span.getName(), context.getTraceId(), context.getSpanId(), spanStatus(span))
            .metadata(metadata);
        SpanContext parent = span.getParentSpanContext();
        if (parent != null && parent.isValid()) {
            attributes.parentSpanId(parent.getSpanId());
        }
        long durationNanos = span.getEndEpochNanos() - span.getStartEpochNanos();
        if (durationNanos >= 0L) {
            attributes.durationMs(durationNanos / 1_000_000.0);
        }
        addEvents(attributes, span);
        addLinks(attributes, span);

        client.span(
            "otel_span_" + context.getSpanId(),
            timestampFromEpochNanos(span.getEndEpochNanos()),
            attributes
        );
    }

    private static Map<String, Object> spanMetadata(SpanData span, SpanContext context) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("source", "opentelemetry");
        metadata.put("spanKind", span.getKind().name().toLowerCase(java.util.Locale.ROOT));
        metadata.put("sampled", Boolean.valueOf(context.getTraceFlags().isSampled()));
        addInstrumentationScope(metadata, span.getInstrumentationScopeInfo());
        addAllowedAttributes(metadata, span.getAttributes());
        if (span.getResource() != null) {
            addAllowedAttributes(metadata, span.getResource().getAttributes());
        }
        addPositiveInt(metadata, "otelTotalAttributeCount", span.getTotalAttributeCount());
        addPositiveInt(metadata, "otelTotalRecordedEvents", span.getTotalRecordedEvents());
        addPositiveInt(metadata, "otelTotalRecordedLinks", span.getTotalRecordedLinks());
        return metadata;
    }

    private static void addInstrumentationScope(
        Map<String, Object> metadata,
        InstrumentationScopeInfo scope
    ) {
        if (scope == null) {
            return;
        }
        addString(metadata, "instrumentationScopeName", scope.getName());
        addString(metadata, "instrumentationScopeVersion", scope.getVersion());
    }

    private static void addEvents(SpanAttributes attributes, SpanData span) {
        int count = 0;
        for (EventData event : span.getEvents()) {
            if (count >= MAX_SUMMARY_ITEMS) {
                break;
            }
            Map<String, Object> metadata = new LinkedHashMap<>();
            addAllowedAttributes(metadata, event.getAttributes());
            addPositiveInt(metadata, "otelTotalAttributeCount", event.getTotalAttributeCount());
            attributes.event(SpanEventSummary
                .create(event.getName())
                .timestamp(timestampFromEpochNanos(event.getEpochNanos()))
                .metadata(metadata));
            count++;
        }
    }

    private static void addLinks(SpanAttributes attributes, SpanData span) {
        int count = 0;
        for (LinkData link : span.getLinks()) {
            if (count >= MAX_SUMMARY_ITEMS) {
                break;
            }
            SpanContext context = link.getSpanContext();
            if (context == null || !context.isValid()) {
                continue;
            }
            Map<String, Object> metadata = new LinkedHashMap<>();
            addAllowedAttributes(metadata, link.getAttributes());
            addPositiveInt(metadata, "otelTotalAttributeCount", link.getTotalAttributeCount());
            attributes.link(SpanLinkSummary
                .create(context.getTraceId(), context.getSpanId(), context.getTraceFlags().isSampled())
                .metadata(metadata));
            count++;
        }
    }

    private static void addAllowedAttributes(Map<String, Object> metadata, Attributes attributes) {
        if (attributes == null || attributes.isEmpty()) {
            return;
        }
        attributes.forEach((key, value) -> {
            String outputKey = outputMetadataKey(key);
            if (outputKey == null || blockedMetadataKey(key.getKey()) || blockedMetadataKey(outputKey)) {
                return;
            }
            Object primitive = primitiveValue(key, value);
            if (primitive != null) {
                metadata.put(outputKey, primitive);
            }
        });
    }

    private static Object primitiveValue(AttributeKey<?> key, Object value) {
        if (key.getType() == AttributeType.STRING && value instanceof String) {
            return value;
        }
        if (key.getType() == AttributeType.BOOLEAN && value instanceof Boolean) {
            return value;
        }
        if (key.getType() == AttributeType.LONG && value instanceof Long) {
            return value;
        }
        if (key.getType() == AttributeType.DOUBLE && value instanceof Double) {
            Double number = (Double) value;
            return number.isNaN() || number.isInfinite() ? null : number;
        }
        return null;
    }

    private static String outputMetadataKey(AttributeKey<?> key) {
        switch (key.getKey()) {
            case "http.request.method":
            case "http.method":
                return "httpMethod";
            case "http.route":
                return "httpRoute";
            case "http.response.status_code":
            case "http.status_code":
                return "httpStatusCode";
            case "db.system":
                return "dbSystem";
            case "db.operation.name":
            case "db.operation":
                return "dbOperation";
            case "db.namespace":
            case "db.name":
                return "dbNamespace";
            case "messaging.system":
                return "messagingSystem";
            case "messaging.operation.name":
            case "messaging.operation":
                return "messagingOperation";
            case "messaging.operation.type":
                return "messagingOperationType";
            case "messaging.destination.name":
                return "messagingDestination";
            case "messaging.batch.message_count":
                return "messagingBatchMessageCount";
            case "rpc.system":
                return "rpcSystem";
            case "rpc.service":
                return "rpcService";
            case "rpc.method":
                return "rpcMethod";
            case "exception.type":
                return "exceptionType";
            case "service.name":
                return "serviceName";
            case "service.namespace":
                return "serviceNamespace";
            case "service.version":
                return "serviceVersion";
            case "deployment.environment.name":
            case "deployment.environment":
                return "environment";
            default:
                return null;
        }
    }

    private static boolean blockedMetadataKey(String key) {
        return Validation.blockedDependencyMetadataKey(key);
    }

    private static String spanStatus(SpanData span) {
        return span.getStatus().getStatusCode() == StatusCode.ERROR ? "error" : "ok";
    }

    private static void addString(Map<String, Object> metadata, String key, String value) {
        if (value != null && !value.trim().isEmpty()) {
            metadata.put(key, value);
        }
    }

    private static void addPositiveInt(Map<String, Object> metadata, String key, int value) {
        if (value > 0) {
            metadata.put(key, Integer.valueOf(value));
        }
    }

    private static String timestampFromEpochNanos(long epochNanos) {
        long seconds = Math.floorDiv(epochNanos, 1_000_000_000L);
        long nanos = Math.floorMod(epochNanos, 1_000_000_000L);
        return Instant.ofEpochSecond(seconds, nanos).toString();
    }
}
