package co.logbrew.sdk;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * Opt-in, caller-owned encrypted restart store for canonical event JSON.
 *
 * <p>The store uses one process lock, authenticated encryption, an admitted high-water boundary,
 * durable intents, atomic replacement, and explicit recovery. It never creates a thread, timer,
 * shutdown hook, or key file. The caller must keep the key outside the store and close this object
 * after delivery.</p>
 */
public final class EncryptedEventStore implements AutoCloseable {
    private final PersistenceFiles files;
    private final PersistenceCrypto crypto;
    private final PersistenceTransaction transaction;
    private final PersistenceRecordCodec recordCodec;
    private final byte[] storeId;
    private List<Record> activeRecords = new ArrayList<>();
    private long checkpointSequence;
    private long nextSequence = 1L;
    private boolean attached;
    private boolean loaded;
    private boolean failed;
    private boolean closed;

    /**
     * Opens or creates an encrypted store using a 16, 24, or 32 byte caller-owned AES key.
     *
     * <p>The current implementation requires a POSIX filesystem that can atomically create and
     * verify owner-only directories and files, expose stable file identity, atomically rename,
     * and durably synchronize the store directory. Unsupported providers fail closed with
     * {@code persistence_unsupported}.</p>
     */
    public static EncryptedEventStore open(Path directory, byte[] key) {
        return open(
            directory,
            key,
            point -> { },
            java.nio.channels.FileChannel::write,
            java.nio.channels.FileChannel::read
        );
    }

    static EncryptedEventStore open(Path directory, byte[] key, FailureInjector failureInjector) {
        return open(
            directory,
            key,
            failureInjector,
            java.nio.channels.FileChannel::write,
            java.nio.channels.FileChannel::read
        );
    }

    static EncryptedEventStore open(
        Path directory,
        byte[] key,
        FailureInjector failureInjector,
        PersistenceFiles.WriteOperation writeOperation
    ) {
        return open(
            directory,
            key,
            failureInjector,
            writeOperation,
            java.nio.channels.FileChannel::read
        );
    }

    static EncryptedEventStore open(
        Path directory,
        byte[] key,
        FailureInjector failureInjector,
        PersistenceFiles.WriteOperation writeOperation,
        PersistenceFiles.ReadOperation readOperation
    ) {
        Objects.requireNonNull(directory, "directory");
        Objects.requireNonNull(key, "key");
        Objects.requireNonNull(failureInjector, "failureInjector");
        Objects.requireNonNull(writeOperation, "writeOperation");
        Objects.requireNonNull(readOperation, "readOperation");
        PersistenceFiles files = null;
        PersistenceCrypto crypto = null;
        try {
            files = PersistenceFiles.open(directory, writeOperation, readOperation);
            crypto = new PersistenceCrypto(key);
            byte[] storeId = PersistenceKeyCheck.initialize(files, crypto);
            return new EncryptedEventStore(files, crypto, storeId, failureInjector);
        } catch (RuntimeException error) {
            if (crypto != null) {
                crypto.close();
            }
            if (files != null) {
                files.close();
            }
            throw error;
        }
    }

    private EncryptedEventStore(
        PersistenceFiles files,
        PersistenceCrypto crypto,
        byte[] storeId,
        FailureInjector failureInjector
    ) {
        this.files = files;
        this.crypto = crypto;
        this.storeId = storeId;
        this.transaction = new PersistenceTransaction(files, crypto, storeId, failureInjector);
        this.recordCodec = new PersistenceRecordCodec(files, crypto, storeId);
    }

    synchronized void attach() {
        ensureUsable();
        if (attached) {
            throw new SdkException(
                "persistence_in_use",
                "persistence store is already attached to a client"
            );
        }
        attached = true;
    }

    synchronized Snapshot recover(int maxEvents, long maxBytes, boolean finalizeAmbiguous) {
        ensureReadable();
        validateBounds(maxEvents, maxBytes);
        if (finalizeAmbiguous) {
            transaction.finalizePending();
            failed = false;
        } else if (failed) {
            throw new SdkException(
                "persistence_failed",
                "persistence requires explicit verified recovery or purge"
            );
        }
        Snapshot snapshot = inspect(maxEvents, maxBytes);
        activeRecords = new ArrayList<>(snapshot.records);
        checkpointSequence = snapshot.checkpointSequence;
        nextSequence = snapshot.nextSequence;
        loaded = true;
        return snapshot;
    }

    synchronized PersistenceStatus status(int maxEvents, long maxBytes, boolean recoveryRequired) {
        ensureReadable();
        validateBounds(maxEvents, maxBytes);
        PersistenceFiles.Layout layout = files.layout();
        if (transaction.hasAmbiguity(layout)) {
            int ambiguous = layout.temporaryFiles.size()
                + (layout.intentFile == null ? 0 : 1)
                + (layout.purgeIntentFile == null ? 0 : 1);
            return new PersistenceStatus(0, 0L, ambiguous, true);
        }
        Snapshot snapshot = inspect(layout, maxEvents, maxBytes);
        return snapshot.status(recoveryRequired || failed);
    }

    synchronized Record admit(String eventId, String eventJson, int maxEvents, long maxBytes) {
        ensureLoaded();
        validateBounds(maxEvents, maxBytes);
        byte[] eventBytes = eventJson.getBytes(StandardCharsets.UTF_8);
        if (eventBytes.length > maxBytes) {
            throw new SdkException("persistence_bounds_exceeded", "persistence bounds reject the event");
        }
        long currentBytes = pendingBytes(activeRecords);
        if (activeRecords.size() >= maxEvents || eventBytes.length > maxBytes - currentBytes) {
            throw new SdkException("persistence_bounds_exceeded", "persistence bounds reject the event");
        }
        if (nextSequence <= 0L || nextSequence == Long.MAX_VALUE) {
            throw new SdkException(
                "persistence_bounds_exceeded",
                "persistence sequence space is exhausted"
            );
        }

        byte[] payload = recordCodec.encodeRecordPayload(eventId, eventBytes);
        byte[] encoded = crypto.encrypt(PersistenceCrypto.RECORD, nextSequence, payload, storeId);
        byte[] highWaterPayload = recordCodec.encodeSequence(nextSequence);
        byte[] highWaterEncoded = crypto.encrypt(
            PersistenceCrypto.HIGH_WATER,
            nextSequence,
            highWaterPayload,
            storeId
        );
        long sequence = nextSequence;
        Path target = files.recordPath(sequence);
        try {
            transaction.commitAdmission(
                sequence,
                target,
                encoded,
                highWaterEncoded
            );
            Record record = recordCodec.readRecord(target, sequence, maxBytes);
            activeRecords.add(record);
            nextSequence++;
            return record;
        } catch (SdkException error) {
            if ("persistence_ambiguous".equals(error.code())) {
                failed = true;
            }
            throw error;
        } finally {
            Arrays.fill(payload, (byte) 0);
            Arrays.fill(encoded, (byte) 0);
            Arrays.fill(highWaterPayload, (byte) 0);
            Arrays.fill(highWaterEncoded, (byte) 0);
            Arrays.fill(eventBytes, (byte) 0);
        }
    }

    synchronized void acknowledge(List<Record> records) {
        ensureLoaded();
        if (records.isEmpty()) {
            return;
        }
        if (records.size() > activeRecords.size()) {
            PersistenceCrypto.integrityFailure();
        }
        for (int index = 0; index < records.size(); index++) {
            Record expected = activeRecords.get(index);
            Record actual = records.get(index);
            if (expected != actual) {
                PersistenceCrypto.integrityFailure();
            }
            recordCodec.verifyUnchanged(actual);
        }

        long acknowledgedSequence = records.get(records.size() - 1).sequence;
        byte[] payload = ByteBuffer.allocate(Long.BYTES).order(ByteOrder.BIG_ENDIAN)
            .putLong(acknowledgedSequence)
            .array();
        byte[] encoded = crypto.encrypt(
            PersistenceCrypto.CHECKPOINT,
            acknowledgedSequence,
            payload,
            storeId
        );
        try {
            transaction.commit(
                PersistenceCrypto.CHECKPOINT,
                acknowledgedSequence,
                files.path(PersistenceFiles.CHECKPOINT_NAME),
                encoded,
                true,
                FailurePoint.BEFORE_CHECKPOINT_RENAME,
                FailurePoint.AFTER_CHECKPOINT_RENAME
            );
            checkpointSequence = acknowledgedSequence;
            activeRecords = new ArrayList<>(
                activeRecords.subList(records.size(), activeRecords.size())
            );
            deleteAcknowledgedRecords(records);
        } catch (SdkException error) {
            if ("persistence_ambiguous".equals(error.code())) {
                failed = true;
            }
            throw error;
        } finally {
            Arrays.fill(payload, (byte) 0);
            Arrays.fill(encoded, (byte) 0);
        }
    }

    synchronized void purge() {
        ensureReadable();
        try {
            transaction.purge();
            activeRecords = new ArrayList<>();
            checkpointSequence = 0L;
            nextSequence = 1L;
            loaded = true;
            failed = false;
        } catch (IOException error) {
            failed = true;
            throw new SdkException(
                "persistence_ambiguous",
                "persistence purge did not complete durably"
            );
        }
    }

    @Override
    public synchronized void close() {
        if (closed) {
            return;
        }
        closed = true;
        activeRecords.clear();
        Arrays.fill(storeId, (byte) 0);
        crypto.close();
        files.close();
    }

    private Snapshot inspect(int maxEvents, long maxBytes) {
        PersistenceFiles.Layout layout = files.layout();
        if (transaction.hasAmbiguity(layout)) {
            throw new SdkException(
                "persistence_ambiguous",
                "persistence transaction requires explicit verified recovery or purge"
            );
        }
        return inspect(layout, maxEvents, maxBytes);
    }

    private Snapshot inspect(PersistenceFiles.Layout layout, int maxEvents, long maxBytes) {
        long checkpoint = recordCodec.readCheckpoint(layout.checkpointFile);
        if (layout.highWaterFile == null) {
            PersistenceCrypto.integrityFailure();
        }
        long highWater = recordCodec.readHighWater(layout.highWaterFile);
        if (highWater < checkpoint) {
            PersistenceCrypto.integrityFailure();
        }
        List<Record> records = new ArrayList<>();
        long eventBytes = 0L;
        long expectedSequence = checkpoint == Long.MAX_VALUE ? Long.MAX_VALUE : checkpoint + 1L;
        for (Path path : layout.recordFiles) {
            long sequence = PersistenceFiles.recordSequence(path);
            if (sequence <= checkpoint) {
                continue;
            }
            if (sequence != expectedSequence || sequence > highWater) {
                PersistenceCrypto.integrityFailure();
            }
            Record record = recordCodec.readRecord(path, sequence, maxBytes);
            if (records.size() >= maxEvents || record.eventBytes > maxBytes - eventBytes) {
                throw new SdkException(
                    "persistence_bounds_exceeded",
                    "persisted events exceed configured bounds"
                );
            }
            records.add(record);
            eventBytes += record.eventBytes;
            expectedSequence = sequence == Long.MAX_VALUE ? Long.MAX_VALUE : sequence + 1L;
        }
        long expectedAfterHighWater = highWater == Long.MAX_VALUE ? Long.MAX_VALUE : highWater + 1L;
        if (expectedSequence != expectedAfterHighWater) {
            PersistenceCrypto.integrityFailure();
        }
        long next = expectedAfterHighWater;
        return new Snapshot(
            Collections.unmodifiableList(records),
            checkpoint,
            next,
            eventBytes,
            0
        );
    }

    private void deleteAcknowledgedRecords(List<Record> records) {
        boolean deleted = false;
        try {
            for (Record record : records) {
                if (Files.exists(record.path, LinkOption.NOFOLLOW_LINKS)) {
                    files.delete(record.path);
                    deleted = true;
                }
            }
            if (deleted) {
                files.syncDirectory();
            }
        } catch (IOException | SdkException error) {
            // The durable checkpoint remains authoritative if encrypted-record deletion is delayed.
        }
    }

    private static long pendingBytes(List<Record> records) {
        long value = 0L;
        try {
            for (Record record : records) {
                value = Math.addExact(value, record.eventBytes);
            }
            return value;
        } catch (ArithmeticException error) {
            throw new SdkException("persistence_bounds_exceeded", "persisted event bytes overflow");
        }
    }

    private static void validateBounds(int maxEvents, long maxBytes) {
        if (maxEvents <= 0 || maxBytes <= 0L) {
            throw new SdkException("validation_error", "persistence bounds must be positive");
        }
    }

    private void ensureLoaded() {
        ensureUsable();
        if (!loaded) {
            throw new SdkException(
                "persistence_recovery_required",
                "recover or purge persistence before capture"
            );
        }
    }

    private void ensureUsable() {
        ensureReadable();
        if (failed) {
            throw new SdkException(
                "persistence_failed",
                "persistence requires explicit verified recovery or purge"
            );
        }
    }

    private void ensureReadable() {
        if (closed) {
            throw new SdkException("persistence_closed", "persistence store is closed");
        }
    }

    enum FailurePoint {
        AFTER_RECORD_TEMP_CREATE,
        AFTER_CHECKPOINT_TEMP_CREATE,
        BEFORE_RECORD_RENAME,
        AFTER_RECORD_RENAME,
        AFTER_HIGH_WATER_RENAME,
        BEFORE_CHECKPOINT_RENAME,
        AFTER_CHECKPOINT_RENAME,
        BEFORE_PURGE_SYNC
    }

    @FunctionalInterface
    interface FailureInjector {
        void fail(FailurePoint point) throws IOException;
    }

    static final class Record {
        private final long sequence;
        private final String eventId;
        private final String eventJson;
        private final long eventBytes;
        final Path path;
        final PersistenceFiles.FileIdentity fileIdentity;

        Record(
            long sequence,
            String eventId,
            String eventJson,
            long eventBytes,
            Path path,
            PersistenceFiles.FileIdentity fileIdentity
        ) {
            this.sequence = sequence;
            this.eventId = eventId;
            this.eventJson = eventJson;
            this.eventBytes = eventBytes;
            this.path = path;
            this.fileIdentity = fileIdentity;
        }

        String eventId() {
            return eventId;
        }

        String eventJson() {
            return eventJson;
        }

        long eventBytes() {
            return eventBytes;
        }
    }

    static final class Snapshot {
        private final List<Record> records;
        private final long checkpointSequence;
        private final long nextSequence;
        private final long pendingBytes;
        private final int ambiguousFiles;

        Snapshot(
            List<Record> records,
            long checkpointSequence,
            long nextSequence,
            long pendingBytes,
            int ambiguousFiles
        ) {
            this.records = records;
            this.checkpointSequence = checkpointSequence;
            this.nextSequence = nextSequence;
            this.pendingBytes = pendingBytes;
            this.ambiguousFiles = ambiguousFiles;
        }

        List<Record> records() {
            return records;
        }

        PersistenceStatus status(boolean recoveryRequired) {
            return new PersistenceStatus(
                records.size(),
                pendingBytes,
                ambiguousFiles,
                recoveryRequired || ambiguousFiles > 0
            );
        }
    }
}
