package co.logbrew.sdk;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Dependency-free test runner for explicit dependency span helpers.
 */
public final class LogBrewOperationTracingTest {
    private int testsRun;

    public static void main(String[] args) {
        new LogBrewOperationTracingTest().run();
    }

    private void run() {
        testOperationTracingHelpersCorrelateAndSanitizeMetadata();
        testOperationTracingHelpersAttachSpanEventsAndExceptionSummaries();
        testQueueOperationInjectsTraceparentAndKeepsActiveChildTrace();
        testQueueOperationContinuesIncomingTraceparentAndAddsLinks();
        testQueueOperationRecordsTimeInQueueMetadata();
        testQueueOperationTreatsNegativeTimeInQueueAsNonFatal();
        testQueueOperationTreatsMalformedPropagationAsNonFatal();
        testOperationTracingHelpersPreserveOriginalErrors();
        testOperationTracingCaptureFailureDoesNotReplaceOperationResult();
        System.out.println("java operation tracing tests ok (" + testsRun + " tests)");
    }

    private void testOperationTracingHelpersCorrelateAndSanitizeMetadata() {
        LogBrewClient client = sampleClient();
        LogBrewTraceContext parent = LogBrewTraceContext.fromTraceparent(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
            "a7ad6b7169203330"
        );
        AtomicReference<LogBrewTraceContext> active = new AtomicReference<>();
        String result;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            result = LogBrewOperationTracing.databaseOperation(
                client,
                "select checkout",
                () -> {
                    active.set(LogBrewTrace.current().orElseThrow());
                    return "order-123";
                },
                LogBrewOperationTracing.DatabaseOperation.create()
                    .system("postgresql")
                    .operationKind("query")
                    .databaseName("orders")
                    .statementTemplate("SELECT * FROM orders WHERE id = ?")
                    .rowCount(1)
                    .eventIdPrefix("java_db_test")
                    .spanId("b7ad6b7169203331")
                    .metadata(Map.of(
                        "component", "checkout",
                        "query", "SELECT * FROM orders WHERE id = 'private'",
                        "params", "private",
                        "host", "db.internal"
                    ))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:00Z"),
                        Instant.parse("2026-06-02T10:00:00.025Z")
                    )
            );
        } catch (Exception error) {
            throw new AssertionError(error);
        } finally {
            scope.close();
        }

        assertEquals("order-123", result, "operation result");
        assertEquals(parent.traceId(), active.get().traceId(), "child trace id");
        assertEquals(parent.spanId(), active.get().parentSpanId(), "child parent span");
        assertEquals("b7ad6b7169203331", active.get().spanId(), "child span id");

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_db_test_span_b7ad6b7169203331\"");
        assertContains(payload, "\"type\": \"span\"");
        assertContains(payload, "\"name\": \"database:select checkout\"");
        assertContains(payload, "\"traceId\": \"" + parent.traceId() + "\"");
        assertContains(payload, "\"parentSpanId\": \"" + parent.spanId() + "\"");
        assertContains(payload, "\"status\": \"ok\"");
        assertContains(payload, "\"durationMs\": 25.0");
        assertContains(payload, "\"source\": \"database.operation\"");
        assertContains(payload, "\"dbSystem\": \"postgresql\"");
        assertContains(payload, "\"dbOperation\": \"select checkout\"");
        assertContains(payload, "\"dbOperationKind\": \"query\"");
        assertContains(payload, "\"dbName\": \"orders\"");
        assertContains(payload, "\"dbStatementTemplate\": \"SELECT * FROM orders WHERE id = ?\"");
        assertContains(payload, "\"rowCount\": 1");
        assertContains(payload, "\"component\": \"checkout\"");
        assertNotContains(payload, "db.internal");
        assertNotContains(payload, "params");
        assertNotContains(payload, "private");
        testsRun++;
    }

    private void testOperationTracingHelpersAttachSpanEventsAndExceptionSummaries() {
        LogBrewClient client = sampleClient();

        try {
            LogBrewOperationTracing.databaseOperation(
                client,
                "select checkout",
                () -> "order-123",
                LogBrewOperationTracing.DatabaseOperation.create()
                    .system("postgresql")
                    .eventIdPrefix("java_db_events")
                    .spanId("b7ad6b7169203335")
                    .spanEvent(SpanEventSummary.create("db.rows")
                        .timestamp("2026-06-02T10:00:00.012Z")
                        .metadata(Map.of(
                            "rowCount", Integer.valueOf(1),
                            "query", "SELECT private",
                            "service", "checkout"
                        )))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:00Z"),
                        Instant.parse("2026-06-02T10:00:00.025Z")
                    )
            );
        } catch (Exception error) {
            throw new AssertionError(error);
        }

        IllegalStateException original = new IllegalStateException("message body contained private order");
        IllegalStateException error = expectException(IllegalStateException.class, () ->
            LogBrewOperationTracing.queueOperation(
                client,
                "publish invoice",
                () -> {
                    throw original;
                },
                LogBrewOperationTracing.QueueOperation.create()
                    .system("kafka")
                    .eventIdPrefix("java_queue_events")
                    .spanId("b7ad6b7169203336")
                    .spanEvent(SpanEventSummary.create("queue.enqueued")
                        .metadata(Map.of(
                            "messageBody", "private body",
                            "component", "billing"
                        )))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:01Z"),
                        Instant.parse("2026-06-02T10:00:01.020Z")
                    )
            )
        );
        assertTrue(error == original, "queue original error identity");

        String payload = client.previewJson();
        assertContains(payload, "\"events\": [");
        assertContains(payload, "\"name\": \"db.rows\"");
        assertContains(payload, "\"timestamp\": \"2026-06-02T10:00:00.012Z\"");
        assertContains(payload, "\"rowCount\": 1");
        assertContains(payload, "\"service\": \"checkout\"");
        assertContains(payload, "\"name\": \"queue.enqueued\"");
        assertContains(payload, "\"component\": \"billing\"");
        assertContains(payload, "\"name\": \"exception\"");
        assertContains(payload, "\"exceptionType\": \"IllegalStateException\"");
        assertContains(payload, "\"exceptionEscaped\": true");
        assertNotContains(payload, "SELECT private");
        assertNotContains(payload, "private body");
        assertNotContains(payload, "message body contained");
        testsRun++;
    }

    private void testQueueOperationInjectsTraceparentAndKeepsActiveChildTrace() {
        LogBrewClient client = sampleClient();
        LogBrewTraceContext parent = LogBrewTraceContext.fromTraceparent(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
            "a7ad6b7169203330"
        );
        AtomicReference<String> injectedName = new AtomicReference<>();
        AtomicReference<String> injectedValue = new AtomicReference<>();
        AtomicReference<LogBrewTraceContext> active = new AtomicReference<>();

        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            String result = LogBrewOperationTracing.queueOperation(
                client,
                "publish invoice",
                () -> {
                    active.set(LogBrewTrace.current().orElseThrow());
                    return "sent";
                },
                LogBrewOperationTracing.QueueOperation.create()
                    .system("kafka")
                    .operationKind("publish")
                    .queueName("billing-events")
                    .eventIdPrefix("java_queue_header")
                    .spanId("b7ad6b7169203337")
                    .traceparentHeaderSetter((name, value) -> {
                        injectedName.set(name);
                        injectedValue.set(value);
                    })
                    .metadata(Map.of(
                        "component", "billing",
                        "headers", "private",
                        "messageBody", "private body"
                    ))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:02Z"),
                        Instant.parse("2026-06-02T10:00:02.030Z")
                    )
            );
            assertEquals("sent", result, "queue publish result");
        } catch (Exception error) {
            throw new AssertionError(error);
        } finally {
            scope.close();
        }

        assertEquals("traceparent", injectedName.get(), "traceparent header name");
        assertEquals(active.get().traceparent(), injectedValue.get(), "traceparent header value");
        assertEquals(parent.traceId(), active.get().traceId(), "queue child trace id");
        assertEquals(parent.spanId(), active.get().parentSpanId(), "queue child parent span");
        assertEquals("b7ad6b7169203337", active.get().spanId(), "queue child span");

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_queue_header_span_b7ad6b7169203337\"");
        assertContains(payload, "\"name\": \"queue:publish invoice\"");
        assertContains(payload, "\"queueSystem\": \"kafka\"");
        assertContains(payload, "\"queueOperationKind\": \"publish\"");
        assertContains(payload, "\"queueName\": \"billing-events\"");
        assertContains(payload, "\"component\": \"billing\"");
        assertNotContains(payload, "private body");
        assertNotContains(payload, "headers");
        assertNotContains(payload, "traceparent");
        testsRun++;
    }

    private void testQueueOperationContinuesIncomingTraceparentAndAddsLinks() {
        LogBrewClient client = sampleClient();
        AtomicReference<LogBrewTraceContext> active = new AtomicReference<>();

        try {
            LogBrewOperationTracing.queueOperation(
                client,
                "process invoices",
                () -> {
                    active.set(LogBrewTrace.current().orElseThrow());
                    return null;
                },
                LogBrewOperationTracing.QueueOperation.create()
                    .system("kafka")
                    .operationKind("process")
                    .queueName("billing-events")
                    .messageCount(2)
                    .eventIdPrefix("java_queue_process")
                    .spanId("b7ad6b7169203338")
                    .incomingTraceparent("00-11111111111111111111111111111111-2222222222222222-01")
                    .linkedMessageTraceparent(
                        "00-33333333333333333333333333333333-4444444444444444-00",
                        Map.of("partition", Integer.valueOf(2), "messageBody", "private")
                    )
                    .linkedMessageTraceparent(
                        "00-55555555555555555555555555555555-6666666666666666-01"
                    )
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:03Z"),
                        Instant.parse("2026-06-02T10:00:03.040Z")
                    )
            );
        } catch (Exception error) {
            throw new AssertionError(error);
        }

        assertEquals("11111111111111111111111111111111", active.get().traceId(), "incoming trace id");
        assertEquals("2222222222222222", active.get().parentSpanId(), "incoming parent span");
        assertEquals("b7ad6b7169203338", active.get().spanId(), "incoming child span");

        String payload = client.previewJson();
        assertContains(payload, "\"links\": [");
        assertContains(payload, "\"traceId\": \"33333333333333333333333333333333\"");
        assertContains(payload, "\"spanId\": \"4444444444444444\"");
        assertContains(payload, "\"sampled\": false");
        assertContains(payload, "\"partition\": 2");
        assertContains(payload, "\"traceId\": \"55555555555555555555555555555555\"");
        assertContains(payload, "\"spanId\": \"6666666666666666\"");
        assertContains(payload, "\"sampled\": true");
        assertContains(payload, "\"messageCount\": 2");
        assertNotContains(payload, "private");
        assertNotContains(payload, "traceFlags");
        testsRun++;
    }

    private void testQueueOperationRecordsTimeInQueueMetadata() {
        LogBrewClient client = sampleClient();

        try {
            LogBrewOperationTracing.queueOperation(
                client,
                "process delayed invoice",
                () -> "processed",
                LogBrewOperationTracing.QueueOperation.create()
                    .system("kafka")
                    .operationKind("process")
                    .eventIdPrefix("java_queue_latency")
                    .spanId("b7ad6b7169203340")
                    .enqueuedAt(Instant.parse("2026-06-02T10:00:00Z"))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:02.250Z"),
                        Instant.parse("2026-06-02T10:00:02.275Z")
                    )
            );
            LogBrewOperationTracing.queueOperation(
                client,
                "process broker latency",
                () -> "processed",
                LogBrewOperationTracing.QueueOperation.create()
                    .eventIdPrefix("java_queue_explicit_latency")
                    .spanId("b7ad6b7169203341")
                    .timeInQueueMs(125.5)
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:03Z"),
                        Instant.parse("2026-06-02T10:00:03.010Z")
                    )
            );
        } catch (Exception error) {
            throw new AssertionError(error);
        }

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_queue_latency_span_b7ad6b7169203340\"");
        assertContains(payload, "\"timeInQueueMs\": 2250.0");
        assertContains(payload, "\"id\": \"java_queue_explicit_latency_span_b7ad6b7169203341\"");
        assertContains(payload, "\"timeInQueueMs\": 125.5");
        assertNotContains(payload, "2026-06-02T10:00:00Z");
        testsRun++;
    }

    private void testQueueOperationTreatsNegativeTimeInQueueAsNonFatal() {
        LogBrewClient client = sampleClient();
        List<String> errorCodes = new ArrayList<>();

        try {
            String result = LogBrewOperationTracing.queueOperation(
                client,
                "process clock skew",
                () -> "processed",
                LogBrewOperationTracing.QueueOperation.create()
                    .eventIdPrefix("java_queue_clock_skew")
                    .spanId("b7ad6b7169203342")
                    .enqueuedAt(Instant.parse("2026-06-02T10:00:05Z"))
                    .onError(error -> errorCodes.add(error.code()))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:04Z"),
                        Instant.parse("2026-06-02T10:00:04.010Z")
                    )
            );
            assertEquals("processed", result, "negative time in queue result");
        } catch (Exception error) {
            throw new AssertionError(error);
        }

        assertTrue(errorCodes.contains("validation_error"), "negative time in queue reported");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_queue_clock_skew_span_b7ad6b7169203342\"");
        assertNotContains(payload, "timeInQueueMs");
        assertNotContains(payload, "2026-06-02T10:00:05Z");
        testsRun++;
    }

    private void testQueueOperationTreatsMalformedPropagationAsNonFatal() {
        LogBrewClient client = sampleClient();
        List<String> errorCodes = new ArrayList<>();

        try {
            String result = LogBrewOperationTracing.queueOperation(
                client,
                "process malformed",
                () -> "processed",
                LogBrewOperationTracing.QueueOperation.create()
                    .eventIdPrefix("java_queue_malformed")
                    .spanId("b7ad6b7169203339")
                    .incomingTraceparent("not-a-traceparent")
                    .linkedMessageTraceparent("also-not-a-traceparent")
                    .traceparentHeaderSetter((name, value) -> {
                        throw new IllegalStateException("headers are read-only");
                    })
                    .onError(error -> errorCodes.add(error.code()))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:04Z"),
                        Instant.parse("2026-06-02T10:00:04.010Z")
                    )
            );
            assertEquals("processed", result, "malformed queue result");
        } catch (Exception error) {
            throw new AssertionError(error);
        }

        assertTrue(errorCodes.contains("validation_error"), "invalid propagation reported");
        assertTrue(errorCodes.contains("traceparent_injection_failed"), "setter failure reported");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_queue_malformed_span_b7ad6b7169203339\"");
        assertContains(payload, "\"traceId\":");
        assertNotContains(payload, "headers are read-only");
        assertNotContains(payload, "not-a-traceparent");
        assertNotContains(payload, "also-not-a-traceparent");
        testsRun++;
    }

    private void testOperationTracingHelpersPreserveOriginalErrors() {
        LogBrewClient client = sampleClient();
        IllegalStateException original = new IllegalStateException("broker payload contained private order");

        IllegalStateException cacheError = expectException(IllegalStateException.class, () ->
            LogBrewOperationTracing.cacheOperation(
                client,
                "get cart",
                () -> {
                    throw original;
                },
                LogBrewOperationTracing.CacheOperation.create()
                    .system("redis")
                    .operationKind("get")
                    .cacheName("checkout-cache")
                    .hit(false)
                    .eventIdPrefix("java_cache_test")
                    .spanId("b7ad6b7169203332")
                    .metadata(Map.of("cacheKey", "cart:private", "value", "sensitive", "service", "checkout"))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:00Z"),
                        Instant.parse("2026-06-02T10:00:00.010Z")
                    )
            )
        );
        assertTrue(cacheError == original, "cache original error identity");

        IllegalStateException queueError = expectException(IllegalStateException.class, () ->
            LogBrewOperationTracing.queueOperation(
                client,
                "publish invoice",
                () -> {
                    throw original;
                },
                LogBrewOperationTracing.QueueOperation.create()
                    .system("kafka")
                    .operationKind("publish")
                    .queueName("billing-events")
                    .taskName("invoice.created")
                    .messageCount(1)
                    .eventIdPrefix("java_queue_test")
                    .spanId("b7ad6b7169203333")
                    .metadata(Map.of("messageBody", "private body", "brokerUrl", "kafka://private", "component", "billing"))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:01Z"),
                        Instant.parse("2026-06-02T10:00:01.020Z")
                    )
            )
        );
        assertTrue(queueError == original, "queue original error identity");

        String payload = client.previewJson();
        assertContains(payload, "\"source\": \"cache.operation\"");
        assertContains(payload, "\"cacheSystem\": \"redis\"");
        assertContains(payload, "\"cacheHit\": false");
        assertContains(payload, "\"source\": \"queue.operation\"");
        assertContains(payload, "\"queueSystem\": \"kafka\"");
        assertContains(payload, "\"queueName\": \"billing-events\"");
        assertContains(payload, "\"errorType\": \"IllegalStateException\"");
        assertNotContains(payload, "cart:private");
        assertNotContains(payload, "sensitive");
        assertNotContains(payload, "private body");
        assertNotContains(payload, "kafka://private");
        assertNotContains(payload, "broker payload");
        testsRun++;
    }

    private void testOperationTracingCaptureFailureDoesNotReplaceOperationResult() {
        LogBrewClient client = sampleClient();
        client.shutdown(RecordingTransport.alwaysAccept());
        AtomicReference<SdkException> reported = new AtomicReference<>();

        String result;
        try {
            result = LogBrewOperationTracing.databaseOperation(
                client,
                "select checkout",
                () -> "order-123",
                LogBrewOperationTracing.DatabaseOperation.create()
                    .eventIdPrefix("java_db_closed")
                    .spanId("b7ad6b7169203334")
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:00Z"),
                        Instant.parse("2026-06-02T10:00:00.001Z")
                    )
                    .onError(reported::set)
            );
        } catch (Exception error) {
            throw new AssertionError(error);
        }

        assertEquals("order-123", result, "closed client operation result");
        assertEquals("shutdown_error", reported.get().code(), "capture failure code");
        assertContains(reported.get().getMessage(), "client is already shut down");
        testsRun++;
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static <T extends Throwable> T expectException(Class<T> expectedType, ThrowingRunnable callback) {
        try {
            callback.run();
        } catch (Throwable error) {
            if (expectedType.isInstance(error)) {
                return expectedType.cast(error);
            }
            throw new AssertionError("expected " + expectedType.getSimpleName() + " but got " + error, error);
        }
        throw new AssertionError("expected " + expectedType.getSimpleName());
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

    private static void assertEquals(String expected, String actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
