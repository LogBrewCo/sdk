package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.List;
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

    LogBrewSpringBootKafkaBeanPostProcessor(LogBrewClient client, Environment environment) {
        this(new SingleLogBrewClientProvider(client), environment);
    }

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
        LogBrewClient client = clientProvider.getIfAvailable();
        if (client == null) {
            return bean;
        }
        if (producerEnabled() && bean instanceof ProducerFactory) {
            instrumentProducerFactory((ProducerFactory<?, ?>) bean, client);
        }
        if (consumerEnabled() && bean instanceof AbstractKafkaListenerContainerFactory) {
            instrumentListenerFactory((AbstractKafkaListenerContainerFactory<?, ?, ?>) bean, client);
        }
        return bean;
    }

    @Override
    public int getOrder() {
        return ORDER;
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private void instrumentProducerFactory(ProducerFactory<?, ?> factory, LogBrewClient client) {
        List<ProducerPostProcessor<?, ?>> postProcessors = (List) factory.getPostProcessors();
        for (ProducerPostProcessor<?, ?> postProcessor : postProcessors) {
            if (postProcessor instanceof LogBrewKafkaProducerPostProcessor) {
                return;
            }
        }
        ((ProducerFactory) factory).addPostProcessor(new LogBrewKafkaProducerPostProcessor<>(client, this));
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private void instrumentListenerFactory(
        AbstractKafkaListenerContainerFactory<?, ?, ?> factory,
        LogBrewClient client
    ) {
        RecordInterceptor existing = factory.getRecordInterceptor();
        if (LogBrewSpringKafkaTracing.isInstrumentedRecordInterceptor(existing)) {
            return;
        }
        LogBrewSpringKafkaTracing.ConsumerConfig config = LogBrewSpringKafkaTracing
            .ConsumerConfig
            .create()
            .eventIdPrefix(eventIdPrefix())
            .recordTimestampLatency(recordTimestampLatency())
            .metadata(springMetadata());
        if (existing != null) {
            config.delegate(existing);
        }
        factory.setRecordInterceptor(LogBrewSpringKafkaTracing.recordInterceptor(client, config));
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

    private static final class SingleLogBrewClientProvider implements ObjectProvider<LogBrewClient> {
        private final LogBrewClient client;

        private SingleLogBrewClientProvider(LogBrewClient client) {
            this.client = Objects.requireNonNull(client, "client");
        }

        @Override
        public LogBrewClient getObject(Object... args) {
            return client;
        }

        @Override
        public LogBrewClient getIfAvailable() {
            return client;
        }

        @Override
        public LogBrewClient getIfUnique() {
            return client;
        }

        @Override
        public LogBrewClient getObject() {
            return client;
        }
    }
}
