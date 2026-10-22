package co.logbrew.sdk;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Saved drop counts: reason codes, counts, and a random report ID, never event data.
 *
 * <p>Version 1 is a version byte, an optional pending report, and the unreported counts. A reader
 * ignores bytes after the fields it knows, so later versions can append state.</p>
 */
final class PersistenceClientReport {
    static final int MAX_REASONS = 16;
    static final int MAX_BYTES = 4096;
    private static final byte VERSION = 1;
    private static final int MAX_COUNT = 1_000_000_000;
    private static final Pattern REPORT_ID = Pattern.compile("[A-Za-z0-9_-]{16,64}");
    private static final Pattern REASON = Pattern.compile("[a-z][a-z0-9_]{0,63}");

    final String pendingId;
    final Map<String, Integer> pending;
    final Map<String, Integer> unreported;

    PersistenceClientReport(String pendingId, Map<String, Integer> pending, Map<String, Integer> unreported) {
        this.pendingId = pendingId;
        this.pending = pending;
        this.unreported = unreported;
    }

    boolean isEmpty() {
        return pendingId == null && unreported.isEmpty();
    }

    byte[] encode() {
        ByteBuffer buffer = ByteBuffer.allocate(MAX_BYTES).put(VERSION);
        if (pendingId == null) {
            buffer.put((byte) 0);
        } else {
            byte[] id = pendingId.getBytes(StandardCharsets.US_ASCII);
            buffer.put((byte) 1).put((byte) id.length).put(id);
            putCounts(buffer, pending);
        }
        putCounts(buffer, unreported);
        byte[] encoded = new byte[buffer.position()];
        buffer.flip();
        buffer.get(encoded);
        return encoded;
    }

    /** Returns the valid part of the saved counts; anything unreadable or out of bounds is ignored. */
    static PersistenceClientReport decode(byte[] payload) {
        try {
            ByteBuffer buffer = ByteBuffer.wrap(payload);
            if (buffer.get() < VERSION) {
                return null;
            }
            String pendingId = null;
            Map<String, Integer> pending = new LinkedHashMap<>();
            if (buffer.get() == 1) {
                byte[] id = new byte[buffer.get() & 0xff];
                buffer.get(id);
                pendingId = new String(id, StandardCharsets.US_ASCII);
                pending = readCounts(buffer);
            }
            Map<String, Integer> unreported = readCounts(buffer);
            if (pendingId == null || !REPORT_ID.matcher(pendingId).matches() || pending.isEmpty()) {
                pendingId = null;
                pending = new LinkedHashMap<>();
            }
            return new PersistenceClientReport(pendingId, pending, unreported);
        } catch (RuntimeException error) {
            return null;
        }
    }

    private static void putCounts(ByteBuffer buffer, Map<String, Integer> counts) {
        buffer.put((byte) counts.size());
        for (Map.Entry<String, Integer> entry : counts.entrySet()) {
            byte[] reason = entry.getKey().getBytes(StandardCharsets.US_ASCII);
            buffer.put((byte) reason.length).put(reason).putInt(entry.getValue().intValue());
        }
    }

    private static Map<String, Integer> readCounts(ByteBuffer buffer) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        int entries = buffer.get() & 0xff;
        for (int index = 0; index < entries; index++) {
            byte[] reason = new byte[buffer.get() & 0xff];
            buffer.get(reason);
            String name = new String(reason, StandardCharsets.US_ASCII);
            int count = buffer.getInt();
            if (REASON.matcher(name).matches() && count >= 1 && count <= MAX_COUNT && counts.size() < MAX_REASONS) {
                counts.put(name, Integer.valueOf(count));
            }
        }
        return counts;
    }
}
