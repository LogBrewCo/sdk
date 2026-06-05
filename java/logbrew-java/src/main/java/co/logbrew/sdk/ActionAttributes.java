package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Public payload fields for an action event.
 */
public final class ActionAttributes {
    private final String name;
    private final String status;
    private Map<String, ?> metadata;

    private ActionAttributes(String name, String status) {
        this.name = name;
        this.status = status;
    }

    /**
     * Creates action attributes with the required action name and status.
     */
    public static ActionAttributes create(String name, String status) {
        return new ActionAttributes(name, status);
    }

    /**
     * Sets optional public metadata values.
     */
    public ActionAttributes metadata(Map<String, ?> metadata) {
        this.metadata = Validation.copyMetadata(metadata);
        return this;
    }

    Map<String, Object> toMap() {
        Validation.requireNonEmpty("action name", name);
        Validation.requireAllowedValue("action status", status, LogBrewClient.ACTION_STATUSES);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("name", name);
        value.put("status", status);
        Validation.putOptionalMetadata(value, metadata);
        return value;
    }
}
