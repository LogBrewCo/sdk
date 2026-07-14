package co.logbrew.sdk;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Buffered public client for validating, previewing, and flushing LogBrew events.
 */
public final class LogBrewClient {
    static final String[] SEVERITY_VALUES = {"trace", "debug", "info", "warn", "warning", "error", "fatal", "critical"};
    static final String[] SPAN_STATUSES = {"ok", "error"};
    static final String[] ACTION_STATUSES = {"queued", "running", "success", "failure"};
    static final String[] METRIC_KINDS = {"counter", "gauge", "histogram"};
    static final String[] DELTA_CUMULATIVE_TEMPORALITIES = {"delta", "cumulative"};
    static final String[] INSTANT_TEMPORALITY = {"instant"};

    private final String apiKey;
    private final Map<String, Object> sdk;
    private final DeliveryOptions deliveryOptions;
    private final Deque<QueuedEvent> events;
    private final Object stateLock;
    private final Object deliveryLock;
    private long pendingEventBytes;
    private long droppedEventBytes;
    private int droppedEvents;
    private boolean closing;
    private boolean closed;
    private Thread deliveryOwner;

    private LogBrewClient(
        String apiKey,
        String sdkName,
        String sdkVersion,
        DeliveryOptions deliveryOptions
    ) {
        this.apiKey = apiKey;
        this.deliveryOptions = deliveryOptions;
        this.events = new ArrayDeque<>();
        this.stateLock = new Object();
        this.deliveryLock = new Object();
        Map<String, Object> sdkValue = new LinkedHashMap<>();
        sdkValue.put("name", sdkName);
        sdkValue.put("language", "java");
        sdkValue.put("version", sdkVersion);
        this.sdk = Collections.unmodifiableMap(sdkValue);
    }

    /**
     * Creates a client from public SDK identity and API key settings.
     */
    public static LogBrewClient create(String apiKey, String sdkName, String sdkVersion) {
        return create(apiKey, sdkName, sdkVersion, DeliveryOptions.builder().build());
    }

    /**
     * Creates a client from public SDK identity, API key settings, and retry budget.
     */
    public static LogBrewClient create(String apiKey, String sdkName, String sdkVersion, int maxRetries) {
        return create(
            apiKey,
            sdkName,
            sdkVersion,
            DeliveryOptions.builder().maxRetries(maxRetries).build()
        );
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
        if (maxRetries < 0) {
            throw new SdkException("validation_error", "max_retries must be non-negative");
        }
        if (maxQueueSize <= 0) {
            throw new SdkException("validation_error", "max_queue_size must be positive");
        }
        return create(
            apiKey,
            sdkName,
            sdkVersion,
            DeliveryOptions.builder()
                .maxRetries(maxRetries)
                .maxQueueEvents(maxQueueSize)
                .onEventDropped(eventDroppedHandler)
                .build()
        );
    }

    /**
     * Creates a client with explicit count, byte, request, retry, and drop-callback bounds.
     */
    public static LogBrewClient create(
        String apiKey,
        String sdkName,
        String sdkVersion,
        DeliveryOptions deliveryOptions
    ) {
        Validation.requireNonEmpty("api_key", apiKey);
        Validation.requireNonEmpty("sdk_name", sdkName);
        Validation.requireNonEmpty("sdk_version", sdkVersion);
        return new LogBrewClient(
            apiKey,
            sdkName,
            sdkVersion,
            Objects.requireNonNull(deliveryOptions, "deliveryOptions")
        );
    }

    /**
     * Returns the queued event count currently buffered in memory.
     */
    public int pendingEvents() {
        synchronized (stateLock) {
            return events.size();
        }
    }

    /**
     * Returns the exact serialized event bytes currently retained in memory.
     *
     * <p>The count excludes the SDK envelope and JSON collection separators added per request.</p>
     */
    public long pendingEventBytes() {
        synchronized (stateLock) {
            return pendingEventBytes;
        }
    }

    /**
     * Returns the number of events rejected before entering the in-memory queue.
     */
    public int droppedEvents() {
        synchronized (stateLock) {
            return droppedEvents;
        }
    }

    /**
     * Returns the serialized event bytes rejected before entering the in-memory queue.
     */
    public long droppedEventBytes() {
        synchronized (stateLock) {
            return droppedEventBytes;
        }
    }

    /**
     * Returns whether {@link #shutdown(Transport)} has closed this client.
     */
    public boolean isClosed() {
        synchronized (stateLock) {
            return closed;
        }
    }

    /**
     * Returns the queued event batch as stable, pretty-printed JSON.
     */
    public String previewJson() {
        return serializeBatch(snapshotEvents());
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
     * Adds an explicit, application-owned metric event to the queue.
     */
    public void metric(String id, String timestamp, MetricAttributes attributes) {
        pushEvent("metric", id, timestamp, Objects.requireNonNull(attributes, "attributes").toMap());
    }

    /**
     * Flushes the events present at call start through a transport.
     *
     * <p>Concurrent calls are serialized. Events captured during transport I/O remain queued for a
     * later flush.</p>
     */
    public TransportResponse flush(Transport transport) {
        return deliver(Objects.requireNonNull(transport, "transport"), false);
    }

    /**
     * Flushes queued events, then marks the client closed so later writes fail.
     *
     * <p>A failed shutdown retains unaccepted work and reopens the client for recovery.</p>
     */
    public TransportResponse shutdown(Transport transport) {
        return deliver(Objects.requireNonNull(transport, "transport"), true);
    }

    private void pushEvent(String type, String id, String timestamp, Map<String, Object> attributes) {
        Validation.requireNonEmpty("event id", id);
        Validation.requireTimestamp(timestamp);
        Event event = new Event(type, timestamp, id, attributes);
        Map<String, Object> eventValue = Collections.unmodifiableMap(event.toMap());
        long eventBytes = utf8Bytes(Json.write(eventValue));
        QueuedEvent queuedEvent = new QueuedEvent(eventValue, eventBytes);
        EventDrop drop = null;

        synchronized (stateLock) {
            ensureWritable();
            if (eventBytes > deliveryOptions.maxQueueBytes()
                || utf8Bytes(serializeBatch(Collections.singletonList(queuedEvent)))
                    > deliveryOptions.maxBatchBytes()) {
                drop = recordDrop(id, type, "event_too_large", eventBytes);
            } else if (events.size() >= deliveryOptions.maxQueueEvents()
                || eventBytes > deliveryOptions.maxQueueBytes() - pendingEventBytes) {
                drop = recordDrop(id, type, "queue_overflow", eventBytes);
            } else {
                events.addLast(queuedEvent);
                pendingEventBytes += eventBytes;
            }
        }

        if (drop != null) {
            reportDroppedEvent(drop);
        }
    }

    private EventDrop recordDrop(String id, String type, String reason, long serializedBytes) {
        droppedEvents++;
        droppedEventBytes += serializedBytes;
        return new EventDrop(id, type, reason, serializedBytes);
    }

    private void reportDroppedEvent(EventDrop drop) {
        EventDroppedHandler handler = deliveryOptions.eventDroppedHandler();
        if (handler == null) {
            return;
        }
        try {
            handler.onEventDropped(drop);
        } catch (RuntimeException error) {
            // Drop callbacks are advisory and must never interrupt app telemetry.
        }
    }

    private TransportResponse deliver(Transport transport, boolean shutdown) {
        synchronized (deliveryLock) {
            if (deliveryOwner == Thread.currentThread()) {
                throw new SdkException(
                    "reentrancy_error",
                    "flush or shutdown cannot run from the active transport callback"
                );
            }
            deliveryOwner = Thread.currentThread();
            try {
                List<QueuedEvent> snapshot;
                synchronized (stateLock) {
                    if (closed) {
                        throw new SdkException("shutdown_error", "client is already shut down");
                    }
                    if (shutdown) {
                        closing = true;
                    }
                    snapshot = new ArrayList<>(events);
                }

                boolean shutdownCompleted = false;
                try {
                    TransportResponse response = flushSnapshot(transport, snapshot);
                    if (shutdown) {
                        synchronized (stateLock) {
                            closing = false;
                            closed = true;
                        }
                    }
                    shutdownCompleted = true;
                    return response;
                } finally {
                    if (shutdown && !shutdownCompleted) {
                        synchronized (stateLock) {
                            closing = false;
                        }
                    }
                }
            } finally {
                deliveryOwner = null;
            }
        }
    }

    private TransportResponse flushSnapshot(Transport transport, List<QueuedEvent> snapshot) {
        if (snapshot.isEmpty()) {
            return new TransportResponse(204, 0, 0, 0);
        }

        int offset = 0;
        int attempts = 0;
        int batches = 0;
        int acceptedEvents = 0;
        int statusCode = 204;
        while (offset < snapshot.size()) {
            FrozenBatch batch = freezeNextBatch(snapshot, offset);
            SendResult result = sendBatch(transport, batch.body);
            acknowledgePrefix(batch.events);
            offset += batch.events.size();
            attempts += result.attempts;
            batches++;
            acceptedEvents += batch.events.size();
            statusCode = result.statusCode;
        }
        return new TransportResponse(statusCode, attempts, batches, acceptedEvents);
    }

    private FrozenBatch freezeNextBatch(List<QueuedEvent> snapshot, int offset) {
        List<QueuedEvent> batchEvents = new ArrayList<>();
        String body = null;
        int limit = Math.min(snapshot.size(), offset + deliveryOptions.maxBatchEvents());
        for (int index = offset; index < limit; index++) {
            batchEvents.add(snapshot.get(index));
            String candidate = serializeBatch(batchEvents);
            if (utf8Bytes(candidate) > deliveryOptions.maxBatchBytes()) {
                batchEvents.remove(batchEvents.size() - 1);
                break;
            }
            body = candidate;
        }

        if (batchEvents.isEmpty() || body == null) {
            throw new SdkException("delivery_error", "queued event exceeds the configured request bound");
        }
        return new FrozenBatch(Collections.unmodifiableList(new ArrayList<>(batchEvents)), body);
    }

    private SendResult sendBatch(Transport transport, String body) {
        int maxAttempts = deliveryOptions.maxRetries() + 1;
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
                    return new SendResult(response.statusCode(), attempt);
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

    private void acknowledgePrefix(List<QueuedEvent> accepted) {
        synchronized (stateLock) {
            for (QueuedEvent expected : accepted) {
                QueuedEvent actual = events.peekFirst();
                if (actual != expected) {
                    throw new SdkException("delivery_error", "queued event ownership changed during delivery");
                }
                events.removeFirst();
                pendingEventBytes -= actual.serializedBytes;
            }
        }
    }

    private void ensureWritable() {
        if (closed) {
            throw new SdkException("shutdown_error", "client is already shut down");
        }
        if (closing) {
            throw new SdkException("shutdown_error", "client is shutting down");
        }
    }

    private List<QueuedEvent> snapshotEvents() {
        synchronized (stateLock) {
            return new ArrayList<>(events);
        }
    }

    private String serializeBatch(List<QueuedEvent> batchEvents) {
        Map<String, Object> batch = new LinkedHashMap<>();
        batch.put("sdk", sdk);
        List<Map<String, Object>> mappedEvents = new ArrayList<>();
        for (QueuedEvent event : batchEvents) {
            mappedEvents.add(event.value);
        }
        batch.put("events", mappedEvents);
        return Json.write(batch);
    }

    private static int utf8Bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
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
        private final long serializedBytes;

        private EventDrop(String eventId, String eventType, String reason, long serializedBytes) {
            this.eventId = eventId;
            this.eventType = eventType;
            this.reason = reason;
            this.serializedBytes = serializedBytes;
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

        /**
         * Returns the dropped event's serialized UTF-8 byte count without event content.
         */
        public long serializedBytes() {
            return serializedBytes;
        }
    }

    private static final class QueuedEvent {
        private final Map<String, Object> value;
        private final long serializedBytes;

        private QueuedEvent(Map<String, Object> value, long serializedBytes) {
            this.value = value;
            this.serializedBytes = serializedBytes;
        }
    }

    private static final class FrozenBatch {
        private final List<QueuedEvent> events;
        private final String body;

        private FrozenBatch(List<QueuedEvent> events, String body) {
            this.events = events;
            this.body = body;
        }
    }

    private static final class SendResult {
        private final int statusCode;
        private final int attempts;

        private SendResult(int statusCode, int attempts) {
            this.statusCode = statusCode;
            this.attempts = attempts;
        }
    }
}
