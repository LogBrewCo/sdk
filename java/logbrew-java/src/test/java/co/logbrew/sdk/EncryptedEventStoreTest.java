package co.logbrew.sdk;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.util.Arrays;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.net.URI;
import java.util.Map;

/**
 * Dependency-free encrypted event-store crash-consistency tests.
 */
public final class EncryptedEventStoreTest {
    private int testsRun;

    public static void main(String[] args) throws Exception {
        new EncryptedEventStoreTest().run();
    }

    private void run() throws Exception {
        testRecordPostRenameFailureRemainsAmbiguousAfterReopen();
        testHighWaterPostRenameFailureRemainsAmbiguousAfterReopen();
        testCheckpointPostRenameFailureRemainsAmbiguousAfterReopen();
        testAtomicOwnerOnlyCreationAndShortWrites();
        testNonPosixProviderFailsClosed();
        testNoProgressWriteFailsClosed();
        testNoProgressReadAndInvalidLockFailClosed();
        testHardLinkedRecordAndLockAreRejected();
        testLockReplacementInvalidatesOriginalOwner();
        testTemporaryReplacementBeforeWriteDoesNotTruncateReplacement();
        testOversizedRecordCheckpointAndIntentFailClosed();
        testSymlinkReplacementForRecordCheckpointAndIntentFailsClosed();
        testRecordTamperAndReplacementBeforeAcknowledgement();
        testCommittedTargetReplacementIsDetectedBeforeFinalize();
        testMissingFirstAndInteriorRecordsFailClosed();
        testMissingSoleAndTrailingRecordsFailClosed();
        testAcknowledgedDeletionLeftoversRemainRecoverable();
        testAcknowledgedDeletionRetriesWithoutDuplicateRecovery();
        testInterruptedPurgeRequiresExplicitRetry();
        System.out.println("encrypted event-store tests ok (" + testsRun + " tests)");
    }

    private void testRecordPostRenameFailureRemainsAmbiguousAfterReopen() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-record-crash");
        byte[] key = key(11);
        try {
            try (EncryptedEventStore store = failingStore(
                directory,
                key,
                EncryptedEventStore.FailurePoint.AFTER_RECORD_RENAME
            )) {
                store.attach();
                store.recover(10, 4096L, false);
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.admit("evt_record", "{\"id\":\"evt_record\"}", 10, 4096L)).code(),
                    "record crash result"
                );
            }

            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                store.attach();
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "record crash survives reopen"
                );
                assertEquals(1, store.recover(10, 4096L, true).records().size(), "record finalize");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testCheckpointPostRenameFailureRemainsAmbiguousAfterReopen() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-checkpoint-crash");
        byte[] key = key(19);
        try {
            EncryptedEventStore.Record record;
            try (EncryptedEventStore store = failingStore(
                directory,
                key,
                EncryptedEventStore.FailurePoint.AFTER_CHECKPOINT_RENAME
            )) {
                store.attach();
                store.recover(10, 4096L, false);
                record = store.admit("evt_checkpoint", "{\"id\":\"evt_checkpoint\"}", 10, 4096L);
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.acknowledge(Collections.singletonList(record))).code(),
                    "checkpoint crash result"
                );
            }

            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                store.attach();
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "checkpoint crash survives reopen"
                );
                assertEquals(0, store.recover(10, 4096L, true).records().size(), "checkpoint finalize");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testHighWaterPostRenameFailureRemainsAmbiguousAfterReopen() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-high-water-crash");
        byte[] key = key(17);
        try {
            try (EncryptedEventStore store = failingStore(
                directory,
                key,
                EncryptedEventStore.FailurePoint.AFTER_HIGH_WATER_RENAME
            )) {
                store.attach();
                store.recover(10, 4096L, false);
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.admit(
                        "evt_high_water",
                        "{\"id\":\"evt_high_water\"}",
                        10,
                        4096L
                    )).code(),
                    "high-water crash result"
                );
            }

            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                store.attach();
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "high-water crash survives reopen"
                );
                EncryptedEventStore.Snapshot snapshot = store.recover(10, 4096L, true);
                assertEquals(1, snapshot.records().size(), "high-water finalize");
                assertEquals("evt_high_water", snapshot.records().get(0).eventId(), "finalized event");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testAtomicOwnerOnlyCreationAndShortWrites() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-owner-only");
        byte[] key = key(23);
        AtomicBoolean observedWrite = new AtomicBoolean();
        try {
            PersistenceFiles.WriteOperation shortWriter = (channel, buffer) -> {
                assertOwnerOnlyFiles(directory);
                observedWrite.set(true);
                int originalLimit = buffer.limit();
                buffer.limit(Math.min(originalLimit, buffer.position() + 3));
                try {
                    return channel.write(buffer);
                } finally {
                    buffer.limit(originalLimit);
                }
            };
            try (EncryptedEventStore store = EncryptedEventStore.open(
                directory,
                key,
                point -> { },
                shortWriter
            )) {
                store.attach();
                store.recover(10, 4096L, false);
                store.admit("evt_short", "{\"id\":\"evt_short\"}", 10, 4096L);
            }
            assertTrue(observedWrite.get(), "short-write seam was exercised");
            assertOwnerOnlyFiles(directory);
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                store.attach();
                assertEquals(1, store.recover(10, 4096L, false).records().size(), "short-write recovery");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testNoProgressWriteFailsClosed() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-no-progress");
        byte[] key = key(29);
        try {
            assertEquals(
                "persistence_ambiguous",
                expectSdkException(() -> EncryptedEventStore.open(
                    directory,
                    key,
                    point -> { },
                    (channel, buffer) -> 0
                )).code(),
                "zero-progress write"
            );
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                store.attach();
                assertEquals(0, store.recover(10, 4096L, false).records().size(), "empty key-check recovery");
            }

            Path mixed = createRealTempDirectory("logbrew-java-key-check-mixed");
            try {
                createOwnerOnlyFile(mixed.resolve(".key-pending-00000000000000000000000000000000.tmp"));
                createOwnerOnlyFile(mixed.resolve(".pending-11111111111111111111111111111111.tmp"));
                assertEquals(
                    "persistence_integrity_error",
                    expectSdkException(() -> EncryptedEventStore.open(mixed, key)).code(),
                    "mixed empty-store layout"
                );
            } finally {
                deleteTree(mixed);
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testNonPosixProviderFailsClosed() throws Exception {
        Path archive = Files.createTempFile("logbrew-java-non-posix", ".zip");
        Files.delete(archive);
        byte[] key = key(27);
        URI uri = URI.create("jar:" + archive.toUri());
        try (FileSystem fileSystem = FileSystems.newFileSystem(uri, Map.of("create", "true"))) {
            assertEquals(
                "persistence_unsupported",
                expectSdkException(() -> EncryptedEventStore.open(fileSystem.getPath("/store"), key)).code(),
                "non-POSIX permission capability"
            );
        } finally {
            Arrays.fill(key, (byte) 0);
            Files.deleteIfExists(archive);
        }
        testsRun++;
    }

    private void testNoProgressReadAndInvalidLockFailClosed() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-no-progress-read");
        byte[] key = key(30);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                // Seed a valid key-check before injecting a read that cannot progress.
                assertTrue(store.status(10, 4096L, true).recoveryRequired(), "seeded store status");
            }
            assertEquals(
                "persistence_integrity_error",
                expectSdkException(() -> EncryptedEventStore.open(
                    directory,
                    key,
                    point -> { },
                    FileChannel::write,
                    (channel, buffer) -> 0
                )).code(),
                "zero-progress read"
            );

            try (PersistenceFiles files = PersistenceFiles.open(directory)) {
                java.lang.reflect.Field field = PersistenceFiles.class.getDeclaredField("lock");
                field.setAccessible(true);
                ((FileLock) field.get(files)).release();
                assertEquals(
                    "persistence_in_use",
                    expectSdkException(files::layout).code(),
                    "invalid held lock"
                );
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testTemporaryReplacementBeforeWriteDoesNotTruncateReplacement() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-temp-replace");
        byte[] key = key(43);
        byte[] replacement = "replacement-must-survive".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try (EncryptedEventStore store = EncryptedEventStore.open(directory, key, point -> {
            if (point == EncryptedEventStore.FailurePoint.AFTER_RECORD_TEMP_CREATE) {
                Path temporary = firstPathWithPrefix(directory, ".pending-");
                Files.delete(temporary);
                createOwnerOnlyFile(temporary);
                Files.write(temporary, replacement, StandardOpenOption.WRITE);
            }
        })) {
            store.attach();
            store.recover(10, 4096L, false);
            assertEquals(
                "persistence_ambiguous",
                expectSdkException(() -> store.admit("evt_replace", "{\"id\":\"evt_replace\"}", 10, 4096L)).code(),
                "replacement before write"
            );
            Path replacementPath = firstPathWithPrefix(directory, ".pending-");
            assertTrue(Arrays.equals(replacement, Files.readAllBytes(replacementPath)), "replacement bytes unchanged");
            store.purge();
        } finally {
            Arrays.fill(replacement, (byte) 0);
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testOversizedRecordCheckpointAndIntentFailClosed() throws Exception {
        Path recordDirectory = createRealTempDirectory("logbrew-java-oversized-record");
        byte[] recordKey = key(47);
        try (EncryptedEventStore store = EncryptedEventStore.open(recordDirectory, recordKey)) {
            store.attach();
            store.recover(10, 64L, false);
            store.admit("evt_large", "{\"id\":\"evt_large\"}", 10, 64L);
            overwrite(firstRecord(recordDirectory), new byte[1300]);
            assertEquals(
                "persistence_integrity_error",
                expectSdkException(() -> store.status(10, 64L, false)).code(),
                "oversized record"
            );
        } finally {
            Arrays.fill(recordKey, (byte) 0);
            deleteTree(recordDirectory);
        }

        Path checkpointDirectory = createRealTempDirectory("logbrew-java-oversized-checkpoint");
        byte[] checkpointKey = key(53);
        try (EncryptedEventStore store = EncryptedEventStore.open(checkpointDirectory, checkpointKey)) {
            store.attach();
            store.recover(10, 4096L, false);
            EncryptedEventStore.Record record = store.admit("evt_checkpoint_size", "{\"id\":\"evt_checkpoint_size\"}", 10, 4096L);
            store.acknowledge(Collections.singletonList(record));
            overwrite(checkpointDirectory.resolve(".checkpoint.lbe"), new byte[9000]);
            assertEquals(
                "persistence_integrity_error",
                expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                "oversized checkpoint"
            );
        } finally {
            Arrays.fill(checkpointKey, (byte) 0);
            deleteTree(checkpointDirectory);
        }

        Path intentDirectory = createRealTempDirectory("logbrew-java-oversized-intent");
        byte[] intentKey = key(59);
        try {
            try (EncryptedEventStore store = failingStore(
                intentDirectory,
                intentKey,
                EncryptedEventStore.FailurePoint.AFTER_RECORD_RENAME
            )) {
                store.attach();
                store.recover(10, 4096L, false);
                expectSdkException(() -> store.admit("evt_intent_size", "{\"id\":\"evt_intent_size\"}", 10, 4096L));
            }
            overwrite(intentDirectory.resolve(".intent.lbe"), new byte[9000]);
            try (EncryptedEventStore store = EncryptedEventStore.open(intentDirectory, intentKey)) {
                store.attach();
                assertEquals(
                    "persistence_integrity_error",
                    expectSdkException(() -> store.recover(10, 4096L, true)).code(),
                    "oversized intent"
                );
            }
        } finally {
            Arrays.fill(intentKey, (byte) 0);
            deleteTree(intentDirectory);
        }
        testsRun++;
    }

    private void testRecordTamperAndReplacementBeforeAcknowledgement() throws Exception {
        Path tamperDirectory = createRealTempDirectory("logbrew-java-record-tamper");
        byte[] tamperKey = key(61);
        try (EncryptedEventStore store = EncryptedEventStore.open(tamperDirectory, tamperKey)) {
            store.attach();
            store.recover(10, 4096L, false);
            EncryptedEventStore.Record record = store.admit("evt_tamper", "{\"id\":\"evt_tamper\"}", 10, 4096L);
            Path path = firstRecord(tamperDirectory);
            byte[] bytes = Files.readAllBytes(path);
            bytes[bytes.length - 1] ^= 1;
            overwrite(path, bytes);
            Arrays.fill(bytes, (byte) 0);
            assertEquals(
                "persistence_integrity_error",
                expectSdkException(() -> store.acknowledge(Collections.singletonList(record))).code(),
                "record tamper before acknowledgement"
            );
        } finally {
            Arrays.fill(tamperKey, (byte) 0);
            deleteTree(tamperDirectory);
        }

        Path replacementDirectory = createRealTempDirectory("logbrew-java-record-replacement");
        byte[] replacementKey = key(67);
        try (EncryptedEventStore store = EncryptedEventStore.open(replacementDirectory, replacementKey)) {
            store.attach();
            store.recover(10, 4096L, false);
            EncryptedEventStore.Record record = store.admit("evt_replaced", "{\"id\":\"evt_replaced\"}", 10, 4096L);
            replaceWithSameBytes(firstRecord(replacementDirectory));
            assertEquals(
                "persistence_integrity_error",
                expectSdkException(() -> store.acknowledge(Collections.singletonList(record))).code(),
                "record replacement before acknowledgement"
            );
        } finally {
            Arrays.fill(replacementKey, (byte) 0);
            deleteTree(replacementDirectory);
        }
        testsRun++;
    }

    private void testSymlinkReplacementForRecordCheckpointAndIntentFailsClosed() throws Exception {
        Path outside = createRealTempDirectory("logbrew-java-symlink-outside");
        Path external = outside.resolve("external");
        createOwnerOnlyFile(external);
        Files.write(external, new byte[] {1}, StandardOpenOption.WRITE);

        Path recordDirectory = createRealTempDirectory("logbrew-java-record-symlink");
        byte[] recordKey = key(68);
        try (EncryptedEventStore store = EncryptedEventStore.open(recordDirectory, recordKey)) {
            store.attach();
            store.recover(10, 4096L, false);
            store.admit("evt_record_link", "{\"id\":\"evt_record_link\"}", 10, 4096L);
            replaceWithSymlink(firstRecord(recordDirectory), external);
            assertEquals(
                "persistence_integrity_error",
                expectSdkException(() -> store.status(10, 4096L, false)).code(),
                "record symlink replacement"
            );
        } finally {
            Arrays.fill(recordKey, (byte) 0);
            deleteTree(recordDirectory);
        }

        Path checkpointDirectory = createRealTempDirectory("logbrew-java-checkpoint-symlink");
        byte[] checkpointKey = key(69);
        try (EncryptedEventStore store = EncryptedEventStore.open(checkpointDirectory, checkpointKey)) {
            store.attach();
            store.recover(10, 4096L, false);
            EncryptedEventStore.Record record = store.admit("evt_checkpoint_link", "{\"id\":\"evt_checkpoint_link\"}", 10, 4096L);
            store.acknowledge(Collections.singletonList(record));
            replaceWithSymlink(checkpointDirectory.resolve(".checkpoint.lbe"), external);
            assertEquals(
                "persistence_integrity_error",
                expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                "checkpoint symlink replacement"
            );
        } finally {
            Arrays.fill(checkpointKey, (byte) 0);
            deleteTree(checkpointDirectory);
        }

        Path intentDirectory = createRealTempDirectory("logbrew-java-intent-symlink");
        byte[] intentKey = key(70);
        try {
            try (EncryptedEventStore store = failingStore(
                intentDirectory,
                intentKey,
                EncryptedEventStore.FailurePoint.AFTER_RECORD_RENAME
            )) {
                store.attach();
                store.recover(10, 4096L, false);
                expectSdkException(() -> store.admit("evt_intent_link", "{\"id\":\"evt_intent_link\"}", 10, 4096L));
            }
            replaceWithSymlink(intentDirectory.resolve(".intent.lbe"), external);
            try (EncryptedEventStore store = EncryptedEventStore.open(intentDirectory, intentKey)) {
                store.attach();
                assertEquals(
                    "persistence_integrity_error",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "intent symlink replacement"
                );
            }
        } finally {
            Arrays.fill(intentKey, (byte) 0);
            deleteTree(intentDirectory);
            deleteTree(outside);
        }
        testsRun++;
    }

    private void testCommittedTargetReplacementIsDetectedBeforeFinalize() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-committed-replacement");
        byte[] key = key(71);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key, point -> {
                if (point == EncryptedEventStore.FailurePoint.AFTER_RECORD_RENAME) {
                    replaceWithSameBytes(firstRecord(directory));
                }
            })) {
                store.attach();
                store.recover(10, 4096L, false);
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.admit("evt_commit_replace", "{\"id\":\"evt_commit_replace\"}", 10, 4096L)).code(),
                    "committed target replacement"
                );
            }
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                store.attach();
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "replacement intent remains fail-closed"
                );
                assertEquals(1, store.recover(10, 4096L, true).records().size(), "digest-verified finalize");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }

        Path tamperDirectory = createRealTempDirectory("logbrew-java-committed-tamper");
        byte[] tamperKey = key(73);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(tamperDirectory, tamperKey, point -> {
                if (point == EncryptedEventStore.FailurePoint.AFTER_RECORD_RENAME) {
                    Path path = firstRecord(tamperDirectory);
                    byte[] bytes = Files.readAllBytes(path);
                    bytes[bytes.length - 1] ^= 1;
                    overwrite(path, bytes);
                    Arrays.fill(bytes, (byte) 0);
                }
            })) {
                store.attach();
                store.recover(10, 4096L, false);
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.admit("evt_commit_tamper", "{\"id\":\"evt_commit_tamper\"}", 10, 4096L)).code(),
                    "committed target digest mismatch"
                );
            }
            try (EncryptedEventStore store = EncryptedEventStore.open(tamperDirectory, tamperKey)) {
                store.attach();
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.recover(10, 4096L, true)).code(),
                    "tampered target cannot finalize"
                );
            }
        } finally {
            Arrays.fill(tamperKey, (byte) 0);
            deleteTree(tamperDirectory);
        }
        testsRun++;
    }

    private void testMissingFirstAndInteriorRecordsFailClosed() throws Exception {
        Path firstDirectory = createRealTempDirectory("logbrew-java-missing-first");
        byte[] firstKey = key(79);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(firstDirectory, firstKey)) {
                store.attach();
                store.recover(10, 4096L, false);
                store.admit("evt_missing_1", "{\"id\":\"evt_missing_1\"}", 10, 4096L);
                store.admit("evt_missing_2", "{\"id\":\"evt_missing_2\"}", 10, 4096L);
            }
            Files.delete(recordPaths(firstDirectory).get(0));
            try (EncryptedEventStore store = EncryptedEventStore.open(firstDirectory, firstKey)) {
                store.attach();
                assertEquals(
                    "persistence_integrity_error",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "missing first record"
                );
            }
        } finally {
            Arrays.fill(firstKey, (byte) 0);
            deleteTree(firstDirectory);
        }

        Path interiorDirectory = createRealTempDirectory("logbrew-java-missing-interior");
        byte[] interiorKey = key(83);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(interiorDirectory, interiorKey)) {
                store.attach();
                store.recover(10, 4096L, false);
                for (int index = 1; index <= 3; index++) {
                    store.admit(
                        "evt_interior_" + index,
                        "{\"id\":\"evt_interior_" + index + "\"}",
                        10,
                        4096L
                    );
                }
            }
            Files.delete(recordPaths(interiorDirectory).get(1));
            try (EncryptedEventStore store = EncryptedEventStore.open(interiorDirectory, interiorKey)) {
                store.attach();
                assertEquals(
                    "persistence_integrity_error",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "missing interior record"
                );
            }
        } finally {
            Arrays.fill(interiorKey, (byte) 0);
            deleteTree(interiorDirectory);
        }
        testsRun++;
    }

    private void testMissingSoleAndTrailingRecordsFailClosed() throws Exception {
        Path soleDirectory = createRealTempDirectory("logbrew-java-missing-sole");
        byte[] soleKey = key(87);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(soleDirectory, soleKey)) {
                store.attach();
                store.recover(10, 4096L, false);
                store.admit("evt_sole", "{\"id\":\"evt_sole\"}", 10, 4096L);
            }
            Files.delete(recordPaths(soleDirectory).get(0));
            try (EncryptedEventStore store = EncryptedEventStore.open(soleDirectory, soleKey)) {
                store.attach();
                assertEquals(
                    "persistence_integrity_error",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "missing sole record"
                );
            }
        } finally {
            Arrays.fill(soleKey, (byte) 0);
            deleteTree(soleDirectory);
        }

        Path trailingDirectory = createRealTempDirectory("logbrew-java-missing-trailing");
        byte[] trailingKey = key(88);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(trailingDirectory, trailingKey)) {
                store.attach();
                store.recover(10, 4096L, false);
                store.admit("evt_trailing_1", "{\"id\":\"evt_trailing_1\"}", 10, 4096L);
                store.admit("evt_trailing_2", "{\"id\":\"evt_trailing_2\"}", 10, 4096L);
            }
            java.util.List<Path> records = recordPaths(trailingDirectory);
            Files.delete(records.get(records.size() - 1));
            try (EncryptedEventStore store = EncryptedEventStore.open(trailingDirectory, trailingKey)) {
                store.attach();
                assertEquals(
                    "persistence_integrity_error",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "missing trailing record"
                );
            }
        } finally {
            Arrays.fill(trailingKey, (byte) 0);
            deleteTree(trailingDirectory);
        }

        Path metadataDirectory = createRealTempDirectory("logbrew-java-missing-admitted-metadata");
        byte[] metadataKey = key(90);
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(metadataDirectory, metadataKey)) {
                store.attach();
                store.recover(10, 4096L, false);
                store.admit("evt_metadata", "{\"id\":\"evt_metadata\"}", 10, 4096L);
            }
            Files.delete(recordPaths(metadataDirectory).get(0));
            Files.delete(metadataDirectory.resolve(PersistenceFiles.HIGH_WATER_NAME));
            assertEquals(
                "persistence_integrity_error",
                expectSdkException(() -> EncryptedEventStore.open(metadataDirectory, metadataKey)).code(),
                "missing admitted metadata"
            );
        } finally {
            Arrays.fill(metadataKey, (byte) 0);
            deleteTree(metadataDirectory);
        }
        testsRun++;
    }

    private void testAcknowledgedDeletionLeftoversRemainRecoverable() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-deletion-leftover");
        byte[] key = key(89);
        byte[] firstBytes = null;
        Path firstPath = null;
        try {
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                store.attach();
                store.recover(10, 4096L, false);
                EncryptedEventStore.Record first = store.admit("evt_old_1", "{\"id\":\"evt_old_1\"}", 10, 4096L);
                store.admit("evt_live_2", "{\"id\":\"evt_live_2\"}", 10, 4096L);
                firstPath = recordPaths(directory).get(0);
                firstBytes = Files.readAllBytes(firstPath);
                store.acknowledge(Collections.singletonList(first));
                createOwnerOnlyFile(firstPath);
                Files.write(firstPath, firstBytes, StandardOpenOption.WRITE);
            }
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                store.attach();
                EncryptedEventStore.Snapshot snapshot = store.recover(10, 4096L, false);
                assertEquals(1, snapshot.records().size(), "delayed deletion pending count");
                assertEquals("evt_live_2", snapshot.records().get(0).eventId(), "delayed deletion event");
            }
        } finally {
            if (firstBytes != null) {
                Arrays.fill(firstBytes, (byte) 0);
            }
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testInterruptedPurgeRequiresExplicitRetry() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-purge-crash");
        byte[] key = key(97);
        try {
            try (EncryptedEventStore store = failingStore(
                directory,
                key,
                EncryptedEventStore.FailurePoint.BEFORE_PURGE_SYNC
            )) {
                store.attach();
                store.recover(10, 4096L, false);
                store.admit("evt_purge", "{\"id\":\"evt_purge\"}", 10, 4096L);
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(store::purge).code(),
                    "interrupted purge"
                );
            }
            try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
                store.attach();
                assertEquals(
                    "persistence_ambiguous",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "purge marker survives reopen"
                );
                store.purge();
                assertEquals(0, store.recover(10, 4096L, false).records().size(), "purge retry empty");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private void testAcknowledgedDeletionRetriesWithoutDuplicateRecovery() throws Exception {
        Path subsequentDirectory = createRealTempDirectory("logbrew-java-deletion-retry-ack");
        byte[] subsequentKey = key(91);
        AtomicBoolean failFirstDelete = new AtomicBoolean(true);
        try (EncryptedEventStore store = EncryptedEventStore.open(
            subsequentDirectory,
            subsequentKey,
            point -> {
                if (point == EncryptedEventStore.FailurePoint.BEFORE_ACKNOWLEDGED_PRUNE
                    && failFirstDelete.compareAndSet(true, false)) {
                    throw new IOException("injected delete failure");
                }
            }
        )) {
            store.attach();
            store.recover(10, 4096L, false);
            EncryptedEventStore.Record first = store.admit(
                "evt_retry_delete_1",
                "{\"id\":\"evt_retry_delete_1\"}",
                10,
                4096L
            );
            EncryptedEventStore.Record second = store.admit(
                "evt_retry_delete_2",
                "{\"id\":\"evt_retry_delete_2\"}",
                10,
                4096L
            );
            store.acknowledge(Collections.singletonList(first));
            assertEquals(2, recordPaths(subsequentDirectory).size(), "accepted record retained after delete failure");
            store.acknowledge(Collections.singletonList(second));
            assertEquals(0, recordPaths(subsequentDirectory).size(), "later acknowledgement retries deletion");
        } finally {
            Arrays.fill(subsequentKey, (byte) 0);
            deleteTree(subsequentDirectory);
        }

        Path recoveryDirectory = createRealTempDirectory("logbrew-java-deletion-retry-recovery");
        byte[] recoveryKey = key(93);
        try {
            try (EncryptedEventStore store = failingStore(
                recoveryDirectory,
                recoveryKey,
                EncryptedEventStore.FailurePoint.BEFORE_ACKNOWLEDGED_PRUNE
            )) {
                store.attach();
                store.recover(10, 4096L, false);
                EncryptedEventStore.Record first = store.admit(
                    "evt_recovery_delete_1",
                    "{\"id\":\"evt_recovery_delete_1\"}",
                    10,
                    4096L
                );
                store.admit(
                    "evt_recovery_delete_2",
                    "{\"id\":\"evt_recovery_delete_2\"}",
                    10,
                    4096L
                );
                store.acknowledge(Collections.singletonList(first));
                assertEquals(2, recordPaths(recoveryDirectory).size(), "checkpoint remains authoritative");
            }

            try (EncryptedEventStore store = failingStore(
                recoveryDirectory,
                recoveryKey,
                EncryptedEventStore.FailurePoint.BEFORE_ACKNOWLEDGED_PRUNE
            )) {
                store.attach();
                assertEquals(
                    "persistence_prune_error",
                    expectSdkException(() -> store.recover(10, 4096L, false)).code(),
                    "explicit recovery pruning failure"
                );
            }

            try (EncryptedEventStore store = EncryptedEventStore.open(recoveryDirectory, recoveryKey)) {
                store.attach();
                EncryptedEventStore.Snapshot snapshot = store.recover(10, 4096L, false);
                assertEquals(1, snapshot.records().size(), "accepted event stays hidden");
                assertEquals(
                    "evt_recovery_delete_2",
                    snapshot.records().get(0).eventId(),
                    "only unaccepted event recovers"
                );
                assertEquals(1, recordPaths(recoveryDirectory).size(), "reopen pruning removes accepted record");
            }
        } finally {
            Arrays.fill(recoveryKey, (byte) 0);
            deleteTree(recoveryDirectory);
        }
        testsRun++;
    }

    private void testHardLinkedRecordAndLockAreRejected() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-hardlink");
        Path outside = createRealTempDirectory("logbrew-java-hardlink-outside");
        byte[] key = key(31);
        try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
            store.attach();
            store.recover(10, 4096L, false);
            store.admit("evt_link", "{\"id\":\"evt_link\"}", 10, 4096L);
            Path record = firstRecord(directory);
            if (supportsLinkCount(record)) {
                Files.createLink(outside.resolve("record-link"), record);
                assertEquals(
                    "persistence_integrity_error",
                    expectSdkException(() -> store.status(10, 4096L, false)).code(),
                    "hard-linked record"
                );
            }
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
            deleteTree(outside);
        }

        Path lockDirectory = createRealTempDirectory("logbrew-java-lock-hardlink");
        Path lockOutside = createRealTempDirectory("logbrew-java-lock-hardlink-outside");
        byte[] lockKey = key(37);
        try (EncryptedEventStore store = EncryptedEventStore.open(lockDirectory, lockKey)) {
            Path lockPath = lockDirectory.resolve(".owner.lock");
            if (supportsLinkCount(lockPath)) {
                Files.createLink(lockOutside.resolve("lock-link"), lockPath);
                assertEquals(
                    "persistence_integrity_error",
                    expectSdkException(() -> store.status(10, 4096L, true)).code(),
                    "hard-linked lock"
                );
            }
        } finally {
            Arrays.fill(lockKey, (byte) 0);
            deleteTree(lockDirectory);
            deleteTree(lockOutside);
        }
        testsRun++;
    }

    private void testLockReplacementInvalidatesOriginalOwner() throws Exception {
        Path directory = createRealTempDirectory("logbrew-java-lock-replace");
        byte[] key = key(41);
        try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
            assertEquals(
                "persistence_in_use",
                expectSdkException(() -> EncryptedEventStore.open(directory, key)).code(),
                "second owner before replacement"
            );
            Path lock = directory.resolve(".owner.lock");
            Files.delete(lock);
            createOwnerOnlyFile(lock);
            assertEquals(
                "persistence_replaced",
                expectSdkException(() -> store.status(10, 4096L, true)).code(),
                "original owner after lock replacement"
            );
        } finally {
            Arrays.fill(key, (byte) 0);
            deleteTree(directory);
        }
        testsRun++;
    }

    private static EncryptedEventStore failingStore(
        Path directory,
        byte[] key,
        EncryptedEventStore.FailurePoint failurePoint
    ) {
        return EncryptedEventStore.open(directory, key, point -> {
            if (point == failurePoint) {
                throw new IOException("injected failure");
            }
        });
    }

    private static byte[] key(int seed) {
        byte[] value = new byte[32];
        for (int index = 0; index < value.length; index++) {
            value[index] = (byte) (seed + index);
        }
        return value;
    }

    private static Path createRealTempDirectory(String prefix) throws IOException {
        Path root = Path.of(System.getProperty("java.io.tmpdir")).toRealPath();
        return Files.createTempDirectory(root, prefix);
    }

    private static Path firstRecord(Path directory) throws IOException {
        return recordPaths(directory).get(0);
    }

    private static java.util.List<Path> recordPaths(Path directory) throws IOException {
        try (java.util.stream.Stream<Path> paths = Files.list(directory)) {
            return paths.filter(path -> path.getFileName().toString().matches("[0-9]{20}\\.lbe"))
                .sorted()
                .collect(java.util.stream.Collectors.toList());
        }
    }

    private static Path firstPathWithPrefix(Path directory, String prefix) throws IOException {
        try (java.util.stream.Stream<Path> paths = Files.list(directory)) {
            return paths.filter(path -> path.getFileName().toString().startsWith(prefix))
                .findFirst()
                .orElseThrow(() -> new AssertionError("expected persistence path with prefix " + prefix));
        }
    }

    private static boolean supportsLinkCount(Path path) throws IOException {
        try {
            return Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS) instanceof Number;
        } catch (UnsupportedOperationException | IllegalArgumentException error) {
            return false;
        }
    }

    private static void assertOwnerOnlyFiles(Path directory) throws IOException {
        PosixFileAttributeView directoryView = Files.getFileAttributeView(
            directory,
            PosixFileAttributeView.class,
            LinkOption.NOFOLLOW_LINKS
        );
        if (directoryView == null) {
            return;
        }
        assertEquals(
            PosixFilePermissions.fromString("rwx------"),
            directoryView.readAttributes().permissions(),
            "store directory permissions"
        );
        try (java.util.stream.Stream<Path> paths = Files.list(directory)) {
            for (Path path : (Iterable<Path>) paths::iterator) {
                if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                    assertEquals(
                        PosixFilePermissions.fromString("rw-------"),
                        Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS),
                        "store file permissions"
                    );
                }
            }
        }
    }

    private static void createOwnerOnlyFile(Path path) throws IOException {
        PosixFileAttributeView view = Files.getFileAttributeView(
            path.getParent(),
            PosixFileAttributeView.class,
            LinkOption.NOFOLLOW_LINKS
        );
        if (view == null) {
            Files.createFile(path);
        } else {
            Files.createFile(path, PosixFilePermissions.asFileAttribute(
                PosixFilePermissions.fromString("rw-------")
            ));
        }
    }

    private static void overwrite(Path path, byte[] bytes) throws IOException {
        Files.write(
            path,
            bytes,
            StandardOpenOption.WRITE,
            StandardOpenOption.TRUNCATE_EXISTING
        );
    }

    private static void replaceWithSameBytes(Path path) throws IOException {
        byte[] bytes = Files.readAllBytes(path);
        try {
            Files.delete(path);
            createOwnerOnlyFile(path);
            Files.write(path, bytes, StandardOpenOption.WRITE);
        } finally {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    private static void replaceWithSymlink(Path path, Path target) throws IOException {
        Files.delete(path);
        Files.createSymbolicLink(path, target);
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
                } catch (IOException error) {
                    throw new IllegalStateException(error);
                }
            });
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
}
