package co.logbrew.sdk;

import java.time.Instant;
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
