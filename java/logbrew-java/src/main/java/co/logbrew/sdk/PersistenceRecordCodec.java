package co.logbrew.sdk;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;

/** Canonical encrypted event and durable sequence-metadata encoding. */
final class PersistenceRecordCodec {
    private static final int MAX_METADATA_BYTES = 8192;

    private final PersistenceFiles files;
    private final PersistenceCrypto crypto;
    private final byte[] storeId;

    PersistenceRecordCodec(PersistenceFiles files, PersistenceCrypto crypto, byte[] storeId) {
        this.files = files;
        this.crypto = crypto;
        this.storeId = storeId;
    }

    byte[] encodeRecordPayload(String eventId, byte[] eventBytes) {
        byte[] idBytes = eventId.getBytes(StandardCharsets.UTF_8);
        try {
            ByteBuffer payload = ByteBuffer.allocate(
                Math.addExact(Integer.BYTES * 2, Math.addExact(idBytes.length, eventBytes.length))
            ).order(ByteOrder.BIG_ENDIAN);
            return payload.putInt(idBytes.length)
                .putInt(eventBytes.length)
                .put(idBytes)
                .put(eventBytes)
                .array();
        } catch (ArithmeticException error) {
            throw new SdkException("persistence_bounds_exceeded", "event is too large to persist");
        } finally {
            Arrays.fill(idBytes, (byte) 0);
        }
    }

    long readCheckpoint(Path path) {
        if (path == null) {
            return 0L;
        }
        return readSequence(path, PersistenceCrypto.CHECKPOINT);
    }

    long readHighWater(Path path) {
        if (path == null) {
            return 0L;
        }
        return readSequence(path, PersistenceCrypto.HIGH_WATER);
    }

    byte[] encodeSequence(long sequence) {
        return ByteBuffer.allocate(Long.BYTES).order(ByteOrder.BIG_ENDIAN)
            .putLong(sequence)
            .array();
    }

    private long readSequence(Path path, byte kind) {
        PersistenceFiles.FileData data = files.read(path, MAX_METADATA_BYTES);
        PersistenceCrypto.Header header = crypto.header(data.bytes);
        byte[] plaintext = crypto.decrypt(
            kind,
            header.sequence,
            data.bytes,
            storeId
        );
        try {
            if (plaintext.length != Long.BYTES) {
                PersistenceCrypto.integrityFailure();
            }
            long value = ByteBuffer.wrap(plaintext).order(ByteOrder.BIG_ENDIAN).getLong();
            if ((kind == PersistenceCrypto.CHECKPOINT && value <= 0L)
                || (kind == PersistenceCrypto.HIGH_WATER && value < 0L)
                || value != header.sequence) {
                PersistenceCrypto.integrityFailure();
            }
            return value;
        } finally {
            Arrays.fill(plaintext, (byte) 0);
            Arrays.fill(data.bytes, (byte) 0);
        }
    }

    EncryptedEventStore.Record readRecord(Path path, long expectedSequence, long maxEventBytes) {
        PersistenceFiles.FileData data = files.read(path, recordFileBound(maxEventBytes));
        PersistenceCrypto.Header header = crypto.header(data.bytes);
        byte[] plaintext = crypto.decrypt(
            PersistenceCrypto.RECORD,
            expectedSequence,
            data.bytes,
            storeId
        );
        try {
            if (header.sequence != expectedSequence) {
                PersistenceCrypto.integrityFailure();
            }
            ByteBuffer payload = ByteBuffer.wrap(plaintext).order(ByteOrder.BIG_ENDIAN);
            if (payload.remaining() < Integer.BYTES * 2) {
                PersistenceCrypto.integrityFailure();
            }
            int idLength = payload.getInt();
            int eventLength = payload.getInt();
            if (idLength <= 0
                || eventLength <= 0
                || eventLength > maxEventBytes
                || idLength > payload.remaining()
                || eventLength != payload.remaining() - idLength) {
                PersistenceCrypto.integrityFailure();
            }
            byte[] idBytes = new byte[idLength];
            byte[] eventBytes = new byte[eventLength];
            payload.get(idBytes).get(eventBytes);
            try {
                return new EncryptedEventStore.Record(
                    expectedSequence,
                    decodeUtf8(idBytes),
                    decodeUtf8(eventBytes),
                    eventLength,
                    path,
                    data.identity
                );
            } finally {
                Arrays.fill(idBytes, (byte) 0);
                Arrays.fill(eventBytes, (byte) 0);
            }
        } finally {
            Arrays.fill(plaintext, (byte) 0);
            Arrays.fill(data.bytes, (byte) 0);
        }
    }

    void verifyUnchanged(EncryptedEventStore.Record record) {
        PersistenceFiles.FileIdentity identity = files.verifyExact(
            record.path,
            record.fileIdentity.size,
            record.fileIdentity.digest,
            record.fileIdentity.fileKey
        );
        if (!record.fileIdentity.fileKey.equals(identity.fileKey)) {
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

    private static long recordFileBound(long maxEventBytes) {
        try {
            long payload = Math.addExact(Math.multiplyExact(maxEventBytes, 2L), 1024L);
            return Math.min(Integer.MAX_VALUE, Math.addExact(
                payload,
                PersistenceCrypto.HEADER_BYTES + PersistenceCrypto.TAG_BYTES
            ));
        } catch (ArithmeticException error) {
            return Integer.MAX_VALUE;
        }
    }
}
