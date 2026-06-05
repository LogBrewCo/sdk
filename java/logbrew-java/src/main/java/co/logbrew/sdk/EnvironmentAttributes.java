package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Public payload fields for an environment event.
 */
public final class EnvironmentAttributes {
    private final String name;
    private String region;
    private Map<String, ?> metadata;

    private EnvironmentAttributes(String name) {
        this.name = name;
    }

    /**
     * Creates environment attributes with the required environment name.
     */
    public static EnvironmentAttributes create(String name) {
        return new EnvironmentAttributes(name);
    }

    /**
     * Sets the optional environment region.
     */
    public EnvironmentAttributes region(String region) {
        this.region = region;
        return this;
    }

    /**
     * Sets optional public metadata values.
     */
    public EnvironmentAttributes metadata(Map<String, ?> metadata) {
        this.metadata = Validation.copyMetadata(metadata);
        return this;
    }

    Map<String, Object> toMap() {
        Validation.requireNonEmpty("environment name", name);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("name", name);
        Validation.putOptionalString(value, "region", region);
        Validation.putOptionalMetadata(value, metadata);
        return value;
    }
}
