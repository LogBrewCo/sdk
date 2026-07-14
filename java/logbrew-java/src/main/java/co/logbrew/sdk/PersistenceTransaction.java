package co.logbrew.sdk;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Durable intent protocol for record admission and accepted-prefix checkpoints. */
final class PersistenceTransaction {
    private static final byte INTENT_VERSION = 2;
    private static final int DIGEST_BYTES = 32;
    private static final int MAX_INTENT_BYTES = 8192;

    private final PersistenceFiles files;
    private final PersistenceCrypto crypto;
    private final byte[] storeId;
    private final EncryptedEventStore.FailureInjector failureInjector;

    PersistenceTransaction(
        PersistenceFiles files,
        PersistenceCrypto crypto,
        byte[] storeId,
        EncryptedEventStore.FailureInjector failureInjector
    ) {
        this.files = files;
        this.crypto = crypto;
        this.storeId = storeId;
        this.failureInjector = failureInjector;
    }

    void commit(
        byte targetKind,
        long sequence,
        Path target,
        byte[] encoded,
        boolean replace,
        EncryptedEventStore.FailurePoint beforeRename,
        EncryptedEventStore.FailurePoint afterRename
    ) {
        commitSingle(
            new Target(targetKind, sequence, replace, target, encoded),
            beforeRename,
            afterRename
        );
    }

    void commitAdmission(long sequence, Path recordTarget, byte[] record, byte[] highWater) {
        PersistenceFiles.Layout initial = files.layout();
        if (hasAmbiguity(initial)) {
            throw ambiguous("an earlier persistence transaction requires explicit recovery or purge");
        }

        PendingTarget recordPending = null;
        PendingTarget highWaterPending = null;
        boolean intentDurable = false;
        try {
            recordPending = prepare(
                new Target(PersistenceCrypto.RECORD, sequence, false, recordTarget, record),
                EncryptedEventStore.FailurePoint.AFTER_RECORD_TEMP_CREATE
            );
            highWaterPending = prepare(
                new Target(
                    PersistenceCrypto.HIGH_WATER,
                    sequence,
                    true,
                    files.path(PersistenceFiles.HIGH_WATER_NAME),
                    highWater
                ),
                null
            );
            Intent intent = new Intent(
                sequence,
                Arrays.asList(recordPending.target, highWaterPending.target)
            );
            writeIntent(intent);
            intentDurable = true;

            failureInjector.fail(EncryptedEventStore.FailurePoint.BEFORE_RECORD_RENAME);
            files.move(recordPending.file, files.path(recordPending.target.targetName), false);
            failureInjector.fail(EncryptedEventStore.FailurePoint.AFTER_RECORD_RENAME);
            files.move(highWaterPending.file, files.path(highWaterPending.target.targetName), true);
            failureInjector.fail(EncryptedEventStore.FailurePoint.AFTER_HIGH_WATER_RENAME);
            completeCommit(Arrays.asList(recordPending, highWaterPending));
        } catch (IOException error) {
            throw ambiguous("persistence transaction did not complete durably");
        } catch (SdkException error) {
            if (intentDurable
                || recordPending != null
                || highWaterPending != null
                || "persistence_ambiguous".equals(error.code())) {
                throw ambiguous("persistence transaction did not complete durably");
            }
            throw error;
        } finally {
            closeQuietly(recordPending);
            closeQuietly(highWaterPending);
        }
    }

    private void commitSingle(
        Target input,
        EncryptedEventStore.FailurePoint beforeRename,
        EncryptedEventStore.FailurePoint afterRename
    ) {
        PersistenceFiles.Layout initial = files.layout();
        if (hasAmbiguity(initial)) {
            throw ambiguous("an earlier persistence transaction requires explicit recovery or purge");
        }

        PendingTarget pending = null;
        boolean intentDurable = false;
        try {
            pending = prepare(
                input,
                input.kind == PersistenceCrypto.RECORD
                    ? EncryptedEventStore.FailurePoint.AFTER_RECORD_TEMP_CREATE
                    : EncryptedEventStore.FailurePoint.AFTER_CHECKPOINT_TEMP_CREATE
            );
            writeIntent(new Intent(input.sequence, Collections.singletonList(pending.target)));
            intentDurable = true;
            if (beforeRename != null) {
                failureInjector.fail(beforeRename);
            }
            files.move(
                pending.file,
                files.path(pending.target.targetName),
                pending.target.replace
            );
            if (afterRename != null) {
                failureInjector.fail(afterRename);
            }
            completeCommit(Collections.singletonList(pending));
        } catch (IOException error) {
            throw ambiguous("persistence transaction did not complete durably");
        } catch (SdkException error) {
            if (intentDurable || pending != null || "persistence_ambiguous".equals(error.code())) {
                throw ambiguous("persistence transaction did not complete durably");
            }
            throw error;
        } finally {
            closeQuietly(pending);
        }
    }

    void finalizePending() {
        PersistenceFiles.Layout layout = files.layout();
        if (layout.purgeIntentFile != null) {
            throw ambiguous("interrupted purge requires explicit purge retry");
        }
        if (layout.intentFile == null) {
            if (!layout.temporaryFiles.isEmpty()) {
                throw ambiguous("orphaned persistence writes require purge");
            }
            return;
        }

        Intent intent = readIntent(layout.intentFile);
        Set<Path> expectedTemporaries = new HashSet<>();
        for (Target target : intent.targets) {
            Path temporary = files.path(target.temporaryName);
            if (files.exists(temporary)) {
                expectedTemporaries.add(temporary);
            }
        }
        if (!expectedTemporaries.equals(new HashSet<>(layout.temporaryFiles))) {
            throw ambiguous("persistence transaction contains unexpected temporary files");
        }

        try {
            for (Target target : intent.targets) {
                finalizeTarget(target);
            }
            files.syncDirectory();
            for (Target target : intent.targets) {
                files.verifyExact(
                    files.path(target.targetName),
                    target.expectedSize,
                    target.expectedDigest,
                    null
                );
            }
            removeIntentDurably();
        } catch (IOException error) {
            throw ambiguous("persistence transaction could not be finalized durably");
        }
    }

    private PendingTarget prepare(Target input, EncryptedEventStore.FailurePoint afterCreate)
        throws IOException {
        PersistenceFiles.OwnedFile temporary = files.createTemporary("pending");
        try {
            if (afterCreate != null) {
                failureInjector.fail(afterCreate);
            }
            PersistenceFiles.FileIdentity identity = files.writeAndForce(temporary, input.encoded);
            Target target = input.withTemporary(
                temporary.path.getFileName().toString(),
                identity.size,
                identity.digest
            );
            return new PendingTarget(target, temporary, identity.fileKey);
        } catch (IOException | SdkException error) {
            PersistenceFiles.closeQuietly(temporary);
            throw ambiguous("persistence transaction did not complete durably");
        }
    }

    private void completeCommit(List<PendingTarget> pendingTargets) throws IOException {
        files.syncDirectory();
        for (PendingTarget pending : pendingTargets) {
            PersistenceFiles.FileIdentity committed = files.verifyExact(
                files.path(pending.target.targetName),
                pending.target.expectedSize,
                pending.target.expectedDigest,
                pending.fileKey
            );
            if (!pending.fileKey.equals(committed.fileKey)) {
                PersistenceCrypto.integrityFailure();
            }
        }
        removeIntentDurably();
    }

    private void finalizeTarget(Target target) throws IOException {
        Path temporary = files.path(target.temporaryName);
        Path targetPath = files.path(target.targetName);
        boolean targetExists = files.exists(targetPath);
        boolean temporaryExists = files.exists(temporary);
        if (targetExists && matches(targetPath, target)) {
            if (temporaryExists) {
                throw ambiguous("persistence transaction contains a duplicate temporary file");
            }
            return;
        }
        if (!temporaryExists || !matches(temporary, target)) {
            throw ambiguous("persistence transaction cannot be verified for recovery");
        }
        if (targetExists && !target.replace) {
            throw ambiguous("persistence target conflicts with recovered admission");
        }
        files.moveExisting(temporary, targetPath, target.replace);
    }

    private static void closeQuietly(PendingTarget pending) {
        if (pending != null) {
            PersistenceFiles.closeQuietly(pending.file);
        }
    }

    boolean hasAmbiguity(PersistenceFiles.Layout layout) {
        return layout.intentFile != null
            || layout.purgeIntentFile != null
            || !layout.temporaryFiles.isEmpty();
    }

    void purge() throws IOException {
        writePurgeIntentIfMissing();
        PersistenceFiles.Layout layout = files.layout();
        for (Path path : layout.purgeableFiles) {
            files.delete(path);
        }
        PersistenceKeyCheck.writeEmptyHighWater(files, crypto, storeId);
        failureInjector.fail(EncryptedEventStore.FailurePoint.BEFORE_PURGE_SYNC);
        files.syncDirectory();
        files.delete(files.path(PersistenceFiles.PURGE_INTENT_NAME));
        files.syncDirectory();
    }

    private void writePurgeIntentIfMissing() throws IOException {
        Path target = files.path(PersistenceFiles.PURGE_INTENT_NAME);
        if (files.exists(target)) {
            return;
        }
        byte[] encoded = crypto.encrypt(PersistenceCrypto.PURGE, 0L, storeId, storeId);
        PersistenceFiles.OwnedFile temporary = null;
        try {
            temporary = files.createTemporary("purge-pending");
            PersistenceFiles.FileIdentity identity = files.writeAndForce(temporary, encoded);
            files.move(temporary, target, false);
            files.syncDirectory();
            PersistenceFiles.FileIdentity committed = files.verifyExact(
                target,
                identity.size,
                identity.digest,
                identity.fileKey
            );
            if (!identity.fileKey.equals(committed.fileKey)) {
                PersistenceCrypto.integrityFailure();
            }
        } finally {
            PersistenceFiles.closeQuietly(temporary);
            Arrays.fill(encoded, (byte) 0);
        }
    }

    private void writeIntent(Intent intent) throws IOException {
        byte[] plaintext = encodeIntent(intent);
        byte[] encoded = crypto.encrypt(PersistenceCrypto.INTENT, intent.sequence, plaintext, storeId);
        PersistenceFiles.OwnedFile temporary = null;
        try {
            temporary = files.createTemporary("intent-pending");
            PersistenceFiles.FileIdentity identity = files.writeAndForce(temporary, encoded);
            Path target = files.path(PersistenceFiles.INTENT_NAME);
            files.move(temporary, target, false);
            files.syncDirectory();
            PersistenceFiles.FileIdentity committed = files.verifyExact(
                target,
                identity.size,
                identity.digest,
                identity.fileKey
            );
            if (!identity.fileKey.equals(committed.fileKey)) {
                PersistenceCrypto.integrityFailure();
            }
        } finally {
            PersistenceFiles.closeQuietly(temporary);
            Arrays.fill(plaintext, (byte) 0);
            Arrays.fill(encoded, (byte) 0);
        }
    }

    private Intent readIntent(Path path) {
        PersistenceFiles.FileData data = files.read(path, MAX_INTENT_BYTES);
        PersistenceCrypto.Header header = crypto.header(data.bytes);
        byte[] plaintext = crypto.decrypt(
            PersistenceCrypto.INTENT,
            header.sequence,
            data.bytes,
            storeId
        );
        try {
            return decodeIntent(header.sequence, plaintext);
        } finally {
            Arrays.fill(plaintext, (byte) 0);
            Arrays.fill(data.bytes, (byte) 0);
        }
    }

    private boolean matches(Path path, Target target) {
        PersistenceFiles.FileData data = files.read(path, target.expectedSize);
        try {
            return data.identity.size == target.expectedSize
                && MessageDigest.isEqual(target.expectedDigest, data.identity.digest);
        } finally {
            Arrays.fill(data.bytes, (byte) 0);
        }
    }

    private void removeIntentDurably() throws IOException {
        files.delete(files.path(PersistenceFiles.INTENT_NAME));
        files.syncDirectory();
    }

    private static byte[] encodeIntent(Intent intent) {
        List<byte[]> targetNames = new ArrayList<>();
        List<byte[]> temporaryNames = new ArrayList<>();
        try {
            int size = 1 + Long.BYTES + Integer.BYTES;
            for (Target target : intent.targets) {
                byte[] targetName = target.targetName.getBytes(StandardCharsets.UTF_8);
                byte[] temporaryName = target.temporaryName.getBytes(StandardCharsets.UTF_8);
                targetNames.add(targetName);
                temporaryNames.add(temporaryName);
                int variable = Math.addExact(targetName.length, temporaryName.length);
                size = Math.addExact(
                    size,
                    Math.addExact(
                        1 + 1 + Long.BYTES * 2 + Integer.BYTES * 3 + DIGEST_BYTES,
                        variable
                    )
                );
            }
            if (size > MAX_INTENT_BYTES - PersistenceCrypto.HEADER_BYTES - PersistenceCrypto.TAG_BYTES) {
                throw new ArithmeticException("intent bound exceeded");
            }
            ByteBuffer buffer = ByteBuffer.allocate(size).order(ByteOrder.BIG_ENDIAN)
                .put(INTENT_VERSION)
                .putLong(intent.sequence)
                .putInt(intent.targets.size());
            for (int index = 0; index < intent.targets.size(); index++) {
                Target target = intent.targets.get(index);
                byte[] targetName = targetNames.get(index);
                byte[] temporaryName = temporaryNames.get(index);
                buffer.put(target.kind)
                    .put((byte) (target.replace ? 1 : 0))
                    .putLong(target.sequence)
                    .putLong(target.expectedSize)
                    .putInt(targetName.length)
                    .putInt(temporaryName.length)
                    .putInt(target.expectedDigest.length)
                    .put(targetName)
                    .put(temporaryName)
                    .put(target.expectedDigest);
            }
            return buffer.array();
        } catch (ArithmeticException error) {
            throw new SdkException("persistence_bounds_exceeded", "persistence intent is too large");
        } finally {
            for (byte[] value : targetNames) {
                Arrays.fill(value, (byte) 0);
            }
            for (byte[] value : temporaryNames) {
                Arrays.fill(value, (byte) 0);
            }
        }
    }

    private static Intent decodeIntent(long headerSequence, byte[] plaintext) {
        ByteBuffer buffer = ByteBuffer.wrap(plaintext).order(ByteOrder.BIG_ENDIAN);
        int headerBytes = 1 + Long.BYTES + Integer.BYTES;
        if (buffer.remaining() < headerBytes || buffer.get() != INTENT_VERSION) {
            PersistenceCrypto.integrityFailure();
        }
        long sequence = buffer.getLong();
        int targetCount = buffer.getInt();
        if (sequence <= 0L || sequence != headerSequence || targetCount < 1 || targetCount > 2) {
            PersistenceCrypto.integrityFailure();
        }
        List<Target> targets = new ArrayList<>();
        for (int index = 0; index < targetCount; index++) {
            targets.add(decodeTarget(buffer, sequence));
        }
        if (buffer.hasRemaining()) {
            PersistenceCrypto.integrityFailure();
        }
        validateIntentShape(targets);
        return new Intent(sequence, targets);
    }

    private static Target decodeTarget(ByteBuffer buffer, long intentSequence) {
        int fixed = 1 + 1 + Long.BYTES * 2 + Integer.BYTES * 3 + DIGEST_BYTES;
        if (buffer.remaining() < fixed) {
            PersistenceCrypto.integrityFailure();
        }
        byte kind = buffer.get();
        byte replaceValue = buffer.get();
        long sequence = buffer.getLong();
        long expectedSize = buffer.getLong();
        int targetLength = buffer.getInt();
        int temporaryLength = buffer.getInt();
        int digestLength = buffer.getInt();
        long variable = (long) targetLength + temporaryLength + digestLength;
        if (sequence != intentSequence
            || (replaceValue != 0 && replaceValue != 1)
            || expectedSize <= 0L
            || targetLength <= 0
            || temporaryLength <= 0
            || digestLength != DIGEST_BYTES
            || variable > buffer.remaining()) {
            PersistenceCrypto.integrityFailure();
        }
        byte[] target = new byte[targetLength];
        byte[] temporary = new byte[temporaryLength];
        byte[] digest = new byte[DIGEST_BYTES];
        buffer.get(target).get(temporary).get(digest);
        try {
            String targetName = decodeUtf8(target);
            String temporaryName = decodeUtf8(temporary);
            validateIntentNames(kind, sequence, targetName, temporaryName);
            return new Target(
                kind,
                sequence,
                replaceValue == 1,
                targetName,
                temporaryName,
                expectedSize,
                digest,
                null
            );
        } finally {
            Arrays.fill(target, (byte) 0);
            Arrays.fill(temporary, (byte) 0);
        }
    }

    private static void validateIntentShape(List<Target> targets) {
        if (targets.size() == 1) {
            Target checkpoint = targets.get(0);
            if (checkpoint.kind != PersistenceCrypto.CHECKPOINT || !checkpoint.replace) {
                PersistenceCrypto.integrityFailure();
            }
            return;
        }
        Target record = targets.get(0);
        Target highWater = targets.get(1);
        if (record.kind != PersistenceCrypto.RECORD
            || record.replace
            || highWater.kind != PersistenceCrypto.HIGH_WATER
            || !highWater.replace
            || record.sequence != highWater.sequence) {
            PersistenceCrypto.integrityFailure();
        }
    }

    private static void validateIntentNames(
        byte kind,
        long sequence,
        String target,
        String temporary
    ) {
        String expectedTarget;
        if (kind == PersistenceCrypto.CHECKPOINT) {
            expectedTarget = PersistenceFiles.CHECKPOINT_NAME;
        } else if (kind == PersistenceCrypto.HIGH_WATER) {
            expectedTarget = PersistenceFiles.HIGH_WATER_NAME;
        } else if (kind == PersistenceCrypto.RECORD) {
            expectedTarget = String.format(java.util.Locale.ROOT, "%020d.lbe", Long.valueOf(sequence));
        } else {
            PersistenceCrypto.integrityFailure();
            throw new AssertionError("unreachable");
        }
        if (!expectedTarget.equals(target)
            || !temporary.matches("\\.pending-[0-9a-f]{32}\\.tmp")) {
            PersistenceCrypto.integrityFailure();
        }
    }

    private static String decodeUtf8(byte[] value) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(value))
                .toString();
        } catch (CharacterCodingException error) {
            PersistenceCrypto.integrityFailure();
            throw new AssertionError("unreachable");
        }
    }

    private static SdkException ambiguous(String message) {
        return new SdkException("persistence_ambiguous", message);
    }

    private static final class Intent {
        private final long sequence;
        private final List<Target> targets;

        private Intent(long sequence, List<Target> targets) {
            this.sequence = sequence;
            this.targets = Collections.unmodifiableList(new ArrayList<>(targets));
            validateIntentShape(this.targets);
        }
    }

    private static final class Target {
        private final byte kind;
        private final long sequence;
        private final boolean replace;
        private final String targetName;
        private final String temporaryName;
        private final long expectedSize;
        private final byte[] expectedDigest;
        private final byte[] encoded;

        private Target(byte kind, long sequence, boolean replace, Path target, byte[] encoded) {
            this(
                kind,
                sequence,
                replace,
                target.getFileName().toString(),
                null,
                0L,
                null,
                encoded
            );
        }

        private Target(
            byte kind,
            long sequence,
            boolean replace,
            String targetName,
            String temporaryName,
            long expectedSize,
            byte[] expectedDigest,
            byte[] encoded
        ) {
            this.kind = kind;
            this.sequence = sequence;
            this.replace = replace;
            this.targetName = targetName;
            this.temporaryName = temporaryName;
            this.expectedSize = expectedSize;
            this.expectedDigest = expectedDigest;
            this.encoded = encoded;
        }

        private Target withTemporary(String temporaryName, long expectedSize, byte[] expectedDigest) {
            return new Target(
                kind,
                sequence,
                replace,
                targetName,
                temporaryName,
                expectedSize,
                expectedDigest,
                null
            );
        }
    }

    private static final class PendingTarget {
        private final Target target;
        private final PersistenceFiles.OwnedFile file;
        private final Object fileKey;

        private PendingTarget(Target target, PersistenceFiles.OwnedFile file, Object fileKey) {
            this.target = target;
            this.file = file;
            this.fileKey = fileKey;
        }
    }
}
