package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One bounded oldest-to-newest step that happened before an issue.
 */
public final class IssueBreadcrumb {
    private final String timestamp;
    private final String category;
    private String type;
    private String level;
    private String message;
    private Map<String, Object> data;

    private IssueBreadcrumb(String timestamp, String category) {
        this.timestamp = timestamp;
        this.category = category;
    }

    /**
     * Creates a breadcrumb with an RFC 3339 timestamp and stable category.
     */
    public static IssueBreadcrumb create(String timestamp, String category) {
        return new IssueBreadcrumb(timestamp, category);
    }

    /**
     * Sets an optional stable breadcrumb type.
     */
    public IssueBreadcrumb type(String type) {
        this.type = type;
        return this;
    }

    /**
     * Sets an optional breadcrumb severity.
     */
    public IssueBreadcrumb level(String level) {
        this.level = level;
        return this;
    }

    /**
     * Sets an optional bounded breadcrumb message.
     */
    public IssueBreadcrumb message(String message) {
        this.message = message;
        return this;
    }

    /**
     * Sets up to eight flat finite primitive data fields.
     */
    public IssueBreadcrumb data(Map<String, ?> data) {
        this.data = IssueDiagnostics.copyBreadcrumbData(data);
        return this;
    }

    Map<String, Object> toMap() {
        IssueDiagnostics.requireBreadcrumbTimestamp(timestamp);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("timestamp", timestamp);
        value.put(
            "category",
            IssueDiagnostics.requireBreadcrumbName("issue breadcrumb category", category, true)
        );
        if (type != null) {
            value.put("type", IssueDiagnostics.requireBreadcrumbName("issue breadcrumb type", type, true));
        }
        if (level != null) {
            value.put("level", IssueDiagnostics.normalizeBreadcrumbLevel(level));
        }
        if (message != null) {
            value.put("message", IssueDiagnostics.requireBreadcrumbMessage(message));
        }
        if (data != null) {
            value.put("data", IssueDiagnostics.copyBreadcrumbData(data));
        }
        return value;
    }
}
