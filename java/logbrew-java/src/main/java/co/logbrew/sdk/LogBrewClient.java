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
    private static final int DEFAULT_MAX_QUEUE_SIZE = 1000;
    static final String[] SEVERITY_VALUES = {"trace", "debug", "info", "warn", "warning", "error", "fatal", "critical"};
    static final String[] SPAN_STATUSES = {"ok", "error"};
    static final String[] ACTION_STATUSES = {"queued", "running", "success", "failure"};
    static final String[] METRIC_KINDS = {"counter", "gauge", "histogram"};
    static final String[] DELTA_CUMULATIVE_TEMPORALITIES = {"delta", "cumulative"};
    static final String[] INSTANT_TEMPORALITY = {"instant"};

    private final String apiKey;
    private final Map<String, Object> sdk;
    private final int maxRetries;
    private final int maxQueueSize;
    private final EventDroppedHandler eventDroppedHandler;
    private final List<Event> events;
    private int droppedEvents;
    private boolean closed;

    private LogBrewClient(
        String apiKey,
        String sdkName,
        String sdkVersion,
        int maxRetries,
        int maxQueueSize,
        EventDroppedHandler eventDroppedHandler
    ) {
        this.apiKey = apiKey;
        this.maxRetries = maxRetries;
        this.maxQueueSize = maxQueueSize;
        this.eventDroppedHandler = eventDroppedHandler;
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
        return create(apiKey, sdkName, sdkVersion, maxRetries, DEFAULT_MAX_QUEUE_SIZE, null);
    }

    /**
     * Creates a client with retry and queue-size settings.
     */
    public static LogBrewClient create(
        String apiKey,
        String sdkName,
        String sdkVersion,
        int maxRetries,
        int maxQueueSize
    ) {
        return create(apiKey, sdkName, sdkVersion, maxRetries, maxQueueSize, null);
    }

    /**
     * Creates a client with retry, queue-size, and event-drop callback settings.
     */
    public static LogBrewClient create(
        String apiKey,
        String sdkName,
        String sdkVersion,
        int maxRetries,
        int maxQueueSize,
        EventDroppedHandler eventDroppedHandler
    ) {
        Validation.requireNonEmpty("api_key", apiKey);
        Validation.requireNonEmpty("sdk_name", sdkName);
        Validation.requireNonEmpty("sdk_version", sdkVersion);
        if (maxRetries < 0) {
            throw new SdkException("validation_error", "max_retries must be non-negative");
        }
        if (maxQueueSize <= 0) {
            throw new SdkException("validation_error", "max_queue_size must be positive");
        }
        return new LogBrewClient(apiKey, sdkName, sdkVersion, maxRetries, maxQueueSize, eventDroppedHandler);
    }

    /**
     * Returns the queued event count currently buffered in memory.
     */
    public synchronized int pendingEvents() {
        return events.size();
    }

    /**
     * Returns the number of events dropped because the in-memory queue was full.
     */
    public synchronized int droppedEvents() {
        return droppedEvents;
    }

    /**
     * Returns whether {@link #shutdown(Transport)} has closed this client.
     */
    public synchronized boolean isClosed() {
        return closed;
    }

    /**
     * Returns the queued event batch as stable, pretty-printed JSON.
     */
    public synchronized String previewJson() {
        return Json.write(batchMap());
    }

    /**
     * Adds a release event to the queue.
     */
    public synchronized void release(String id, String timestamp, ReleaseAttributes attributes) {
        pushEvent("release", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds an environment event to the queue.
     */
    public synchronized void environment(String id, String timestamp, EnvironmentAttributes attributes) {
        pushEvent("environment", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds an issue event to the queue.
     */
    public synchronized void issue(String id, String timestamp, IssueAttributes attributes) {
        pushEvent("issue", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds a log event to the queue.
     */
    public synchronized void log(String id, String timestamp, LogAttributes attributes) {
        pushEvent("log", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds a span event to the queue.
     */
    public synchronized void span(String id, String timestamp, SpanAttributes attributes) {
        pushEvent("span", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds an action event to the queue.
     */
    public synchronized void action(String id, String timestamp, ActionAttributes attributes) {
        pushEvent("action", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Adds an explicit, application-owned metric event to the queue.
     */
    public synchronized void metric(String id, String timestamp, MetricAttributes attributes) {
        pushEvent("metric", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Flushes queued events through a transport while preserving retry semantics.
     */
    public synchronized TransportResponse flush(Transport transport) {
        if (closed) {
            throw new SdkException("shutdown_error", "client is already shut down");
        }
        return flushInternal(Objects.requireNonNull(transport, "transport"));
    }

    /**
     * Flushes queued events, then marks the client closed so later writes fail.
     */
    public synchronized TransportResponse shutdown(Transport transport) {
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
        if (events.size() >= maxQueueSize) {
            droppedEvents++;
            reportDroppedEvent(new EventDrop(id, type, "queue_overflow"));
            return;
        }
        events.add(new Event(type, timestamp, id, attributes));
    }

    private void reportDroppedEvent(EventDrop drop) {
        if (eventDroppedHandler == null) {
            return;
        }
        try {
            eventDroppedHandler.onEventDropped(drop);
        } catch (RuntimeException error) {
            // Drop callbacks are advisory and must never interrupt app telemetry.
        }
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

    /**
     * Callback for advisory event-drop notifications.
     */
    public interface EventDroppedHandler {
        /**
         * Called when an event is dropped before it enters the in-memory queue.
         */
        void onEventDropped(EventDrop drop);
    }

    /**
     * Redacted summary of an event dropped before queueing.
     */
    public static final class EventDrop {
        private final String eventId;
        private final String eventType;
        private final String reason;

        private EventDrop(String eventId, String eventType, String reason) {
            this.eventId = eventId;
            this.eventType = eventType;
            this.reason = reason;
        }

        /**
         * Returns the dropped event id.
         */
        public String eventId() {
            return eventId;
        }

        /**
         * Returns the dropped event type, such as {@code log} or {@code span}.
         */
        public String eventType() {
            return eventType;
        }

        /**
         * Returns the drop reason.
         */
        public String reason() {
            return reason;
        }
    }
}
