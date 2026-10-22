package co.logbrew.sdk;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
        testCrashReportEvictsOldestPersistedEventAcrossRestart();
        testUnreportedDropCountsSurviveARestart();
        testAReportSentBeforeARestartKeepsItsReportId();
        testADropBurstSavesOncePerSecondAndShutdownSavesTheRest();
        testUnreadableSavedDropCountsAreIgnored();
        testAnOrphanedDropCountFileNeverBlocksRecovery();
        testSavedDropCountsTolerateLaterVersions();
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
                enqueueLog(
                    client,
                    "evt_java_persist_1",
                    "café",
                    TelemetryContext.builder()
                        .session("session_restart_1")
                        .tag("operation", "checkout")
                        .build()
                );
                firstBody = client.previewJson();
                assertEquals(1, client.persistenceStatus().pendingEvents(), "persisted admission");
            }

            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = persistentClient(store);
                PersistenceStatus recovered = client.recoverPersistedEvents();
                assertEquals(1, recovered.pendingEvents(), "recovered events");
                assertEquals(firstBody, client.previewJson(), "stable recovered body");
                assertContains(client.previewJson(), "evt_java_persist_1");
                assertContains(client.previewJson(), "session_restart_1");
                assertContains(client.previewJson(), "\"operation\": \"checkout\"");
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

    private void testCrashReportEvictsOldestPersistedEventAcrossRestart() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-persistent-eviction");
        byte[] key = key(29);
        List<LogBrewClient.EventDrop> drops = new ArrayList<>();
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = evictionClient(store, drops);
                client.recoverPersistedEvents();
                enqueueLog(client, "evt_java_persist_evict_0", "first");
                enqueueLog(client, "evt_java_persist_evict_1", "second");
                enqueueLog(client, "evt_java_persist_evict_2", "third");
                client.issue("evt_java_persist_crash_0", "2026-06-02T10:00:04Z", IssueAttributes.create("App crashed", "fatal"));

                assertEquals(1, drops.size(), "persistent eviction callback count");
                assertEquals("evt_java_persist_evict_0", drops.get(0).eventId(), "persistent evicted event");
                assertEquals("evicted_for_fatal", drops.get(0).reason(), "persistent eviction reason");
                assertEquals(3, client.persistenceStatus().pendingEvents(), "persisted queue stays at its limit");
            }

            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = evictionClient(store, drops);
                assertEquals(3, client.recoverPersistedEvents().pendingEvents(), "recovered after eviction");
                String recovered = client.previewJson();
                assertNotContains(recovered, "evt_java_persist_evict_0");
                assertContains(recovered, "evt_java_persist_evict_1");
                assertContains(recovered, "evt_java_persist_crash_0");

                client.issue("evt_java_persist_crash_1", "2026-06-02T10:00:05Z", IssueAttributes.create("App crashed again", "critical"));
                assertEquals("evt_java_persist_evict_1", drops.get(1).eventId(), "a recovered crash report is kept");
                assertEquals("log", drops.get(1).eventType(), "recovered event type");
                RecordingTransport transport = RecordingTransport.alwaysAccept();
                assertEquals(3, client.flush(transport).acceptedEvents(), "drained after eviction");
                // The first eviction was saved before the restart, so both are reported.
                assertContains(transport.sentBodies().get(0), "\"evicted_for_fatal\": 2");
            }

            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                assertEquals(0, persistentClient(store).recoverPersistedEvents().pendingEvents(), "nothing left after drain");
            }
            // Drained, the store has no evicted records or saved counts, so older SDKs open it again.
            try (java.util.stream.Stream<Path> entries = Files.list(directory)) {
                assertEquals(
                    List.of(".admitted.lbe", ".checkpoint.lbe", ".key-check.lbe", ".owner.lock"),
                    entries.map(entry -> entry.getFileName().toString()).sorted().collect(java.util.stream.Collectors.toList()),
                    "drained store shape"
                );
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testUnreportedDropCountsSurviveARestart() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-persistent-drops");
        byte[] key = key(31);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = dropClient(store);
                client.recoverPersistedEvents();
                long[] now = {0L};
                client.setClientReportClock(() -> now[0] += 2_000_000_000L);
                enqueueLog(client, "evt_java_drops_0", "queued");
                enqueueLog(client, "evt_java_drops_1", "dropped");
                enqueueLog(client, "evt_java_drops_2", "dropped");
                assertEquals(true, Files.exists(directory.resolve(".client-report.lbe")), "saved drop counts");
            }
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = dropClient(store);
                client.recoverPersistedEvents();
                RecordingTransport transport = RecordingTransport.alwaysAccept();
                client.flush(transport);
                assertContains(transport.sentBodies().get(0), "\"queue_overflow\": 2");
                assertEquals(false, Files.exists(directory.resolve(".client-report.lbe")), "cleared once acknowledged");
                enqueueLog(client, "evt_java_drops_3", "later");
                client.flush(transport);
                assertNotContains(transport.sentBodies().get(1), "client_report");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testAReportSentBeforeARestartKeepsItsReportId() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-persistent-report-id");
        byte[] key = key(37);
        try {
            RecordingTransport failing = RecordingTransport.scripted(503);
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = dropClient(store);
                client.recoverPersistedEvents();
                enqueueLog(client, "evt_java_report_id_0", "queued");
                enqueueLog(client, "evt_java_report_id_1", "dropped");
                expectSdkException(() -> client.flush(failing));
                enqueueLog(client, "evt_java_report_id_2", "dropped later");
            }
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = dropClient(store);
                client.recoverPersistedEvents();
                RecordingTransport transport = RecordingTransport.alwaysAccept();
                client.flush(transport);
                enqueueLog(client, "evt_java_report_id_3", "queued");
                enqueueLog(client, "evt_java_report_id_4", "dropped");
                client.flush(transport);

                String sent = reportOf(failing.sentBodies().get(0));
                assertEquals(sent, reportOf(transport.sentBodies().get(0)), "resent report keeps its ID and counts");
                assertContains(sent, "\"queue_overflow\": 1");
                // The drop recorded after the failed send waited under a new report ID.
                assertNotEquals(sent, reportOf(transport.sentBodies().get(1)), "later drops use a new report ID");
                assertContains(transport.sentBodies().get(1), "\"queue_overflow\": 2");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testADropBurstSavesOncePerSecondAndShutdownSavesTheRest() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-persistent-burst");
        byte[] key = key(41);
        try {
            for (boolean shutdown : new boolean[] {false, true}) {
                try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                    LogBrewClient client = tooLargeClient(store);
                    client.recoverPersistedEvents();
                    long[] now = {0L};
                    client.setClientReportClock(() -> now[0]);
                    for (int index = 0; index < 5; index++) {
                        now[0] += 200_000_000L;
                        enqueueLog(client, "evt_java_burst_" + shutdown + index, "x".repeat(200));
                    }
                    if (shutdown) {
                        client.shutdown(RecordingTransport.alwaysAccept());
                    }
                }
                // The first drop saved at once; the rest of the burst waits for the interval or shutdown.
                assertEquals(shutdown ? 5 : 1, savedDropCount(directory, key), "saved drops, shutdown=" + shutdown);
                deleteTree(directory.resolve(".client-report.lbe"));
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testUnreadableSavedDropCountsAreIgnored() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-persistent-unreadable");
        byte[] key = key(43);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = dropClient(store);
                client.recoverPersistedEvents();
                enqueueLog(client, "evt_java_unreadable_0", "queued");
                Map<String, Integer> bad = new LinkedHashMap<>();
                bad.put("Not-A-Reason", 1);
                bad.put("event_too_large", 0);
                bad.put("evicted_for_fatal", 2);
                store.saveClientReport(new PersistenceClientReport("short", bad, bad));
            }
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = dropClient(store);
                assertEquals(1, client.recoverPersistedEvents().pendingEvents(), "event recovers");
                RecordingTransport transport = RecordingTransport.alwaysAccept();
                client.flush(transport);
                assertContains(transport.sentBodies().get(0), "\"evicted_for_fatal\": 2");
                assertNotContains(transport.sentBodies().get(0), "Not-A-Reason");
                assertNotContains(transport.sentBodies().get(0), "event_too_large");
            }
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = dropClient(store);
                client.recoverPersistedEvents();
                enqueueLog(client, "evt_java_unreadable_1", "queued");
            }
            Path unreadable = directory.resolve(".client-report.lbe");
            Files.write(unreadable, new byte[] {1, 2, 3, 4});
            Files.setPosixFilePermissions(unreadable, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = dropClient(store);
                assertEquals(1, client.recoverPersistedEvents().pendingEvents(), "events recover past unreadable counts");
                RecordingTransport transport = RecordingTransport.alwaysAccept();
                client.flush(transport);
                assertNotContains(transport.sentBodies().get(0), "client_report");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testAnOrphanedDropCountFileNeverBlocksRecovery() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-persistent-orphan");
        byte[] key = key(47);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                LogBrewClient client = dropClient(store);
                client.recoverPersistedEvents();
                enqueueLog(client, "evt_java_orphan_0", "queued");
            }
            Path orphan = directory.resolve(".report-pending-" + "0".repeat(32) + ".tmp");
            Files.write(orphan, new byte[] {9});
            Files.setPosixFilePermissions(orphan, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                assertEquals(1, dropClient(store).recoverPersistedEvents().pendingEvents(), "recovers with an orphaned report file");
            }
            assertEquals(false, Files.exists(orphan), "orphaned report file removed");
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testSavedDropCountsTolerateLaterVersions() {
        Map<String, Integer> counts = new LinkedHashMap<>();
        counts.put("queue_overflow", 3);
        byte[] current = new PersistenceClientReport("0123456789abcdef", counts, counts).encode();
        byte[] later = Arrays.copyOf(current, current.length + 3);
        later[0] = 2;
        later[later.length - 1] = 7;
        PersistenceClientReport decoded = PersistenceClientReport.decode(later);
        assertEquals("0123456789abcdef", decoded.pendingId, "later version keeps the pending report");
        assertEquals(counts, decoded.unreported, "later version keeps the unreported counts");
        assertEquals(null, PersistenceClientReport.decode(new byte[] {0}), "unknown older version is ignored");
        assertEquals(null, PersistenceClientReport.decode(Arrays.copyOf(current, 5)), "truncated counts are ignored");
        testsRun++;
    }

    private static LogBrewClient tooLargeClient(EncryptedEventStore store) {
        return LogBrewClient.create(
            API_KEY,
            "logbrew-java",
            "0.1.0",
            DeliveryOptions.builder().maxRetries(0).maxQueueBytes(100L).encryptedEventStore(store).build()
        );
    }

    private static int savedDropCount(Path directory, byte[] key) {
        try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
            store.recover(10, 1_000_000L, false);
            PersistenceClientReport saved = store.loadClientReport();
            return saved == null ? 0 : saved.unreported.values().stream().mapToInt(Integer::intValue).sum();
        }
    }

    private static String reportOf(String body) {
        int start = body.indexOf("\"client_report\"");
        assertEquals(true, start >= 0, "body carries a client report");
        return body.substring(start);
    }

    private static LogBrewClient dropClient(EncryptedEventStore store) {
        return LogBrewClient.create(
            API_KEY,
            "logbrew-java",
            "0.1.0",
            DeliveryOptions.builder().maxRetries(0).maxQueueEvents(1).encryptedEventStore(store).build()
        );
    }

    private static LogBrewClient evictionClient(EncryptedEventStore store, List<LogBrewClient.EventDrop> drops) {
        return LogBrewClient.create(
            API_KEY,
            "logbrew-java",
            "0.1.0",
            DeliveryOptions.builder()
                .maxRetries(0)
                .maxQueueEvents(3)
                .onEventDropped(drops::add)
                .encryptedEventStore(store)
                .build()
        );
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

    private static void enqueueLog(
        LogBrewClient client,
        String id,
        String message,
        TelemetryContext context
    ) {
        client.log(
            id,
            "2026-06-02T10:00:03Z",
            LogAttributes.create(message, "info").context(context)
        );
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

    private static void assertNotEquals(Object unexpected, Object actual, String label) {
        if (unexpected.equals(actual)) {
            throw new AssertionError(label + ": unexpectedly " + actual);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }
}
