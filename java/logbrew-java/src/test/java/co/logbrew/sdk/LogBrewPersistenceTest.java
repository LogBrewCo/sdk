package co.logbrew.sdk;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Dependency-free restart persistence tests for the Java SDK.
 */
public final class LogBrewPersistenceTest {
    private static final String API_KEY = "LOGBREW_API_KEY";
    private int testsRun;

    public static void main(String[] args) throws Exception {
        new LogBrewPersistenceTest().run();
    }

    private void run() throws Exception {
        testRequiresExplicitRecoveryAndPreservesStableBodyAcrossRestart();
        testPersistentAndMemoryBatchesRemainByteCompatible();
        testRetryPrefixAcknowledgementAndLaterCaptureSurviveRestart();
        testFailedShutdownAndExactBoundsRecover();
        System.out.println("java persistence tests ok (" + testsRun + " tests)");
    }

    private void testRequiresExplicitRecoveryAndPreservesStableBodyAcrossRestart() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-persistence");
        byte[] key = key(7);
        String firstBody;
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = persistentClient(store);
                assertEquals(
                    "persistence_recovery_required",
                    expectSdkException(() -> enqueueLog(client, "evt_java_persist_1", "café")).code(),
                    "capture before recovery"
                );
                PersistenceStatus empty = client.recoverPersistedEvents();
                assertEquals(0, empty.pendingEvents(), "initial persisted events");
                enqueueLog(client, "evt_java_persist_1", "café");
                firstBody = client.previewJson();
                assertEquals(1, client.persistenceStatus().pendingEvents(), "persisted admission");
            }

            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = persistentClient(store);
                PersistenceStatus recovered = client.recoverPersistedEvents();
                assertEquals(1, recovered.pendingEvents(), "recovered events");
                assertEquals(firstBody, client.previewJson(), "stable recovered body");
                assertContains(client.previewJson(), "evt_java_persist_1");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testPersistentAndMemoryBatchesRemainByteCompatible() throws Exception {
        LogBrewClient memory = LogBrewClient.create(API_KEY, "logbrew-java", "0.1.0");
        enqueueLog(memory, "evt_java_compatible", "café");
        String expected = memory.previewJson();

        Path directory = createRealTempDirectory("logbrew-java-compatible");
        byte[] key = key(13);
        try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
            LogBrewClient persistent = persistentClient(store);
            persistent.recoverPersistedEvents();
            enqueueLog(persistent, "evt_java_compatible", "café");
            assertEquals(expected, persistent.previewJson(), "memory and persistence batch bytes");
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testRetryPrefixAcknowledgementAndLaterCaptureSurviveRestart() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-prefix-restart");
        byte[] key = key(17);
        List<String> bodies = new ArrayList<>();
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = LogBrewClient.create(
                    API_KEY,
                    "logbrew-java",
                    "0.1.0",
                    DeliveryOptions.builder()
                        .maxRetries(1)
                        .maxBatchEvents(1)
                        .maxBatchBytes(4096)
                        .encryptedEventStore(store)
                        .build()
                );
                client.recoverPersistedEvents();
                enqueueLog(client, "evt_java_prefix_1", "first");
                enqueueLog(client, "evt_java_prefix_2", "second");
                AtomicInteger calls = new AtomicInteger();
                SdkException failure = expectSdkException(() -> client.flush((apiKey, body) -> {
                    bodies.add(body);
                    int call = calls.incrementAndGet();
                    if (call == 1) {
                        enqueueLog(client, "evt_java_prefix_3", "later");
                        return new TransportResponse(503, 1);
                    }
                    return new TransportResponse(call == 2 ? 202 : 400, 1);
                }));
                assertEquals("transport_error", failure.code(), "prefix failure");
                assertEquals(bodies.get(0), bodies.get(1), "frozen retry body");
                assertEquals(2, client.persistenceStatus().pendingEvents(), "retained persisted suffix");
            }

            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = LogBrewClient.create(
                    API_KEY,
                    "logbrew-java",
                    "0.1.0",
                    DeliveryOptions.builder()
                        .maxRetries(0)
                        .maxBatchEvents(1)
                        .maxBatchBytes(4096)
                        .encryptedEventStore(store)
                        .build()
                );
                PersistenceStatus recovered = client.recoverPersistedEvents();
                assertEquals(2, recovered.pendingEvents(), "recovered suffix count");
                assertNotContains(client.previewJson(), "evt_java_prefix_1");
                assertContains(client.previewJson(), "evt_java_prefix_2");
                assertContains(client.previewJson(), "evt_java_prefix_3");
                TransportResponse response = client.flush(RecordingTransport.alwaysAccept());
                assertEquals(2, response.acceptedEvents(), "recovered suffix accepted");
                assertEquals(0, client.persistenceStatus().pendingEvents(), "durable suffix drained");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testFailedShutdownAndExactBoundsRecover() throws Exception {
        LogBrewClient probe = LogBrewClient.create(API_KEY, "logbrew-java", "0.1.0");
        enqueueLog(probe, "evt_java_bound_1", "café");
        long eventBytes = probe.pendingEventBytes();

        Path directory = createRealTempDirectory("logbrew-java-shutdown-restart");
        byte[] key = key(21);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = LogBrewClient.create(
                    API_KEY,
                    "logbrew-java",
                    "0.1.0",
                    DeliveryOptions.builder()
                        .maxRetries(0)
                        .maxQueueEvents(2)
                        .maxQueueBytes(eventBytes)
                        .maxBatchBytes(4096)
                        .encryptedEventStore(store)
                        .build()
                );
                client.recoverPersistedEvents();
                enqueueLog(client, "evt_java_bound_1", "café");
                enqueueLog(client, "evt_java_bound_2", "café");
                assertEquals(1, client.pendingEvents(), "exact UTF-8 bound");
                assertEquals(1, client.droppedEvents(), "exact bound drop");
                assertEquals(
                    "transport_error",
                    expectSdkException(() -> client.shutdown(
                        RecordingTransport.scripted(Integer.valueOf(503))
                    )).code(),
                    "failed persistent shutdown"
                );
                assertEquals(1, client.persistenceStatus().pendingEvents(), "failed shutdown retained");
            }
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = persistentClient(store);
                assertEquals(1, client.recoverPersistedEvents().pendingEvents(), "failed shutdown recovered");
                client.purgePersistedEvents();
                assertEquals(0, client.persistenceStatus().pendingEvents(), "explicit purge");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private static LogBrewClient persistentClient(EncryptedEventStore store) {
        return LogBrewClient.create(
            API_KEY,
            "logbrew-java",
            "0.1.0",
            DeliveryOptions.builder().encryptedEventStore(store).build()
        );
    }

    private static void enqueueLog(LogBrewClient client, String id, String message) {
        client.log(id, "2026-06-02T10:00:03Z", LogAttributes.create(message, "info"));
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

    private static SdkException expectSdkException(Runnable callback) {
        try {
            callback.run();
        } catch (SdkException error) {
            return error;
        }
        throw new AssertionError("expected SdkException");
    }

    private static void deleteTree(Path root) throws Exception {
        if (!Files.exists(root)) {
            return;
        }
        try (java.util.stream.Stream<Path> paths = Files.walk(root)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (java.io.IOException error) {
                    throw new IllegalStateException(error);
                }
            });
        }
    }

    private static void assertContains(String value, String needle) {
        if (!value.contains(needle)) {
            throw new AssertionError("expected value to contain " + needle);
        }
    }

    private static void assertNotContains(String value, String needle) {
        if (value.contains(needle)) {
            throw new AssertionError("expected value not to contain " + needle);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }
}
