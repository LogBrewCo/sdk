package co.logbrew.sdk;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;

/**
 * Optional Spring Boot auto-configuration for app-owned Spring Kafka tracing.
 *
 * <p>The configuration activates only when Spring Boot, Spring Kafka, an
 * application-provided {@link LogBrewClient} bean, and {@code logbrew.kafka.enabled=true}
 * are present. It adds LogBrew's producer post-processor to Spring Kafka producer factories and
 * composes a record interceptor into listener container factories. It does not create clients from
 * properties, capture record keys, values, arbitrary headers, broker addresses, consumer groups,
 * payloads, exception messages, stacks, baggage, or tracestate.</p>
 */
@AutoConfiguration(afterName = {
    "org.springframework.boot.autoconfigure.kafka.KafkaAutoConfiguration",
    "org.springframework.boot.kafka.autoconfigure.KafkaAutoConfiguration"
})
@ConditionalOnClass(name = {
    "org.springframework.kafka.core.ProducerFactory",
    "org.springframework.kafka.config.AbstractKafkaListenerContainerFactory"
})
@ConditionalOnBean(LogBrewClient.class)
@ConditionalOnProperty(prefix = "logbrew.kafka", name = "enabled", havingValue = "true")
public class LogBrewSpringBootKafkaAutoConfiguration {
    /**
     * Registers Spring Kafka producer and listener factory post-processing.
     */
    @Bean(name = "logBrewSpringKafkaBeanPostProcessor")
    @ConditionalOnMissingBean(name = "logBrewSpringKafkaBeanPostProcessor")
    public static BeanPostProcessor logBrewSpringKafkaBeanPostProcessor(
        ObjectProvider<LogBrewClient> clientProvider,
        Environment environment
    ) {
        return new LogBrewSpringBootKafkaBeanPostProcessor(clientProvider, environment);
    }
}
