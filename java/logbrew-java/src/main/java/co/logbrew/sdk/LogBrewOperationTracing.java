package co.logbrew.sdk;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Explicit app-owned dependency span helpers for database, cache, and queue operations.
 */
public final class LogBrewOperationTracing {
    private LogBrewOperationTracing() {
    }

    /**
     * Runs a database operation under a child trace and queues one privacy-bounded span.
     */
    public static <T> T databaseOperation(
        LogBrewClient client,
        String operationName,
        Callable<T> operation,
        DatabaseOperation config
    ) throws Exception {
        DatabaseOperation safeConfig = config == null ? DatabaseOperation.create() : config;
        return operationSpan(
            client,
            operationName,
            operation,
            safeConfig,
            "database",
            "database.operation",
            safeConfig.resolvedEventIdPrefix("java_database"),
            databaseMetadata(operationName, safeConfig),
            childTrace(safeConfig.spanId),
            null
        );
    }

    /**
     * Runs a cache operation under a child trace and queues one privacy-bounded span.
     */
    public static <T> T cacheOperation(
        LogBrewClient client,
        String operationName,
        Callable<T> operation,
        CacheOperation config
    ) throws Exception {
        CacheOperation safeConfig = config == null ? CacheOperation.create() : config;
        return operationSpan(
            client,
            operationName,
            operation,
            safeConfig,
            "cache",
            "cache.operation",
            safeConfig.resolvedEventIdPrefix("java_cache"),
            cacheMetadata(operationName, safeConfig),
            childTrace(safeConfig.spanId),
            null
        );
    }

    /**
     * Runs a queue operation under a child trace and queues one privacy-bounded span.
     */
    public static <T> T queueOperation(
        LogBrewClient client,
        String operationName,
        Callable<T> operation,
        QueueOperation config
    ) throws Exception {
        QueueOperation safeConfig = config == null ? QueueOperation.create() : config;
        LogBrewTraceContext trace = queueTrace(safeConfig);
        injectQueueTraceparent(safeConfig, trace);
        Instant startedAt = safeConfig.currentInstant();
        return operationSpan(
            client,
            operationName,
            operation,
            safeConfig,
            "queue",
            "queue.operation",
            safeConfig.resolvedEventIdPrefix("java_queue"),
            queueMetadata(operationName, safeConfig, startedAt),
            trace,
            queueSpanLinks(safeConfig),
            startedAt
        );
    }

    private static <T> T operationSpan(
        LogBrewClient client,
        String operationName,
        Callable<T> operation,
        BaseOperation<?> config,
        String spanNamePrefix,
        String source,
        String eventIdPrefix,
        Map<String, Object> metadata,
        LogBrewTraceContext trace,
        List<SpanLinkSummary> links
    ) throws Exception {
        return operationSpan(
            client,
            operationName,
            operation,
            config,
            spanNamePrefix,
            source,
            eventIdPrefix,
            metadata,
            trace,
            links,
            config.currentInstant()
        );
    }

    private static <T> T operationSpan(
        LogBrewClient client,
        String operationName,
        Callable<T> operation,
        BaseOperation<?> config,
        String spanNamePrefix,
        String source,
        String eventIdPrefix,
        Map<String, Object> metadata,
        LogBrewTraceContext trace,
        List<SpanLinkSummary> links,
        Instant startedAt
    ) throws Exception {
        Objects.requireNonNull(client, "client");
        Objects.requireNonNull(operation, "operation");
        Validation.requireNonEmpty("operation name", operationName);

        Exception operationError = null;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(trace);
        try {
            return operation.call();
        } catch (Exception error) {
            operationError = error;
            throw error;
        } finally {
            scope.close();
            Instant finishedAt = config.currentInstant();
            captureSpan(
                client,
                eventIdPrefix,
                spanNamePrefix + ":" + operationName.trim(),
                source,
                trace,
                metadata,
                spanEventsWithException(config.spanEvents, operationError),
                links,
                operationError,
                Duration.between(startedAt, finishedAt),
                finishedAt,
                config.onError
            );
        }
    }

    private static LogBrewTraceContext childTrace(String configuredSpanId) {
        String spanId = childSpanId(configuredSpanId);
        return LogBrewTrace.current()
            .map(parent -> LogBrewTraceContext.create(parent.traceId(), spanId, parent.spanId(), parent.traceFlags()))
            .orElseGet(() -> {
                LogBrewTraceContext root = LogBrewTraceContext.generate();
                if (configuredSpanId == null || configuredSpanId.trim().isEmpty()) {
                    return root;
                }
                return LogBrewTraceContext.create(root.traceId(), spanId);
            });
    }

    private static String childSpanId(String configuredSpanId) {
        return configuredSpanId == null || configuredSpanId.trim().isEmpty()
            ? LogBrewTraceContext.generate().spanId()
            : configuredSpanId.trim().toLowerCase(Locale.ROOT);
    }

    private static LogBrewTraceContext queueTrace(QueueOperation config) {
        if (config.incomingTraceparent != null && !config.incomingTraceparent.trim().isEmpty()) {
            try {
                return LogBrewTraceContext.fromTraceparent(
                    config.incomingTraceparent,
                    childSpanId(config.spanId)
                );
            } catch (SdkException error) {
                reportCaptureError(config.onError, error);
            }
        }
        return childTrace(config.spanId);
    }

    private static void injectQueueTraceparent(QueueOperation config, LogBrewTraceContext trace) {
        if (config.traceparentHeaderSetter == null) {
            return;
        }
        try {
            config.traceparentHeaderSetter.accept("traceparent", trace.traceparent());
        } catch (RuntimeException error) {
            reportCaptureError(
                config.onError,
                new SdkException("traceparent_injection_failed", "traceparent header setter failed")
            );
        }
    }

    private static List<SpanLinkSummary> queueSpanLinks(QueueOperation config) {
        if (config.linkedTraceparents == null || config.linkedTraceparents.isEmpty()) {
            return null;
        }
        List<SpanLinkSummary> links = new ArrayList<>();
        for (QueueTraceparentLink link : config.linkedTraceparents) {
            if (links.size() >= SpanLinkSummary.MAX_LINKS) {
                reportCaptureError(
                    config.onError,
                    new SdkException(
                        "validation_error",
                        "span links must contain at most " + SpanLinkSummary.MAX_LINKS + " entries"
                    )
                );
                break;
            }
            try {
                links.add(SpanLinkSummary
                    .fromTraceparent(link.traceparent)
                    .metadata(safeOperationMetadata(link.metadata)));
            } catch (SdkException error) {
                reportCaptureError(config.onError, error);
            }
        }
        return links;
    }

    private static void captureSpan(
        LogBrewClient client,
        String eventIdPrefix,
        String spanName,
        String source,
        LogBrewTraceContext trace,
        Map<String, Object> baseMetadata,
        List<SpanEventSummary> spanEvents,
        List<SpanLinkSummary> spanLinks,
        Exception operationError,
        Duration duration,
        Instant finishedAt,
        Consumer<SdkException> onError
    ) {
        Map<String, Object> metadata = new LinkedHashMap<>(baseMetadata);
        metadata.put("source", source);
        metadata.put("sampled", Boolean.valueOf(trace.sampled()));
        if (operationError != null) {
            metadata.put("errorType", operationError.getClass().getSimpleName());
        }
        SpanAttributes attributes = SpanAttributes
            .create(spanName, trace.traceId(), trace.spanId(), operationError == null ? "ok" : "error")
            .durationMs(duration.toNanos() / 1_000_000.0)
            .metadata(metadata);
        if (!spanEvents.isEmpty()) {
            attributes.events(spanEvents);
        }
        if (spanLinks != null && !spanLinks.isEmpty()) {
            attributes.links(spanLinks);
        }
        if (trace.parentSpanId() != null) {
            attributes.parentSpanId(trace.parentSpanId());
        }
        try {
            client.span(
                eventIdPrefix + "_span_" + trace.spanId(),
                finishedAt.toString(),
                attributes
            );
        } catch (SdkException error) {
            reportCaptureError(onError, error);
        }
    }

    private static Map<String, Object> databaseMetadata(String operationName, DatabaseOperation config) {
        Map<String, Object> metadata = safeOperationMetadata(config.metadata);
        addString(metadata, "dbSystem", config.system);
        addString(metadata, "dbOperation", operationName);
        addString(metadata, "dbOperationKind", config.operationKind);
        addString(metadata, "dbName", config.databaseName);
        addString(metadata, "dbStatementTemplate", config.statementTemplate);
        addNonNegativeInt(metadata, "rowCount", config.rowCount);
        return metadata;
    }

    private static Map<String, Object> cacheMetadata(String operationName, CacheOperation config) {
        Map<String, Object> metadata = safeOperationMetadata(config.metadata);
        addString(metadata, "cacheSystem", config.system);
        addString(metadata, "cacheOperation", operationName);
        addString(metadata, "cacheOperationKind", config.operationKind);
        addString(metadata, "cacheName", config.cacheName);
        if (config.hit != null) {
            metadata.put("cacheHit", config.hit);
        }
        addNonNegativeInt(metadata, "itemSizeBytes", config.itemSizeBytes);
        addNonNegativeInt(metadata, "itemCount", config.itemCount);
        return metadata;
    }

    private static Map<String, Object> queueMetadata(
        String operationName,
        QueueOperation config,
        Instant startedAt
    ) {
        Map<String, Object> metadata = safeOperationMetadata(config.metadata);
        addString(metadata, "queueSystem", config.system);
        addString(metadata, "queueOperation", operationName);
        addString(metadata, "queueOperationKind", config.operationKind);
        addString(metadata, "queueName", config.queueName);
        addString(metadata, "taskName", config.taskName);
        addNonNegativeInt(metadata, "messageCount", config.messageCount);
        addQueueTimeInQueueMs(metadata, config, startedAt);
        return metadata;
    }

    private static void addQueueTimeInQueueMs(
        Map<String, Object> metadata,
        QueueOperation config,
        Instant startedAt
    ) {
        Double value = config.timeInQueueMs;
        if (value == null && config.enqueuedAt != null) {
            value = Double.valueOf(Duration.between(config.enqueuedAt, startedAt).toNanos() / 1_000_000.0);
        }
        if (value == null) {
            return;
        }
        if (value.doubleValue() < 0.0 || value.isNaN() || value.isInfinite()) {
            reportCaptureError(
                config.onError,
                new SdkException("validation_error", "queue timeInQueueMs must be non-negative")
            );
            return;
        }
        metadata.put("timeInQueueMs", value);
    }

    private static List<SpanEventSummary> spanEventsWithException(
        List<SpanEventSummary> configuredEvents,
        Exception operationError
    ) {
        List<SpanEventSummary> safeEvents = new ArrayList<>();
        if (configuredEvents != null) {
            for (SpanEventSummary event : configuredEvents) {
                safeEvents.add(event.filterMetadataKeys(key -> !Validation.blockedDependencyMetadataKey(key)));
            }
        }
        if (operationError != null && safeEvents.size() < SpanEventSummary.MAX_EVENTS) {
            safeEvents.add(SpanEventSummary.create("exception").metadata(Map.of(
                "exceptionType", operationError.getClass().getSimpleName(),
                "exceptionEscaped", Boolean.TRUE
            )));
        }
        return safeEvents;
    }

    private static Map<String, Object> safeOperationMetadata(Map<String, ?> input) {
        return Validation.copySafeDependencyMetadata(input);
    }

    private static void addString(Map<String, Object> metadata, String key, String value) {
        if (value != null && !value.trim().isEmpty()) {
            metadata.put(key, value.trim());
        }
    }

    private static void addNonNegativeInt(Map<String, Object> metadata, String key, Integer value) {
        if (value != null && value.intValue() >= 0) {
            metadata.put(key, value);
        }
    }

    private static void reportCaptureError(Consumer<SdkException> onError, SdkException error) {
        if (onError == null) {
            return;
        }
        try {
            onError.accept(error);
        } catch (RuntimeException ignored) {
            // Preserve the app-owned operation result even if diagnostics handling fails.
        }
    }

    /**
     * Database span configuration.
     */
    public static final class DatabaseOperation extends BaseOperation<DatabaseOperation> {
        private String system;
        private String operationKind;
        private String databaseName;
        private String statementTemplate;
        private Integer rowCount;

        private DatabaseOperation() {
        }

        public static DatabaseOperation create() {
            return new DatabaseOperation();
        }

        public DatabaseOperation system(String value) {
            this.system = value;
            return this;
        }

        public DatabaseOperation operationKind(String value) {
            this.operationKind = value;
            return this;
        }

        public DatabaseOperation databaseName(String value) {
            this.databaseName = value;
            return this;
        }

        public DatabaseOperation statementTemplate(String value) {
            this.statementTemplate = value;
            return this;
        }

        public DatabaseOperation rowCount(int value) {
            this.rowCount = Integer.valueOf(value);
            return this;
        }

        @Override
        DatabaseOperation self() {
            return this;
        }
    }

    /**
     * Cache span configuration.
     */
    public static final class CacheOperation extends BaseOperation<CacheOperation> {
        private String system;
        private String operationKind;
        private String cacheName;
        private Boolean hit;
        private Integer itemSizeBytes;
        private Integer itemCount;

        private CacheOperation() {
        }

        public static CacheOperation create() {
            return new CacheOperation();
        }

        public CacheOperation system(String value) {
            this.system = value;
            return this;
        }

        public CacheOperation operationKind(String value) {
            this.operationKind = value;
            return this;
        }

        public CacheOperation cacheName(String value) {
            this.cacheName = value;
            return this;
        }

        public CacheOperation hit(boolean value) {
            this.hit = Boolean.valueOf(value);
            return this;
        }

        public CacheOperation itemSizeBytes(int value) {
            this.itemSizeBytes = Integer.valueOf(value);
            return this;
        }

        public CacheOperation itemCount(int value) {
            this.itemCount = Integer.valueOf(value);
            return this;
        }

        @Override
        CacheOperation self() {
            return this;
        }
    }

    /**
     * Queue span configuration.
     */
    public static final class QueueOperation extends BaseOperation<QueueOperation> {
        private String system;
        private String operationKind;
        private String queueName;
        private String taskName;
        private Integer messageCount;
        private String incomingTraceparent;
        private BiConsumer<String, String> traceparentHeaderSetter;
        private List<QueueTraceparentLink> linkedTraceparents;
        private Instant enqueuedAt;
        private Double timeInQueueMs;

        private QueueOperation() {
        }

        public static QueueOperation create() {
            return new QueueOperation();
        }

        public QueueOperation system(String value) {
            this.system = value;
            return this;
        }

        public QueueOperation operationKind(String value) {
            this.operationKind = value;
            return this;
        }

        public QueueOperation queueName(String value) {
            this.queueName = value;
            return this;
        }

        public QueueOperation taskName(String value) {
            this.taskName = value;
            return this;
        }

        public QueueOperation messageCount(int value) {
            this.messageCount = Integer.valueOf(value);
            return this;
        }

        public QueueOperation enqueuedAt(Instant value) {
            this.enqueuedAt = Objects.requireNonNull(value, "enqueuedAt");
            return this;
        }

        public QueueOperation timeInQueueMs(double value) {
            Validation.requireFiniteNumber("queue timeInQueueMs", value);
            this.timeInQueueMs = Double.valueOf(value);
            return this;
        }

        public QueueOperation incomingTraceparent(String value) {
            this.incomingTraceparent = value;
            return this;
        }

        public QueueOperation traceparentHeaderSetter(BiConsumer<String, String> value) {
            this.traceparentHeaderSetter = Objects.requireNonNull(value, "traceparentHeaderSetter");
            return this;
        }

        public QueueOperation linkedMessageTraceparent(String value) {
            return linkedMessageTraceparent(value, null);
        }

        public QueueOperation linkedMessageTraceparent(String value, Map<String, ?> metadata) {
            if (linkedTraceparents == null) {
                linkedTraceparents = new ArrayList<>();
            }
            linkedTraceparents.add(new QueueTraceparentLink(value, metadata));
            return this;
        }

        @Override
        QueueOperation self() {
            return this;
        }
    }

    private static final class QueueTraceparentLink {
        private final String traceparent;
        private final Map<String, ?> metadata;

        QueueTraceparentLink(String traceparent, Map<String, ?> metadata) {
            this.traceparent = traceparent;
            this.metadata = Validation.copyMetadata(metadata);
        }
    }

    private abstract static class BaseOperation<T extends BaseOperation<T>> {
        private String eventIdPrefix;
        protected String spanId;
        private List<SpanEventSummary> spanEvents;
        protected Map<String, ?> metadata;
        protected Consumer<SdkException> onError;
        private Supplier<Instant> now = Instant::now;

        abstract T self();

        public T eventIdPrefix(String value) {
            this.eventIdPrefix = value;
            return self();
        }

        public T spanId(String value) {
            this.spanId = value;
            return self();
        }

        public T metadata(Map<String, ?> value) {
            this.metadata = Validation.copyMetadata(value);
            return self();
        }

        public T spanEvent(SpanEventSummary value) {
            if (value == null) {
                throw new SdkException("validation_error", "span event summary must be provided");
            }
            if (spanEvents == null) {
                spanEvents = new ArrayList<>();
            }
            spanEvents.add(value);
            SpanEventSummary.requireEventLimit(spanEvents.size());
            return self();
        }

        public T spanEvents(Iterable<SpanEventSummary> values) {
            if (values == null) {
                throw new SdkException("validation_error", "span events must be provided");
            }
            List<SpanEventSummary> copied = new ArrayList<>();
            for (SpanEventSummary value : values) {
                if (value == null) {
                    throw new SdkException("validation_error", "span event summary must be provided");
                }
                copied.add(value);
                SpanEventSummary.requireEventLimit(copied.size());
            }
            this.spanEvents = copied;
            return self();
        }

        public T onError(Consumer<SdkException> value) {
            this.onError = value;
            return self();
        }

        public T now(Supplier<Instant> value) {
            this.now = Objects.requireNonNull(value, "now");
            return self();
        }

        public T nowSequence(Instant first, Instant second) {
            Instant[] values = {Objects.requireNonNull(first, "first"), Objects.requireNonNull(second, "second")};
            int[] index = {0};
            this.now = () -> values[Math.min(index[0]++, values.length - 1)];
            return self();
        }

        protected Instant currentInstant() {
            return now.get();
        }

        protected String resolvedEventIdPrefix(String fallback) {
            if (eventIdPrefix == null || eventIdPrefix.trim().isEmpty()) {
                return fallback;
            }
            return eventIdPrefix.trim();
        }
    }
}
