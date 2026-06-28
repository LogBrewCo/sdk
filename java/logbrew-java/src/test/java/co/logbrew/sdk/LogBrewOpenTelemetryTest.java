package co.logbrew.sdk;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import java.util.Optional;

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
}
