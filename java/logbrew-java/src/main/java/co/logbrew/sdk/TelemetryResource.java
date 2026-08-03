package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/** Immutable shared service, deployment, runtime, and application identity. */
public final class TelemetryResource {
    private final Map<String, Object> value;

    private TelemetryResource(Map<String, Object> value) {
        this.value = TelemetryValues.immutableMap(value);
    }

    /** Returns a new resource builder. */
    public static Builder builder() {
        return new Builder();
    }

    /** Returns an immutable schema-shaped map. */
    public Map<String, Object> asMap() {
        return value;
    }

    Map<String, Object> value() {
        return value;
    }

    /** Builder for bounded resource sections. */
    public static final class Builder {
        private final Map<String, Object> sections = new LinkedHashMap<>();

        private Builder() {
        }

        /** Sets service name and optional version. */
        public Builder service(String name, String version) {
            sections.put("service", namedVersion(name, version, "service"));
            return this;
        }

        /** Sets deployment environment and optional release identity. */
        public Builder deployment(String environment, String release) {
            Map<String, Object> deployment = new LinkedHashMap<>();
            put(deployment, "environment", TelemetryValues.optionalString(environment, "deployment environment"));
            put(deployment, "release", TelemetryValues.optionalString(release, "deployment release"));
            requireSection(deployment, "deployment");
            sections.put("deployment", deployment);
            return this;
        }

        /** Sets runtime name and optional version. */
        public Builder runtime(String name, String version) {
            sections.put("runtime", namedVersion(name, version, "runtime"));
            return this;
        }

        /** Sets framework name and optional version. */
        public Builder framework(String name, String version) {
            sections.put("framework", namedVersion(name, version, "framework"));
            return this;
        }

        /** Sets operating-system family and optional version/build. */
        public Builder operatingSystem(String name, String version, String build) {
            Map<String, Object> operatingSystem = new LinkedHashMap<>();
            operatingSystem.put("name", TelemetryValues.requiredString(name, "operatingSystem name"));
            put(operatingSystem, "version", TelemetryValues.optionalString(version, "operatingSystem version"));
            put(operatingSystem, "build", TelemetryValues.optionalString(build, "operatingSystem build"));
            sections.put("operatingSystem", operatingSystem);
            return this;
        }

        /** Sets broad device family, model, and architecture values. */
        public Builder device(String family, String model, String architecture) {
            Map<String, Object> device = new LinkedHashMap<>();
            put(device, "family", TelemetryValues.optionalString(family, "device family"));
            put(device, "model", TelemetryValues.optionalString(model, "device model"));
            put(device, "architecture", TelemetryValues.optionalString(architecture, "device architecture"));
            requireSection(device, "device");
            sections.put("device", device);
            return this;
        }

        /** Sets application name, version, and build identity. */
        public Builder application(String name, String version, String build) {
            Map<String, Object> application = new LinkedHashMap<>();
            put(application, "name", TelemetryValues.optionalString(name, "application name"));
            put(application, "version", TelemetryValues.optionalString(version, "application version"));
            put(application, "build", TelemetryValues.optionalString(build, "application build"));
            requireSection(application, "application");
            sections.put("application", application);
            return this;
        }

        /** Builds one non-empty immutable resource. */
        public TelemetryResource build() {
            if (sections.isEmpty()) {
                throw TelemetryValues.invalid("telemetry resource must not be empty");
            }
            return new TelemetryResource(sections);
        }

        private static Map<String, Object> namedVersion(String name, String version, String label) {
            Map<String, Object> section = new LinkedHashMap<>();
            section.put("name", TelemetryValues.requiredString(name, label + " name"));
            put(section, "version", TelemetryValues.optionalString(version, label + " version"));
            return section;
        }

        private static void requireSection(Map<String, Object> section, String label) {
            if (section.isEmpty()) {
                throw TelemetryValues.invalid(label + " must not be empty");
            }
        }

        private static void put(Map<String, Object> target, String key, String value) {
            if (value != null) {
                target.put(key, value);
            }
        }
    }
}
