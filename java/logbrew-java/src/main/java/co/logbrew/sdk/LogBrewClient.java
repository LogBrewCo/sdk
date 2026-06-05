package co.logbrew.sdk;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Buffered public client for validating, previewing, and flushing LogBrew events.
 */
public final class LogBrewClient {
    static final String[] ISSUE_LEVELS = {"info", "warning", "error", "critical"};
    static final String[] LOG_LEVELS = {"debug", "info", "warning", "error"};
    static final String[] SPAN_STATUSES = {"ok", "error"};
    static final String[] ACTION_STATUSES = {"queued", "running", "success", "failure"};

    private final String apiKey;
    private final Map<String, Object> sdk;
    private final int maxRetries;
    private final List<Event> events;
    private boolean closed;

    private LogBrewClient(String apiKey, String sdkName, String sdkVersion, int maxRetries) {
        this.apiKey = apiKey;
        this.maxRetries = maxRetries;
        this.events = new ArrayList<>();
        this.sdk = new LinkedHashMap<>();
        this.sdk.put("name", sdkName);
        this.sdk.put("language", "java");
        this.sdk.put("version", sdkVersion);
    }

    /**
     * Creates a client from public SDK identity and API key settings.
     */
    public static LogBrewClient create(String apiKey, String sdkName, String sdkVersion) {
        return create(apiKey, sdkName, sdkVersion, 2);
    }

    /**
     * Creates a client from public SDK identity, API key settings, and retry budget.
     */
    public static LogBrewClient create(String apiKey, String sdkName, String sdkVersion, int maxRetries) {
        Validation.requireNonEmpty("api_key", apiKey);
        Validation.requireNonEmpty("sdk_name", sdkName);
        Validation.requireNonEmpty("sdk_version", sdkVersion);
        if (maxRetries < 0) {
            throw new SdkException("validation_error", "max_retries must be non-negative");
        }
        return new LogBrewClient(apiKey, sdkName, sdkVersion, maxRetries);
    }

    /**
     * Returns the queued event count currently buffered in memory.
     */
    public int pendingEvents() {
        return events.size();
    }

    /**
     * Returns whether {@link #shutdown(Transport)} has closed this client.
     */
    public boolean isClosed() {
        return closed;
    }

    /**
     * Returns the queued event batch as stable, pretty-printed JSON.
     */
    public String previewJson() {
        return Json.write(batchMap());
    }

    /**
     * Adds a release event to the queue.
     */
    public void release(String id, String timestamp, ReleaseAttributes attributes) {
        pushEvent("release", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds an environment event to the queue.
     */
    public void environment(String id, String timestamp, EnvironmentAttributes attributes) {
        pushEvent("environment", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds an issue event to the queue.
     */
    public void issue(String id, String timestamp, IssueAttributes attributes) {
        pushEvent("issue", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds a log event to the queue.
     */
    public void log(String id, String timestamp, LogAttributes attributes) {
        pushEvent("log", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds a span event to the queue.
     */
    public void span(String id, String timestamp, SpanAttributes attributes) {
        pushEvent("span", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds an action event to the queue.
     */
    public void action(String id, String timestamp, ActionAttributes attributes) {
        pushEvent("action", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Flushes queued events through a transport while preserving retry semantics.
     */
    public TransportResponse flush(Transport transport) {
        if (closed) {
            throw new SdkException("shutdown_error", "client is already shut down");
        }
        return flushInternal(Objects.requireNonNull(transport, "transport"));
    }

    /**
     * Flushes queued events, then marks the client closed so later writes fail.
     */
    public TransportResponse shutdown(Transport transport) {
        if (closed) {
            throw new SdkException("shutdown_error", "client is already shut down");
        }
        TransportResponse response = flushInternal(Objects.requireNonNull(transport, "transport"));
        closed = true;
        return response;
    }

    private void pushEvent(String type, String id, String timestamp, Map<String, Object> attributes) {
        if (closed) {
            throw new SdkException("shutdown_error", "client is already shut down");
        }
        Validation.requireNonEmpty("event id", id);
        Validation.requireTimestamp(timestamp);
        events.add(new Event(type, timestamp, id, attributes));
    }

    private TransportResponse flushInternal(Transport transport) {
        if (events.isEmpty()) {
            return new TransportResponse(204, 0);
        }

        String body = previewJson();
        int maxAttempts = maxRetries + 1;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                TransportResponse response = transport.send(apiKey, body);
                if (response == null) {
                    throw new SdkException("transport_error", "transport returned no response");
                }
                if (response.statusCode() == 401) {
                    throw new SdkException("unauthenticated", "transport rejected the API key");
                }
                if (response.statusCode() >= 200 && response.statusCode() < 300) {
                    events.clear();
                    return new TransportResponse(response.statusCode(), attempt);
                }
                if (response.statusCode() >= 500 && attempt < maxAttempts) {
                    continue;
                }
                throw new SdkException("transport_error", "unexpected transport status " + response.statusCode());
            } catch (TransportException error) {
                if (error.retryable() && attempt < maxAttempts) {
                    continue;
                }
                throw new SdkException(error.code(), error.getMessage());
            }
        }
        throw new SdkException("transport_error", "exhausted retries");
    }

    private Map<String, Object> batchMap() {
        Map<String, Object> batch = new LinkedHashMap<>();
        batch.put("sdk", sdk);
        List<Map<String, Object>> mappedEvents = new ArrayList<>();
        for (Event event : events) {
            mappedEvents.add(event.toMap());
        }
        batch.put("events", mappedEvents);
        return batch;
    }
}
