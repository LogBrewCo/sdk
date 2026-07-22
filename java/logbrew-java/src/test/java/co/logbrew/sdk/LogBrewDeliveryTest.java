package co.logbrew.sdk;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Dependency-free delivery reliability tests for the Java SDK.
 */
public final class LogBrewDeliveryTest {
    private static final String API_KEY = "LOGBREW_API_KEY";
    private int testsRun;

    public static void main(String[] args) throws Exception {
        new LogBrewDeliveryTest().run();
    }

    private void run() throws Exception {
        testDirectAndAggregateResponseAccounting();
        testCountAndSerializedByteBoundsDropNewest();
        testOversizeEventIsRejectedBeforeQueueing();
        testFlushSplitsByEventAndSerializedByteLimits();
        testRetryUsesFrozenBodyAndRetainsLaterCapture();
        testAcceptedPrefixIsAcknowledgedBeforeLaterFailure();
        testConcurrentFlushesSerializeAndDrainLaterWork();
        testTransportReentrantFlushFailsWithoutLosingWork();
        testFailedShutdownReopensAndRetainsWork();
        System.out.println("java delivery tests ok (" + testsRun + " tests)");
    }

    private void testDirectAndAggregateResponseAccounting() {
        TransportResponse accepted = new TransportResponse(202, 1);
        TransportResponse rejected = new TransportResponse(503, 1);

        assertEquals(1, accepted.batches(), "direct accepted batches");
        assertEquals(0, accepted.acceptedEvents(), "direct accepted event count is unknown");
        assertEquals(0, rejected.batches(), "direct rejected batches");
        assertEquals(0, rejected.acceptedEvents(), "direct rejected events");
        assertContains(
            expectSdkException(() -> LogBrewClient.create(API_KEY, "logbrew-java", "0.1.0", 0, 0))
                .detailMessage(),
            "max_queue_size"
        );

        LogBrewClient client = client(DeliveryOptions.builder()
            .maxRetries(0)
            .maxBatchEvents(2)
            .maxBatchBytes(1_000_000)
            .build());
        for (int index = 0; index < 3; index++) {
            enqueueLog(client, "evt_java_accounting_" + index, "accounting");
        }
        TransportResponse aggregate = client.flush(RecordingTransport.alwaysAccept());
        assertEquals(2, aggregate.attempts(), "aggregate accounting attempts");
        assertEquals(2, aggregate.batches(), "aggregate accounting batches");
        assertEquals(3, aggregate.acceptedEvents(), "aggregate accounting events");
        testsRun++;
    }

    private void testCountAndSerializedByteBoundsDropNewest() {
        LogBrewClient probe = client(DeliveryOptions.builder().build());
        enqueueLog(probe, "evt_java_bytes_0", "same-size");
        long eventBytes = probe.pendingEventBytes();

        List<LogBrewClient.EventDrop> drops = new ArrayList<>();
        DeliveryOptions options = DeliveryOptions.builder()
            .maxQueueEvents(10)
            .maxQueueBytes(eventBytes * 2)
            .maxBatchEvents(10)
            .maxBatchBytes(1_000_000)
            .onEventDropped(drops::add)
            .build();
        LogBrewClient client = client(options);

        enqueueLog(client, "evt_java_bytes_0", "same-size");
        enqueueLog(client, "evt_java_bytes_1", "same-size");
        enqueueLog(client, "evt_java_bytes_2", "same-size");

        assertEquals(2, client.pendingEvents(), "byte-bound pending events");
        assertEquals(eventBytes * 2, client.pendingEventBytes(), "byte-bound pending bytes");
        assertEquals(1, client.droppedEvents(), "byte-bound dropped events");
        assertEquals(eventBytes, client.droppedEventBytes(), "byte-bound dropped bytes");
        assertEquals(1, drops.size(), "byte-bound callback count");
        assertEquals("queue_overflow", drops.get(0).reason(), "byte-bound drop reason");
        assertEquals(eventBytes, drops.get(0).serializedBytes(), "byte-bound callback bytes");
        assertNotContains(client.previewJson(), "evt_java_bytes_2");
        testsRun++;
    }

    private void testOversizeEventIsRejectedBeforeQueueing() {
        List<LogBrewClient.EventDrop> drops = new ArrayList<>();
        LogBrewClient client = client(DeliveryOptions.builder()
            .maxQueueEvents(10)
            .maxQueueBytes(1_000_000)
            .maxBatchEvents(10)
            .maxBatchBytes(64)
            .onEventDropped(drops::add)
            .build());

        enqueueLog(client, "evt_java_oversize", "cannot fit in one request");

        assertEquals(0, client.pendingEvents(), "oversize pending events");
        assertEquals(1, client.droppedEvents(), "oversize dropped events");
        assertTrue(client.droppedEventBytes() > 0L, "oversize dropped bytes");
        assertEquals("event_too_large", drops.get(0).reason(), "oversize reason");
        testsRun++;
    }

    private void testFlushSplitsByEventAndSerializedByteLimits() {
        LogBrewClient twoEventProbe = client(DeliveryOptions.builder().build());
        enqueueLog(twoEventProbe, "evt_java_split_0", "split");
        enqueueLog(twoEventProbe, "evt_java_split_1", "split");
        int twoEventBodyBytes = utf8Bytes(twoEventProbe.previewJson());

        LogBrewClient client = client(DeliveryOptions.builder()
            .maxRetries(0)
            .maxQueueEvents(10)
            .maxQueueBytes(1_000_000)
            .maxBatchEvents(2)
            .maxBatchBytes(twoEventBodyBytes)
            .build());
        for (int index = 0; index < 5; index++) {
            enqueueLog(client, "evt_java_split_" + index, "split");
        }
        RecordingTransport transport = RecordingTransport.alwaysAccept();

        TransportResponse response = client.flush(transport);

        assertEquals(202, response.statusCode(), "split status");
        assertEquals(3, response.attempts(), "split total attempts");
        assertEquals(3, response.batches(), "split batches");
        assertEquals(5, response.acceptedEvents(), "split accepted events");
        assertEquals(3, transport.sentBodies().size(), "split request count");
        assertEquals(2, occurrences(transport.sentBodies().get(0), "\"type\": \"log\""), "first split count");
        assertEquals(2, occurrences(transport.sentBodies().get(1), "\"type\": \"log\""), "second split count");
        assertEquals(1, occurrences(transport.sentBodies().get(2), "\"type\": \"log\""), "third split count");
        for (String body : transport.sentBodies()) {
            assertTrue(utf8Bytes(body) <= twoEventBodyBytes, "split byte limit");
        }
        assertEquals(0, client.pendingEvents(), "split pending events");
        assertEquals(0L, client.pendingEventBytes(), "split pending bytes");
        testsRun++;
    }

    private void testRetryUsesFrozenBodyAndRetainsLaterCapture() {
        LogBrewClient client = client(DeliveryOptions.builder().maxRetries(1).build());
        enqueueLog(client, "evt_java_retry_initial", "initial");
        List<String> bodies = new ArrayList<>();
        AtomicInteger calls = new AtomicInteger();
        Transport transport = (apiKey, body) -> {
            bodies.add(body);
            if (calls.incrementAndGet() == 1) {
                enqueueLog(client, "evt_java_retry_later", "later");
                return new TransportResponse(503, 1);
            }
            return new TransportResponse(202, 1);
        };

        TransportResponse response = client.flush(transport);

        assertEquals(2, response.attempts(), "retry attempts");
        assertEquals(2, bodies.size(), "retry body count");
        assertEquals(bodies.get(0), bodies.get(1), "retry body stability");
        assertNotContains(bodies.get(0), "evt_java_retry_later");
        assertEquals(1, client.pendingEvents(), "later capture retained");
        assertContains(client.previewJson(), "evt_java_retry_later");
        testsRun++;
    }

    private void testAcceptedPrefixIsAcknowledgedBeforeLaterFailure() {
        LogBrewClient client = client(DeliveryOptions.builder()
            .maxRetries(0)
            .maxBatchEvents(2)
            .maxBatchBytes(1_000_000)
            .build());
        for (int index = 0; index < 5; index++) {
            enqueueLog(client, "evt_java_prefix_" + index, "prefix");
        }
        RecordingTransport transport = RecordingTransport.scripted(Integer.valueOf(202), Integer.valueOf(400));

        SdkException error = expectSdkException(() -> client.flush(transport));

        assertEquals("transport_error", error.code(), "prefix failure code");
        assertEquals(2, transport.sentBodies().size(), "prefix request count");
        assertEquals(3, client.pendingEvents(), "prefix retained events");
        String pending = client.previewJson();
        assertNotContains(pending, "evt_java_prefix_0");
        assertNotContains(pending, "evt_java_prefix_1");
        assertContains(pending, "evt_java_prefix_2");
        assertContains(pending, "evt_java_prefix_4");
        testsRun++;
    }

    private void testConcurrentFlushesSerializeAndDrainLaterWork() throws Exception {
        LogBrewClient client = client(DeliveryOptions.builder().maxRetries(0).build());
        enqueueLog(client, "evt_java_concurrent_initial", "initial");
        BlockingTransport transport = new BlockingTransport();
        AtomicReference<Throwable> firstFailure = new AtomicReference<>();
        AtomicReference<Throwable> secondFailure = new AtomicReference<>();

        Thread first = new Thread(() -> runFlush(client, transport, firstFailure), "logbrew-flush-first");
        first.start();
        assertTrue(transport.firstRequestEntered.await(5, TimeUnit.SECONDS), "first request entered");
        enqueueLog(client, "evt_java_concurrent_later", "later");

        Thread second = new Thread(() -> runFlush(client, transport, secondFailure), "logbrew-flush-second");
        second.start();
        transport.releaseFirstRequest.countDown();
        first.join(5_000L);
        second.join(5_000L);

        assertTrue(!first.isAlive() && !second.isAlive(), "concurrent flushes completed");
        assertEquals(null, firstFailure.get(), "first flush failure");
        assertEquals(null, secondFailure.get(), "second flush failure");
        assertEquals(1, transport.maxActiveRequests.get(), "serialized active requests");
        assertEquals(2, transport.bodies.size(), "serialized request count");
        assertContains(transport.bodies.get(0), "evt_java_concurrent_initial");
        assertNotContains(transport.bodies.get(0), "evt_java_concurrent_later");
        assertContains(transport.bodies.get(1), "evt_java_concurrent_later");
        assertEquals(0, client.pendingEvents(), "concurrent pending events");
        testsRun++;
    }

    private void testTransportReentrantFlushFailsWithoutLosingWork() {
        LogBrewClient client = client(DeliveryOptions.builder().maxRetries(0).build());
        enqueueLog(client, "evt_java_reentrant", "reentrant");
        AtomicReference<SdkException> nestedFailure = new AtomicReference<>();
        Transport transport = (apiKey, body) -> {
            nestedFailure.set(expectSdkException(() -> client.flush(RecordingTransport.alwaysAccept())));
            return new TransportResponse(202, 1);
        };

        TransportResponse response = client.flush(transport);

        assertEquals(202, response.statusCode(), "reentrant outer status");
        assertEquals("reentrancy_error", nestedFailure.get().code(), "reentrant failure code");
        assertEquals(0, client.pendingEvents(), "reentrant pending events");
        testsRun++;
    }

    private void testFailedShutdownReopensAndRetainsWork() {
        LogBrewClient client = client(DeliveryOptions.builder().maxRetries(0).build());
        enqueueLog(client, "evt_java_shutdown_initial", "initial");

        SdkException failure = expectSdkException(() ->
            client.shutdown(RecordingTransport.scripted(Integer.valueOf(503))));

        assertEquals("transport_error", failure.code(), "failed shutdown code");
        assertTrue(!client.isClosed(), "failed shutdown reopens client");
        assertEquals(1, client.pendingEvents(), "failed shutdown retains work");
        enqueueLog(client, "evt_java_shutdown_recovery", "recovery");

        TransportResponse recovered = client.shutdown(RecordingTransport.alwaysAccept());

        assertEquals(202, recovered.statusCode(), "recovered shutdown status");
        assertEquals(2, recovered.acceptedEvents(), "recovered accepted events");
        assertTrue(client.isClosed(), "recovered shutdown closes client");
        assertEquals(0, client.pendingEvents(), "recovered shutdown pending events");
        testsRun++;
    }

    private static LogBrewClient client(DeliveryOptions options) {
        return LogBrewClient.create(API_KEY, "logbrew-java", "0.1.0", options);
    }

    private static void enqueueLog(LogBrewClient client, String id, String message) {
        client.log(id, "2026-06-02T10:00:03Z", LogAttributes.create(message, "info"));
    }

    private static void runFlush(
        LogBrewClient client,
        Transport transport,
        AtomicReference<Throwable> failure
    ) {
        try {
            client.flush(transport);
        } catch (Throwable error) {
            failure.set(error);
        }
    }

    private static SdkException expectSdkException(Runnable callback) {
        try {
            callback.run();
        } catch (SdkException error) {
            return error;
        }
        throw new AssertionError("expected SdkException");
    }

    private static int utf8Bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }

    private static int occurrences(String value, String needle) {
        int count = 0;
        int cursor = 0;
        while (true) {
            int index = value.indexOf(needle, cursor);
            if (index < 0) {
                return count;
            }
            count++;
            cursor = index + needle.length();
        }
    }

    private static void assertContains(String value, String needle) {
        if (!value.contains(needle)) {
            throw new AssertionError("expected value to contain " + needle);
        }
    }

    private static void assertNotContains(String value, String needle) {
        if (value.contains(needle)) {
            throw new AssertionError("expected value to omit " + needle);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }

    private static void assertTrue(boolean value, String label) {
        if (!value) {
            throw new AssertionError(label);
        }
    }

    private static final class BlockingTransport implements Transport {
        private final CountDownLatch firstRequestEntered = new CountDownLatch(1);
        private final CountDownLatch releaseFirstRequest = new CountDownLatch(1);
        private final AtomicInteger activeRequests = new AtomicInteger();
        private final AtomicInteger maxActiveRequests = new AtomicInteger();
        private final List<String> bodies = Collections.synchronizedList(new ArrayList<>());

        @Override
        public TransportResponse send(String apiKey, String body) throws TransportException {
            int active = activeRequests.incrementAndGet();
            maxActiveRequests.accumulateAndGet(active, Math::max);
            int request = bodies.size();
            bodies.add(body);
            try {
                if (request == 0) {
                    firstRequestEntered.countDown();
                    if (!releaseFirstRequest.await(5, TimeUnit.SECONDS)) {
                        throw new TransportException("transport_timeout", "timed out", false);
                    }
                }
                return new TransportResponse(202, 1);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new TransportException("transport_interrupted", "interrupted", false);
            } finally {
                activeRequests.decrementAndGet();
            }
        }
    }
}
