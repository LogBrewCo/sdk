package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Public payload fields for an issue event.
 */
public final class IssueAttributes {
    private final String title;
    private final String level;
    private String message;
    private Map<String, ?> metadata;

    private IssueAttributes(String title, String level) {
        this.title = title;
        this.level = level;
    }

    /**
     * Creates issue attributes with the required title and level.
     */
    public static IssueAttributes create(String title, String level) {
        return new IssueAttributes(title, level);
    }

    /**
     * Sets the optional issue message.
     */
    public IssueAttributes message(String message) {
        this.message = message;
        return this;
    }

    /**
     * Sets optional public metadata values.
     */
    public IssueAttributes metadata(Map<String, ?> metadata) {
        this.metadata = Validation.copyMetadata(metadata);
        return this;
    }

    Map<String, Object> toMap() {
        Validation.requireNonEmpty("issue title", title);
        String normalizedLevel = Validation.normalizeSeverity("issue level", level);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("title", title);
        value.put("level", normalizedLevel);
        Validation.putOptionalString(value, "message", message);
        Validation.putOptionalMetadata(value, metadata);
        return value;
    }
}
