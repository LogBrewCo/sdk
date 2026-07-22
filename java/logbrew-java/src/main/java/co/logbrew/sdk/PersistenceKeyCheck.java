package co.logbrew.sdk;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Arrays;

/** Creates and verifies the encrypted store identity without retaining the caller's key. */
final class PersistenceKeyCheck {
    private static final int STORE_ID_BYTES = 16;
    private static final int MAX_METADATA_BYTES = 8192;

    private PersistenceKeyCheck() { }

    static byte[] initialize(PersistenceFiles files, PersistenceCrypto crypto) {
        Path keyCheck = files.path(PersistenceFiles.KEY_CHECK_NAME);
        if (files.exists(keyCheck)) {
            if (!files.exists(files.path(PersistenceFiles.HIGH_WATER_NAME))
                && !files.exists(files.path(PersistenceFiles.PURGE_INTENT_NAME))) {
                PersistenceCrypto.integrityFailure();
            }
            PersistenceFiles.FileData data = files.read(keyCheck, MAX_METADATA_BYTES);
            byte[] storeId = crypto.decrypt(
                PersistenceCrypto.KEY_CHECK,
                0L,
                data.bytes,
                new byte[0]
            );
            Arrays.fill(data.bytes, (byte) 0);
            if (storeId.length != STORE_ID_BYTES) {
                Arrays.fill(storeId, (byte) 0);
                PersistenceCrypto.integrityFailure();
            }
            return storeId;
        }

        PersistenceFiles.Layout layout = files.layout();
        if (isRecoverableEmptyInitialization(layout)) {
            try {
                for (Path path : layout.temporaryFiles) {
                    files.delete(path);
                }
                if (layout.highWaterFile != null) {
                    files.delete(layout.highWaterFile);
                }
                files.syncDirectory();
                layout = files.layout();
            } catch (IOException error) {
                throw new SdkException(
                    "persistence_ambiguous",
                    "incomplete empty-store key check could not be recovered"
                );
            }
        }
        if (!layout.recordFiles.isEmpty()
            || layout.checkpointFile != null
            || layout.highWaterFile != null
            || layout.intentFile != null
            || layout.purgeIntentFile != null
            || !layout.temporaryFiles.isEmpty()) {
            PersistenceCrypto.integrityFailure();
        }

        byte[] storeId = new byte[STORE_ID_BYTES];
        new SecureRandom().nextBytes(storeId);
        byte[] encoded = crypto.encrypt(PersistenceCrypto.KEY_CHECK, 0L, storeId, new byte[0]);
        PersistenceFiles.OwnedFile temporary = null;
        try {
            writeEmptyHighWater(files, crypto, storeId);
            temporary = files.createTemporary("key-pending");
            PersistenceFiles.FileIdentity identity = files.writeAndForce(temporary, encoded);
            files.move(temporary, keyCheck, false);
            files.syncDirectory();
            PersistenceFiles.FileIdentity committed = files.verifyExact(
                keyCheck,
                identity.size,
                identity.digest,
                identity.fileKey
            );
            if (!identity.fileKey.equals(committed.fileKey)) {
                PersistenceCrypto.integrityFailure();
            }
            return storeId;
        } catch (IOException error) {
            Arrays.fill(storeId, (byte) 0);
            throw new SdkException("persistence_ambiguous", "persistence key check is incomplete");
        } finally {
            PersistenceFiles.closeQuietly(temporary);
            Arrays.fill(encoded, (byte) 0);
        }
    }

    private static boolean isRecoverableEmptyInitialization(PersistenceFiles.Layout layout) {
        if (!layout.recordFiles.isEmpty()
            || layout.checkpointFile != null
            || layout.intentFile != null
            || layout.purgeIntentFile != null
            || (layout.highWaterFile == null && layout.temporaryFiles.isEmpty())) {
            return false;
        }
        for (Path path : layout.temporaryFiles) {
            if (!path.getFileName().toString().startsWith(".key-pending-")) {
                return false;
            }
        }
        return true;
    }

    static void writeEmptyHighWater(
        PersistenceFiles files,
        PersistenceCrypto crypto,
        byte[] storeId
    ) throws IOException {
        byte[] payload = ByteBuffer.allocate(Long.BYTES).order(ByteOrder.BIG_ENDIAN)
            .putLong(0L)
            .array();
        byte[] encoded = crypto.encrypt(PersistenceCrypto.HIGH_WATER, 0L, payload, storeId);
        PersistenceFiles.OwnedFile temporary = null;
        try {
            temporary = files.createTemporary("key-pending");
            PersistenceFiles.FileIdentity identity = files.writeAndForce(temporary, encoded);
            Path target = files.path(PersistenceFiles.HIGH_WATER_NAME);
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
            Arrays.fill(payload, (byte) 0);
            Arrays.fill(encoded, (byte) 0);
        }
    }
}
