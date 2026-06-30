package co.logbrew.sdk;

import java.nio.charset.StandardCharsets;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Future;
import org.apache.kafka.clients.consumer.Consumer;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.Callback;
import org.apache.kafka.clients.producer.Producer;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.RecordMetadata;
import org.apache.kafka.common.header.internals.RecordHeaders;
import org.apache.kafka.common.record.TimestampType;
import org.springframework.kafka.core.KafkaOperations;
import org.springframework.kafka.core.ProducerPostProcessor;
import org.springframework.kafka.listener.RecordInterceptor;
import org.springframework.kafka.support.SendResult;

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
        testProducerSendInjectsTraceparentAndCapturesCompletionSpan();
        testProducerSendCapturesFutureFailureWithoutLeakingDetails();
        testProducerSendCapturesSynchronousSendFailureWithoutLeakingDetails();
        testProducerWrapperInjectsTraceparentAndCapturesCallbackSpan();
        testProducerWrapperRethrowsSynchronousSendFailureWithoutLeakingDetails();
        testProducerPostProcessorWrapsAppOwnedProducer();
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

    private void testProducerPostProcessorWrapsAppOwnedProducer() {
        LogBrewClient client = sampleClient();
        RecordingKafkaProducer delegate = new RecordingKafkaProducer();
        ProducerPostProcessor<String, String> postProcessor = LogBrewSpringKafkaTracing.producerPostProcessor(
            client,
            LogBrewSpringKafkaTracing.ProducerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka_post_processor")
                .spanId("b7ad6b7169203607")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:14.000Z"),
                    Instant.parse("2026-06-02T10:00:14.070Z")
                )
        );
        LogBrewTraceContext parent = LogBrewTraceContext.create(
            "33333333333333333333333333333333",
            "4444444444444444"
        );

        Producer<String, String> producer = postProcessor.apply(delegate.proxy());
        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            producer.send(producerRecordWithHeaders());
        } finally {
            scope.close();
        }

        assertTrue(delegate.sentRecord != null, "post processor wrapped producer send is invoked");
        assertEquals("00-33333333333333333333333333333333-b7ad6b7169203607-01", lastTraceparent(delegate.sentRecord.headers()), "post processor producer injects traceparent");
        assertEquals("b7ad6b7169203607", delegate.activeTraceDuringSend.get().spanId(), "post processor producer uses configured child span id");

        delegate.callback.onCompletion(null, null);

        assertEquals(1, client.pendingEvents(), "post processor wrapped producer queues one span");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_kafka_post_processor_span_b7ad6b7169203607\"");
        assertContains(payload, "\"name\": \"spring.kafka.produce:orders-events\"");
        assertContains(payload, "\"traceId\": \"33333333333333333333333333333333\"");
        assertContains(payload, "\"spanId\": \"b7ad6b7169203607\"");
        assertContains(payload, "\"parentSpanId\": \"4444444444444444\"");
        assertContains(payload, "\"durationMs\": 70.0");
        assertNotContains(payload, "private-key");
        assertNotContains(payload, "private value");
        assertNotContains(payload, "traceparent");
        testsRun++;
    }

    private void testProducerSendInjectsTraceparentAndCapturesCompletionSpan() {
        LogBrewClient client = sampleClient();
        CompletableFuture<SendResult<String, String>> future = new CompletableFuture<>();
        RecordingKafkaOperations operations = new RecordingKafkaOperations(future);
        ProducerRecord<String, String> record = producerRecordWithHeaders();
        LogBrewTraceContext parent = LogBrewTraceContext.create(
            "33333333333333333333333333333333",
            "4444444444444444"
        );

        CompletableFuture<SendResult<String, String>> returned;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            returned = LogBrewSpringKafkaTracing.producerSend(
                client,
                operations.proxy(),
                record,
                LogBrewSpringKafkaTracing.ProducerConfig.<String, String>create()
                    .eventIdPrefix("spring_kafka_produce")
                    .spanId("b7ad6b7169203603")
                    .metadata(Map.of(
                        "service", "checkout",
                        "messageBody", "private metadata body",
                        "authorization", "se" + "cret metadata to" + "ken"
                    ))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:08.000Z"),
                        Instant.parse("2026-06-02T10:00:08.040Z")
                    )
            );
        } finally {
            scope.close();
        }

        assertTrue(returned == future, "producer helper returns the app-owned future");
        assertTrue(operations.sentRecord != null, "producer send is invoked");
        assertTrue(operations.sentRecord != record, "producer record is cloned before header injection");
        assertEquals("orders-events", operations.sentRecord.topic(), "topic is preserved");
        assertEquals(Integer.valueOf(2), operations.sentRecord.partition(), "partition is preserved");
        assertEquals(Long.valueOf(Instant.parse("2026-06-02T10:00:07Z").toEpochMilli()), operations.sentRecord.timestamp(), "timestamp is preserved");
        assertEquals("private-key", operations.sentRecord.key(), "key is preserved for the app-owned send call");
        assertEquals("private value", operations.sentRecord.value(), "value is preserved for the app-owned send call");
        assertEquals("00-33333333333333333333333333333333-b7ad6b7169203603-01", lastTraceparent(operations.sentRecord.headers()), "traceparent is injected");
        assertEquals(1, countTraceparentHeaders(operations.sentRecord.headers()), "producer record has exactly one traceparent header");
        assertEquals("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01", lastTraceparent(record.headers()), "original record headers are not mutated");
        assertEquals("33333333333333333333333333333333", operations.activeTraceDuringSend.get().traceId(), "send runs with the child trace active");
        assertEquals("b7ad6b7169203603", operations.activeTraceDuringSend.get().spanId(), "send uses configured child span id");

        future.complete(null);

        assertEquals(1, client.pendingEvents(), "producer completion queues one span");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_kafka_produce_span_b7ad6b7169203603\"");
        assertContains(payload, "\"name\": \"spring.kafka.produce:orders-events\"");
        assertContains(payload, "\"source\": \"spring.kafka.producer\"");
        assertContains(payload, "\"traceId\": \"33333333333333333333333333333333\"");
        assertContains(payload, "\"spanId\": \"b7ad6b7169203603\"");
        assertContains(payload, "\"parentSpanId\": \"4444444444444444\"");
        assertContains(payload, "\"durationMs\": 40.0");
        assertContains(payload, "\"framework\": \"spring-kafka\"");
        assertContains(payload, "\"queueSystem\": \"kafka\"");
        assertContains(payload, "\"queueOperation\": \"produce\"");
        assertContains(payload, "\"queueName\": \"orders-events\"");
        assertContains(payload, "\"service\": \"checkout\"");
        assertNotContains(payload, "private-key");
        assertNotContains(payload, "private value");
        assertNotContains(payload, "private metadata body");
        assertNotContains(payload, "se" + "cret metadata to" + "ken");
        assertNotContains(payload, "authorization");
        assertNotContains(payload, "traceparent");
        assertNotContains(payload, "baggage");
        testsRun++;
    }

    private void testProducerSendCapturesFutureFailureWithoutLeakingDetails() {
        LogBrewClient client = sampleClient();
        CompletableFuture<SendResult<String, String>> future = new CompletableFuture<>();
        RecordingKafkaOperations operations = new RecordingKafkaOperations(future);
        ProducerRecord<String, String> record = producerRecordWithHeaders();

        LogBrewSpringKafkaTracing.producerSend(
            client,
            operations.proxy(),
            record,
            LogBrewSpringKafkaTracing.ProducerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka_produce_failure")
                .spanId("b7ad6b7169203604")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:10.000Z"),
                    Instant.parse("2026-06-02T10:00:10.020Z")
                )
        );
        future.completeExceptionally(new RuntimeException("private broker failure"));

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_kafka_produce_failure_span_b7ad6b7169203604\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"errorType\": \"RuntimeException\"");
        assertContains(payload, "\"exceptionType\": \"RuntimeException\"");
        assertContains(payload, "\"exceptionEscaped\": true");
        assertNotContains(payload, "private broker failure");
        assertNotContains(payload, "private-key");
        assertNotContains(payload, "private value");
        testsRun++;
    }

    private void testProducerSendCapturesSynchronousSendFailureWithoutLeakingDetails() {
        LogBrewClient client = sampleClient();
        RuntimeException failure = new RuntimeException("private producer send failure");
        RecordingKafkaOperations operations = new RecordingKafkaOperations(new CompletableFuture<>(), failure);
        ProducerRecord<String, String> record = producerRecordWithHeaders();

        CompletableFuture<SendResult<String, String>> returned = LogBrewSpringKafkaTracing.producerSend(
            client,
            operations.proxy(),
            record,
            LogBrewSpringKafkaTracing.ProducerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka_produce_throw")
                .spanId("b7ad6b7169203605")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:11.000Z"),
                    Instant.parse("2026-06-02T10:00:11.010Z")
                )
        );

        assertTrue(returned.isCompletedExceptionally(), "producer helper returns a failed future for send failure");

        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_kafka_produce_throw_span_b7ad6b7169203605\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"errorType\": \"RuntimeException\"");
        assertContains(payload, "\"exceptionType\": \"RuntimeException\"");
        assertNotContains(payload, "private producer send failure");
        assertNotContains(payload, "private-key");
        assertNotContains(payload, "private value");
        testsRun++;
    }

    private void testProducerWrapperInjectsTraceparentAndCapturesCallbackSpan() {
        LogBrewClient client = sampleClient();
        RecordingKafkaProducer delegate = new RecordingKafkaProducer();
        ProducerRecord<String, String> record = producerRecordWithHeaders();
        List<Optional<LogBrewTraceContext>> callbackTrace = new ArrayList<>();
        Callback callback = (metadata, exception) -> callbackTrace.add(LogBrewTrace.current());
        LogBrewTraceContext parent = LogBrewTraceContext.create(
            "33333333333333333333333333333333",
            "4444444444444444"
        );

        Producer<String, String> producer = LogBrewSpringKafkaTracing.producer(
            client,
            delegate.proxy(),
            LogBrewSpringKafkaTracing.ProducerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka_wrap")
                .spanId("b7ad6b7169203606")
                .metadata(Map.of(
                    "service", "checkout",
                    "messageBody", "private metadata body",
                    "authorization", "se" + "cret metadata to" + "ken"
                ))
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:12.000Z"),
                    Instant.parse("2026-06-02T10:00:12.060Z")
                )
        );

        Future<RecordMetadata> returned;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            returned = producer.send(record, callback);
        } finally {
            scope.close();
        }

        assertTrue(returned == delegate.future, "producer wrapper returns the app-owned future");
        assertTrue(delegate.sentRecord != null, "wrapped producer send is invoked");
        assertTrue(delegate.sentRecord != record, "wrapped producer clones the record before header injection");
        assertEquals("orders-events", delegate.sentRecord.topic(), "wrapped producer topic is preserved");
        assertEquals(Integer.valueOf(2), delegate.sentRecord.partition(), "wrapped producer partition is preserved");
        assertEquals(Long.valueOf(Instant.parse("2026-06-02T10:00:07Z").toEpochMilli()), delegate.sentRecord.timestamp(), "wrapped producer timestamp is preserved");
        assertEquals("private-key", delegate.sentRecord.key(), "wrapped producer key is preserved for the app-owned send call");
        assertEquals("private value", delegate.sentRecord.value(), "wrapped producer value is preserved for the app-owned send call");
        assertEquals("00-33333333333333333333333333333333-b7ad6b7169203606-01", lastTraceparent(delegate.sentRecord.headers()), "wrapped producer traceparent is injected");
        assertEquals(1, countTraceparentHeaders(delegate.sentRecord.headers()), "wrapped producer has exactly one traceparent header");
        assertEquals("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01", lastTraceparent(record.headers()), "wrapped producer does not mutate original headers");
        assertEquals("33333333333333333333333333333333", delegate.activeTraceDuringSend.get().traceId(), "wrapped send runs with child trace active");
        assertEquals("b7ad6b7169203606", delegate.activeTraceDuringSend.get().spanId(), "wrapped send uses configured child span id");

        delegate.callback.onCompletion(null, null);

        assertEquals(1, callbackTrace.size(), "user callback is invoked");
        assertTrue(callbackTrace.get(0).isPresent(), "user callback runs with the child trace active");
        assertEquals("b7ad6b7169203606", callbackTrace.get(0).get().spanId(), "callback uses wrapped producer child span");
        assertEquals(1, client.pendingEvents(), "wrapped producer callback queues one span");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_kafka_wrap_span_b7ad6b7169203606\"");
        assertContains(payload, "\"name\": \"spring.kafka.produce:orders-events\"");
        assertContains(payload, "\"source\": \"spring.kafka.producer\"");
        assertContains(payload, "\"traceId\": \"33333333333333333333333333333333\"");
        assertContains(payload, "\"spanId\": \"b7ad6b7169203606\"");
        assertContains(payload, "\"parentSpanId\": \"4444444444444444\"");
        assertContains(payload, "\"durationMs\": 60.0");
        assertContains(payload, "\"framework\": \"spring-kafka\"");
        assertContains(payload, "\"queueSystem\": \"kafka\"");
        assertContains(payload, "\"queueOperation\": \"produce\"");
        assertContains(payload, "\"queueName\": \"orders-events\"");
        assertContains(payload, "\"service\": \"checkout\"");
        assertNotContains(payload, "private-key");
        assertNotContains(payload, "private value");
        assertNotContains(payload, "private metadata body");
        assertNotContains(payload, "se" + "cret metadata to" + "ken");
        assertNotContains(payload, "authorization");
        assertNotContains(payload, "traceparent");
        assertNotContains(payload, "baggage");
        testsRun++;
    }

    private void testProducerWrapperRethrowsSynchronousSendFailureWithoutLeakingDetails() {
        LogBrewClient client = sampleClient();
        RuntimeException failure = new RuntimeException("private wrapped producer failure");
        RecordingKafkaProducer delegate = new RecordingKafkaProducer(failure);
        ProducerRecord<String, String> record = producerRecordWithHeaders();
        Producer<String, String> producer = LogBrewSpringKafkaTracing.producer(
            client,
            delegate.proxy(),
            LogBrewSpringKafkaTracing.ProducerConfig.<String, String>create()
                .eventIdPrefix("spring_kafka_wrap_throw")
                .spanId("b7ad6b7169203608")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:15.000Z"),
                    Instant.parse("2026-06-02T10:00:15.010Z")
                )
        );

        RuntimeException thrown = null;
        try {
            producer.send(record);
        } catch (RuntimeException error) {
            thrown = error;
        }

        assertTrue(thrown == failure, "wrapped producer rethrows the app-owned send failure");
        assertTrue(!LogBrewTrace.current().isPresent(), "wrapped producer clears trace scope after send failure");
        assertEquals(0, client.pendingEvents(), "wrapped producer does not emit completion span before Kafka accepts the send");
        String payload = client.previewJson();
        assertNotContains(payload, "private wrapped producer failure");
        assertNotContains(payload, "private-key");
        assertNotContains(payload, "private value");
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

    private static ProducerRecord<String, String> producerRecordWithHeaders() {
        RecordHeaders headers = new RecordHeaders();
        headers.add(
            "traceparent",
            "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01".getBytes(StandardCharsets.UTF_8)
        );
        headers.add("authorization", ("se" + "cret-to" + "ken").getBytes(StandardCharsets.UTF_8));
        headers.add("baggage", "private value".getBytes(StandardCharsets.UTF_8));
        return new ProducerRecord<>(
            "orders-events",
            2,
            Instant.parse("2026-06-02T10:00:07Z").toEpochMilli(),
            "private-key",
            "private value",
            headers
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

    private static String lastTraceparent(Iterable<org.apache.kafka.common.header.Header> headers) {
        org.apache.kafka.common.header.Header found = null;
        for (org.apache.kafka.common.header.Header header : headers) {
            if ("traceparent".equals(header.key())) {
                found = header;
            }
        }
        return found == null ? null : new String(found.value(), StandardCharsets.UTF_8);
    }

    private static int countTraceparentHeaders(Iterable<org.apache.kafka.common.header.Header> headers) {
        int count = 0;
        for (org.apache.kafka.common.header.Header header : headers) {
            if ("traceparent".equals(header.key())) {
                count++;
            }
        }
        return count;
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

    private static final class RecordingKafkaOperations implements InvocationHandler {
        private final CompletableFuture<SendResult<String, String>> future;
        private final RuntimeException sendFailure;
        private ProducerRecord<String, String> sentRecord;
        private Optional<LogBrewTraceContext> activeTraceDuringSend = Optional.empty();

        private RecordingKafkaOperations(CompletableFuture<SendResult<String, String>> future) {
            this(future, null);
        }

        private RecordingKafkaOperations(
            CompletableFuture<SendResult<String, String>> future,
            RuntimeException sendFailure
        ) {
            this.future = future;
            this.sendFailure = sendFailure;
        }

        @SuppressWarnings("unchecked")
        private KafkaOperations<String, String> proxy() {
            return (KafkaOperations<String, String>) Proxy.newProxyInstance(
                KafkaOperations.class.getClassLoader(),
                new Class<?>[] {KafkaOperations.class},
                this
            );
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            if ("send".equals(method.getName()) && args != null && args.length == 1 && args[0] instanceof ProducerRecord) {
                @SuppressWarnings("unchecked")
                ProducerRecord<String, String> record = (ProducerRecord<String, String>) args[0];
                sentRecord = record;
                activeTraceDuringSend = LogBrewTrace.current();
                if (sendFailure != null) {
                    throw sendFailure;
                }
                return future;
            }
            throw new UnsupportedOperationException(method.getName());
        }
    }

    private static final class RecordingKafkaProducer implements InvocationHandler {
        private final CompletableFuture<RecordMetadata> future = new CompletableFuture<>();
        private final RuntimeException sendFailure;
        private ProducerRecord<String, String> sentRecord;
        private Callback callback;
        private Optional<LogBrewTraceContext> activeTraceDuringSend = Optional.empty();

        private RecordingKafkaProducer() {
            this(null);
        }

        private RecordingKafkaProducer(RuntimeException sendFailure) {
            this.sendFailure = sendFailure;
        }

        @SuppressWarnings("unchecked")
        private Producer<String, String> proxy() {
            return (Producer<String, String>) Proxy.newProxyInstance(
                Producer.class.getClassLoader(),
                new Class<?>[] {Producer.class},
                this
            );
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) {
            if ("send".equals(method.getName()) && args != null && args.length == 2 && args[0] instanceof ProducerRecord) {
                @SuppressWarnings("unchecked")
                ProducerRecord<String, String> record = (ProducerRecord<String, String>) args[0];
                sentRecord = record;
                callback = (Callback) args[1];
                activeTraceDuringSend = LogBrewTrace.current();
                if (sendFailure != null) {
                    throw sendFailure;
                }
                return future;
            }
            if ("toString".equals(method.getName())) {
                return "RecordingKafkaProducer";
            }
            if ("close".equals(method.getName()) || "flush".equals(method.getName())) {
                return null;
            }
            throw new UnsupportedOperationException(method.getName());
        }
    }
}
