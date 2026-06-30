package co.logbrew.sdk;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.apache.kafka.clients.consumer.Consumer;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.common.header.internals.RecordHeaders;
import org.apache.kafka.common.record.TimestampType;
import org.springframework.kafka.listener.RecordInterceptor;

/**
 * Dependency-free test runner for Spring Kafka tracing helpers.
 */
public final class LogBrewSpringKafkaTracingTest {
    private int testsRun;

    public static void main(String[] args) {
        new LogBrewSpringKafkaTracingTest().run();
    }

    private void run() {
        testRecordInterceptorContinuesTraceDuringListenerAndCapturesSanitizedSpan();
        testRecordInterceptorTreatsMalformedTraceAndListenerFailureAsSafeDiagnostics();
        testRecordInterceptorClearThreadStateFinishesActiveRecordWithOkStatus();
        System.out.println("java spring kafka tracing tests ok (" + testsRun + " tests)");
    }

    private void testRecordInterceptorContinuesTraceDuringListenerAndCapturesSanitizedSpan() {
        LogBrewClient client = sampleClient();
        RecordingInterceptor delegate = new RecordingInterceptor();
        RecordInterceptor<String, String> interceptor = LogBrewSpringKafkaTracing.recordInterceptor(
            client,
            LogBrewSpringKafkaTracing.ConsumerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka")
                .spanId("b7ad6b7169203600")
                .delegate(delegate)
                .metadata(Map.of(
                    "service", "checkout",
                    "messageBody", "private metadata body",
                    "authorization", "se" + "cret metadata to" + "ken"
                ))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:02.000Z"),
                    Instant.parse("2026-06-02T10:00:02.050Z")
                )
        );
        ConsumerRecord<String, String> record = recordWithHeaders();

        ConsumerRecord<String, String> intercepted = interceptor.intercept(record, null);

        assertTrue(intercepted == record, "interceptor returns delegate record");
        assertEquals(1, delegate.intercepts, "delegate intercept called once");
        assertTrue(LogBrewTrace.current().isPresent(), "trace is active for listener processing");
        LogBrewTraceContext active = LogBrewTrace.current().get();
        assertEquals("11111111111111111111111111111111", active.traceId(), "incoming trace id continued");
        assertEquals("2222222222222222", active.parentSpanId(), "incoming parent span id continued");

        interceptor.success(record, null);

        assertEquals(1, delegate.successes, "delegate success called once");
        assertTrue(!LogBrewTrace.current().isPresent(), "trace scope is cleared after success");
        assertEquals(1, client.pendingEvents(), "spring kafka span queued");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_kafka_span_b7ad6b7169203600\"");
        assertContains(payload, "\"name\": \"spring.kafka.process:orders-events\"");
        assertContains(payload, "\"source\": \"spring.kafka.record\"");
        assertContains(payload, "\"traceId\": \"11111111111111111111111111111111\"");
        assertContains(payload, "\"spanId\": \"b7ad6b7169203600\"");
        assertContains(payload, "\"parentSpanId\": \"2222222222222222\"");
        assertContains(payload, "\"durationMs\": 50.0");
        assertContains(payload, "\"framework\": \"spring-kafka\"");
        assertContains(payload, "\"queueSystem\": \"kafka\"");
        assertContains(payload, "\"queueOperation\": \"process\"");
        assertContains(payload, "\"queueName\": \"orders-events\"");
        assertContains(payload, "\"timeInQueueMs\": 2000.0");
        assertContains(payload, "\"service\": \"checkout\"");
        assertNotContains(payload, "private-key");
        assertNotContains(payload, "private value");
        assertNotContains(payload, "se" + "cret-to" + "ken");
        assertNotContains(payload, "private metadata body");
        assertNotContains(payload, "se" + "cret metadata to" + "ken");
        assertNotContains(payload, "authorization");
        assertNotContains(payload, "traceparent");
        assertNotContains(payload, "baggage");
        testsRun++;
    }

    private void testRecordInterceptorTreatsMalformedTraceAndListenerFailureAsSafeDiagnostics() {
        LogBrewClient client = sampleClient();
        List<String> errorCodes = new ArrayList<>();
        RecordInterceptor<String, String> interceptor = LogBrewSpringKafkaTracing.recordInterceptor(
            client,
            LogBrewSpringKafkaTracing.ConsumerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka_failure")
                .spanId("b7ad6b7169203601")
                .onError(error -> errorCodes.add(error.code()))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:04.000Z"),
                    Instant.parse("2026-06-02T10:00:04.025Z")
                )
        );
        ConsumerRecord<String, String> record = malformedRecord();

        interceptor.intercept(record, null);
        RuntimeException listenerFailure = new RuntimeException("private listener failure");
        interceptor.failure(record, listenerFailure, null);

        assertTrue(errorCodes.contains("validation_error"), "malformed traceparent is diagnostic");
        assertTrue(!LogBrewTrace.current().isPresent(), "trace scope is cleared after failure");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_kafka_failure_span_b7ad6b7169203601\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"errorType\": \"RuntimeException\"");
        assertContains(payload, "\"exceptionType\": \"RuntimeException\"");
        assertContains(payload, "\"exceptionEscaped\": true");
        assertNotContains(payload, "not-a-traceparent");
        assertNotContains(payload, "private listener failure");
        assertNotContains(payload, "private value");
        testsRun++;
    }

    private void testRecordInterceptorClearThreadStateFinishesActiveRecordWithOkStatus() {
        LogBrewClient client = sampleClient();
        List<String> errorCodes = new ArrayList<>();
        RecordInterceptor<String, String> interceptor = LogBrewSpringKafkaTracing.recordInterceptor(
            client,
            LogBrewSpringKafkaTracing.ConsumerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka_clear")
                .spanId("b7ad6b7169203602")
                .onError(error -> errorCodes.add(error.code()))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:06.000Z"),
                    Instant.parse("2026-06-02T10:00:06.015Z")
                )
        );
        ConsumerRecord<String, String> record = recordWithHeaders();

        interceptor.intercept(record, null);
        interceptor.clearThreadState(null);

        assertTrue(!LogBrewTrace.current().isPresent(), "trace scope is cleared by Spring Kafka thread-state clear");
        assertTrue(!errorCodes.contains("validation_error"), "clearThreadState does not use invalid span status");
        assertEquals(1, client.pendingEvents(), "clearThreadState queues active spring kafka span");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_kafka_clear_span_b7ad6b7169203602\"");
        assertContains(payload, "\"status\": \"ok\"");
        assertContains(payload, "\"durationMs\": 15.0");
        testsRun++;
    }

    private static ConsumerRecord<String, String> recordWithHeaders() {
        RecordHeaders headers = new RecordHeaders();
        headers.add(
            "traceparent",
            "00-11111111111111111111111111111111-2222222222222222-01".getBytes(StandardCharsets.UTF_8)
        );
        headers.add("authorization", ("se" + "cret-to" + "ken").getBytes(StandardCharsets.UTF_8));
        headers.add("baggage", "private value".getBytes(StandardCharsets.UTF_8));
        return new ConsumerRecord<>(
            "orders-events",
            2,
            91L,
            Instant.parse("2026-06-02T10:00:00Z").toEpochMilli(),
            TimestampType.CREATE_TIME,
            11,
            13,
            "private-key",
            "private value",
            headers,
            Optional.empty()
        );
    }

    private static ConsumerRecord<String, String> malformedRecord() {
        RecordHeaders headers = new RecordHeaders();
        headers.add("traceparent", "not-a-traceparent".getBytes(StandardCharsets.UTF_8));
        return new ConsumerRecord<>(
            "payments-events",
            1,
            37L,
            Instant.parse("2026-06-02T10:00:03Z").toEpochMilli(),
            TimestampType.CREATE_TIME,
            11,
            13,
            "private-key",
            "private value",
            headers,
            Optional.empty()
        );
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static void assertContains(String text, String expected) {
        if (!text.contains(expected)) {
            throw new AssertionError("expected to contain " + expected + " in " + text);
        }
    }

    private static void assertNotContains(String text, String unexpected) {
        if (text.contains(unexpected)) {
            throw new AssertionError("expected not to contain " + unexpected + " in " + text);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private static void assertTrue(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError(label);
        }
    }

    private static final class RecordingInterceptor implements RecordInterceptor<String, String> {
        private int intercepts;
        private int successes;

        @Override
        public ConsumerRecord<String, String> intercept(
            ConsumerRecord<String, String> record,
            Consumer<String, String> consumer
        ) {
            intercepts++;
            return record;
        }

        @Override
        public void success(ConsumerRecord<String, String> record, Consumer<String, String> consumer) {
            successes++;
        }
    }
}
