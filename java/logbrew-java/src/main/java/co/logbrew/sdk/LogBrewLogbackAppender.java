package co.logbrew.sdk;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.StackTraceElementProxy;
import ch.qos.logback.core.AppenderBase;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.slf4j.Marker;
import org.slf4j.event.KeyValuePair;

/**
 * Logback appender that queues SLF4J/Logback events as LogBrew log events.
 */
public final class LogBrewLogbackAppender extends AppenderBase<ILoggingEvent> {
    private LogBrewClient client;
    private Transport transport;
    private boolean flushOnAppend;
    private boolean includeThrowableStackTrace;
    private String eventIdPrefix = "logback";
    private Map<String, Object> baseMetadata = Collections.emptyMap();
    private long nextEventNumber;

    /**
     * Creates an appender for programmatic Logback configuration.
     */
    public LogBrewLogbackAppender() {
    }

    /**
     * Creates an appender that queues events on the provided client.
     */
    public LogBrewLogbackAppender(LogBrewClient client) {
        this.client = Objects.requireNonNull(client, "client");
    }

    /**
     * Creates an appender with optional flush-on-append behavior.
     */
    public LogBrewLogbackAppender(LogBrewClient client, Transport transport, boolean flushOnAppend) {
        this.client = Objects.requireNonNull(client, "client");
        this.transport = transport;
        this.flushOnAppend = flushOnAppend;
    }

    /**
     * Sets the client used to queue events.
     */
    public void setClient(LogBrewClient client) {
        this.client = Objects.requireNonNull(client, "client");
    }

    /**
     * Sets the transport used when flushing from the appender.
     */
    public void setTransport(Transport transport) {
        this.transport = transport;
    }

    /**
     * Enables or disables flushing after each appended event when a transport is set.
     */
    public void setFlushOnAppend(boolean flushOnAppend) {
        this.flushOnAppend = flushOnAppend;
    }

    /**
     * Enables or disables throwable stack-trace metadata.
     */
    public void setIncludeThrowableStackTrace(boolean includeThrowableStackTrace) {
        this.includeThrowableStackTrace = includeThrowableStackTrace;
    }

    /**
     * Sets the prefix for generated event ids.
     */
    public void setEventIdPrefix(String eventIdPrefix) {
        Validation.requireNonEmpty("event id prefix", eventIdPrefix);
        this.eventIdPrefix = eventIdPrefix;
    }

    /**
     * Sets primitive metadata copied onto every captured event.
     */
    public void setMetadata(Map<String, ?> metadata) {
        Map<String, Object> copiedMetadata = Validation.copyMetadata(metadata);
        baseMetadata = copiedMetadata == null ? Collections.emptyMap() : copiedMetadata;
    }

    /**
     * Converts a Logback event into LogBrew log attributes without stack-trace text.
     */
    public static LogAttributes logAttributesFromEvent(ILoggingEvent event) {
        return logAttributesFromEvent(event, false, null);
    }

    /**
     * Converts a Logback event into LogBrew log attributes.
     */
    public static LogAttributes logAttributesFromEvent(
        ILoggingEvent event,
        boolean includeThrowableStackTrace
    ) {
        return logAttributesFromEvent(event, includeThrowableStackTrace, null);
    }

    /**
     * Converts a Logback event into LogBrew log attributes with optional base metadata.
     */
    public static LogAttributes logAttributesFromEvent(
        ILoggingEvent event,
        boolean includeThrowableStackTrace,
        Map<String, ?> metadata
    ) {
        Objects.requireNonNull(event, "event");
        LogAttributes attributes = LogAttributes.create(messageFromEvent(event), logbrewLevel(event.getLevel()));
        String loggerName = event.getLoggerName();
        if (loggerName != null && !loggerName.trim().isEmpty()) {
            attributes.logger(loggerName);
        }
        return attributes.metadata(metadataFromEvent(event, includeThrowableStackTrace, metadata));
    }

    /**
     * Converts a Logback event timestamp into the LogBrew event timestamp format.
     */
    public static String timestampFromEvent(ILoggingEvent event) {
        Instant instant = Objects.requireNonNull(event, "event").getInstant();
        return instant.toString();
    }

    /**
     * Maps Logback levels to LogBrew log levels.
     */
    public static String logbrewLevel(Level level) {
        if (level == null) {
            return "info";
        }
        if (level.isGreaterOrEqual(Level.ERROR)) {
            return "error";
        }
        if (level.isGreaterOrEqual(Level.WARN)) {
            return "warning";
        }
        if (level.isGreaterOrEqual(Level.INFO)) {
            return "info";
        }
        return "debug";
    }

    /**
     * Returns primitive metadata captured from a Logback event.
     */
    public static Map<String, Object> metadataFromEvent(
        ILoggingEvent event,
        boolean includeThrowableStackTrace,
        Map<String, ?> metadata
    ) {
        Objects.requireNonNull(event, "event");
        Map<String, Object> values = new LinkedHashMap<>();
        Map<String, Object> copiedMetadata = Validation.copyMetadata(metadata);
        if (copiedMetadata != null) {
            values.putAll(copiedMetadata);
        }

        values.put("source", "logback");
        putIfPresent(values, "javaLoggerName", event.getLoggerName());
        Level level = event.getLevel();
        if (level != null) {
            putIfPresent(values, "slf4jLevel", level.toString());
            values.put("logbackLevelValue", Integer.valueOf(level.levelInt));
        }
        putIfPresent(values, "threadName", event.getThreadName());
        long sequenceNumber = event.getSequenceNumber();
        if (sequenceNumber > 0L) {
            values.put("sequenceNumber", Long.valueOf(sequenceNumber));
        }
        copyMarkers(values, event.getMarkerList());
        copyMappedContext(values, event.getMDCPropertyMap());
        copyKeyValuePairs(values, event.getKeyValuePairs());
        copyCallerData(values, event);
        copyThrowable(values, event.getThrowableProxy(), includeThrowableStackTrace);
        return Collections.unmodifiableMap(values);
    }

    @Override
    public void start() {
        if (client == null) {
            addError("LogBrewLogbackAppender requires a LogBrewClient");
            return;
        }
        try {
            Validation.requireNonEmpty("event id prefix", eventIdPrefix);
        } catch (RuntimeException error) {
            addError("LogBrewLogbackAppender has invalid configuration", error);
            return;
        }
        super.start();
    }

    @Override
    public void stop() {
        flushTransport();
        super.stop();
    }

    @Override
    protected void append(ILoggingEvent event) {
        if (event == null || client == null || client.isClosed()) {
            return;
        }
        try {
            event.prepareForDeferredProcessing();
            client.log(
                nextEventId(),
                timestampFromEvent(event),
                logAttributesFromEvent(event, includeThrowableStackTrace, baseMetadata)
            );
            if (flushOnAppend) {
                flushTransport();
            }
        } catch (RuntimeException error) {
            addError("failed to append LogBrew Logback event", error);
        }
    }

    private void flushTransport() {
        if (transport == null || client == null || client.isClosed() || client.pendingEvents() == 0) {
            return;
        }
        try {
            client.flush(transport);
        } catch (RuntimeException error) {
            addError("failed to flush LogBrew Logback events", error);
        }
    }

    private String nextEventId() {
        nextEventNumber++;
        return eventIdPrefix + "_" + nextEventNumber;
    }

    private static String messageFromEvent(ILoggingEvent event) {
        String message = event.getFormattedMessage();
        if (message != null && !message.trim().isEmpty()) {
            return message;
        }
        IThrowableProxy throwable = event.getThrowableProxy();
        if (throwable != null) {
            String throwableMessage = throwable.getMessage();
            return throwableMessage == null || throwableMessage.trim().isEmpty()
                ? simpleClassName(throwable.getClassName())
                : throwableMessage;
        }
        Level level = event.getLevel();
        return level == null ? "Logback event" : level.toString();
    }

    private static void copyMarkers(Map<String, Object> values, List<Marker> markers) {
        if (markers == null || markers.isEmpty()) {
            return;
        }
        StringBuilder markerNames = new StringBuilder();
        for (Marker marker : markers) {
            if (marker == null || marker.getName() == null || marker.getName().trim().isEmpty()) {
                continue;
            }
            if (markerNames.length() > 0) {
                markerNames.append(',');
            }
            markerNames.append(marker.getName());
        }
        if (markerNames.length() > 0) {
            values.put("slf4jMarkers", markerNames.toString());
        }
    }

    private static void copyMappedContext(Map<String, Object> values, Map<String, String> mappedContext) {
        if (mappedContext == null) {
            return;
        }
        for (Map.Entry<String, String> entry : mappedContext.entrySet()) {
            String key = entry.getKey();
            if (key != null && !key.trim().isEmpty()) {
                putIfPresent(values, "mdc." + key, entry.getValue());
            }
        }
    }

    private static void copyKeyValuePairs(Map<String, Object> values, List<KeyValuePair> keyValuePairs) {
        if (keyValuePairs == null) {
            return;
        }
        for (KeyValuePair pair : keyValuePairs) {
            if (pair != null && pair.key != null && !pair.key.trim().isEmpty()) {
                putPrimitive(values, "kv." + pair.key, pair.value);
            }
        }
    }

    private static void copyCallerData(Map<String, Object> values, ILoggingEvent event) {
        if (!event.hasCallerData()) {
            return;
        }
        StackTraceElement[] callerData = event.getCallerData();
        if (callerData == null || callerData.length == 0) {
            return;
        }
        StackTraceElement caller = callerData[0];
        putIfPresent(values, "sourceClassName", caller.getClassName());
        putIfPresent(values, "sourceMethodName", caller.getMethodName());
        putIfPresent(values, "sourceFileName", caller.getFileName());
        if (caller.getLineNumber() >= 0) {
            values.put("sourceLineNumber", Integer.valueOf(caller.getLineNumber()));
        }
    }

    private static void copyThrowable(
        Map<String, Object> values,
        IThrowableProxy throwable,
        boolean includeThrowableStackTrace
    ) {
        if (throwable == null) {
            return;
        }
        putIfPresent(values, "exceptionType", simpleClassName(throwable.getClassName()));
        putIfPresent(values, "exceptionMessage", throwable.getMessage());
        if (includeThrowableStackTrace) {
            values.put("logbackStackTrace", stackTraceText(throwable));
        }
    }

    private static String stackTraceText(IThrowableProxy throwable) {
        StringBuilder builder = new StringBuilder();
        putStackTraceText(builder, throwable, "");
        return builder.toString();
    }

    private static void putStackTraceText(StringBuilder builder, IThrowableProxy throwable, String prefix) {
        if (throwable == null) {
            return;
        }
        builder.append(prefix).append(throwable.getClassName());
        if (throwable.getMessage() != null) {
            builder.append(": ").append(throwable.getMessage());
        }
        builder.append('\n');
        StackTraceElementProxy[] stackTrace = throwable.getStackTraceElementProxyArray();
        if (stackTrace != null) {
            for (StackTraceElementProxy element : stackTrace) {
                builder.append(prefix).append("\tat ").append(element).append('\n');
            }
        }
        putStackTraceText(builder, throwable.getCause(), "Caused by: ");
    }

    private static void putIfPresent(Map<String, Object> values, String key, String value) {
        if (value != null && !value.trim().isEmpty()) {
            values.put(key, value);
        }
    }

    private static void putPrimitive(Map<String, Object> values, String key, Object value) {
        if (value == null || value instanceof String || value instanceof Boolean) {
            values.put(key, value);
            return;
        }
        if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte) {
            values.put(key, value);
            return;
        }
        if (value instanceof Float) {
            Float number = (Float) value;
            if (!number.isNaN() && !number.isInfinite()) {
                values.put(key, number);
            }
            return;
        }
        if (value instanceof Double) {
            Double number = (Double) value;
            if (!number.isNaN() && !number.isInfinite()) {
                values.put(key, number);
            }
        }
    }

    private static String simpleClassName(String className) {
        if (className == null || className.trim().isEmpty()) {
            return null;
        }
        int separator = className.lastIndexOf('.');
        return separator < 0 ? className : className.substring(separator + 1);
    }
}
