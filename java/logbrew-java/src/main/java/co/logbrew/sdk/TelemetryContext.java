package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** Immutable schema-v1 context shared by every LogBrew telemetry signal. */
public final class TelemetryContext {
    private static final String[] RESOURCE_SECTIONS = {
        "service",
        "deployment",
        "runtime",
        "framework",
        "operatingSystem",
        "device",
        "application"
    };

    private final Map<String, Object> value;

    private TelemetryContext(Map<String, Object> value) {
        this.value = TelemetryValues.immutableMap(value);
    }

    /** Returns a new shared-context builder. */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Merges client context with event context.
     *
     * <p>Resource fields and tags merge by field. Event trace, session, and
     * subject sections replace the matching client section.</p>
     */
    public static TelemetryContext merge(TelemetryContext client, TelemetryContext event) {
        if (client == null) {
            return event;
        }
        if (event == null) {
            return client;
        }

        Map<String, Object> merged = new LinkedHashMap<>();
        merged.put("schemaVersion", Integer.valueOf(1));
        Map<String, Object> resource = mergeResources(section(client, "resource"), section(event, "resource"));
        if (resource != null) {
            merged.put("resource", resource);
        }
        putReplacement(merged, "trace", client, event);
        putReplacement(merged, "session", client, event);
        putReplacement(merged, "subject", client, event);
        Map<String, Object> tags = mergeFlatMaps(section(client, "tags"), section(event, "tags"));
        if (tags != null) {
            requireTagCount(tags.size());
            merged.put("tags", tags);
        }
        return new TelemetryContext(merged);
    }

    /** Returns the immutable schema-shaped map used for JSON serialization. */
    public Map<String, Object> asMap() {
        return TelemetryValues.immutableMap(value);
    }

    static TelemetryContext withTrace(TelemetryContext base, LogBrewTraceContext trace) {
        Objects.requireNonNull(trace, "trace");
        return merge(base, builder().trace(trace).build());
    }

    static TelemetryContext runtimeDefaults() {
        TelemetryResource.Builder resource = TelemetryResource.builder().runtime(
            "java",
            TelemetryValues.safeOptionalString(Runtime.version().toString())
        );
        String operatingSystem = safeSystemProperty("os.name");
        if (operatingSystem != null) {
            resource.operatingSystem(operatingSystem, null, null);
        }
        String architecture = safeSystemProperty("os.arch");
        if (architecture != null) {
            resource.device(null, null, architecture);
        }
        return builder().resource(resource.build()).build();
    }

    private static String safeSystemProperty(String name) {
        try {
            return TelemetryValues.safeOptionalString(System.getProperty(name));
        } catch (SecurityException error) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> section(TelemetryContext context, String key) {
        Object value = context.value.get(key);
        return value instanceof Map<?, ?> ? (Map<String, Object>) value : null;
    }

    private static Map<String, Object> mergeResources(
        Map<String, Object> client,
        Map<String, Object> event
    ) {
        if (client == null) {
            return event == null ? null : TelemetryValues.mutableMap(event);
        }
        if (event == null) {
            return TelemetryValues.mutableMap(client);
        }
        Map<String, Object> merged = new LinkedHashMap<>();
        for (String section : RESOURCE_SECTIONS) {
            @SuppressWarnings("unchecked")
            Map<String, Object> clientSection = (Map<String, Object>) client.get(section);
            @SuppressWarnings("unchecked")
            Map<String, Object> eventSection = (Map<String, Object>) event.get(section);
            Map<String, Object> value = mergeFlatMaps(clientSection, eventSection);
            if (value != null) {
                merged.put(section, value);
            }
        }
        return merged;
    }

    private static Map<String, Object> mergeFlatMaps(Map<String, Object> client, Map<String, Object> event) {
        if (client == null) {
            return event == null ? null : new LinkedHashMap<>(event);
        }
        Map<String, Object> merged = new LinkedHashMap<>(client);
        if (event != null) {
            merged.putAll(event);
        }
        return merged;
    }

    private static void putReplacement(
        Map<String, Object> target,
        String key,
        TelemetryContext client,
        TelemetryContext event
    ) {
        Map<String, Object> value = section(event, key);
        if (value == null) {
            value = section(client, key);
        }
        if (value != null) {
            target.put(key, new LinkedHashMap<>(value));
        }
    }

    private static void requireTagCount(int count) {
        if (count < 1 || count > TelemetryValues.MAX_TAGS) {
            throw TelemetryValues.invalid("tags must contain 1-32 entries");
        }
    }

    /** Builder for explicit bounded resource and correlation context. */
    public static final class Builder {
        private TelemetryResource resource;
        private Map<String, Object> trace;
        private Map<String, Object> session;
        private Map<String, Object> subject;
        private final Map<String, Object> tags = new LinkedHashMap<>();

        private Builder() {
        }

        /** Sets the stable resource identity. */
        public Builder resource(TelemetryResource value) {
            this.resource = Objects.requireNonNull(value, "value");
            return this;
        }

        /** Sets exact trace correlation from an existing LogBrew trace. */
        public Builder trace(LogBrewTraceContext value) {
            Objects.requireNonNull(value, "value");
            return trace(
                value.traceId(),
                value.spanId(),
                value.parentSpanId(),
                Boolean.valueOf(value.sampled())
            );
        }

        /** Sets exact W3C trace and optional span correlation. */
        public Builder trace(
            String traceId,
            String spanId,
            String parentSpanId,
            Boolean sampled
        ) {
            Map<String, Object> mapped = new LinkedHashMap<>();
            mapped.put("traceId", TelemetryValues.traceId(traceId, "traceId"));
            put(mapped, "spanId", TelemetryValues.optionalSpanId(spanId, "spanId"));
            put(mapped, "parentSpanId", TelemetryValues.optionalSpanId(parentSpanId, "parentSpanId"));
            if (sampled != null) {
                mapped.put("sampled", sampled);
            }
            this.trace = mapped;
            return this;
        }

        /** Sets one opaque session identity. */
        public Builder session(String id) {
            return session(id, null);
        }

        /** Sets opaque current and optional previous session identities. */
        public Builder session(String id, String previousId) {
            String normalizedId = TelemetryValues.requiredId(id, "session id");
            String normalizedPrevious = TelemetryValues.optionalId(previousId, "session previousId");
            if (normalizedPrevious != null && normalizedPrevious.equals(normalizedId)) {
                throw TelemetryValues.invalid("session previousId must differ from id");
            }
            Map<String, Object> mapped = new LinkedHashMap<>();
            mapped.put("id", normalizedId);
            put(mapped, "previousId", normalizedPrevious);
            this.session = mapped;
            return this;
        }

        /** Sets an opaque user or anonymous subject identity. */
        public Builder subject(String id, String kind) {
            String normalizedId = TelemetryValues.requiredId(id, "subject id");
            if (!"anonymous".equals(kind) && !"user".equals(kind)) {
                throw TelemetryValues.invalid("subject kind must be anonymous or user");
            }
            Map<String, Object> mapped = new LinkedHashMap<>();
            mapped.put("id", normalizedId);
            mapped.put("kind", kind);
            this.subject = mapped;
            return this;
        }

        /** Adds or replaces one low-cardinality tag. */
        public Builder tag(String key, String value) {
            String normalizedKey = TelemetryValues.tagKey(key);
            tags.put(normalizedKey, TelemetryValues.requiredString(value, "tag value for " + normalizedKey));
            return this;
        }

        /** Adds or replaces low-cardinality tags from a caller-owned map. */
        public Builder tags(Map<String, String> values) {
            if (values == null) {
                throw TelemetryValues.invalid("tags must be provided");
            }
            for (Map.Entry<String, String> entry : values.entrySet()) {
                tag(entry.getKey(), entry.getValue());
            }
            return this;
        }

        /** Builds one non-empty immutable shared context. */
        public TelemetryContext build() {
            Map<String, Object> mapped = new LinkedHashMap<>();
            mapped.put("schemaVersion", Integer.valueOf(1));
            if (resource != null) {
                mapped.put("resource", resource.value());
            }
            put(mapped, "trace", trace);
            put(mapped, "session", session);
            put(mapped, "subject", subject);
            if (!tags.isEmpty()) {
                requireTagCount(tags.size());
                mapped.put("tags", new LinkedHashMap<>(tags));
            }
            if (mapped.size() == 1) {
                throw TelemetryValues.invalid(
                    "telemetry context must include resource, trace, session, subject, or tags"
                );
            }
            return new TelemetryContext(mapped);
        }

        private static void put(Map<String, Object> target, String key, Object value) {
            if (value != null) {
                target.put(key, value);
            }
        }
    }
}
