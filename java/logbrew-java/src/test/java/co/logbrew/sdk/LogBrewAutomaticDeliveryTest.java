package co.logbrew.sdk;

import java.time.Duration;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/**
 * Dependency-free automatic delivery lifecycle tests for the Java SDK.
 */
public final class LogBrewAutomaticDeliveryTest {
    private static final String API_KEY = "LOGBREW_API_KEY";
    private int testsRun;

    public static void main(String[] args) throws Exception {
        new LogBrewAutomaticDeliveryTest().run();
    }

    private void run() throws Exception {
        testFirstEventDeliversWithoutManualFlush();
        testThresholdPreemptsIntervalAndCoalescesDuringFlight();
        testRetryKeepsFrozenPrefixAndLaterWork();
        testCaptureDuringBackoffCannotPreemptRetryDelay();
        testTerminalOutcomesPauseUntilExplicitRecovery();
        testMalformedTransportPausesWithoutLeakingDetails();
        testRuntimeTransportFailureIsStableAndPrivate();
        testPersistentRecoverySchedulesHydratedWork();
        testShutdownInvalidatesStaleWakeAndRejectsMutation();
        testConcurrentAutomaticDeliveryAndShutdownSerialize();
        testFailedShutdownRetainsWorkForExplicitRecovery();
        testRetryBudgetPausesWithoutHotLooping();
        testReentrantShutdownFailsWithoutLosingOuterDelivery();
        testProcessOwnershipFailsClosed();
        testQueueDropAndHealthSurfaceStayContentFree();
        testSchedulerFailureDoesNotEscapeCapture();
        testAutomaticOptionsAndDefaultFactoryStayBounded();
        testExplicitManualAPIsOwnAutomaticSchedulerLifecycle();
        testShutdownHealthStaysClosingThroughOverlappingDrain();
        testRetryFailureCounterIsExact();
        testSchedulerTerminationEscalates();
        testSchedulerTerminationFailureDoesNotRewriteAcceptedShutdown();
        testManualClientDefaultsRemainCallerDriven();
        System.out.println("java automatic delivery tests ok (" + testsRun + " tests)");
    }

    private void testFirstEventDeliversWithoutManualFlush() throws Exception {
        CountDownLatch delivered = new CountDownLatch(1);
        RecordingTransport recording = RecordingTransport.alwaysAccept();
        Transport transport = (apiKey, body) -> {
            TransportResponse response = recording.send(apiKey, body);
            delivered.countDown();
            return response;
        };
        LogBrewClient client = LogBrewClient.createAutomatic(
            API_KEY,
            "logbrew-java",
            "0.1.0",
            transport,
            DeliveryOptions.builder().maxRetries(0).build(),
            AutomaticDeliveryOptions.builder()
                .flushInterval(Duration.ofMillis(20))
                .queueThreshold(10)
                .build()
        );

        client.log(
            "evt_java_automatic_first",
            "2026-06-02T10:00:03Z",
            LogAttributes.create("first automatic event", "info")
        );

        assertTrue(delivered.await(5, TimeUnit.SECONDS), "first automatic delivery");
        DeliveryHealth health = awaitAccepted(client, 1L);
        assertEquals(DeliveryHealth.Lifecycle.OPEN, health.lifecycle(), "open lifecycle");
        assertEquals(DeliveryHealth.Outcome.ACCEPTED, health.lastOutcome(), "accepted outcome");
        assertEquals(1L, health.acceptedEvents(), "accepted event count");
        assertEquals(0, health.queuedEvents(), "drained queue");
        client.shutdown();
        testsRun++;
    }

    private void testThresholdPreemptsIntervalAndCoalescesDuringFlight() throws Exception {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        BlockingTransport transport = new BlockingTransport();
        LogBrewClient client = automaticClient(
            transport,
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(2),
            schedulers,
            () -> true
        );

        enqueueLog(client, "evt_java_threshold_1", "first");
        assertEquals(1, schedulers.creations(), "one lazy scheduler");
        assertEquals(1_000L, schedulers.scheduler().nextDelayMillis(), "interval delay");
        ManualTask staleInterval = schedulers.scheduler().nextTask();
        enqueueLog(client, "evt_java_threshold_2", "second");
        assertTrue(staleInterval.cancelled(), "threshold cancels interval");
        assertEquals(0L, schedulers.scheduler().nextDelayMillis(), "threshold delay");

        AtomicReference<Throwable> workerFailure = new AtomicReference<>();
        Thread worker = new Thread(
            () -> schedulers.scheduler().runNext(workerFailure),
            "automatic-test-worker"
        );
        worker.start();
        assertTrue(transport.entered.await(5, TimeUnit.SECONDS), "automatic request entered");
        enqueueLog(client, "evt_java_threshold_later", "later");
        assertTrue(client.deliveryHealth().wakeCoalesced(), "in-flight wake coalesced");
        transport.release.countDown();
        worker.join(5_000L);
        assertEquals(null, workerFailure.get(), "automatic worker failure");
        assertEquals(1, transport.maxActive.get(), "single active delivery");
        assertEquals(0L, schedulers.scheduler().nextDelayMillis(), "coalesced trailing delay");
        schedulers.scheduler().runNext();
        assertEquals(2, transport.bodies.size(), "coalesced request count");
        assertContains(transport.bodies.get(0), "evt_java_threshold_1");
        assertContains(transport.bodies.get(0), "evt_java_threshold_2");
        assertNotContains(transport.bodies.get(0), "evt_java_threshold_later");
        assertContains(transport.bodies.get(1), "evt_java_threshold_later");
        client.shutdown();
        testsRun++;
    }

    private void testRetryKeepsFrozenPrefixAndLaterWork() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        List<String> bodies = new ArrayList<>();
        AtomicInteger calls = new AtomicInteger();
        AtomicReference<LogBrewClient> clientRef = new AtomicReference<>();
        Transport transport = (apiKey, body) -> {
            bodies.add(body);
            int call = calls.incrementAndGet();
            if (call == 1) {
                enqueueLog(clientRef.get(), "evt_java_retry_later", "later");
                return new TransportResponse(503, 1);
            }
            return new TransportResponse(202, 1);
        };
        LogBrewClient client = automaticClient(
            transport,
            DeliveryOptions.builder().maxRetries(0).maxBatchEvents(10).build(),
            AutomaticDeliveryOptions.builder()
                .flushInterval(Duration.ofSeconds(1))
                .queueThreshold(1)
                .initialRetryDelay(Duration.ofMillis(10))
                .maxRetryDelay(Duration.ofMillis(40))
                .maxRetryAttempts(2)
                .build(),
            schedulers,
            () -> true
        );
        clientRef.set(client);
        enqueueLog(client, "evt_java_retry_initial", "initial");

        schedulers.scheduler().runNext();
        DeliveryHealth retrying = client.deliveryHealth();
        assertEquals(DeliveryHealth.Activity.RETRYING, retrying.activity(), "retry activity");
        assertEquals(DeliveryHealth.Outcome.RETRYABLE_FAILURE, retrying.lastOutcome(), "retry outcome");
        assertEquals(10L, retrying.scheduledDelayMillis(), "bounded retry delay");
        assertEquals(2, retrying.queuedEvents(), "retry queue includes later work");
        schedulers.scheduler().runNext();

        assertEquals(bodies.get(0), bodies.get(1), "byte-identical failed prefix retry");
        assertNotContains(bodies.get(1), "evt_java_retry_later");
        assertEquals(0L, schedulers.scheduler().nextDelayMillis(), "later capture retained");
        schedulers.scheduler().runNext();
        assertContains(bodies.get(2), "evt_java_retry_later");
        DeliveryHealth accepted = client.deliveryHealth();
        assertEquals(2L, accepted.acceptedEvents(), "accepted retry and later events");
        assertEquals(2L, accepted.acceptedBatches(), "accepted retry and later batches");
        assertEquals(3L, accepted.transportAttempts(), "transport attempt count");
        client.shutdown();
        testsRun++;
    }

    private void testTerminalOutcomesPauseUntilExplicitRecovery() {
        assertTerminalPause(401, DeliveryHealth.PauseReason.AUTHENTICATION);
        assertTerminalPause(429, DeliveryHealth.PauseReason.QUOTA);
        assertTerminalPause(400, DeliveryHealth.PauseReason.NON_RETRYABLE);
        testsRun++;
    }

    private void testCaptureDuringBackoffCannotPreemptRetryDelay() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        List<String> bodies = new ArrayList<>();
        AtomicInteger calls = new AtomicInteger();
        LogBrewClient client = automaticClient(
            (apiKey, body) -> {
                bodies.add(body);
                return new TransportResponse(calls.incrementAndGet() == 1 ? 503 : 202, 1);
            },
            DeliveryOptions.builder().maxRetries(0).build(),
            AutomaticDeliveryOptions.builder()
                .flushInterval(Duration.ofSeconds(1))
                .queueThreshold(10)
                .initialRetryDelay(Duration.ofMillis(20))
                .maxRetryDelay(Duration.ofMillis(20))
                .maxRetryAttempts(2)
                .build(),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_backoff_initial", "initial");
        schedulers.scheduler().runNext();
        ManualTask retry = schedulers.scheduler().nextTask();
        assertEquals(20L, retry.delayMillis, "retry delay before later capture");

        enqueueLog(client, "evt_java_backoff_later", "later");

        assertTrue(!retry.cancelled(), "later capture preserves retry wake");
        assertEquals(1, schedulers.scheduler().pendingTasks(), "one retry wake remains");
        assertEquals(20L, schedulers.scheduler().nextDelayMillis(), "later capture cannot preempt backoff");
        schedulers.scheduler().runNext();
        assertEquals(bodies.get(0), bodies.get(1), "backoff retry body identity");
        assertNotContains(bodies.get(1), "evt_java_backoff_later");
        assertEquals(0L, schedulers.scheduler().nextDelayMillis(), "coalesced later send after success");
        schedulers.scheduler().runNext();
        assertContains(bodies.get(2), "evt_java_backoff_later");
        client.shutdown();
        testsRun++;
    }

    private void testMalformedTransportPausesWithoutLeakingDetails() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        LogBrewClient client = automaticClient(
            (apiKey, body) -> null,
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(1),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_malformed", "private-body-marker");
        schedulers.scheduler().runNext();
        DeliveryHealth health = client.deliveryHealth();
        assertEquals(DeliveryHealth.Activity.PAUSED, health.activity(), "malformed pause activity");
        assertEquals(DeliveryHealth.PauseReason.NON_RETRYABLE, health.pauseReason(), "malformed pause reason");
        assertEquals(1, health.queuedEvents(), "malformed retained queue");
        assertHealthPrivacy(health, "private-body-marker");
        expectSdkException(client::shutdown);
        testsRun++;
    }

    private void testPersistentRecoverySchedulesHydratedWork() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-auto-persist");
        byte[] key = key(31);
        try {
            ManualSchedulerFactory firstSchedulers = new ManualSchedulerFactory();
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient first = automaticClient(
                    RecordingTransport.alwaysAccept(),
                    DeliveryOptions.builder().encryptedEventStore(store).build(),
                    automaticOptions(10),
                    firstSchedulers,
                    () -> true
                );
                first.recoverPersistedEvents();
                enqueueLog(first, "evt_java_hydrated", "restart");
                assertEquals(1, first.deliveryHealth().queuedEvents(), "persisted pre-restart queue");
            }

            ManualSchedulerFactory secondSchedulers = new ManualSchedulerFactory();
            RecordingTransport recoveredTransport = RecordingTransport.alwaysAccept();
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient second = automaticClient(
                    recoveredTransport,
                    DeliveryOptions.builder().encryptedEventStore(store).build(),
                    automaticOptions(10),
                    secondSchedulers,
                    () -> true
                );
                PersistenceStatus recovered = second.recoverPersistedEvents();
                assertEquals(1, recovered.pendingEvents(), "hydrated persisted count");
                assertEquals(1, second.deliveryHealth().queuedEvents(), "hydrated health count");
                assertEquals(1_000L, secondSchedulers.scheduler().nextDelayMillis(), "hydrated interval");
                secondSchedulers.scheduler().runNext();
                assertContains(recoveredTransport.sentBodies().get(0), "evt_java_hydrated");
                assertEquals(0, second.persistenceStatus().pendingEvents(), "hydrated durable drain");
                second.shutdown();
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testRuntimeTransportFailureIsStableAndPrivate() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        String privateFailure = "private runtime transport detail";
        Transport transport = (apiKey, body) -> {
            throw new IllegalStateException(privateFailure);
        };
        LogBrewClient client = automaticClient(
            transport,
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(1),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_runtime_failure", "runtime-private-message");
        schedulers.scheduler().runNext();

        SdkException failure = expectSdkException(() -> client.flush(transport));
        assertEquals("transport_error", failure.code(), "runtime failure code");
        assertNotContains(failure.detailMessage(), privateFailure);
        assertHealthPrivacy(client.deliveryHealth(), privateFailure);
        assertHealthPrivacy(client.deliveryHealth(), "runtime-private-message");
        testsRun++;
    }

    private void testShutdownInvalidatesStaleWakeAndRejectsMutation() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        RecordingTransport transport = RecordingTransport.alwaysAccept();
        LogBrewClient client = automaticClient(
            transport,
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(10),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_shutdown", "shutdown");
        ManualTask stale = schedulers.scheduler().nextTask();

        TransportResponse response = client.shutdown();

        assertEquals(1, response.acceptedEvents(), "shutdown accepted events");
        assertEquals(DeliveryHealth.Lifecycle.CLOSED, client.deliveryHealth().lifecycle(), "closed health");
        assertTrue(schedulers.scheduler().shutdown, "scheduler shut down");
        stale.runEvenIfCancelled();
        assertEquals(1, transport.sentBodies().size(), "stale wake sends nothing");
        assertEquals("shutdown_error", expectSdkException(() -> enqueueLog(
            client,
            "evt_java_shutdown_late",
            "late"
        )).code(), "post-shutdown capture");
        testsRun++;
    }

    private void testConcurrentAutomaticDeliveryAndShutdownSerialize() throws Exception {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        BlockingTransport transport = new BlockingTransport();
        LogBrewClient client = automaticClient(
            transport,
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(1),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_shutdown_initial", "initial");
        AtomicReference<Throwable> workerFailure = new AtomicReference<>();
        Thread worker = new Thread(
            () -> schedulers.scheduler().runNext(workerFailure),
            "automatic-shutdown-worker"
        );
        worker.start();
        assertTrue(transport.entered.await(5, TimeUnit.SECONDS), "shutdown worker entered");

        AtomicReference<Throwable> shutdownFailure = new AtomicReference<>();
        Thread shutdown = new Thread(() -> {
            try {
                client.shutdown();
            } catch (Throwable error) {
                shutdownFailure.set(error);
            }
        }, "automatic-shutdown-caller");
        shutdown.start();
        awaitTrue(() -> client.deliveryHealth().activity() == DeliveryHealth.Activity.IN_FLIGHT);
        enqueueLog(client, "evt_java_shutdown_later", "later");
        transport.release.countDown();
        worker.join(5_000L);
        shutdown.join(5_000L);

        assertEquals(null, workerFailure.get(), "shutdown worker failure");
        assertEquals(null, shutdownFailure.get(), "shutdown caller failure");
        assertTrue(!worker.isAlive() && !shutdown.isAlive(), "shutdown threads complete");
        assertEquals(1, transport.maxActive.get(), "shutdown remains serialized");
        assertEquals(2, transport.bodies.size(), "shutdown drains later capture once");
        assertNotContains(transport.bodies.get(0), "evt_java_shutdown_later");
        assertContains(transport.bodies.get(1), "evt_java_shutdown_later");
        assertEquals(DeliveryHealth.Lifecycle.CLOSED, client.deliveryHealth().lifecycle(), "shutdown lifecycle");
        testsRun++;
    }

    private void testFailedShutdownRetainsWorkForExplicitRecovery() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        AtomicInteger status = new AtomicInteger(503);
        LogBrewClient client = automaticClient(
            (apiKey, body) -> new TransportResponse(status.get(), 1),
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(10),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_failed_shutdown", "retain");

        assertEquals("transport_error", expectSdkException(client::shutdown).code(), "failed shutdown code");
        DeliveryHealth failed = client.deliveryHealth();
        assertEquals(DeliveryHealth.Lifecycle.OPEN, failed.lifecycle(), "failed shutdown reopens");
        assertEquals(DeliveryHealth.Activity.PAUSED, failed.activity(), "failed shutdown pauses");
        assertEquals(1, failed.queuedEvents(), "failed shutdown retains work");
        status.set(202);
        client.resumeAutomaticDelivery();
        schedulers.scheduler().runNext();
        assertEquals(0, client.deliveryHealth().queuedEvents(), "failed shutdown recovered");
        client.shutdown();
        testsRun++;
    }

    private void testRetryBudgetPausesWithoutHotLooping() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        AtomicInteger calls = new AtomicInteger();
        LogBrewClient client = automaticClient(
            (apiKey, body) -> {
                calls.incrementAndGet();
                return new TransportResponse(503, 1);
            },
            DeliveryOptions.builder().maxRetries(0).build(),
            AutomaticDeliveryOptions.builder()
                .flushInterval(Duration.ofSeconds(1))
                .queueThreshold(1)
                .initialRetryDelay(Duration.ofMillis(4))
                .maxRetryDelay(Duration.ofMillis(8))
                .maxRetryAttempts(2)
                .build(),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_retry_exhausted", "retry");

        schedulers.scheduler().runNext();
        assertEquals(4L, schedulers.scheduler().nextDelayMillis(), "first retry delay");
        schedulers.scheduler().runNext();
        assertEquals(8L, schedulers.scheduler().nextDelayMillis(), "second retry delay");
        schedulers.scheduler().runNext();

        DeliveryHealth health = client.deliveryHealth();
        assertEquals(3, calls.get(), "stable retry attempt count");
        assertEquals(DeliveryHealth.Activity.PAUSED, health.activity(), "retry exhausted pause");
        assertEquals(DeliveryHealth.PauseReason.RETRY_EXHAUSTED, health.pauseReason(), "retry exhausted reason");
        assertEquals(0, schedulers.scheduler().pendingTasks(), "retry exhausted no hot loop");
        assertEquals(1, health.queuedEvents(), "retry exhausted retains prefix");
        expectSdkException(client::shutdown);
        testsRun++;
    }

    private void testReentrantShutdownFailsWithoutLosingOuterDelivery() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        AtomicReference<LogBrewClient> clientRef = new AtomicReference<>();
        AtomicReference<SdkException> nested = new AtomicReference<>();
        Transport transport = (apiKey, body) -> {
            nested.set(expectSdkException(clientRef.get()::shutdown));
            return new TransportResponse(202, 1);
        };
        LogBrewClient client = automaticClient(
            transport,
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(1),
            schedulers,
            () -> true
        );
        clientRef.set(client);
        enqueueLog(client, "evt_java_reentrant_auto", "reentrant");

        schedulers.scheduler().runNext();

        assertEquals("reentrancy_error", nested.get().code(), "reentrant shutdown code");
        assertEquals(0, client.pendingEvents(), "outer automatic delivery succeeds");
        assertEquals(DeliveryHealth.Outcome.ACCEPTED, client.deliveryHealth().lastOutcome(), "outer outcome");
        client.shutdown();
        testsRun++;
    }

    private void testProcessOwnershipFailsClosed() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        AtomicBoolean ownsProcess = new AtomicBoolean(true);
        RecordingTransport transport = RecordingTransport.alwaysAccept();
        LogBrewClient client = automaticClient(
            transport,
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(1),
            schedulers,
            ownsProcess::get
        );
        enqueueLog(client, "evt_java_process", "process");
        ownsProcess.set(false);

        DeliveryHealth health = client.deliveryHealth();
        assertEquals(DeliveryHealth.Activity.PAUSED, health.activity(), "process pause activity");
        assertEquals(DeliveryHealth.PauseReason.PROCESS_OWNERSHIP, health.pauseReason(), "process pause reason");
        assertEquals(0, schedulers.scheduler().pendingTasks(), "foreign process wake cancelled");
        assertEquals(0, transport.sentBodies().size(), "foreign process sends nothing");
        assertEquals(1, health.queuedEvents(), "foreign process retains work");
        assertEquals("process_ownership_error", expectSdkException(client::resumeAutomaticDelivery).code(), "resume process ownership");
        testsRun++;
    }

    private void testQueueDropAndHealthSurfaceStayContentFree() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        LogBrewClient client = automaticClient(
            RecordingTransport.alwaysAccept(),
            DeliveryOptions.builder().maxQueueEvents(1).build(),
            automaticOptions(10),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_private_1", "private-message-one");
        enqueueLog(client, "evt_java_private_2", "private-message-two");

        DeliveryHealth health = client.deliveryHealth();
        assertEquals(DeliveryHealth.Outcome.DROPPED, health.lastOutcome(), "drop outcome");
        assertEquals(DeliveryHealth.DropReason.QUEUE_OVERFLOW, health.lastDropReason(), "drop reason");
        assertEquals(1L, health.droppedEvents(), "drop count");
        assertHealthPrivacy(health, "private-message-one");
        assertHealthPrivacy(health, "private-message-two");
        client.shutdown();
        testsRun++;
    }

    private void testSchedulerFailureDoesNotEscapeCapture() {
        AutomaticDeliveryScheduler.Factory failingScheduler = () -> {
            throw new SdkException("automatic_delivery_error", "scheduler unavailable");
        };
        LogBrewClient client = LogBrewClient.createAutomatic(
            API_KEY,
            "logbrew-java",
            "0.1.0",
            RecordingTransport.alwaysAccept(),
            DeliveryOptions.builder().build(),
            automaticOptions(1),
            failingScheduler,
            (minimum, maximum) -> maximum,
            () -> true
        );

        enqueueLog(client, "evt_java_scheduler_failure", "scheduler-private");

        DeliveryHealth health = client.deliveryHealth();
        assertEquals(1, health.queuedEvents(), "scheduler failure retains capture");
        assertEquals(DeliveryHealth.Activity.PAUSED, health.activity(), "scheduler failure pauses");
        assertEquals(DeliveryHealth.PauseReason.NON_RETRYABLE, health.pauseReason(), "scheduler failure reason");
        assertHealthPrivacy(health, "scheduler-private");
        testsRun++;
    }

    private void testAutomaticOptionsAndDefaultFactoryStayBounded() {
        assertEquals(
            "validation_error",
            expectSdkException(() -> AutomaticDeliveryOptions.builder()
                .flushInterval(AutomaticDeliveryOptions.MAX_SCHEDULE_DELAY.plusMillis(1L))
                .build()).code(),
            "bounded flush interval"
        );
        assertEquals(
            "validation_error",
            expectSdkException(() -> AutomaticDeliveryOptions.builder()
                .maxRetryDelay(AutomaticDeliveryOptions.MAX_SCHEDULE_DELAY.plusMillis(1L))
                .build()).code(),
            "bounded retry delay"
        );
        assertEquals(
            "validation_error",
            expectSdkException(() -> AutomaticDeliveryOptions.builder()
                .maxRetryAttempts(AutomaticDeliveryOptions.MAX_RETRY_ATTEMPTS + 1)
                .build()).code(),
            "bounded retry attempts"
        );

        RecordingTransport transport = RecordingTransport.alwaysAccept();
        LogBrewClient client = LogBrewClient.createAutomatic(
            API_KEY,
            "logbrew-java",
            "0.1.0",
            transport
        );
        assertTrue(client.deliveryHealth().automaticDelivery(), "default automatic factory");
        client.shutdown();
        testsRun++;
    }

    private void testExplicitManualAPIsOwnAutomaticSchedulerLifecycle() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        RecordingTransport owned = RecordingTransport.alwaysAccept();
        RecordingTransport explicit = RecordingTransport.alwaysAccept();
        LogBrewClient client = automaticClient(
            owned,
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(10),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_explicit_flush", "flush");
        ManualTask staleFlushWake = schedulers.scheduler().nextTask();

        TransportResponse flushed = client.flush(explicit);
        assertEquals(1, flushed.acceptedEvents(), "explicit flush accepted events");
        assertTrue(staleFlushWake.cancelled(), "explicit flush cancels stale wake");
        staleFlushWake.runEvenIfCancelled();
        assertEquals(0, owned.sentBodies().size(), "stale wake does not use owned transport");
        assertEquals(1, explicit.sentBodies().size(), "explicit flush transport used once");

        enqueueLog(client, "evt_java_explicit_shutdown", "shutdown");
        ManualTask staleShutdownWake = schedulers.scheduler().nextTask();
        TransportResponse closed = client.shutdown(explicit);
        assertEquals(1, closed.acceptedEvents(), "explicit shutdown accepted events");
        assertTrue(staleShutdownWake.cancelled(), "explicit shutdown cancels stale wake");
        staleShutdownWake.runEvenIfCancelled();
        assertEquals(0, owned.sentBodies().size(), "closed stale wake stays silent");
        assertEquals(2, explicit.sentBodies().size(), "explicit shutdown transport used once");
        assertTrue(schedulers.scheduler().shutdown, "explicit shutdown stops scheduler");
        assertEquals(DeliveryHealth.Lifecycle.CLOSED, client.deliveryHealth().lifecycle(), "explicit close");
        testsRun++;
    }

    private void testRetryFailureCounterIsExact() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        LogBrewClient client = automaticClient(
            (apiKey, body) -> new TransportResponse(503, 1),
            DeliveryOptions.builder().maxRetries(0).build(),
            AutomaticDeliveryOptions.builder()
                .flushInterval(Duration.ofSeconds(1))
                .queueThreshold(1)
                .initialRetryDelay(Duration.ofMillis(2))
                .maxRetryDelay(Duration.ofMillis(4))
                .maxRetryAttempts(2)
                .build(),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_failure_count", "failure-count");

        schedulers.scheduler().runNext();
        assertEquals(1, client.deliveryHealth().consecutiveFailures(), "first failure count");
        schedulers.scheduler().runNext();
        assertEquals(2, client.deliveryHealth().consecutiveFailures(), "second failure count");
        schedulers.scheduler().runNext();
        assertEquals(3, client.deliveryHealth().consecutiveFailures(), "terminal failure count");
        testsRun++;
    }

    private void testShutdownHealthStaysClosingThroughOverlappingDrain() throws Exception {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        SequencedBlockingTransport transport = new SequencedBlockingTransport();
        LogBrewClient client = automaticClient(
            transport,
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(1),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_closing_initial", "initial");
        AtomicReference<Throwable> automaticFailure = new AtomicReference<>();
        Thread automatic = new Thread(
            () -> schedulers.scheduler().runNext(automaticFailure),
            "automatic-closing-worker"
        );
        automatic.start();
        assertTrue(transport.firstEntered.await(5, TimeUnit.SECONDS), "first closing request entered");
        enqueueLog(client, "evt_java_closing_later", "later");

        AtomicReference<Throwable> shutdownFailure = new AtomicReference<>();
        Thread shutdown = new Thread(() -> {
            try {
                client.shutdown();
            } catch (Throwable error) {
                shutdownFailure.set(error);
            }
        }, "automatic-closing-shutdown");
        shutdown.start();
        awaitTrue(() -> client.deliveryHealth().lifecycle() == DeliveryHealth.Lifecycle.CLOSING);

        transport.firstRelease.countDown();
        assertTrue(transport.secondEntered.await(5, TimeUnit.SECONDS), "second closing request entered");
        DeliveryHealth draining = client.deliveryHealth();
        assertEquals(DeliveryHealth.Lifecycle.CLOSING, draining.lifecycle(), "closing lifecycle remains visible");
        assertEquals(DeliveryHealth.Activity.IN_FLIGHT, draining.activity(), "closing activity remains visible");
        assertTrue(draining.inFlight(), "closing in-flight remains visible");
        transport.secondRelease.countDown();
        automatic.join(5_000L);
        shutdown.join(5_000L);

        assertEquals(null, automaticFailure.get(), "closing automatic failure");
        assertEquals(null, shutdownFailure.get(), "closing shutdown failure");
        assertTrue(!automatic.isAlive() && !shutdown.isAlive(), "closing workers complete");
        assertEquals(DeliveryHealth.Lifecycle.CLOSED, client.deliveryHealth().lifecycle(), "closing final lifecycle");
        testsRun++;
    }

    private void testSchedulerTerminationEscalates() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        schedulers.scheduler().terminateGracefully = false;
        LogBrewClient client = automaticClient(
            RecordingTransport.alwaysAccept(),
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(1),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_forced_scheduler_stop", "stop");

        client.shutdown();

        assertTrue(schedulers.scheduler().shutdownNow, "scheduler forced termination");
        testsRun++;
    }

    private void testSchedulerTerminationFailureDoesNotRewriteAcceptedShutdown() {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        schedulers.scheduler().shutdownFailure = new IllegalStateException("private scheduler failure");
        LogBrewClient client = automaticClient(
            RecordingTransport.alwaysAccept(),
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(1),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_scheduler_stop_failure", "private-stop-message");

        TransportResponse response = client.shutdown();

        assertEquals(1, response.acceptedEvents(), "accepted shutdown remains authoritative");
        assertEquals(DeliveryHealth.Lifecycle.CLOSED, client.deliveryHealth().lifecycle(), "teardown failure closed");
        assertHealthPrivacy(client.deliveryHealth(), "private scheduler failure");
        assertHealthPrivacy(client.deliveryHealth(), "private-stop-message");
        testsRun++;
    }

    private void testManualClientDefaultsRemainCallerDriven() throws Exception {
        long threadsBefore = deliveryThreadCount();
        LogBrewClient client = LogBrewClient.create(API_KEY, "logbrew-java", "0.1.0");
        enqueueLog(client, "evt_java_manual_default", "manual");
        Thread.sleep(30L);
        DeliveryHealth health = client.deliveryHealth();
        assertTrue(!health.automaticDelivery(), "manual automatic flag");
        assertEquals(DeliveryHealth.Activity.IDLE, health.activity(), "manual activity");
        assertEquals(1, health.queuedEvents(), "manual queue retained");
        assertEquals(threadsBefore, deliveryThreadCount(), "manual creates no scheduler");
        assertEquals(
            "automatic_delivery_disabled",
            expectSdkException(client::shutdown).code(),
            "manual no-argument shutdown"
        );
        assertEquals(1, client.shutdown(RecordingTransport.alwaysAccept()).acceptedEvents(), "manual shutdown API");
        testsRun++;
    }

    private static void assertTerminalPause(int status, DeliveryHealth.PauseReason expectedReason) {
        ManualSchedulerFactory schedulers = new ManualSchedulerFactory();
        AtomicInteger currentStatus = new AtomicInteger(status);
        LogBrewClient client = automaticClient(
            (apiKey, body) -> new TransportResponse(currentStatus.get(), 1),
            DeliveryOptions.builder().maxRetries(0).build(),
            automaticOptions(1),
            schedulers,
            () -> true
        );
        enqueueLog(client, "evt_java_pause_" + status, "pause");
        schedulers.scheduler().runNext();
        DeliveryHealth paused = client.deliveryHealth();
        assertEquals(DeliveryHealth.Activity.PAUSED, paused.activity(), "terminal pause " + status);
        assertEquals(expectedReason, paused.pauseReason(), "terminal reason " + status);
        assertEquals(0, schedulers.scheduler().pendingTasks(), "terminal no wake " + status);
        currentStatus.set(202);
        client.resumeAutomaticDelivery();
        assertEquals(0L, schedulers.scheduler().nextDelayMillis(), "recovery delay " + status);
        schedulers.scheduler().runNext();
        assertEquals(0, client.deliveryHealth().queuedEvents(), "recovered queue " + status);
        client.shutdown();
    }

    private static LogBrewClient automaticClient(
        Transport transport,
        DeliveryOptions deliveryOptions,
        AutomaticDeliveryOptions automaticOptions,
        ManualSchedulerFactory schedulers,
        BooleanSupplier processOwnership
    ) {
        return LogBrewClient.createAutomatic(
            API_KEY,
            "logbrew-java",
            "0.1.0",
            transport,
            deliveryOptions,
            automaticOptions,
            schedulers,
            (minimum, maximum) -> maximum,
            processOwnership
        );
    }

    private static AutomaticDeliveryOptions automaticOptions(int threshold) {
        return AutomaticDeliveryOptions.builder()
            .flushInterval(Duration.ofSeconds(1))
            .queueThreshold(threshold)
            .build();
    }

    private static void enqueueLog(LogBrewClient client, String id, String message) {
        client.log(id, "2026-06-02T10:00:03Z", LogAttributes.create(message, "info"));
    }

    private static void assertHealthPrivacy(DeliveryHealth health, String forbidden) {
        String summary = health.lifecycle() + " "
            + health.activity() + " "
            + health.lastOutcome() + " "
            + health.pauseReason() + " "
            + health.lastDropReason() + " "
            + health.queuedEvents() + " "
            + health.queuedBytes() + " "
            + health.droppedEvents() + " "
            + health.droppedBytes();
        assertNotContains(summary, forbidden);
        Arrays.stream(DeliveryHealth.class.getDeclaredFields()).forEach(field -> {
            if (String.class.equals(field.getType())
                || Throwable.class.isAssignableFrom(field.getType())
                || Thread.class.isAssignableFrom(field.getType())
                || Path.class.isAssignableFrom(field.getType())) {
                throw new AssertionError("unsafe health field type " + field.getName());
            }
        });
    }

    private static void awaitTrue(Condition condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5L);
        while (!condition.value() && System.nanoTime() < deadline) {
            Thread.sleep(1L);
        }
        assertTrue(condition.value(), "condition became true");
    }

    private static long deliveryThreadCount() {
        return Thread.getAllStackTraces().keySet().stream()
            .filter(thread -> thread.isAlive() && "logbrew-delivery".equals(thread.getName()))
            .count();
    }

    private static byte[] key(int seed) {
        byte[] value = new byte[32];
        for (int index = 0; index < value.length; index++) {
            value[index] = (byte) (seed + index);
        }
        return value;
    }

    private static Path createRealTempDirectory(String prefix) throws java.io.IOException {
        return Files.createTempDirectory(
            Path.of(System.getProperty("java.io.tmpdir")).toRealPath(),
            prefix
        );
    }

    private static void deleteTree(Path root) throws Exception {
        if (!Files.exists(root)) {
            return;
        }
        try (java.util.stream.Stream<Path> paths = Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (java.io.IOException error) {
                    throw new IllegalStateException(error);
                }
            });
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

    private static DeliveryHealth awaitAccepted(LogBrewClient client, long expected) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5L);
        DeliveryHealth health = client.deliveryHealth();
        while (health.acceptedEvents() != expected && System.nanoTime() < deadline) {
            Thread.sleep(1L);
            health = client.deliveryHealth();
        }
        return health;
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

    private static final class BlockingTransport implements Transport {
        private final CountDownLatch entered = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private final AtomicInteger active = new AtomicInteger();
        private final AtomicInteger maxActive = new AtomicInteger();
        private final List<String> bodies = new ArrayList<>();

        @Override
        public TransportResponse send(String apiKey, String body) throws TransportException {
            int current = active.incrementAndGet();
            maxActive.accumulateAndGet(current, Math::max);
            synchronized (bodies) {
                bodies.add(body);
            }
            entered.countDown();
            try {
                if (!release.await(5, TimeUnit.SECONDS)) {
                    throw new TransportException("transport_timeout", "timed out", true);
                }
                return new TransportResponse(202, 1);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new TransportException("transport_interrupted", "interrupted", true);
            } finally {
                active.decrementAndGet();
            }
        }
    }

    private static final class SequencedBlockingTransport implements Transport {
        private final CountDownLatch firstEntered = new CountDownLatch(1);
        private final CountDownLatch firstRelease = new CountDownLatch(1);
        private final CountDownLatch secondEntered = new CountDownLatch(1);
        private final CountDownLatch secondRelease = new CountDownLatch(1);
        private final AtomicInteger calls = new AtomicInteger();

        @Override
        public TransportResponse send(String apiKey, String body) throws TransportException {
            int call = calls.incrementAndGet();
            CountDownLatch entered = call == 1 ? firstEntered : secondEntered;
            CountDownLatch release = call == 1 ? firstRelease : secondRelease;
            entered.countDown();
            try {
                if (!release.await(5, TimeUnit.SECONDS)) {
                    throw new TransportException("transport_timeout", "timed out", true);
                }
                return new TransportResponse(202, 1);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new TransportException("transport_interrupted", "interrupted", true);
            }
        }
    }

    private interface Condition {
        boolean value();
    }

    private static final class ManualSchedulerFactory
        implements AutomaticDeliveryScheduler.Factory {
        private final ManualScheduler scheduler = new ManualScheduler();
        private int creations;

        @Override
        public AutomaticDeliveryScheduler.Scheduler create() {
            creations++;
            return scheduler;
        }

        int creations() {
            return creations;
        }

        ManualScheduler scheduler() {
            return scheduler;
        }
    }

    private static final class ManualScheduler implements AutomaticDeliveryScheduler.Scheduler {
        private final List<ManualTask> tasks = new ArrayList<>();
        private boolean shutdown;
        private boolean shutdownNow;
        private boolean terminateGracefully = true;
        private RuntimeException shutdownFailure;

        @Override
        public AutomaticDeliveryScheduler.ScheduledTask schedule(Runnable task, long delayMillis) {
            ManualTask scheduled = new ManualTask(task, delayMillis);
            tasks.add(scheduled);
            return scheduled;
        }

        @Override
        public void shutdown() {
            shutdown = true;
            if (shutdownFailure != null) {
                throw shutdownFailure;
            }
        }

        @Override
        public void shutdownNow() {
            shutdownNow = true;
        }

        @Override
        public boolean awaitTermination(long timeoutMillis) {
            return terminateGracefully || shutdownNow;
        }

        int pendingTasks() {
            int count = 0;
            for (ManualTask task : tasks) {
                if (!task.cancelled() && !task.completed()) {
                    count++;
                }
            }
            return count;
        }

        ManualTask nextTask() {
            for (ManualTask task : tasks) {
                if (!task.cancelled() && !task.completed()) {
                    return task;
                }
            }
            throw new AssertionError("expected a scheduled task");
        }

        long nextDelayMillis() {
            return nextTask().delayMillis;
        }

        void runNext() {
            nextTask().run();
        }

        void runNext(AtomicReference<Throwable> failure) {
            try {
                runNext();
            } catch (Throwable error) {
                failure.set(error);
            }
        }
    }

    private static final class ManualTask implements AutomaticDeliveryScheduler.ScheduledTask {
        private final Runnable task;
        private final long delayMillis;
        private boolean cancelled;
        private boolean completed;

        private ManualTask(Runnable task, long delayMillis) {
            this.task = task;
            this.delayMillis = delayMillis;
        }

        @Override
        public void cancel() {
            cancelled = true;
        }

        @Override
        public boolean isDone() {
            return cancelled || completed;
        }

        boolean cancelled() {
            return cancelled;
        }

        boolean completed() {
            return completed;
        }

        void run() {
            if (!cancelled) {
                runEvenIfCancelled();
            }
        }

        void runEvenIfCancelled() {
            completed = true;
            task.run();
        }
    }
}
