package co.logbrew.sdk;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Authenticated record encoding owned by {@link EncryptedEventStore}. */
final class PersistenceCrypto implements AutoCloseable {
    static final byte RECORD = 1;
    static final byte CHECKPOINT = 2;
    static final byte KEY_CHECK = 3;
    static final byte INTENT = 4;
    static final byte PURGE = 5;
    static final byte HIGH_WATER = 6;
    static final int TAG_BYTES = 16;
    static final int HEADER_BYTES = 4 + 1 + 1 + 8 + 12 + 4;

    private static final int MAGIC = 0x4c425045;
    private static final byte VERSION = 1;
    private static final int NONCE_BYTES = 12;

    private final byte[] key;
    private final SecureRandom random = new SecureRandom();
    private boolean closed;

    PersistenceCrypto(byte[] callerKey) {
        if (callerKey.length != 16 && callerKey.length != 24 && callerKey.length != 32) {
            throw new SdkException(
                "persistence_key_invalid",
                "persistence key must contain 16, 24, or 32 bytes"
            );
        }
        key = callerKey.clone();
    }

    byte[] encrypt(byte kind, long sequence, byte[] plaintext, byte[] context) {
        ensureOpen();
        byte[] nonce = new byte[NONCE_BYTES];
        random.nextBytes(nonce);
        try {
            int cipherLength = Math.addExact(plaintext.length, TAG_BYTES);
            ByteBuffer header = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.BIG_ENDIAN);
            header.putInt(MAGIC);
            header.put(VERSION);
            header.put(kind);
            header.putLong(sequence);
            header.put(nonce);
            header.putInt(cipherLength);

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.ENCRYPT_MODE,
                new SecretKeySpec(key, "AES"),
                new GCMParameterSpec(TAG_BYTES * Byte.SIZE, nonce)
            );
            cipher.updateAAD(header.array());
            cipher.updateAAD(context);
            byte[] ciphertext = cipher.doFinal(plaintext);
            try {
                return ByteBuffer.allocate(HEADER_BYTES + ciphertext.length)
                    .put(header.array())
                    .put(ciphertext)
                    .array();
            } finally {
                Arrays.fill(ciphertext, (byte) 0);
            }
        } catch (GeneralSecurityException | ArithmeticException error) {
            throw new SdkException(
                "persistence_error",
                "authenticated persistence encryption failed"
            );
        } finally {
            Arrays.fill(nonce, (byte) 0);
        }
    }

    byte[] decrypt(byte expectedKind, long expectedSequence, byte[] encoded, byte[] context) {
        ensureOpen();
        Header header = parseHeader(encoded);
        if (header.kind != expectedKind || header.sequence != expectedSequence) {
            integrityFailure();
        }
        byte[] headerBytes = Arrays.copyOf(encoded, HEADER_BYTES);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                new SecretKeySpec(key, "AES"),
                new GCMParameterSpec(TAG_BYTES * Byte.SIZE, header.nonce)
            );
            cipher.updateAAD(headerBytes);
            cipher.updateAAD(context);
            return cipher.doFinal(encoded, HEADER_BYTES, header.ciphertextLength);
        } catch (AEADBadTagException error) {
            integrityFailure();
            throw new AssertionError("unreachable");
        } catch (GeneralSecurityException error) {
            throw new SdkException(
                "persistence_error",
                "authenticated persistence decryption failed"
            );
        } finally {
            Arrays.fill(headerBytes, (byte) 0);
            Arrays.fill(header.nonce, (byte) 0);
        }
    }

    Header header(byte[] encoded) {
        return parseHeader(encoded);
    }

    static byte[] digest(byte[] value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value);
        } catch (NoSuchAlgorithmException error) {
            throw new SdkException("persistence_unsupported", "SHA-256 is unavailable");
        }
    }

    static void integrityFailure() {
        throw new SdkException(
            "persistence_integrity_error",
            "persistence authentication or ownership failed"
        );
    }

    @Override
    public void close() {
        if (!closed) {
            closed = true;
            Arrays.fill(key, (byte) 0);
        }
    }

    private static Header parseHeader(byte[] encoded) {
        if (encoded.length < HEADER_BYTES + TAG_BYTES) {
            integrityFailure();
        }
        ByteBuffer buffer = ByteBuffer.wrap(encoded, 0, HEADER_BYTES).order(ByteOrder.BIG_ENDIAN);
        int magic = buffer.getInt();
        byte version = buffer.get();
        byte kind = buffer.get();
        long sequence = buffer.getLong();
        byte[] nonce = new byte[NONCE_BYTES];
        buffer.get(nonce);
        int cipherLength = buffer.getInt();
        if (magic != MAGIC
            || version != VERSION
            || sequence < 0L
            || cipherLength < TAG_BYTES
            || cipherLength != encoded.length - HEADER_BYTES) {
            Arrays.fill(nonce, (byte) 0);
            integrityFailure();
        }
        return new Header(kind, sequence, nonce, cipherLength);
    }

    private void ensureOpen() {
        if (closed) {
            throw new SdkException("persistence_closed", "persistence store is closed");
        }
    }

    static final class Header {
        final byte kind;
        final long sequence;
        final byte[] nonce;
        final int ciphertextLength;

        Header(byte kind, long sequence, byte[] nonce, int ciphertextLength) {
            this.kind = kind;
            this.sequence = sequence;
            this.nonce = nonce;
            this.ciphertextLength = ciphertextLength;
        }
    }
}
