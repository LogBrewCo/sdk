package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Public payload fields for a release event.
 */
public final class ReleaseAttributes {
    private final String version;
    private String commit;
    private String notes;
    private Map<String, ?> metadata;

    private ReleaseAttributes(String version) {
        this.version = version;
    }

    /**
     * Creates release attributes with the required release version.
     */
    public static ReleaseAttributes create(String version) {
        return new ReleaseAttributes(version);
    }

    /**
     * Sets the optional release commit.
     */
    public ReleaseAttributes commit(String commit) {
        this.commit = commit;
        return this;
    }

    /**
     * Sets optional release notes.
     */
    public ReleaseAttributes notes(String notes) {
        this.notes = notes;
        return this;
    }

    /**
     * Sets optional public metadata values.
     */
    public ReleaseAttributes metadata(Map<String, ?> metadata) {
        this.metadata = Validation.copyMetadata(metadata);
        return this;
    }

    Map<String, Object> toMap() {
        Validation.requireNonEmpty("release version", version);
        if (commit != null) {
            Validation.requireNonEmpty("release commit", commit);
        }
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("version", version);
        Validation.putOptionalString(value, "commit", commit);
        Validation.putOptionalString(value, "notes", notes);
        Validation.putOptionalMetadata(value, metadata);
        return value;
    }
}
