package co.logbrew.sdk;

import java.lang.reflect.Field;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import org.apache.kafka.clients.producer.Producer;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import org.springframework.kafka.config.AbstractKafkaListenerContainerFactory;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.core.ProducerPostProcessor;
import org.springframework.kafka.listener.RecordInterceptor;

final class LogBrewSpringBootKafkaBeanPostProcessor implements BeanPostProcessor, Ordered {
    private static final int ORDER = Ordered.LOWEST_PRECEDENCE - 12;
    private static final String SCOPED_TARGET_PREFIX = "scopedTarget.";

    private final ObjectProvider<LogBrewClient> clientProvider;
    private final Environment environment;

    LogBrewSpringBootKafkaBeanPostProcessor(
        ObjectProvider<LogBrewClient> clientProvider,
        Environment environment
    ) {
        this.clientProvider = Objects.requireNonNull(clientProvider, "clientProvider");
        this.environment = Objects.requireNonNull(environment, "environment");
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) throws BeansException {
        if (!enabled() || isScopedTarget(beanName)) {
            return bean;
        }
        boolean producerFactory = producerEnabled() && bean instanceof ProducerFactory;
        boolean listenerFactory = consumerEnabled() && bean instanceof AbstractKafkaListenerContainerFactory;
        if (!producerFactory && !listenerFactory) {
            return bean;
        }
        LogBrewClient client = clientProvider.getIfAvailable();
        if (client == null) {
            return bean;
        }
        if (producerFactory) {
            instrumentProducerFactory((ProducerFactory<?, ?>) bean, client);
        }
        if (listenerFactory) {
            instrumentListenerFactory((AbstractKafkaListenerContainerFactory<?, ?, ?>) bean, client);
        }
        return bean;
    }

    @Override
    public int getOrder() {
        return ORDER;
    }

    private <K, V> void instrumentProducerFactory(ProducerFactory<K, V> factory, LogBrewClient client) {
        for (ProducerPostProcessor<K, V> postProcessor : factory.getPostProcessors()) {
            if (postProcessor instanceof LogBrewKafkaProducerPostProcessor) {
                return;
            }
        }
        factory.addPostProcessor(new LogBrewKafkaProducerPostProcessor<>(client, this));
    }

    private <K, V> void instrumentListenerFactory(
        AbstractKafkaListenerContainerFactory<?, K, V> factory,
        LogBrewClient client
    ) {
        RecordInterceptor<K, V> existing = recordInterceptor(factory);
        if (LogBrewSpringKafkaTracing.isInstrumentedRecordInterceptor(existing)) {
            return;
        }
        LogBrewSpringKafkaTracing.ConsumerConfig<K, V> config = LogBrewSpringKafkaTracing
            .ConsumerConfig
            .<K, V>create()
            .eventIdPrefix(eventIdPrefix())
            .recordTimestampLatency(recordTimestampLatency())
            .metadata(springMetadata());
        if (existing != null) {
            config.delegate(existing);
        }
        factory.setRecordInterceptor(LogBrewSpringKafkaTracing.recordInterceptor(client, config));
    }

    // Spring Kafka 3.x has no getter for the interceptor, so this reads the field that setRecordInterceptor typed as
    // RecordInterceptor<K, V>. Reflection returns Object, and Java cannot check type arguments at run time.
    @SuppressWarnings("unchecked")
    private static <K, V> RecordInterceptor<K, V> recordInterceptor(AbstractKafkaListenerContainerFactory<?, K, V> factory) {
        try {
            Field field = AbstractKafkaListenerContainerFactory.class.getDeclaredField("recordInterceptor");
            field.setAccessible(true);
            return (RecordInterceptor<K, V>) field.get(factory);
        } catch (ReflectiveOperationException | RuntimeException error) {
            throw new IllegalStateException("spring kafka record interceptor cannot be inspected", error);
        }
    }

    private boolean enabled() {
        return booleanProperty("logbrew.kafka.enabled", false);
    }

    private boolean producerEnabled() {
        return booleanProperty("logbrew.kafka.producer.enabled", true);
    }

    private boolean consumerEnabled() {
        return booleanProperty("logbrew.kafka.consumer.enabled", true);
    }

    private boolean recordTimestampLatency() {
        return booleanProperty("logbrew.kafka.record-timestamp-latency", true);
    }

    private String eventIdPrefix() {
        return environment.getProperty("logbrew.kafka.event-id-prefix");
    }

    private boolean booleanProperty(String key, boolean defaultValue) {
        String value = environment.getProperty(key);
        if (value == null || value.trim().isEmpty()) {
            return defaultValue;
        }
        return Boolean.parseBoolean(value.trim());
    }

    private Map<String, Object> springMetadata() {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("springApplicationName", environment.getProperty("spring.application.name", "application"));
        String[] activeProfiles = environment.getActiveProfiles();
        if (activeProfiles.length > 0) {
            values.put("springActiveProfiles", String.join(",", activeProfiles));
        }
        return values;
    }

    private static boolean isScopedTarget(String beanName) {
        return beanName != null && beanName.startsWith(SCOPED_TARGET_PREFIX);
    }

    private static final class LogBrewKafkaProducerPostProcessor<K, V> implements ProducerPostProcessor<K, V> {
        private final LogBrewClient client;
        private final LogBrewSpringBootKafkaBeanPostProcessor parent;

        private LogBrewKafkaProducerPostProcessor(
            LogBrewClient client,
            LogBrewSpringBootKafkaBeanPostProcessor parent
        ) {
            this.client = Objects.requireNonNull(client, "client");
            this.parent = Objects.requireNonNull(parent, "parent");
        }

        @Override
        public Producer<K, V> apply(Producer<K, V> producer) {
            return LogBrewSpringKafkaTracing.producer(
                client,
                producer,
                LogBrewSpringKafkaTracing.ProducerConfig.<K, V>create()
                    .eventIdPrefix(parent.eventIdPrefix())
                    .metadata(parent.springMetadata())
            );
        }
    }

}
