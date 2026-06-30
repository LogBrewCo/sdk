package co.logbrew.sdk;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;
import org.apache.kafka.clients.consumer.Consumer;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.header.internals.RecordHeaders;
import org.springframework.kafka.core.KafkaOperations;
import org.springframework.kafka.listener.RecordInterceptor;
import org.springframework.kafka.support.SendResult;

/**
 * Spring Kafka helpers for app-owned consumer and producer record tracing.
 *
 * <p>Apps register the returned {@link RecordInterceptor} with their own listener
 * container factory or call {@link #producerSend(LogBrewClient, KafkaOperations, ProducerRecord)}
 * for app-owned sends. LogBrew continues or injects one W3C {@code traceparent},
 * keeps the child trace active while app code runs, and emits one sanitized queue
 * span when Spring Kafka reports success or failure. It does not capture record
 * keys, values, offsets, arbitrary headers, broker details, baggage, or tracestate.</p>
 */
public final class LogBrewSpringKafkaTracing {
    private static final String TRACEPARENT_HEADER = "traceparent";
    private static final String DEFAULT_EVENT_ID_PREFIX = "spring_kafka";

    private LogBrewSpringKafkaTracing() {
    }

    /**
     * Creates a Spring Kafka record interceptor with default safe settings.
     */
    public static <K, V> RecordInterceptor<K, V> recordInterceptor(LogBrewClient client) {
        return recordInterceptor(client, ConsumerConfig.<K, V>create());
    }

    /**
     * Creates a Spring Kafka record interceptor with app-owned settings.
     */
    public static <K, V> RecordInterceptor<K, V> recordInterceptor(
        LogBrewClient client,
        ConsumerConfig<K, V> config
    ) {
        return new LogBrewRecordInterceptor<>(
            Objects.requireNonNull(client, "client"),
            config == null ? ConsumerConfig.<K, V>create() : config
        );
    }

    /**
     * Sends one app-owned Spring Kafka producer record with a LogBrew traceparent.
     */
    public static <K, V> CompletableFuture<SendResult<K, V>> producerSend(
        LogBrewClient client,
        KafkaOperations<K, V> operations,
        ProducerRecord<K, V> record
    ) {
        return producerSend(client, operations, record, ProducerConfig.<K, V>create());
    }

    /**
     * Sends one app-owned Spring Kafka producer record with app-owned tracing settings.
     */
    public static <K, V> CompletableFuture<SendResult<K, V>> producerSend(
        LogBrewClient client,
        KafkaOperations<K, V> operations,
        ProducerRecord<K, V> record,
        ProducerConfig<K, V> config
    ) {
        Objects.requireNonNull(client, "client");
        Objects.requireNonNull(operations, "operations");
        Objects.requireNonNull(record, "record");
        ProducerConfig<K, V> safeConfig = config == null ? ProducerConfig.<K, V>create() : config;
        Instant startedAt = safeConfig.currentInstant();
        LogBrewTraceContext trace = producerTrace(safeConfig);
        ProducerRecord<K, V> tracedRecord = recordWithTraceparent(record, trace.traceparent());
        CompletableFuture<SendResult<K, V>> future;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(trace);
        try {
            future = operations.send(tracedRecord);
        } catch (RuntimeException error) {
            captureProducerSpan(client, safeConfig, record, trace, startedAt, safeConfig.currentInstant(), error);
            return failedFuture(error);
        } finally {
            scope.close();
        }
        if (future == null) {
            SdkException error = new SdkException("validation_error", "spring kafka send future must be provided");
            captureProducerSpan(client, safeConfig, record, trace, startedAt, safeConfig.currentInstant(), error);
            return failedFuture(error);
        }
        future.whenComplete((result, error) ->
            captureProducerSpan(client, safeConfig, record, trace, startedAt, safeConfig.currentInstant(), error)
        );
        return future;
    }

    private static <T> CompletableFuture<T> failedFuture(Throwable error) {
        CompletableFuture<T> failed = new CompletableFuture<>();
        failed.completeExceptionally(error);
        return failed;
    }

    /**
     * Spring Kafka consumer record tracing configuration.
     */
    public static final class ConsumerConfig<K, V> {
        private String eventIdPrefix;
        private String spanId;
        private Map<String, ?> metadata;
        private java.util.function.Consumer<SdkException> onError;
        private Supplier<Instant> now = Instant::now;
        private RecordInterceptor<K, V> delegate;
        private boolean recordTimestampLatency = true;

        private ConsumerConfig() {
        }

        /**
         * Creates Spring Kafka consumer tracing configuration.
         */
        public static <K, V> ConsumerConfig<K, V> create() {
            return new ConsumerConfig<>();
        }

        /**
         * Sets the span event ID prefix.
         */
        public ConsumerConfig<K, V> eventIdPrefix(String value) {
            this.eventIdPrefix = value;
            return this;
        }

        /**
         * Sets an app-owned child span ID for deterministic tests or advanced correlation.
         */
        public ConsumerConfig<K, V> spanId(String value) {
            this.spanId = value;
            return this;
        }

        /**
         * Sets primitive metadata merged into captured Spring Kafka spans.
         */
        public ConsumerConfig<K, V> metadata(Map<String, ?> value) {
            this.metadata = Validation.copyMetadata(value);
            return this;
        }

        /**
         * Receives non-fatal tracing and capture diagnostics.
         */
        public ConsumerConfig<K, V> onError(java.util.function.Consumer<SdkException> value) {
            this.onError = value;
            return this;
        }

        /**
         * Sets the clock used for span timing.
         */
        public ConsumerConfig<K, V> now(Supplier<Instant> value) {
            this.now = Objects.requireNonNull(value, "now");
            return this;
        }

        /**
         * Sets two deterministic timestamps for start and finish timing.
         */
        public ConsumerConfig<K, V> nowSequence(Instant first, Instant second) {
            Instant[] values = {Objects.requireNonNull(first, "first"), Objects.requireNonNull(second, "second")};
            int[] index = {0};
            this.now = () -> values[Math.min(index[0]++, values.length - 1)];
            return this;
        }

        /**
         * Delegates to an existing Spring Kafka record interceptor.
         */
        public ConsumerConfig<K, V> delegate(RecordInterceptor<K, V> value) {
            this.delegate = value;
            return this;
        }

        /**
         * Enables or disables primitive latency derived from {@link ConsumerRecord#timestamp()}.
         */
        public ConsumerConfig<K, V> recordTimestampLatency(boolean value) {
            this.recordTimestampLatency = value;
            return this;
        }

        private Instant currentInstant() {
            return now.get();
        }

        private String resolvedEventIdPrefix() {
            if (eventIdPrefix == null || eventIdPrefix.trim().isEmpty()) {
                return DEFAULT_EVENT_ID_PREFIX;
            }
            return eventIdPrefix.trim();
        }
    }

    /**
     * Spring Kafka producer record tracing configuration.
     */
    public static final class ProducerConfig<K, V> {
        private String eventIdPrefix;
        private String spanId;
        private Map<String, ?> metadata;
        private java.util.function.Consumer<SdkException> onError;
        private Supplier<Instant> now = Instant::now;

        private ProducerConfig() {
        }

        /**
         * Creates Spring Kafka producer tracing configuration.
         */
        public static <K, V> ProducerConfig<K, V> create() {
            return new ProducerConfig<>();
        }

        /**
         * Sets the span event ID prefix.
         */
        public ProducerConfig<K, V> eventIdPrefix(String value) {
            this.eventIdPrefix = value;
            return this;
        }

        /**
         * Sets an app-owned child span ID for deterministic tests or advanced correlation.
         */
        public ProducerConfig<K, V> spanId(String value) {
            this.spanId = value;
            return this;
        }

        /**
         * Sets primitive metadata merged into captured Spring Kafka producer spans.
         */
        public ProducerConfig<K, V> metadata(Map<String, ?> value) {
            this.metadata = Validation.copyMetadata(value);
            return this;
        }

        /**
         * Receives non-fatal tracing and capture diagnostics.
         */
        public ProducerConfig<K, V> onError(java.util.function.Consumer<SdkException> value) {
            this.onError = value;
            return this;
        }

        /**
         * Sets the clock used for span timing.
         */
        public ProducerConfig<K, V> now(Supplier<Instant> value) {
            this.now = Objects.requireNonNull(value, "now");
            return this;
        }

        /**
         * Sets two deterministic timestamps for start and finish timing.
         */
        public ProducerConfig<K, V> nowSequence(Instant first, Instant second) {
            Instant[] values = {Objects.requireNonNull(first, "first"), Objects.requireNonNull(second, "second")};
            int[] index = {0};
            this.now = () -> values[Math.min(index[0]++, values.length - 1)];
            return this;
        }

        private Instant currentInstant() {
            return now.get();
        }

        private String resolvedEventIdPrefix() {
            if (eventIdPrefix == null || eventIdPrefix.trim().isEmpty()) {
                return DEFAULT_EVENT_ID_PREFIX + "_produce";
            }
            return eventIdPrefix.trim();
        }
    }

    private static <K, V> LogBrewTraceContext producerTrace(ProducerConfig<K, V> config) {
        String spanId = configuredSpanId(config.spanId);
        Optional<LogBrewTraceContext> current = LogBrewTrace.current();
        if (current.isPresent()) {
            LogBrewTraceContext parent = current.get();
            return LogBrewTraceContext.create(parent.traceId(), spanId, parent.spanId(), parent.traceFlags());
        }
        LogBrewTraceContext root = LogBrewTraceContext.generate();
        if (config.spanId == null || config.spanId.trim().isEmpty()) {
            return root;
        }
        return LogBrewTraceContext.create(root.traceId(), spanId);
    }

    private static String configuredSpanId(String spanId) {
        if (spanId == null || spanId.trim().isEmpty()) {
            return LogBrewTraceContext.generate().spanId();
        }
        return spanId.trim().toLowerCase(Locale.ROOT);
    }

    private static <K, V> ProducerRecord<K, V> recordWithTraceparent(
        ProducerRecord<K, V> record,
        String traceparent
    ) {
        RecordHeaders headers = new RecordHeaders(record.headers());
        headers.remove(TRACEPARENT_HEADER);
        headers.add(TRACEPARENT_HEADER, traceparent.getBytes(StandardCharsets.UTF_8));
        return new ProducerRecord<>(
            record.topic(),
            record.partition(),
            record.timestamp(),
            record.key(),
            record.value(),
            headers
        );
    }

    private static <K, V> void captureProducerSpan(
        LogBrewClient client,
        ProducerConfig<K, V> config,
        ProducerRecord<K, V> record,
        LogBrewTraceContext trace,
        Instant startedAt,
        Instant finishedAt,
        Throwable error
    ) {
        Duration duration = Duration.between(startedAt, finishedAt);
        double durationMs = duration.isNegative() ? 0.0 : duration.toNanos() / 1_000_000.0;
        if (duration.isNegative()) {
            reportError(config.onError, new SdkException("validation_error", "spring kafka duration must be non-negative"));
        }
        SpanAttributes attributes = SpanAttributes
            .create(
                "spring.kafka.produce:" + record.topic(),
                trace.traceId(),
                trace.spanId(),
                error == null ? "ok" : "error"
            )
            .durationMs(durationMs)
            .metadata(producerMetadata(record, trace, config, error));
        if (trace.parentSpanId() != null) {
            attributes.parentSpanId(trace.parentSpanId());
        }
        if (error != null) {
            attributes.event(SpanEventSummary.create("exception").metadata(exceptionMetadata(error)));
        }
        try {
            client.span(
                config.resolvedEventIdPrefix() + "_span_" + trace.spanId(),
                finishedAt.toString(),
                attributes
            );
        } catch (SdkException captureError) {
            reportError(config.onError, captureError);
        } catch (RuntimeException captureError) {
            reportError(config.onError, new SdkException("capture_error", "spring kafka producer span capture failed"));
        }
    }

    private static <K, V> Map<String, Object> producerMetadata(
        ProducerRecord<K, V> record,
        LogBrewTraceContext trace,
        ProducerConfig<K, V> config,
        Throwable error
    ) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.putAll(Validation.copySafeDependencyMetadata(config.metadata));
        values.put("framework", "spring-kafka");
        values.put("source", "spring.kafka.producer");
        values.put("sampled", Boolean.valueOf(trace.sampled()));
        values.put("queueSystem", "kafka");
        values.put("queueOperation", "produce");
        values.put("queueOperationKind", "produce");
        values.put("queueName", record.topic());
        if (error != null) {
            values.put("errorType", error.getClass().getSimpleName());
        }
        return values;
    }

    private static Map<String, Object> exceptionMetadata(Throwable error) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("exceptionType", error.getClass().getSimpleName());
        values.put("exceptionEscaped", Boolean.TRUE);
        return values;
    }

    private static void reportError(java.util.function.Consumer<SdkException> onError, SdkException error) {
        if (onError == null) {
            return;
        }
        try {
            onError.accept(error);
        } catch (RuntimeException ignored) {
            // Diagnostics callbacks are advisory and must not affect app-owned Kafka operations.
        }
    }

    private static final class LogBrewRecordInterceptor<K, V> implements RecordInterceptor<K, V> {
        private final LogBrewClient client;
        private final ConsumerConfig<K, V> config;
        private final ThreadLocal<ActiveRecord> activeRecord = new ThreadLocal<>();

        private LogBrewRecordInterceptor(LogBrewClient client, ConsumerConfig<K, V> config) {
            this.client = client;
            this.config = config;
        }

        @Override
        public ConsumerRecord<K, V> intercept(ConsumerRecord<K, V> record, Consumer<K, V> consumer) {
            finishRecord(null, "ok");
            ActiveRecord active = startRecord(record);
            activeRecord.set(active);
            boolean completed = false;
            try {
                if (config.delegate != null) {
                    ConsumerRecord<K, V> result = config.delegate.intercept(record, consumer);
                    completed = true;
                    return result;
                }
                completed = true;
                return record;
            } finally {
                if (!completed) {
                    finishRecord(null, "error");
                }
            }
        }

        @Override
        public void success(ConsumerRecord<K, V> record, Consumer<K, V> consumer) {
            try {
                if (config.delegate != null) {
                    config.delegate.success(record, consumer);
                }
            } finally {
                finishRecord(null, "ok");
            }
        }

        @Override
        public void failure(ConsumerRecord<K, V> record, Exception exception, Consumer<K, V> consumer) {
            try {
                if (config.delegate != null) {
                    config.delegate.failure(record, exception, consumer);
                }
            } finally {
                finishRecord(exception, "error");
            }
        }

        @Override
        public void afterRecord(ConsumerRecord<K, V> record, Consumer<K, V> consumer) {
            if (config.delegate != null) {
                config.delegate.afterRecord(record, consumer);
            }
        }

        @Override
        public void setupThreadState(Consumer<?, ?> consumer) {
            if (config.delegate != null) {
                config.delegate.setupThreadState(consumer);
            }
        }

        @Override
        public void clearThreadState(Consumer<?, ?> consumer) {
            try {
                finishRecord(null, "ok");
            } finally {
                if (config.delegate != null) {
                    config.delegate.clearThreadState(consumer);
                }
            }
        }

        private ActiveRecord startRecord(ConsumerRecord<K, V> record) {
            Instant startedAt = config.currentInstant();
            LogBrewTraceContext trace = traceForRecord(record);
            LogBrewTrace.Scope scope = LogBrewTrace.activate(trace);
            return new ActiveRecord(record, trace, startedAt, scope);
        }

        private LogBrewTraceContext traceForRecord(ConsumerRecord<K, V> record) {
            String incoming = traceparentHeader(record);
            String spanId = configuredSpanId();
            if (incoming != null) {
                try {
                    return LogBrewTraceContext.fromTraceparent(incoming, spanId);
                } catch (SdkException error) {
                    reportError(error);
                }
            }
            Optional<LogBrewTraceContext> current = LogBrewTrace.current();
            if (current.isPresent()) {
                LogBrewTraceContext parent = current.get();
                return LogBrewTraceContext.create(parent.traceId(), spanId, parent.spanId(), parent.traceFlags());
            }
            LogBrewTraceContext root = LogBrewTraceContext.generate();
            if (config.spanId == null || config.spanId.trim().isEmpty()) {
                return root;
            }
            return LogBrewTraceContext.create(root.traceId(), spanId);
        }

        private String configuredSpanId() {
            return LogBrewSpringKafkaTracing.configuredSpanId(config.spanId);
        }

        private String traceparentHeader(ConsumerRecord<K, V> record) {
            Header header = record.headers().lastHeader(TRACEPARENT_HEADER);
            if (header == null || header.value() == null) {
                return null;
            }
            return new String(header.value(), StandardCharsets.UTF_8);
        }

        private void finishRecord(Throwable error, String status) {
            ActiveRecord active = activeRecord.get();
            if (active == null) {
                return;
            }
            activeRecord.remove();
            active.scope.close();
            Instant finishedAt = config.currentInstant();
            Duration duration = Duration.between(active.startedAt, finishedAt);
            double durationMs = duration.isNegative() ? 0.0 : duration.toNanos() / 1_000_000.0;
            if (duration.isNegative()) {
                reportError(new SdkException("validation_error", "spring kafka duration must be non-negative"));
            }
            SpanAttributes attributes = SpanAttributes
                .create(spanName(active.record), active.trace.traceId(), active.trace.spanId(), status)
                .durationMs(durationMs)
                .metadata(metadata(active.record, active.trace, active.startedAt, error));
            if (active.trace.parentSpanId() != null) {
                attributes.parentSpanId(active.trace.parentSpanId());
            }
            if (error != null) {
                attributes.event(SpanEventSummary.create("exception").metadata(
                    LogBrewSpringKafkaTracing.exceptionMetadata(error)
                ));
            }
            try {
                client.span(
                    config.resolvedEventIdPrefix() + "_span_" + active.trace.spanId(),
                    finishedAt.toString(),
                    attributes
                );
            } catch (SdkException captureError) {
                reportError(captureError);
            } catch (RuntimeException captureError) {
                reportError(new SdkException("capture_error", "spring kafka span capture failed"));
            }
        }

        private String spanName(ConsumerRecord<?, ?> record) {
            return "spring.kafka.process:" + record.topic();
        }

        private Map<String, Object> metadata(
            ConsumerRecord<?, ?> record,
            LogBrewTraceContext trace,
            Instant startedAt,
            Throwable error
        ) {
            Map<String, Object> values = new LinkedHashMap<>();
            values.putAll(Validation.copySafeDependencyMetadata(config.metadata));
            values.put("framework", "spring-kafka");
            values.put("source", "spring.kafka.record");
            values.put("sampled", Boolean.valueOf(trace.sampled()));
            values.put("queueSystem", "kafka");
            values.put("queueOperation", "process");
            values.put("queueOperationKind", "process");
            values.put("queueName", record.topic());
            if (error != null) {
                values.put("errorType", error.getClass().getSimpleName());
            }
            addTimeInQueue(values, record, startedAt);
            return values;
        }

        private void addTimeInQueue(Map<String, Object> values, ConsumerRecord<?, ?> record, Instant startedAt) {
            if (!config.recordTimestampLatency || record.timestamp() < 0) {
                return;
            }
            Duration latency = Duration.between(Instant.ofEpochMilli(record.timestamp()), startedAt);
            if (latency.isNegative()) {
                reportError(new SdkException("validation_error", "spring kafka timeInQueueMs must be non-negative"));
                return;
            }
            values.put("timeInQueueMs", Double.valueOf(latency.toNanos() / 1_000_000.0));
        }

        private void reportError(SdkException error) {
            LogBrewSpringKafkaTracing.reportError(config.onError, error);
        }
    }

    private static final class ActiveRecord {
        private final ConsumerRecord<?, ?> record;
        private final LogBrewTraceContext trace;
        private final Instant startedAt;
        private final LogBrewTrace.Scope scope;

        private ActiveRecord(
            ConsumerRecord<?, ?> record,
            LogBrewTraceContext trace,
            Instant startedAt,
            LogBrewTrace.Scope scope
        ) {
            this.record = record;
            this.trace = trace;
            this.startedAt = startedAt;
            this.scope = scope;
        }
    }
}
