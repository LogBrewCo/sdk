package co.logbrew.sdk;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

public final class LogBrewOpenTelemetryTest {
    private static final String TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
    private static final String OTEL_SPAN_ID = "00f067aa0ba902b7";
    private static final String LOGBREW_SPAN_ID = "b7ad6b7169203331";

    private int testsRun;

    public static void main(String[] args) {
        new LogBrewOpenTelemetryTest().run();
    }

    private void run() {
        testSpanContextCopiesValidOtelParentIntoLogBrewChildContext();
        testCurrentSpanAndExplicitContextCopyActiveOtelContext();
        testInvalidAndMissingOtelContextsReturnEmpty();
        testSpanExporterQueuesSanitizedEndedOpenTelemetrySpan();
        System.out.println("java opentelemetry context tests ok (" + testsRun + " tests)");
    }

    private void testSpanContextCopiesValidOtelParentIntoLogBrewChildContext() {
        SpanContext otelContext = SpanContext.create(
            TRACE_ID,
            OTEL_SPAN_ID,
            TraceFlags.getSampled(),
            TraceState.getDefault()
        );

        Optional<LogBrewTraceContext> context =
            LogBrewOpenTelemetry.traceContextFromSpanContext(otelContext, LOGBREW_SPAN_ID);

        assertTrue(context.isPresent(), "valid otel span context copies into LogBrew");
        LogBrewTraceContext trace = context.get();
        assertEquals(TRACE_ID, trace.traceId(), "trace id");
        assertEquals(LOGBREW_SPAN_ID, trace.spanId(), "LogBrew child span id");
        assertEquals(OTEL_SPAN_ID, trace.parentSpanId(), "OpenTelemetry parent span id");
        assertEquals("01", trace.traceFlags(), "sampled flags");
        assertTrue(trace.sampled(), "sampled");
        assertEquals(
            "00-" + TRACE_ID + "-" + LOGBREW_SPAN_ID + "-01",
            trace.traceparent(),
            "outgoing traceparent"
        );

        SpanContext unsampled = SpanContext.create(
            TRACE_ID,
            "1111111111111111",
            TraceFlags.getDefault(),
            TraceState.getDefault()
        );
        LogBrewTraceContext unsampledTrace =
            LogBrewOpenTelemetry.traceContextFromSpanContext(unsampled, "2222222222222222").orElseThrow();
        assertEquals("00", unsampledTrace.traceFlags(), "unsampled flags");
        assertTrue(!unsampledTrace.sampled(), "unsampled");
        testsRun++;
    }

    private void testCurrentSpanAndExplicitContextCopyActiveOtelContext() {
        SpanContext otelContext = SpanContext.create(
            TRACE_ID,
            OTEL_SPAN_ID,
            TraceFlags.getSampled(),
            TraceState.getDefault()
        );
        Span otelSpan = Span.wrap(otelContext);
        Context explicitContext = Context.root().with(otelSpan);

        Optional<LogBrewTraceContext> fromContext =
            LogBrewOpenTelemetry.traceContextFromContext(explicitContext, LOGBREW_SPAN_ID);
        assertTrue(fromContext.isPresent(), "explicit otel context copies");
        assertEquals(OTEL_SPAN_ID, fromContext.get().parentSpanId(), "explicit context parent");

        try (Scope scope = explicitContext.makeCurrent()) {
            assertTrue(scope != null, "otel scope created");
            Optional<LogBrewTraceContext> current =
                LogBrewOpenTelemetry.traceContextFromCurrentSpan(LOGBREW_SPAN_ID);
            assertTrue(current.isPresent(), "current otel span copies");
            assertEquals(OTEL_SPAN_ID, current.get().parentSpanId(), "current span parent");
        }

        assertTrue(
            LogBrewOpenTelemetry.traceContextFromCurrentSpan(LOGBREW_SPAN_ID).isEmpty(),
            "closed otel scope is not copied"
        );
        testsRun++;
    }

    private void testInvalidAndMissingOtelContextsReturnEmpty() {
        assertTrue(
            LogBrewOpenTelemetry.traceContextFromSpanContext(SpanContext.getInvalid(), LOGBREW_SPAN_ID).isEmpty(),
            "invalid otel span context is empty"
        );
        assertTrue(
            LogBrewOpenTelemetry.traceContextFromSpan(Span.getInvalid(), LOGBREW_SPAN_ID).isEmpty(),
            "invalid otel span is empty"
        );
        assertTrue(
            LogBrewOpenTelemetry.traceContextFromContext(Context.root(), LOGBREW_SPAN_ID).isEmpty(),
            "missing otel span is empty"
        );
        testsRun++;
    }

    private void testSpanExporterQueuesSanitizedEndedOpenTelemetrySpan() {
        LogBrewClient client = LogBrewClient.create("lbw_ingest_java_otel", "logbrew-java", "0.1.0");
        SpanContext parent = SpanContext.createFromRemoteParent(
            TRACE_ID,
            OTEL_SPAN_ID,
            TraceFlags.getSampled(),
            TraceState.getDefault()
        );
        SpanContext linked = SpanContext.createFromRemoteParent(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbb",
            TraceFlags.getDefault(),
            TraceState.getDefault()
        );
        SdkTracerProvider provider = SdkTracerProvider.builder()
            .addSpanProcessor(SimpleSpanProcessor.create(LogBrewOpenTelemetrySdk.spanExporter(client)))
            .build();

        try {
            Span span = provider.get("checkout-service", "1.2.3")
                .spanBuilder("POST /checkout")
                .setSpanKind(SpanKind.SERVER)
                .setParent(Context.root().with(Span.wrap(parent)))
                .addLink(
                    linked,
                    Attributes.of(
                        AttributeKey.stringKey("messaging.system"),
                        "kafka",
                        AttributeKey.stringKey("messaging.message.id"),
                        "private-message-id"
                    )
                )
                .setStartTimestamp(1_780_000_000_000_000_000L, TimeUnit.NANOSECONDS)
                .startSpan();
            span.setAttribute("http.request.method", "POST");
            span.setAttribute("http.route", "/checkout/{cartId}");
            span.setAttribute("http.response.status_code", 202L);
            span.setAttribute("url.full", "https://example.invalid/orders?debug=blocked");
            span.setAttribute("db.statement", "select * from orders where marker = 'blocked'");
            span.addEvent(
                "exception",
                Attributes.of(
                    AttributeKey.stringKey("exception.type"),
                    "java.lang.IllegalStateException",
                    AttributeKey.stringKey("exception.message"),
                    "private exception message",
                    AttributeKey.stringKey("exception.stacktrace"),
                    "private stacktrace"
                ),
                1_780_000_001_000_000_000L,
                TimeUnit.NANOSECONDS
            );
            span.setStatus(StatusCode.ERROR, "private status description");
            span.end(1_780_000_002_500_000_000L, TimeUnit.NANOSECONDS);
        } finally {
            provider.shutdown().join(5, TimeUnit.SECONDS);
        }

        assertEquals(1, client.pendingEvents(), "OpenTelemetry exporter queues one span");
        String payload = client.previewJson();
        assertContains(payload, "\"type\": \"span\"");
        assertContains(payload, "\"name\": \"POST /checkout\"");
        assertContains(payload, "\"traceId\": \"" + TRACE_ID + "\"");
        assertContains(payload, "\"parentSpanId\": \"" + OTEL_SPAN_ID + "\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"durationMs\": 2500.0");
        assertContains(payload, "\"httpMethod\": \"POST\"");
        assertContains(payload, "\"httpRoute\": \"/checkout/{cartId}\"");
        assertContains(payload, "\"httpStatusCode\": 202");
        assertContains(payload, "\"instrumentationScopeName\": \"checkout-service\"");
        assertContains(payload, "\"instrumentationScopeVersion\": \"1.2.3\"");
        assertContains(payload, "\"events\": [");
        assertContains(payload, "\"exceptionType\": \"java.lang.IllegalStateException\"");
        assertContains(payload, "\"links\": [");
        assertContains(payload, "\"traceId\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"");
        assertContains(payload, "\"spanId\": \"bbbbbbbbbbbbbbbb\"");
        assertContains(payload, "\"sampled\": false");
        assertContains(payload, "\"messagingSystem\": \"kafka\"");
        assertNotContains(payload, "private-message-id");
        assertNotContains(payload, "private exception message");
        assertNotContains(payload, "private stacktrace");
        assertNotContains(payload, "private status description");
        assertNotContains(payload, "example.invalid");
        assertNotContains(payload, "db.statement");
        assertNotContains(payload, "debug=blocked");
        assertNotContains(payload, "traceparent");
        testsRun++;
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }

    private static void assertTrue(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError(label);
        }
    }

    private static void assertContains(String value, String expected) {
        if (!value.contains(expected)) {
            throw new AssertionError("expected payload to contain " + expected + "\n" + value);
        }
    }

    private static void assertNotContains(String value, String unexpected) {
        if (value.contains(unexpected)) {
            throw new AssertionError("expected payload to omit " + unexpected + "\n" + value);
        }
    }
}
