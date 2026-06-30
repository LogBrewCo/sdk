package co.logbrew.sdk;

import java.lang.reflect.Method;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Explicit JMS-style tracing helpers for app-owned message objects.
 *
 * <p>The helpers work with app-owned {@code javax.jms.Message}, {@code jakarta.jms.Message},
 * or compatible message objects by reflecting only {@code setStringProperty(String, String)}
 * and {@code getStringProperty(String)}. LogBrew writes or reads one W3C {@code traceparent}
 * string property and delegates span capture to {@link LogBrewOperationTracing}. It does not
 * add a JMS dependency, patch connection factories, inspect destinations, capture message
 * bodies, enumerate arbitrary message properties, or propagate baggage/tracestate.</p>
 */
public final class LogBrewJmsTracing {
    private static final String TRACEPARENT_PROPERTY = "traceparent";
    private static final String DEFAULT_EVENT_ID_PREFIX = "java_jms";
    private static final String JMS_SYSTEM = "jms";
    private static final String PRODUCE_OPERATION = "jms.produce";
    private static final String PROCESS_OPERATION = "jms.process";

    private LogBrewJmsTracing() {
    }

    /**
     * Sends one app-owned JMS-style message with default safe tracing settings.
     */
    public static <T> T send(LogBrewClient client, Object message, Callable<T> operation) throws Exception {
        return send(client, message, operation, ProducerConfig.create());
    }

    /**
     * Sends one app-owned JMS-style message with app-owned tracing settings.
     */
    public static <T> T send(
        LogBrewClient client,
        Object message,
        Callable<T> operation,
        ProducerConfig config
    ) throws Exception {
        Objects.requireNonNull(message, "message");
        ProducerConfig safeConfig = config == null ? ProducerConfig.create() : config;
        LogBrewOperationTracing.QueueOperation queueConfig = baseQueueConfig(safeConfig, "produce")
            .traceparentHeaderSetter((name, value) ->
                setStringProperty(message, jmsPropertyName(name), value, configuredOnError(safeConfig))
            );
        return LogBrewOperationTracing.queueOperation(client, PRODUCE_OPERATION, operation, queueConfig);
    }

    /**
     * Processes one app-owned JMS-style message with default safe tracing settings.
     */
    public static <T> T process(LogBrewClient client, Object message, Callable<T> operation) throws Exception {
        return process(client, message, operation, ConsumerConfig.create());
    }

    /**
     * Processes one app-owned JMS-style message with app-owned tracing settings.
     */
    public static <T> T process(
        LogBrewClient client,
        Object message,
        Callable<T> operation,
        ConsumerConfig config
    ) throws Exception {
        Objects.requireNonNull(message, "message");
        ConsumerConfig safeConfig = config == null ? ConsumerConfig.create() : config;
        LogBrewOperationTracing.QueueOperation queueConfig = baseQueueConfig(safeConfig, "process")
            .incomingTraceparent(getStringProperty(message, TRACEPARENT_PROPERTY, configuredOnError(safeConfig)));
        if (safeConfig.messageCount != null) {
            queueConfig.messageCount(safeConfig.messageCount.intValue());
        }
        if (safeConfig.timeInQueueMs != null) {
            queueConfig.timeInQueueMs(safeConfig.timeInQueueMs.doubleValue());
        }
        return LogBrewOperationTracing.queueOperation(client, PROCESS_OPERATION, operation, queueConfig);
    }

    private static LogBrewOperationTracing.QueueOperation baseQueueConfig(BaseConfig<?> config, String operationKind) {
        LogBrewOperationTracing.QueueOperation queueConfig = LogBrewOperationTracing.QueueOperation.create()
            .system(JMS_SYSTEM)
            .operationKind(operationKind)
            .eventIdPrefix(config.resolvedEventIdPrefix())
            .now(config.now);
        if (config.spanId != null) {
            queueConfig.spanId(config.spanId);
        }
        if (config.destinationName != null) {
            queueConfig.queueName(config.destinationName);
        }
        if (config.metadata != null) {
            queueConfig.metadata(config.metadata);
        }
        if (config.onError != null) {
            queueConfig.onError(config.onError);
        }
        return queueConfig;
    }

    private static void setStringProperty(
        Object message,
        String name,
        String value,
        Consumer<SdkException> onError
    ) {
        try {
            Method method = message.getClass().getMethod("setStringProperty", String.class, String.class);
            method.setAccessible(true);
            method.invoke(message, name, value);
        } catch (ReflectiveOperationException | RuntimeException error) {
            reportDiagnostic(
                onError,
                new SdkException("jms_property_write_failed", "JMS string property write failed")
            );
        }
    }

    private static String getStringProperty(Object message, String name, Consumer<SdkException> onError) {
        try {
            Method method = message.getClass().getMethod("getStringProperty", String.class);
            method.setAccessible(true);
            Object value = method.invoke(message, name);
            if (value == null || value instanceof String) {
                return (String) value;
            }
        } catch (ReflectiveOperationException | RuntimeException error) {
            reportDiagnostic(
                onError,
                new SdkException("jms_property_read_failed", "JMS string property read failed")
            );
            return null;
        }
        reportDiagnostic(
            onError,
            new SdkException("jms_property_read_failed", "JMS string property read returned a non-string value")
        );
        return null;
    }

    private static String jmsPropertyName(String key) {
        return key.replace("-", "__dash__");
    }

    private static Consumer<SdkException> configuredOnError(BaseConfig<?> config) {
        return config.onError;
    }

    private static void reportDiagnostic(Consumer<SdkException> onError, SdkException error) {
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
     * Producer/send tracing configuration for app-owned JMS-style messages.
     */
    public static final class ProducerConfig extends BaseConfig<ProducerConfig> {
        private ProducerConfig() {
        }

        /**
         * Creates producer tracing configuration.
         */
        public static ProducerConfig create() {
            return new ProducerConfig();
        }

        @Override
        ProducerConfig self() {
            return this;
        }
    }

    /**
     * Consumer/process tracing configuration for app-owned JMS-style messages.
     */
    public static final class ConsumerConfig extends BaseConfig<ConsumerConfig> {
        private Integer messageCount;
        private Double timeInQueueMs;

        private ConsumerConfig() {
        }

        /**
         * Creates consumer tracing configuration.
         */
        public static ConsumerConfig create() {
            return new ConsumerConfig();
        }

        /**
         * Sets the primitive message count for a receive/process span.
         */
        public ConsumerConfig messageCount(int value) {
            this.messageCount = Integer.valueOf(value);
            return this;
        }

        /**
         * Sets the primitive broker latency in milliseconds when the app already has it.
         */
        public ConsumerConfig timeInQueueMs(double value) {
            Validation.requireFiniteNumber("JMS timeInQueueMs", value);
            this.timeInQueueMs = Double.valueOf(value);
            return this;
        }

        @Override
        ConsumerConfig self() {
            return this;
        }
    }

    private abstract static class BaseConfig<T extends BaseConfig<T>> {
        private String eventIdPrefix;
        private String spanId;
        private String destinationName;
        private Map<String, ?> metadata;
        private Consumer<SdkException> onError;
        private Supplier<Instant> now = Instant::now;

        abstract T self();

        /**
         * Sets the span event ID prefix.
         */
        public T eventIdPrefix(String value) {
            this.eventIdPrefix = value;
            return self();
        }

        /**
         * Sets an app-owned child span ID for deterministic tests or advanced correlation.
         */
        public T spanId(String value) {
            this.spanId = value;
            return self();
        }

        /**
         * Sets the JMS destination name when the app can provide a safe queue/topic label.
         */
        public T destinationName(String value) {
            this.destinationName = value;
            return self();
        }

        /**
         * Sets primitive metadata merged into captured JMS spans.
         */
        public T metadata(Map<String, ?> value) {
            this.metadata = Validation.copyMetadata(value);
            return self();
        }

        /**
         * Receives non-fatal tracing and capture diagnostics.
         */
        public T onError(Consumer<SdkException> value) {
            this.onError = value;
            return self();
        }

        /**
         * Sets the clock used for span timing.
         */
        public T now(Supplier<Instant> value) {
            this.now = Objects.requireNonNull(value, "now");
            return self();
        }

        /**
         * Sets two deterministic timestamps for start and finish timing.
         */
        public T nowSequence(Instant first, Instant second) {
            Instant[] values = {Objects.requireNonNull(first, "first"), Objects.requireNonNull(second, "second")};
            int[] index = {0};
            this.now = () -> values[Math.min(index[0]++, values.length - 1)];
            return self();
        }

        private String resolvedEventIdPrefix() {
            if (eventIdPrefix == null || eventIdPrefix.trim().isEmpty()) {
                return DEFAULT_EVENT_ID_PREFIX;
            }
            return eventIdPrefix.trim();
        }

    }
}
