package co.logbrew.sdk;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.logging.ErrorManager;
import java.util.logging.Formatter;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;

/**
 * Standard {@code java.util.logging} handler that queues JUL records as LogBrew log events.
 */
public final class LogBrewJulHandler extends Handler {
    private static final Formatter MESSAGE_FORMATTER = new MessageFormatter();

    private final LogBrewClient client;
    private final Transport transport;
    private final boolean flushOnPublish;
    private final boolean includeThrownStackTrace;
    private final Map<String, Object> baseMetadata;
    private boolean closed;

    /**
     * Creates a handler that queues records on the provided client.
     */
    public LogBrewJulHandler(LogBrewClient client) {
        this(client, null, false, false, null);
    }

    /**
     * Creates a handler that can flush queued records through a transport when {@link #flush()} is called.
     */
    public LogBrewJulHandler(LogBrewClient client, Transport transport) {
        this(client, transport, false, false, null);
    }

    /**
     * Creates a handler with optional flush-on-publish behavior.
     */
    public LogBrewJulHandler(LogBrewClient client, Transport transport, boolean flushOnPublish) {
        this(client, transport, flushOnPublish, false, null);
    }

    /**
     * Creates a handler with optional stack-trace metadata for thrown exceptions.
     */
    public LogBrewJulHandler(
        LogBrewClient client,
        Transport transport,
        boolean flushOnPublish,
        boolean includeThrownStackTrace
    ) {
        this(client, transport, flushOnPublish, includeThrownStackTrace, null);
    }

    /**
     * Creates a handler with optional transport, flushing, exception, and base metadata settings.
     */
    public LogBrewJulHandler(
        LogBrewClient client,
        Transport transport,
        boolean flushOnPublish,
        boolean includeThrownStackTrace,
        Map<String, ?> metadata
    ) {
        this.client = Objects.requireNonNull(client, "client");
        this.transport = transport;
        this.flushOnPublish = flushOnPublish;
        this.includeThrownStackTrace = includeThrownStackTrace;
        Map<String, Object> copiedMetadata = Validation.copyMetadata(metadata);
        this.baseMetadata = copiedMetadata == null ? Collections.emptyMap() : copiedMetadata;
    }

    /**
     * Converts a JUL record into LogBrew log attributes without stack-trace text.
     */
    public static LogAttributes logAttributesFromRecord(LogRecord record) {
        return logAttributesFromRecord(record, false, null);
    }

    /**
     * Converts a JUL record into LogBrew log attributes.
     */
    public static LogAttributes logAttributesFromRecord(LogRecord record, boolean includeThrownStackTrace) {
        return logAttributesFromRecord(record, includeThrownStackTrace, null);
    }

    /**
     * Converts a JUL record into LogBrew log attributes with optional base metadata.
     */
    public static LogAttributes logAttributesFromRecord(
        LogRecord record,
        boolean includeThrownStackTrace,
        Map<String, ?> metadata
    ) {
        Objects.requireNonNull(record, "record");
        LogAttributes attributes = LogAttributes.create(messageFromRecord(record), logbrewLevel(record.getLevel()));
        if (record.getLoggerName() != null && !record.getLoggerName().trim().isEmpty()) {
            attributes.logger(record.getLoggerName());
        }
        return attributes.metadata(metadataFromRecord(record, includeThrownStackTrace, metadata));
    }

    /**
     * Converts a JUL record timestamp into the LogBrew event timestamp format.
     */
    public static String timestampFromRecord(LogRecord record) {
        return Objects.requireNonNull(record, "record").getInstant().toString();
    }

    /**
     * Creates a deterministic event id from the JUL sequence number.
     */
    public static String defaultEventId(LogRecord record) {
        long sequenceNumber = Objects.requireNonNull(record, "record").getSequenceNumber();
        return "jul_" + Long.toUnsignedString(sequenceNumber);
    }

    /**
     * Maps JUL levels to LogBrew log levels.
     */
    public static String logbrewLevel(Level level) {
        if (level == null) {
            return "info";
        }
        int levelValue = level.intValue();
        if (levelValue >= Level.SEVERE.intValue()) {
            return "error";
        }
        if (levelValue >= Level.WARNING.intValue()) {
            return "warning";
        }
        if (levelValue >= Level.INFO.intValue()) {
            return "info";
        }
        return "debug";
    }

    /**
     * Returns primitive metadata captured from a JUL record.
     */
    public static Map<String, Object> metadataFromRecord(
        LogRecord record,
        boolean includeThrownStackTrace,
        Map<String, ?> metadata
    ) {
        Objects.requireNonNull(record, "record");
        Map<String, Object> values = new LinkedHashMap<>();
        Map<String, Object> copiedMetadata = Validation.copyMetadata(metadata);
        if (copiedMetadata != null) {
            values.putAll(copiedMetadata);
        }

        putIfPresent(values, "javaLoggerName", record.getLoggerName());
        Level level = record.getLevel();
        if (level != null) {
            putIfPresent(values, "javaLevel", level.getName());
            values.put("javaLevelValue", Integer.valueOf(level.intValue()));
        }
        putIfPresent(values, "sourceClassName", record.getSourceClassName());
        putIfPresent(values, "sourceMethodName", record.getSourceMethodName());
        putIfPresent(values, "resourceBundleName", record.getResourceBundleName());
        values.put("threadId", Integer.valueOf(record.getThreadID()));
        values.put("sequenceNumber", Long.valueOf(record.getSequenceNumber()));

        Throwable thrown = record.getThrown();
        if (thrown != null) {
            putIfPresent(values, "exceptionType", thrown.getClass().getSimpleName());
            putIfPresent(values, "exceptionMessage", thrown.getMessage());
            if (includeThrownStackTrace) {
                values.put("javaStackTrace", stackTraceText(thrown));
            }
        }
        return Collections.unmodifiableMap(values);
    }

    @Override
    public void publish(LogRecord record) {
        if (record == null || closed || client.isClosed() || !isLoggable(record)) {
            return;
        }
        try {
            client.log(
                defaultEventId(record),
                timestampFromRecord(record),
                logAttributesFromRecord(record, includeThrownStackTrace, baseMetadata)
            );
            if (flushOnPublish) {
                flushTransport();
            }
        } catch (RuntimeException error) {
            reportError("failed to publish LogBrew JUL record", error, ErrorManager.WRITE_FAILURE);
        }
    }

    @Override
    public void flush() {
        flushTransport();
    }

    @Override
    public void close() {
        if (!closed) {
            flushTransport();
            closed = true;
        }
    }

    private void flushTransport() {
        if (transport == null || client.isClosed() || client.pendingEvents() == 0) {
            return;
        }
        try {
            client.flush(transport);
        } catch (RuntimeException error) {
            reportError("failed to flush LogBrew JUL records", error, ErrorManager.FLUSH_FAILURE);
        }
    }

    private static String messageFromRecord(LogRecord record) {
        String message = MESSAGE_FORMATTER.format(record);
        if (message != null && !message.trim().isEmpty()) {
            return message;
        }
        Throwable thrown = record.getThrown();
        if (thrown != null) {
            return thrown.toString();
        }
        Level level = record.getLevel();
        if (level != null && level.getName() != null && !level.getName().trim().isEmpty()) {
            return level.getName();
        }
        return "Log record";
    }

    private static void putIfPresent(Map<String, Object> values, String key, String value) {
        if (value != null && !value.trim().isEmpty()) {
            values.put(key, value);
        }
    }

    private static String stackTraceText(Throwable thrown) {
        StringWriter writer = new StringWriter();
        thrown.printStackTrace(new PrintWriter(writer));
        return writer.toString();
    }

    private static final class MessageFormatter extends Formatter {
        @Override
        public String format(LogRecord record) {
            return formatMessage(record);
        }
    }
}
