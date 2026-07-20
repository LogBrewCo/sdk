package co.logbrew.sdk;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestTemplate;

/**
 * Optional Spring Boot auto-configuration for blocking outbound HTTP tracing.
 *
 * <p>When the application owns a {@link LogBrewClient}, this configuration instruments Spring
 * {@link RestClient.Builder} and {@link RestTemplate} beans once. It does not create clients,
 * patch global builders, or capture request content.</p>
 */
@AutoConfiguration
@ConditionalOnClass({RestClient.class, RestTemplate.class, BeanPostProcessor.class})
@ConditionalOnProperty(prefix = "logbrew.http-client", name = "enabled", havingValue = "true", matchIfMissing = true)
public class LogBrewSpringBootHttpClientAutoConfiguration {
    /**
     * Registers the blocking HTTP client post-processor.
     *
     * @param clientProvider app-owned LogBrew client provider
     * @param environment Spring environment
     * @return HTTP client post-processor
     */
    @Bean(name = "logBrewSpringHttpClientPostProcessor")
    @ConditionalOnMissingBean(name = "logBrewSpringHttpClientPostProcessor")
    public static BeanPostProcessor logBrewSpringHttpClientPostProcessor(
        ObjectProvider<LogBrewClient> clientProvider,
        Environment environment
    ) {
        return new LogBrewSpringBootHttpClientPostProcessor(clientProvider, environment);
    }
}
