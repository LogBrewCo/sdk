package co.logbrew.sdk;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;
import org.springframework.web.reactive.function.client.WebClient;

/**
 * Optional Spring Boot auto-configuration for reactive outbound HTTP tracing.
 *
 * <p>When the application owns a {@link LogBrewClient}, this configuration instruments Spring
 * {@link WebClient.Builder} beans once. It does not create clients, register Reactor hooks, or
 * capture request content.</p>
 */
@AutoConfiguration
@ConditionalOnClass({WebClient.class, BeanPostProcessor.class})
@ConditionalOnProperty(prefix = "logbrew.http-client", name = "enabled", havingValue = "true", matchIfMissing = true)
public class LogBrewSpringBootWebClientAutoConfiguration {
    /**
     * Registers the reactive HTTP client post-processor.
     *
     * @param clientProvider app-owned LogBrew client provider
     * @param environment Spring environment
     * @return WebClient post-processor
     */
    @Bean(name = "logBrewSpringWebClientPostProcessor")
    @ConditionalOnMissingBean(name = "logBrewSpringWebClientPostProcessor")
    public static BeanPostProcessor logBrewSpringWebClientPostProcessor(
        ObjectProvider<LogBrewClient> clientProvider,
        Environment environment
    ) {
        return new LogBrewSpringBootWebClientPostProcessor(clientProvider, environment);
    }
}
