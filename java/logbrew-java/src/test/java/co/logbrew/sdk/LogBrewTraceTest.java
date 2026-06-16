package co.logbrew.sdk;

import java.time.Instant;
import java.util.Collections;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import org.slf4j.LoggerFactory;

/**
 * Dependency-free trace correlation test runner for the Java SDK.
 */
public final class LogBrewTraceTest {
    private static final String TRACEPARENT =
        "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
    private static final String CHILD_SPAN_ID = "b7ad6b7169203331";

    private int testsRun;

    public static void main(String[] args) {
        new LogBrewTraceTest().run();
    }

    private void run() {
        testTraceContextContinuesIncomingTraceparent();
        testTraceScopesReinstateAndPropagateExplicitAsyncWork();
        testJulHandlerAddsActiveTraceMetadata();
        testLogbackAppenderAddsActiveTraceMetadata();
        testHttpRequestTelemetryLinksSpanMetricLogAndIssue();
        testHttpRequestTelemetryIgnoresMalformedIncomingTraceparent();
        System.out.println("java trace correlation tests ok (" + testsRun + " tests)");
    }

    private void testTraceContextContinuesIncomingTraceparent() {
        LogBrewTraceContext context = LogBrewTraceContext.fromTraceparent(TRACEPARENT, CHILD_SPAN_ID);

        assertEquals("4bf92f3577b34da6a3ce929d0e0e4736", context.traceId(), "trace id");
        assertEquals(CHILD_SPAN_ID, context.spanId(), "span id");
        assertEquals("00f067aa0ba902b7", context.parentSpanId(), "parent span id");
        assertEquals("01", context.traceFlags(), "trace flags");
        assertTrue(context.sampled(), "sampled");
        assertEquals(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01",
            context.traceparent(),
            "outgoing traceparent"
        );
        assertEquals(context.traceparent(), context.headers().get("traceparent"), "traceparent header");

        Map<String, Object> metadata = context.metadata();
        assertEquals(context.traceId(), metadata.get("traceId"), "metadata trace id");
        assertEquals(context.spanId(), metadata.get("spanId"), "metadata span id");
        assertEquals(context.parentSpanId(), metadata.get("parentSpanId"), "metadata parent span id");
        assertEquals(Boolean.TRUE, metadata.get("traceSampled"), "metadata sampled");
        assertTrue(!metadata.containsKey("traceparent"), "metadata omits raw propagation header");
        testsRun++;
    }

    private void testTraceScopesReinstateAndPropagateExplicitAsyncWork() {
        LogBrewTraceContext root = LogBrewTraceContext.create(
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "1111111111111111"
        );
        LogBrewTraceContext child = LogBrewTraceContext.create(
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "2222222222222222",
            root.spanId(),
            root.traceFlags()
        );
        AtomicReference<String> threadTrace = new AtomicReference<>();
        AtomicReference<String> wrappedTrace = new AtomicReference<>();
        AtomicReference<String> noTraceWrappedTrace = new AtomicReference<>();
        Runnable noTraceWrapper = LogBrewTrace.wrapCurrent(() ->
            noTraceWrappedTrace.set(currentSpanId().orElse("none")));

        LogBrewTrace.Scope rootScope = LogBrewTrace.activate(root);
        try {
            assertCurrentSpan(root.spanId());
            LogBrewTrace.Scope childScope = LogBrewTrace.activate(child);
            try {
                assertCurrentSpan(child.spanId());
            } finally {
                childScope.close();
            }
            assertCurrentSpan(root.spanId());

            Thread plainThread = new Thread(() -> threadTrace.set(currentSpanId().orElse("none")));
            plainThread.start();
            join(plainThread);

            Thread wrappedThread = new Thread(LogBrewTrace.wrapCurrent(() ->
                wrappedTrace.set(currentSpanId().orElse("none"))));
            wrappedThread.start();
            join(wrappedThread);

            noTraceWrapper.run();
            assertCurrentSpan(root.spanId());
        } finally {
            rootScope.close();
        }

        assertTrue(LogBrewTrace.current().isEmpty(), "scope closed");
        assertEquals("none", threadTrace.get(), "plain thread has no implicit trace");
        assertEquals(root.spanId(), wrappedTrace.get(), "wrapped thread has captured trace");
        assertEquals("none", noTraceWrappedTrace.get(), "captured empty trace clears during wrapped work");
        testsRun++;
    }

    private void testJulHandlerAddsActiveTraceMetadata() {
        LogBrewClient client = sampleClient();
        LogBrewTraceContext context = LogBrewTraceContext.fromTraceparent(TRACEPARENT, CHILD_SPAN_ID);
        LogRecord record = new LogRecord(Level.WARNING, "cart queued");
        record.setInstant(Instant.parse("2026-06-02T10:00:07Z"));
        record.setLoggerName("checkout.worker");
        record.setSequenceNumber(42L);

        withTrace(context, () -> {
            client.log(
                LogBrewJulHandler.defaultEventId(record),
                LogBrewJulHandler.timestampFromRecord(record),
                LogBrewJulHandler.logAttributesFromRecord(
                    record,
                    false,
                    Collections.singletonMap("service", "checkout")
                )
            );
        });

        String payload = client.previewJson();
        assertContains(payload, "\"traceId\": \"" + context.traceId() + "\"");
        assertContains(payload, "\"spanId\": \"" + context.spanId() + "\"");
        assertContains(payload, "\"parentSpanId\": \"" + context.parentSpanId() + "\"");
        assertContains(payload, "\"traceSampled\": true");
        assertContains(payload, "\"service\": \"checkout\"");
        assertNotContains(payload, "traceparent");
        testsRun++;
    }

    private void testLogbackAppenderAddsActiveTraceMetadata() {
        LogBrewClient client = sampleClient();
        LogBrewTraceContext context = LogBrewTraceContext.fromTraceparent(TRACEPARENT, CHILD_SPAN_ID);
        LogBrewLogbackAppender appender = new LogBrewLogbackAppender(client);
        appender.setName("LOGBREW_TRACE");
        appender.setEventIdPrefix("logback_trace");
        appender.start();
        ch.qos.logback.classic.Logger logger = logbackLogger("checkout.slf4j.trace");
        ch.qos.logback.classic.Level originalLevel = logger.getLevel();
        boolean originalAdditive = logger.isAdditive();
        try {
            logger.setAdditive(false);
            logger.setLevel(ch.qos.logback.classic.Level.TRACE);
            logger.addAppender(appender);
            withTrace(context, () -> {
                logger.atError().addKeyValue("cartId", Integer.valueOf(42)).log("checkout failed");
            });
        } finally {
            logger.detachAppender(appender);
            logger.setLevel(originalLevel);
            logger.setAdditive(originalAdditive);
            appender.stop();
        }

        String payload = client.previewJson();
        assertContains(payload, "\"traceId\": \"" + context.traceId() + "\"");
        assertContains(payload, "\"spanId\": \"" + context.spanId() + "\"");
        assertContains(payload, "\"parentSpanId\": \"" + context.parentSpanId() + "\"");
        assertContains(payload, "\"kv.cartId\": 42");
        assertNotContains(payload, "traceparent");
        testsRun++;
    }

    private void testHttpRequestTelemetryLinksSpanMetricLogAndIssue() {
        LogBrewClient client = sampleClient();
        LogBrewTraceContext context = LogBrewTraceContext.fromTraceparent(TRACEPARENT, CHILD_SPAN_ID);
        LogBrewHttpRequestTelemetry request = LogBrewHttpRequestTelemetry.start(
            client,
            "post",
            "https://shop.example/checkout/{cart_id}?cart=private#review",
            context,
            Collections.singletonMap("service", "checkout-api")
        );

        LogBrewTrace.Scope requestScope = request.activate();
        try {
            client.log(
                "evt_log_request",
                "2026-06-02T10:00:02Z",
                LogAttributes.create("checkout request started", "info")
                    .metadata(LogBrewTrace.metadataWithCurrentTrace(Map.of("stage", "handler")))
            );
            client.issue(
                "evt_issue_request",
                "2026-06-02T10:00:03Z",
                IssueAttributes.create("Checkout failed", "error")
                    .message("handler returned 502")
                    .metadata(LogBrewTrace.metadataWithCurrentTrace(Map.of("stage", "exception")))
            );
        } finally {
            requestScope.close();
        }
        request.finishSpanAndMetric(
            "evt_span_request",
            "evt_metric_request_duration",
            "2026-06-02T10:00:04Z",
            502,
            183.4
        );

        String payload = client.previewJson();
        assertContains(payload, "\"type\": \"log\"");
        assertContains(payload, "\"type\": \"issue\"");
        assertContains(payload, "\"type\": \"span\"");
        assertContains(payload, "\"type\": \"metric\"");
        assertContains(payload, "\"name\": \"POST /checkout/{cart_id}\"");
        assertContains(payload, "\"name\": \"http.server.duration\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"value\": 183.4");
        assertContains(payload, "\"routeTemplate\": \"/checkout/{cart_id}\"");
        assertContains(payload, "\"statusCode\": 502");
        assertContains(payload, "\"traceId\": \"" + context.traceId() + "\"");
        assertContains(payload, "\"spanId\": \"" + context.spanId() + "\"");
        assertNotContains(payload, "cart=private");
        assertNotContains(payload, "traceparent");
        assertEquals(context.traceparent(), request.outgoingHeaders().get("traceparent"), "outgoing traceparent");
        testsRun++;
    }

    private void testHttpRequestTelemetryIgnoresMalformedIncomingTraceparent() {
        LogBrewClient client = sampleClient();
        LogBrewHttpRequestTelemetry request = LogBrewHttpRequestTelemetry.start(
            client,
            "GET",
            "/health",
            "not-a-traceparent"
        );

        LogBrewTraceContext context = request.traceContext();
        assertEquals(32, context.traceId().length(), "generated trace id length");
        assertEquals(16, context.spanId().length(), "generated span id length");
        assertNull(context.parentSpanId(), "malformed propagation starts a local root");
        assertEquals("01", context.traceFlags(), "generated trace flags");
        assertTrue(context.sampled(), "generated trace sampled");
        testsRun++;
    }

    private static Optional<String> currentSpanId() {
        return LogBrewTrace.current().map(LogBrewTraceContext::spanId);
    }

    private static void assertCurrentSpan(String spanId) {
        assertEquals(spanId, currentSpanId().orElse("none"), "current span");
    }

    private static void withTrace(LogBrewTraceContext context, Runnable runnable) {
        LogBrewTrace.Scope scope = LogBrewTrace.activate(context);
        try {
            runnable.run();
        } finally {
            scope.close();
        }
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static ch.qos.logback.classic.Logger logbackLogger(String name) {
        ch.qos.logback.classic.LoggerContext context =
            (ch.qos.logback.classic.LoggerContext) LoggerFactory.getILoggerFactory();
        return context.getLogger(name);
    }

    private static void join(Thread thread) {
        try {
            thread.join();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError(error);
        }
    }

    private static void assertContains(String value, String needle) {
        if (!value.contains(needle)) {
            throw new AssertionError("expected " + value + " to contain " + needle);
        }
    }

    private static void assertNotContains(String value, String needle) {
        if (value.contains(needle)) {
            throw new AssertionError("expected " + value + " to omit " + needle);
        }
    }

    private static void assertTrue(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError("expected true: " + label);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private static void assertNull(Object actual, String label) {
        if (actual != null) {
            throw new AssertionError(label + ": expected null but got " + actual);
        }
    }
}
