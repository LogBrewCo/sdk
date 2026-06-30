package co.logbrew.sdk;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Dependency-free test runner for app-owned JMS-style message tracing helpers.
 */
public final class LogBrewJmsTracingTest {
    private int testsRun;

    public static void main(String[] args) {
        new LogBrewJmsTracingTest().run();
    }

    private void run() {
        testSendInjectsTraceparentAndCapturesSanitizedSpan();
        testProcessContinuesIncomingTraceparentAndRecordsLatency();
        testProcessBatchContinuesFirstTraceparentAndLinksRemainingMessages();
        testPropertyFailuresAreNonFatalDiagnostics();
        System.out.println("java jms tracing tests ok (" + testsRun + " tests)");
    }

    private void testSendInjectsTraceparentAndCapturesSanitizedSpan() {
        LogBrewClient client = sampleClient();
        FakeJmsMessage message = new FakeJmsMessage();
        LogBrewTraceContext parent = LogBrewTraceContext.create(
            "33333333333333333333333333333333",
            "4444444444444444"
        );
        AtomicReference<LogBrewTraceContext> active = new AtomicReference<>();

        String result;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            result = LogBrewJmsTracing.send(
                client,
                message,
                () -> {
                    active.set(LogBrewTrace.current().orElseThrow());
                    return "sent";
                },
                LogBrewJmsTracing.ProducerConfig.create()
                    .eventIdPrefix("java_jms_produce")
                    .spanId("b7ad6b7169203700")
                    .destinationName("billing-queue")
                    .metadata(Map.of(
                        "service", "checkout",
                        "messageBody", "private body",
                        "brokerUrl", "jms://private"
                    ))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:08.000Z"),
                        Instant.parse("2026-06-02T10:00:08.040Z")
                    )
            );
        } catch (Exception error) {
            throw new AssertionError(error);
        } finally {
            scope.close();
        }

        assertEquals("sent", result, "jms send result");
        assertEquals("00-33333333333333333333333333333333-b7ad6b7169203700-01", message.properties().get("traceparent"), "jms traceparent property");
        assertEquals(parent.traceId(), active.get().traceId(), "jms child trace id");
        assertEquals(parent.spanId(), active.get().parentSpanId(), "jms child parent span");
        assertEquals("b7ad6b7169203700", active.get().spanId(), "jms child span");

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_jms_produce_span_b7ad6b7169203700\"");
        assertContains(payload, "\"name\": \"queue:jms.produce\"");
        assertContains(payload, "\"source\": \"queue.operation\"");
        assertContains(payload, "\"traceId\": \"33333333333333333333333333333333\"");
        assertContains(payload, "\"spanId\": \"b7ad6b7169203700\"");
        assertContains(payload, "\"parentSpanId\": \"4444444444444444\"");
        assertContains(payload, "\"durationMs\": 40.0");
        assertContains(payload, "\"queueSystem\": \"jms\"");
        assertContains(payload, "\"queueOperation\": \"jms.produce\"");
        assertContains(payload, "\"queueOperationKind\": \"produce\"");
        assertContains(payload, "\"queueName\": \"billing-queue\"");
        assertContains(payload, "\"service\": \"checkout\"");
        assertNotContains(payload, "private body");
        assertNotContains(payload, "jms://private");
        assertNotContains(payload, "traceparent");
        assertNotContains(payload, "baggage");
        testsRun++;
    }

    private void testProcessContinuesIncomingTraceparentAndRecordsLatency() {
        LogBrewClient client = sampleClient();
        FakeJmsMessage message = new FakeJmsMessage();
        message.setStringProperty("traceparent", "00-11111111111111111111111111111111-2222222222222222-01");
        AtomicReference<LogBrewTraceContext> active = new AtomicReference<>();

        try {
            String result = LogBrewJmsTracing.process(
                client,
                message,
                () -> {
                    active.set(LogBrewTrace.current().orElseThrow());
                    return "processed";
                },
                LogBrewJmsTracing.ConsumerConfig.create()
                    .eventIdPrefix("java_jms_process")
                    .spanId("b7ad6b7169203701")
                    .destinationName("billing-queue")
                    .messageCount(1)
                    .timeInQueueMs(125.5)
                    .metadata(Map.of(
                        "worker", "billing",
                        "messageBody", "private process body"
                    ))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:09.000Z"),
                        Instant.parse("2026-06-02T10:00:09.030Z")
                    )
            );
            assertEquals("processed", result, "jms process result");
        } catch (Exception error) {
            throw new AssertionError(error);
        }

        assertEquals("11111111111111111111111111111111", active.get().traceId(), "jms incoming trace id");
        assertEquals("2222222222222222", active.get().parentSpanId(), "jms incoming parent span");
        assertEquals("b7ad6b7169203701", active.get().spanId(), "jms incoming child span");

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_jms_process_span_b7ad6b7169203701\"");
        assertContains(payload, "\"name\": \"queue:jms.process\"");
        assertContains(payload, "\"traceId\": \"11111111111111111111111111111111\"");
        assertContains(payload, "\"spanId\": \"b7ad6b7169203701\"");
        assertContains(payload, "\"parentSpanId\": \"2222222222222222\"");
        assertContains(payload, "\"queueSystem\": \"jms\"");
        assertContains(payload, "\"queueOperationKind\": \"process\"");
        assertContains(payload, "\"queueName\": \"billing-queue\"");
        assertContains(payload, "\"messageCount\": 1");
        assertContains(payload, "\"timeInQueueMs\": 125.5");
        assertContains(payload, "\"worker\": \"billing\"");
        assertNotContains(payload, "private process body");
        assertNotContains(payload, "11111111111111111111111111111111-2222222222222222");
        testsRun++;
    }

    private void testProcessBatchContinuesFirstTraceparentAndLinksRemainingMessages() {
        LogBrewClient client = sampleClient();
        FakeJmsMessage first = new FakeJmsMessage();
        first.setStringProperty("traceparent", "00-11111111111111111111111111111111-2222222222222222-01");
        FakeJmsMessage second = new FakeJmsMessage();
        second.setStringProperty("traceparent", "00-33333333333333333333333333333333-4444444444444444-00");
        FakeJmsMessage malformed = new FakeJmsMessage();
        malformed.setStringProperty("traceparent", "not-a-traceparent");
        FakeJmsMessage third = new FakeJmsMessage();
        third.setStringProperty("traceparent", "00-55555555555555555555555555555555-6666666666666666-01");
        AtomicReference<LogBrewTraceContext> active = new AtomicReference<>();
        List<String> errorCodes = new ArrayList<>();

        try {
            String result = LogBrewJmsTracing.processBatch(
                client,
                List.of(first, second, malformed, third),
                () -> {
                    active.set(LogBrewTrace.current().orElseThrow());
                    return "batch-processed";
                },
                LogBrewJmsTracing.ConsumerConfig.create()
                    .eventIdPrefix("java_jms_batch_process")
                    .spanId("b7ad6b7169203710")
                    .destinationName("billing-queue")
                    .timeInQueueMs(250.5)
                    .metadata(Map.of(
                        "worker", "billing-batch",
                        "messageBody", "private batch body",
                        "headers", "private headers"
                    ))
                    .onError(error -> errorCodes.add(error.code()))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:12.000Z"),
                        Instant.parse("2026-06-02T10:00:12.050Z")
                    )
            );
            assertEquals("batch-processed", result, "jms batch process result");
        } catch (Exception error) {
            throw new AssertionError(error);
        }

        assertEquals("11111111111111111111111111111111", active.get().traceId(), "jms batch trace id");
        assertEquals("2222222222222222", active.get().parentSpanId(), "jms batch parent span");
        assertEquals("b7ad6b7169203710", active.get().spanId(), "jms batch child span");
        assertTrue(errorCodes.contains("validation_error"), "malformed batch traceparent reported");

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_jms_batch_process_span_b7ad6b7169203710\"");
        assertContains(payload, "\"name\": \"queue:jms.process_batch\"");
        assertContains(payload, "\"traceId\": \"11111111111111111111111111111111\"");
        assertContains(payload, "\"spanId\": \"b7ad6b7169203710\"");
        assertContains(payload, "\"parentSpanId\": \"2222222222222222\"");
        assertContains(payload, "\"queueSystem\": \"jms\"");
        assertContains(payload, "\"queueOperation\": \"jms.process_batch\"");
        assertContains(payload, "\"queueOperationKind\": \"process\"");
        assertContains(payload, "\"queueName\": \"billing-queue\"");
        assertContains(payload, "\"messageCount\": 4");
        assertContains(payload, "\"timeInQueueMs\": 250.5");
        assertContains(payload, "\"links\": [");
        assertContains(payload, "\"traceId\": \"33333333333333333333333333333333\"");
        assertContains(payload, "\"spanId\": \"4444444444444444\"");
        assertContains(payload, "\"sampled\": false");
        assertContains(payload, "\"traceId\": \"55555555555555555555555555555555\"");
        assertContains(payload, "\"spanId\": \"6666666666666666\"");
        assertContains(payload, "\"sampled\": true");
        assertContains(payload, "\"worker\": \"billing-batch\"");
        assertNotContains(payload, "private batch body");
        assertNotContains(payload, "private headers");
        assertNotContains(payload, "not-a-traceparent");
        assertNotContains(payload, "11111111111111111111111111111111-2222222222222222");
        assertNotContains(payload, "33333333333333333333333333333333-4444444444444444");
        testsRun++;
    }

    private void testPropertyFailuresAreNonFatalDiagnostics() {
        LogBrewClient client = sampleClient();
        FailingJmsMessage message = new FailingJmsMessage();
        List<String> errorCodes = new ArrayList<>();

        try {
            String sendResult = LogBrewJmsTracing.send(
                client,
                message,
                () -> "sent",
                LogBrewJmsTracing.ProducerConfig.create()
                    .eventIdPrefix("java_jms_write_failure")
                    .spanId("b7ad6b7169203702")
                    .onError(error -> errorCodes.add(error.code()))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:10.000Z"),
                        Instant.parse("2026-06-02T10:00:10.010Z")
                    )
            );
            String processResult = LogBrewJmsTracing.process(
                client,
                message,
                () -> "processed",
                LogBrewJmsTracing.ConsumerConfig.create()
                    .eventIdPrefix("java_jms_read_failure")
                    .spanId("b7ad6b7169203703")
                    .onError(error -> errorCodes.add(error.code()))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:11.000Z"),
                        Instant.parse("2026-06-02T10:00:11.010Z")
                    )
            );
            assertEquals("sent", sendResult, "jms send with property failure result");
            assertEquals("processed", processResult, "jms process with property failure result");
        } catch (Exception error) {
            throw new AssertionError(error);
        }

        assertTrue(errorCodes.contains("jms_property_write_failed"), "write failure reported");
        assertTrue(errorCodes.contains("jms_property_read_failed"), "read failure reported");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_jms_write_failure_span_b7ad6b7169203702\"");
        assertContains(payload, "\"id\": \"java_jms_read_failure_span_b7ad6b7169203703\"");
        assertNotContains(payload, "private setter failure");
        assertNotContains(payload, "private getter failure");
        assertNotContains(payload, "traceparent");
        testsRun++;
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    public static final class FakeJmsMessage {
        private final Map<String, String> properties = new LinkedHashMap<>();

        public void setStringProperty(String name, String value) {
            properties.put(name, value);
        }

        public String getStringProperty(String name) {
            return properties.get(name);
        }

        public Map<String, String> properties() {
            return properties;
        }
    }

    public static final class FailingJmsMessage {
        public void setStringProperty(String name, String value) {
            throw new IllegalStateException("private setter failure");
        }

        public String getStringProperty(String name) {
            throw new IllegalStateException("private getter failure");
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

    private static void assertEquals(String expected, String actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }
}
