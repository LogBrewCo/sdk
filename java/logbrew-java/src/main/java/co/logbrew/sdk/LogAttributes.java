package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Public payload fields for a log event.
 */
public final class LogAttributes {
    private final String message;
    private final String level;
    private String logger;
    private Map<String, ?> metadata;

    private LogAttributes(String message, String level) {
        this.message = message;
        this.level = level;
    }

    /**
     * Creates log attributes with the required message and level.
     */
    public static LogAttributes create(String message, String level) {
        return new LogAttributes(message, level);
    }

    /**
     * Sets the optional logger name.
     */
    public LogAttributes logger(String logger) {
        this.logger = logger;
        return this;
    }

    /**
     * Sets optional public metadata values.
     */
    public LogAttributes metadata(Map<String, ?> metadata) {
        this.metadata = Validation.copyMetadata(metadata);
        return this;
    }

    Map<String, Object> toMap() {
        Validation.requireNonEmpty("log message", message);
        String normalizedLevel = Validation.normalizeSeverity("log level", level);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("message", message);
        value.put("level", normalizedLevel);
        Validation.putOptionalString(value, "logger", logger);
        Validation.putOptionalMetadata(value, metadata);
        return value;
    }
}
