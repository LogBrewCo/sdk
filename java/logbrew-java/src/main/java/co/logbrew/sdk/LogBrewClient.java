package co.logbrew.sdk;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;

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
    private static final int MAX_CLIENT_REPORT_COUNT = 1_000_000_000;
    private static final long CLIENT_REPORT_SAVE_INTERVAL_NANOS = 1_000_000_000L;

    private final String apiKey;
    private final Map<String, Object> sdk;
    private final TelemetryContext context;
    private final DeliveryOptions deliveryOptions;
    private final Deque<QueuedEvent> events;
    private final Object stateLock;
    private final Object deliveryLock;
    private final EncryptedEventStore eventStore;
    private final AutomaticDeliveryController automaticDelivery;
    private long pendingEventBytes;
    // The newest event captured by a delivery snapshot or session; it and older events are never evicted.
    private QueuedEvent deliveryProtectedThrough;
    private long droppedEventBytes;
    private int droppedEvents;
    // Drops not yet acknowledged by the intake; they ride in the next batch as a client report.
    private final Map<String, Integer> unreportedDrops = new LinkedHashMap<>();
    // Drops frozen under one report ID until a 2xx acknowledges a body that carried them.
    private Map<String, Object> pendingReport;
    // A persistent store keeps counts not yet acknowledged by a 2xx across restarts.
    private LongSupplier clientReportClock = System::nanoTime;
    private long clientReportSavedAt;
    private boolean clientReportSaved;
    private boolean closing;
    private boolean closed;
    private Thread deliveryOwner;
    private boolean persistenceRecovered;

    private LogBrewClient(
        String apiKey,
        String sdkName,
        String sdkVersion,
        DeliveryOptions deliveryOptions,
        Transport ownedTransport,
        AutomaticDeliveryOptions automaticDeliveryOptions,
        AutomaticDeliveryScheduler.Factory schedulerFactory,
        AutomaticDeliveryScheduler.Jitter jitter,
        BooleanSupplier processOwnership,
        TelemetryContext clientContext,
        boolean disableRuntimeContext
    ) {
        this.apiKey = apiKey;
        this.context = TelemetryContext.merge(
            disableRuntimeContext ? null : TelemetryContext.runtimeDefaults(),
            clientContext
        );
        this.deliveryOptions = deliveryOptions;
        this.events = new ArrayDeque<>();
        this.stateLock = new Object();
        this.deliveryLock = new Object();
        this.eventStore = deliveryOptions.encryptedEventStore();
        Map<String, Object> sdkValue = new LinkedHashMap<>();
        sdkValue.put("name", sdkName);
        sdkValue.put("language", "java");
        sdkValue.put("version", sdkVersion);
        this.sdk = Collections.unmodifiableMap(sdkValue);
        this.persistenceRecovered = eventStore == null;
        if (automaticDeliveryOptions == null) {
            this.automaticDelivery = null;
        } else if (schedulerFactory == null) {
            this.automaticDelivery = new AutomaticDeliveryController(
                this,
                Objects.requireNonNull(ownedTransport, "ownedTransport"),
                automaticDeliveryOptions
            );
        } else {
            this.automaticDelivery = new AutomaticDeliveryController(
                this,
                Objects.requireNonNull(ownedTransport, "ownedTransport"),
                automaticDeliveryOptions,
                schedulerFactory,
                Objects.requireNonNull(jitter, "jitter"),
                Objects.requireNonNull(processOwnership, "processOwnership")
            );
        }
        if (eventStore != null) {
            eventStore.attach();
        }
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
            Objects.requireNonNull(deliveryOptions, "deliveryOptions"),
            null,
            null,
            null,
            null,
            null,
            null,
            false
        );
    }

    /** Creates a client with explicit shared-context and delivery options. */
    public static LogBrewClient create(
        String apiKey,
        String sdkName,
        String sdkVersion,
        LogBrewClientOptions options
    ) {
        Validation.requireNonEmpty("api_key", apiKey);
        Validation.requireNonEmpty("sdk_name", sdkName);
        Validation.requireNonEmpty("sdk_version", sdkVersion);
        LogBrewClientOptions validated = Objects.requireNonNull(options, "options");
        return new LogBrewClient(
            apiKey,
            sdkName,
            sdkVersion,
            validated.deliveryOptions(),
            null,
            null,
            null,
            null,
            null,
            validated.context(),
            validated.disableRuntimeContext()
        );
    }

    /**
     * Creates an explicit automatic client that owns one transport and lazy scheduler.
     */
    public static LogBrewClient createAutomatic(
        String apiKey,
        String sdkName,
        String sdkVersion,
        Transport transport
    ) {
        return createAutomatic(
            apiKey,
            sdkName,
            sdkVersion,
            transport,
            DeliveryOptions.builder().build(),
            AutomaticDeliveryOptions.builder().build()
        );
    }

    /**
     * Creates an explicit automatic client with custom delivery and scheduling bounds.
     */
    public static LogBrewClient createAutomatic(
        String apiKey,
        String sdkName,
        String sdkVersion,
        Transport transport,
        DeliveryOptions deliveryOptions,
        AutomaticDeliveryOptions automaticDeliveryOptions
    ) {
        Validation.requireNonEmpty("api_key", apiKey);
        Validation.requireNonEmpty("sdk_name", sdkName);
        Validation.requireNonEmpty("sdk_version", sdkVersion);
        return new LogBrewClient(
            apiKey,
            sdkName,
            sdkVersion,
            Objects.requireNonNull(deliveryOptions, "deliveryOptions"),
            Objects.requireNonNull(transport, "transport"),
            Objects.requireNonNull(automaticDeliveryOptions, "automaticDeliveryOptions"),
            null,
            null,
            null,
            null,
            false
        );
    }

    /** Creates an automatic client with explicit shared-context and delivery options. */
    public static LogBrewClient createAutomatic(
        String apiKey,
        String sdkName,
        String sdkVersion,
        Transport transport,
        LogBrewClientOptions options
    ) {
        return createAutomatic(
            apiKey,
            sdkName,
            sdkVersion,
            transport,
            options,
            AutomaticDeliveryOptions.builder().build()
        );
    }

    /** Creates an automatic client with explicit shared-context, delivery, and scheduling options. */
    public static LogBrewClient createAutomatic(
        String apiKey,
        String sdkName,
        String sdkVersion,
        Transport transport,
        LogBrewClientOptions options,
        AutomaticDeliveryOptions automaticDeliveryOptions
    ) {
        Validation.requireNonEmpty("api_key", apiKey);
        Validation.requireNonEmpty("sdk_name", sdkName);
        Validation.requireNonEmpty("sdk_version", sdkVersion);
        LogBrewClientOptions validated = Objects.requireNonNull(options, "options");
        return new LogBrewClient(
            apiKey,
            sdkName,
            sdkVersion,
            validated.deliveryOptions(),
            Objects.requireNonNull(transport, "transport"),
            Objects.requireNonNull(automaticDeliveryOptions, "automaticDeliveryOptions"),
            null,
            null,
            null,
            validated.context(),
            validated.disableRuntimeContext()
        );
    }

    static LogBrewClient createAutomatic(
        String apiKey,
        String sdkName,
        String sdkVersion,
        Transport transport,
        DeliveryOptions deliveryOptions,
        AutomaticDeliveryOptions automaticDeliveryOptions,
        AutomaticDeliveryScheduler.Factory schedulerFactory,
        AutomaticDeliveryScheduler.Jitter jitter,
        BooleanSupplier processOwnership
    ) {
        Validation.requireNonEmpty("api_key", apiKey);
        Validation.requireNonEmpty("sdk_name", sdkName);
        Validation.requireNonEmpty("sdk_version", sdkVersion);
        return new LogBrewClient(
            apiKey,
            sdkName,
            sdkVersion,
            Objects.requireNonNull(deliveryOptions, "deliveryOptions"),
            Objects.requireNonNull(transport, "transport"),
            Objects.requireNonNull(automaticDeliveryOptions, "automaticDeliveryOptions"),
            Objects.requireNonNull(schedulerFactory, "schedulerFactory"),
            Objects.requireNonNull(jitter, "jitter"),
            Objects.requireNonNull(processOwnership, "processOwnership"),
            null,
            false
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

    /** Returns a fixed, content-free snapshot of local delivery state. */
    public DeliveryHealth deliveryHealth() {
        synchronized (stateLock) {
            AutomaticDeliveryController.State automatic = automaticDelivery == null
                ? AutomaticDeliveryController.State.manual()
                : automaticDelivery.snapshot();
            DeliveryHealth.Lifecycle lifecycle = closed
                ? DeliveryHealth.Lifecycle.CLOSED
                : closing || automatic.stopping
                    ? DeliveryHealth.Lifecycle.CLOSING
                    : DeliveryHealth.Lifecycle.OPEN;
            return new DeliveryHealth(
                lifecycle,
                automatic.activity,
                automatic.lastOutcome,
                automatic.pauseReason,
                automatic.lastDropReason,
                automatic.retryDelaySource,
                automaticDelivery != null,
                automatic.inFlight,
                automatic.wakeCoalesced,
                events.size(),
                pendingEventBytes,
                droppedEvents,
                droppedEventBytes,
                automatic.automaticAttempts,
                automatic.transportAttempts,
                automatic.acceptedBatches,
                automatic.acceptedEvents,
                automatic.consecutiveFailures,
                automatic.scheduledDelayMillis,
                automatic.acceptedServerRetryHints,
                automatic.rejectedServerRetryHints
            );
        }
    }

    /**
     * Returns the queued event batch as stable, pretty-printed JSON.
     */
    public String previewJson() {
        return serializeBatch(snapshotEvents(), null);
    }

    /**
     * Recovers authenticated persisted events in oldest-first order before capture or delivery.
     */
    public PersistenceStatus recoverPersistedEvents() {
        return recoverPersistence(false);
    }

    /**
     * Verifies and finalizes one durable interrupted transaction, then recovers persisted events.
     *
     * <p>This method never guesses about orphaned writes. If the durable intent cannot prove the
     * target bytes, callers must explicitly purge instead.</p>
     */
    public PersistenceStatus finalizePersistedTransactionAndRecover() {
        return recoverPersistence(true);
    }

    /** Returns content-free persisted queue accounting without changing recovery state. */
    public PersistenceStatus persistenceStatus() {
        synchronized (deliveryLock) {
            synchronized (stateLock) {
                EncryptedEventStore store = requireEventStore();
                return store.status(
                    deliveryOptions.maxQueueEvents(),
                    deliveryOptions.maxQueueBytes(),
                    !persistenceRecovered
                );
            }
        }
    }

    /** Explicitly removes all recognized persisted work and enables capture on an empty queue. */
    public PersistenceStatus purgePersistedEvents() {
        PersistenceStatus status;
        synchronized (deliveryLock) {
            rejectDeliveryReentrancy();
            synchronized (stateLock) {
                ensureNotClosedOrClosing();
                EncryptedEventStore store = requireEventStore();
                store.purge();
                events.clear();
                pendingEventBytes = 0L;
                persistenceRecovered = true;
                status = store.status(
                    deliveryOptions.maxQueueEvents(),
                    deliveryOptions.maxQueueBytes(),
                    false
                );
            }
        }
        if (automaticDelivery != null) {
            automaticDelivery.onQueueCleared();
        }
        return status;
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
        if (automaticDelivery != null) {
            return automaticDelivery.flush(Objects.requireNonNull(transport, "transport"));
        }
        return deliver(Objects.requireNonNull(transport, "transport"), false);
    }

    /**
     * Flushes queued events, then marks the client closed so later writes fail.
     *
     * <p>A failed shutdown retains unaccepted work and reopens the client for recovery.</p>
     */
    public TransportResponse shutdown(Transport transport) {
        if (automaticDelivery != null) {
            return automaticDelivery.shutdown(Objects.requireNonNull(transport, "transport"));
        }
        return deliver(Objects.requireNonNull(transport, "transport"), true);
    }

    /** Flushes queued work once and closes an explicit automatic client. */
    public TransportResponse shutdown() {
        if (automaticDelivery == null) {
            throw new SdkException(
                "automatic_delivery_disabled",
                "automatic delivery is not enabled for this client"
            );
        }
        return automaticDelivery.shutdown();
    }

    /** Resumes a paused automatic client and requests one immediate delivery wake. */
    public void resumeAutomaticDelivery() {
        if (automaticDelivery == null) {
            throw new SdkException(
                "automatic_delivery_disabled",
                "automatic delivery is not enabled for this client"
            );
        }
        synchronized (stateLock) {
            ensureNotClosedOrClosing();
            ensurePersistenceRecovered();
        }
        automaticDelivery.resume();
    }

    private void pushEvent(String type, String id, String timestamp, Map<String, Object> attributes) {
        Validation.requireNonEmpty("event id", id);
        Validation.requireTimestamp(timestamp);
        Object rawEventContext = attributes.remove("context");
        if (rawEventContext != null && !(rawEventContext instanceof TelemetryContext)) {
            throw new SdkException("validation_error", "event context must be a TelemetryContext");
        }
        TelemetryContext eventContext = (TelemetryContext) rawEventContext;
        TelemetryContext ambientContext = "span".equals(type)
            ? context : LogBrewTrace.contextWithCurrentTrace(context);
        TelemetryContext mergedContext = TelemetryContext.merge(ambientContext, eventContext);
        if (mergedContext != null) {
            attributes.put("context", mergedContext.asMap());
        }
        Event event = new Event(type, timestamp, id, attributes);
        Map<String, Object> eventValue = Collections.unmodifiableMap(event.toMap());
        String eventJson = Json.write(eventValue);
        long eventBytes = utf8Bytes(eventJson);
        boolean fatal = "issue".equals(type) && "critical".equals(attributes.get("level"));
        QueuedEvent queuedEvent = new QueuedEvent(eventJson, eventBytes, null, id, type, fatal);
        EventDrop drop = null;
        List<EventDrop> evictions = new ArrayList<>();
        boolean queued = false;

        synchronized (stateLock) {
            ensureWritable();
            boolean tooLarge = eventBytes > deliveryOptions.maxQueueBytes()
                || utf8Bytes(serializeBatch(Collections.singletonList(queuedEvent), null))
                    > deliveryOptions.maxBatchBytes();
            boolean overflow = !tooLarge && overflows(events.size(), pendingEventBytes + eventBytes);
            Set<QueuedEvent> evicted = overflow && fatal
                ? fatalEvictionsLocked(eventBytes)
                : Collections.<QueuedEvent>emptySet();
            if (tooLarge) {
                drop = recordDrop(id, type, "event_too_large", eventBytes);
            } else if (overflow && evicted.isEmpty()) {
                drop = recordDrop(id, type, "queue_overflow", eventBytes);
            } else {
                if (eventStore != null) {
                    List<EncryptedEventStore.Record> evictedRecords = new ArrayList<>();
                    for (QueuedEvent candidate : events) {
                        if (evicted.contains(candidate)) {
                            evictedRecords.add(candidate.persistedRecord);
                        }
                    }
                    // The store removes evicted events in the same durable write that admits this one.
                    EncryptedEventStore.Record record = eventStore.admit(
                        id,
                        eventJson,
                        deliveryOptions.maxQueueEvents(),
                        deliveryOptions.maxQueueBytes(),
                        evictedRecords
                    );
                    queuedEvent = new QueuedEvent(eventJson, eventBytes, record, id, type, fatal);
                }
                Iterator<QueuedEvent> remaining = events.iterator();
                while (remaining.hasNext()) {
                    QueuedEvent candidate = remaining.next();
                    if (evicted.contains(candidate)) {
                        remaining.remove();
                        pendingEventBytes -= candidate.serializedBytes;
                        evictions.add(recordDrop(
                            candidate.id,
                            candidate.type,
                            "evicted_for_fatal",
                            candidate.serializedBytes
                        ));
                    }
                }
                events.addLast(queuedEvent);
                pendingEventBytes += eventBytes;
                queued = true;
            }
        }

        if (drop != null) {
            reportDroppedEvent(drop);
            if (automaticDelivery != null) {
                automaticDelivery.onDropped(drop.reason());
            }
        }
        // Report evictions only after admission so drop callbacks cannot refill the freed room.
        for (EventDrop eviction : evictions) {
            reportDroppedEvent(eviction);
            if (automaticDelivery != null) {
                automaticDelivery.onDropped(eviction.reason());
            }
        }
        if (queued && automaticDelivery != null) {
            automaticDelivery.onQueueChanged(pendingEvents());
        }
    }

    private boolean overflows(int queuedEvents, long queuedBytes) {
        return queuedEvents >= deliveryOptions.maxQueueEvents() || queuedBytes > deliveryOptions.maxQueueBytes();
    }

    /**
     * Selects the oldest events that are not crash reports and not captured by a delivery snapshot
     * or session, only when removing them makes room; otherwise returns an empty set.
     */
    private Set<QueuedEvent> fatalEvictionsLocked(long eventBytes) {
        boolean protectedPrefix = false;
        for (QueuedEvent queued : events) {
            if (queued == deliveryProtectedThrough) {
                protectedPrefix = true;
                break;
            }
        }
        Set<QueuedEvent> evicted = Collections.newSetFromMap(new IdentityHashMap<>());
        int remainingEvents = events.size();
        long remainingBytes = pendingEventBytes + eventBytes;
        Iterator<QueuedEvent> candidates = events.iterator();
        while (candidates.hasNext() && overflows(remainingEvents, remainingBytes)) {
            QueuedEvent candidate = candidates.next();
            if (protectedPrefix) {
                protectedPrefix = candidate != deliveryProtectedThrough;
                continue;
            }
            if (!candidate.fatal) {
                evicted.add(candidate);
                remainingEvents--;
                remainingBytes -= candidate.serializedBytes;
            }
        }
        boolean storeLimit = eventStore != null && evicted.size() > PersistenceTransaction.MAX_EVICTIONS;
        if (evicted.isEmpty() || storeLimit || overflows(remainingEvents, remainingBytes)) {
            return Collections.emptySet();
        }
        return evicted;
    }

    private EventDrop recordDrop(String id, String type, String reason, long serializedBytes) {
        if (droppedEvents < Integer.MAX_VALUE) {
            droppedEvents++;
        }
        boolean firstOfReason = !unreportedDrops.containsKey(reason);
        unreportedDrops.merge(reason, 1, (count, one) -> Math.min(MAX_CLIENT_REPORT_COUNT, count + one));
        saveClientReport(firstOfReason);
        droppedEventBytes = serializedBytes > Long.MAX_VALUE - droppedEventBytes
            ? Long.MAX_VALUE
            : droppedEventBytes + serializedBytes;
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

    private PersistenceStatus recoverPersistence(boolean finalizeAmbiguous) {
        PersistenceStatus status;
        int recoveredEvents;
        synchronized (deliveryLock) {
            rejectDeliveryReentrancy();
            synchronized (stateLock) {
                ensureNotClosedOrClosing();
                EncryptedEventStore store = requireEventStore();
                if (!events.isEmpty() || pendingEventBytes != 0L) {
                    throw new SdkException(
                        "persistence_state_error",
                        "persistence recovery requires an empty in-memory queue"
                    );
                }
                EncryptedEventStore.Snapshot snapshot = store.recover(
                    deliveryOptions.maxQueueEvents(),
                    deliveryOptions.maxQueueBytes(),
                    finalizeAmbiguous
                );
                for (EncryptedEventStore.Record record : snapshot.records()) {
                    String json = record.eventJson();
                    String type = recoveredEventType(json);
                    QueuedEvent event = new QueuedEvent(
                        json,
                        record.eventBytes(),
                        record,
                        record.eventId(),
                        type,
                        "issue".equals(type) && json.contains("\n    \"level\": \"critical\"")
                    );
                    events.addLast(event);
                    pendingEventBytes += event.serializedBytes;
                }
                loadSavedClientReport(store.loadClientReport());
                persistenceRecovered = true;
                status = snapshot.status(false);
                recoveredEvents = events.size();
            }
        }
        if (automaticDelivery != null && recoveredEvents > 0) {
            automaticDelivery.onQueueChanged(recoveredEvents);
        }
        return status;
    }

    // Persisted events are this client's own pretty-printed JSON, and string values never hold a raw
    // newline, so these markers match only the top-level type and the attributes level.
    private static String recoveredEventType(String json) {
        String prefix = "{\n  \"type\": \"";
        int end = json.startsWith(prefix) ? json.indexOf('"', prefix.length()) : -1;
        return end < 0 ? null : json.substring(prefix.length(), end);
    }

    void setClientReportClock(LongSupplier clock) {
        synchronized (stateLock) {
            clientReportClock = clock;
        }
    }

    private void loadSavedClientReport(PersistenceClientReport saved) {
        if (saved == null) {
            return;
        }
        if (pendingReport == null && saved.pendingId != null) {
            pendingReport = new LinkedHashMap<>();
            pendingReport.put("report_id", saved.pendingId);
            pendingReport.put("dropped_events", new LinkedHashMap<>(saved.pending));
        }
        saved.unreported.forEach((reason, count) -> unreportedDrops.merge(
            reason,
            count,
            (known, added) -> Math.min(MAX_CLIENT_REPORT_COUNT, known + added)
        ));
    }

    /** Saves at once for a new report or reason, and at most once a second during a drop burst. */
    private void saveClientReport(boolean immediately) {
        if (eventStore == null) {
            return;
        }
        long now = clientReportClock.getAsLong();
        if (!immediately && clientReportSaved && now - clientReportSavedAt < CLIENT_REPORT_SAVE_INTERVAL_NANOS) {
            return;
        }
        clientReportSaved = true;
        clientReportSavedAt = now;
        Map<String, Integer> pending = new LinkedHashMap<>();
        if (pendingReport != null) {
            ((Map<?, ?>) pendingReport.get("dropped_events")).forEach(
                (reason, count) -> pending.put((String) reason, (Integer) count)
            );
        }
        try {
            eventStore.saveClientReport(new PersistenceClientReport(
                pendingReport == null ? null : (String) pendingReport.get("report_id"),
                pending,
                new LinkedHashMap<>(unreportedDrops)
            ));
        } catch (RuntimeException error) {
            // Drop counts are advisory: a failed save keeps them in memory and never blocks capture.
        }
    }

    private EncryptedEventStore requireEventStore() {
        if (eventStore == null) {
            throw new SdkException(
                "persistence_disabled",
                "encrypted restart persistence is not enabled for this client"
            );
        }
        return eventStore;
    }

    void rejectDeliveryReentrancy() {
        if (deliveryOwner == Thread.currentThread()) {
            throw new SdkException(
                "reentrancy_error",
                "persistence recovery cannot run from the active transport callback"
            );
        }
    }

    private TransportResponse deliver(Transport transport, boolean shutdown) {
        return deliver(transport, shutdown, null, DeliveryObserver.NONE, deliveryOptions.maxRetries() + 1);
    }

    DeliverySession beginAutomaticDelivery() {
        synchronized (stateLock) {
            ensureNotClosedOrClosing();
            ensurePersistenceRecovered();
            deliveryProtectedThrough = events.peekLast();
            return new DeliverySession(new ArrayList<>(events));
        }
    }

    TransportResponse deliverAutomatically(
        Transport transport,
        boolean shutdown,
        DeliverySession session,
        DeliveryObserver observer
    ) {
        return deliver(
            Objects.requireNonNull(transport, "transport"),
            shutdown,
            session,
            Objects.requireNonNull(observer, "observer"),
            shutdown ? 1 : deliveryOptions.maxRetries() + 1
        );
    }

    private TransportResponse deliver(
        Transport transport,
        boolean shutdown,
        DeliverySession session,
        DeliveryObserver observer,
        int maxAttempts
    ) {
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
                    ensurePersistenceRecovered();
                    if (shutdown) {
                        closing = true;
                    }
                    if (session == null) {
                        deliveryProtectedThrough = events.peekLast();
                        snapshot = new ArrayList<>(events);
                    } else {
                        snapshot = remainingSessionEvents(session);
                    }
                }

                boolean shutdownCompleted = false;
                try {
                    TransportResponse response = flushSnapshot(transport, snapshot, observer, maxAttempts);
                    if (shutdown) {
                        synchronized (stateLock) {
                            closing = false;
                            closed = true;
                        }
                    }
                    shutdownCompleted = true;
                    return response;
                } finally {
                    if (shutdown) {
                        synchronized (stateLock) {
                            saveClientReport(true);
                            if (!shutdownCompleted) {
                                closing = false;
                            }
                        }
                    }
                }
            } finally {
                deliveryOwner = null;
            }
        }
    }

    private TransportResponse flushSnapshot(
        Transport transport,
        List<QueuedEvent> snapshot,
        DeliveryObserver observer,
        int maxAttempts
    ) {
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
            SendResult result = sendBatch(transport, batch.body, maxAttempts);
            acknowledgePrefix(batch);
            observer.onBatchAccepted(batch.events.size(), result.attempts);
            offset += batch.events.size();
            attempts += result.attempts;
            batches++;
            acceptedEvents += batch.events.size();
            statusCode = result.statusCode;
        }
        return new TransportResponse(statusCode, attempts, batches, acceptedEvents);
    }

    private List<QueuedEvent> remainingSessionEvents(DeliverySession session) {
        if (session.events.isEmpty() || events.isEmpty()) {
            return Collections.emptyList();
        }
        QueuedEvent currentFirst = events.peekFirst();
        int start = identityIndexOf(session.events, currentFirst);
        if (start < 0) {
            return Collections.emptyList();
        }
        List<QueuedEvent> remaining = new ArrayList<>();
        Iterator<QueuedEvent> current = events.iterator();
        for (int index = start; index < session.events.size(); index++) {
            if (!current.hasNext()) {
                throw new SdkException("delivery_error", "automatic delivery ownership is incomplete");
            }
            QueuedEvent expected = session.events.get(index);
            QueuedEvent actual = current.next();
            if (actual != expected) {
                throw new SdkException("delivery_error", "automatic delivery ownership changed");
            }
            remaining.add(expected);
        }
        return remaining;
    }

    private static int identityIndexOf(List<QueuedEvent> values, QueuedEvent expected) {
        for (int index = 0; index < values.size(); index++) {
            if (values.get(index) == expected) {
                return index;
            }
        }
        return -1;
    }

    private FrozenBatch freezeNextBatch(List<QueuedEvent> snapshot, int offset) {
        Map<String, Object> report;
        synchronized (stateLock) {
            if (pendingReport == null && !unreportedDrops.isEmpty()) {
                // Freeze unreported drops under one stable ID, so every resend of them is counted once.
                pendingReport = new LinkedHashMap<>();
                pendingReport.put("report_id", UUID.randomUUID().toString().replace("-", ""));
                pendingReport.put("dropped_events", new LinkedHashMap<>(unreportedDrops));
                unreportedDrops.clear();
                saveClientReport(true);
            }
            report = pendingReport;
        }
        // A report never pushes a batch over maxBatchBytes; it waits for a batch with room.
        FrozenBatch batch = report == null ? null : fitBatch(snapshot, offset, report);
        batch = batch == null ? fitBatch(snapshot, offset, null) : batch;
        if (batch == null) {
            throw new SdkException("delivery_error", "queued event exceeds the configured request bound");
        }
        return batch;
    }

    private FrozenBatch fitBatch(List<QueuedEvent> snapshot, int offset, Map<String, Object> report) {
        List<QueuedEvent> batchEvents = new ArrayList<>();
        String body = null;
        int limit = Math.min(snapshot.size(), offset + deliveryOptions.maxBatchEvents());
        for (int index = offset; index < limit; index++) {
            batchEvents.add(snapshot.get(index));
            String candidate = serializeBatch(batchEvents, report);
            if (utf8Bytes(candidate) > deliveryOptions.maxBatchBytes()) {
                batchEvents.remove(batchEvents.size() - 1);
                break;
            }
            body = candidate;
        }

        if (batchEvents.isEmpty() || body == null) {
            return null;
        }
        return new FrozenBatch(Collections.unmodifiableList(new ArrayList<>(batchEvents)), body, report);
    }

    private SendResult sendBatch(Transport transport, String body, int maxAttempts) {
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
                if (transport instanceof AutomaticDeliveryTransport
                    && response.retryAfterDirective().outcome() != RetryAfterDirective.Outcome.NONE) {
                    throw new SdkException(
                        "transport_error",
                        "unexpected transport status " + response.statusCode()
                    );
                }
                if (response.statusCode() >= 500 && attempt < maxAttempts) {
                    continue;
                }
                throw new SdkException("transport_error", "unexpected transport status " + response.statusCode());
            } catch (TransportException error) {
                if (error.retryable() && attempt < maxAttempts && !Thread.currentThread().isInterrupted()) {
                    continue;
                }
                throw new SdkException(error.code(), error.getMessage());
            }
        }
        throw new SdkException("transport_error", "exhausted retries");
    }

    private void acknowledgePrefix(FrozenBatch batch) {
        List<QueuedEvent> accepted = batch.events;
        synchronized (stateLock) {
            // Drops recorded while this body was in flight stay pending under a new report ID.
            if (batch.report != null && batch.report == pendingReport) {
                pendingReport = null;
                saveClientReport(true);
            }
            List<EncryptedEventStore.Record> persisted = new ArrayList<>();
            Iterator<QueuedEvent> queued = events.iterator();
            for (QueuedEvent expected : accepted) {
                QueuedEvent actual = queued.hasNext() ? queued.next() : null;
                if (actual != expected) {
                    throw new SdkException("delivery_error", "queued event ownership changed during delivery");
                }
                if (eventStore != null) {
                    if (actual.persistedRecord == null) {
                        throw new SdkException("delivery_error", "persisted event ownership is missing");
                    }
                    persisted.add(actual.persistedRecord);
                }
            }
            if (eventStore != null) {
                eventStore.acknowledge(persisted);
            }
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
        ensureNotClosedOrClosing();
        ensurePersistenceRecovered();
    }

    private void ensureNotClosedOrClosing() {
        if (closed) {
            throw new SdkException("shutdown_error", "client is already shut down");
        }
        if (closing) {
            throw new SdkException("shutdown_error", "client is shutting down");
        }
    }

    private void ensurePersistenceRecovered() {
        if (!persistenceRecovered) {
            throw new SdkException(
                "persistence_recovery_required",
                "recover or purge persistence before capture or delivery"
            );
        }
    }

    private List<QueuedEvent> snapshotEvents() {
        synchronized (stateLock) {
            ensurePersistenceRecovered();
            return new ArrayList<>(events);
        }
    }

    private String serializeBatch(List<QueuedEvent> batchEvents, Map<String, Object> report) {
        StringBuilder builder = new StringBuilder();
        builder.append("{\n  \"sdk\": ");
        appendIndented(builder, Json.write(sdk), "  ");
        builder.append(",\n  \"events\": [");
        if (!batchEvents.isEmpty()) {
            builder.append('\n');
            for (int index = 0; index < batchEvents.size(); index++) {
                builder.append("    ");
                appendIndented(builder, batchEvents.get(index).eventJson, "    ");
                if (index + 1 < batchEvents.size()) {
                    builder.append(',');
                }
                builder.append('\n');
            }
            builder.append("  ");
        }
        builder.append(']');
        if (report != null) {
            builder.append(",\n  \"client_report\": ");
            appendIndented(builder, Json.write(report), "  ");
        }
        return builder.append("\n}").toString();
    }

    private static void appendIndented(StringBuilder builder, String value, String indentation) {
        int start = 0;
        int newline;
        while ((newline = value.indexOf('\n', start)) >= 0) {
            builder.append(value, start, newline + 1).append(indentation);
            start = newline + 1;
        }
        builder.append(value, start, value.length());
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
        private final String eventJson;
        private final long serializedBytes;
        private final EncryptedEventStore.Record persistedRecord;
        private final String id;
        private final String type;
        private final boolean fatal;

        private QueuedEvent(
            String eventJson,
            long serializedBytes,
            EncryptedEventStore.Record persistedRecord,
            String id,
            String type,
            boolean fatal
        ) {
            this.eventJson = eventJson;
            this.serializedBytes = serializedBytes;
            this.persistedRecord = persistedRecord;
            this.id = id;
            this.type = type;
            this.fatal = fatal;
        }
    }

    private static final class FrozenBatch {
        private final List<QueuedEvent> events;
        private final String body;
        private final Map<String, Object> report;

        private FrozenBatch(List<QueuedEvent> events, String body, Map<String, Object> report) {
            this.events = events;
            this.body = body;
            this.report = report;
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

    static final class DeliverySession {
        private final List<QueuedEvent> events;

        private DeliverySession(List<QueuedEvent> events) {
            this.events = Collections.unmodifiableList(events);
        }
    }

    interface DeliveryObserver {
        DeliveryObserver NONE = (eventCount, attempts) -> { };

        void onBatchAccepted(int eventCount, int attempts);
    }
}
