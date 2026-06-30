package co.logbrew.sdk;

import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.cache.CacheManager;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;

/**
 * Optional Spring Boot auto-configuration for app-owned Spring Cache tracing.
 *
 * <p>The configuration activates only when Spring Boot, Spring Cache, and an application-provided
 * {@link LogBrewClient} bean are present. It wraps initialized {@link CacheManager} beans and does
 * not create clients from properties, capture cache keys or values, inspect native cache objects,
 * or add baggage/tracestate propagation.</p>
 */
@AutoConfiguration(afterName = {
    "org.springframework.boot.autoconfigure.cache.CacheAutoConfiguration",
    "org.springframework.boot.cache.autoconfigure.CacheAutoConfiguration"
})
@ConditionalOnClass({CacheManager.class, BeanPostProcessor.class})
@ConditionalOnBean(LogBrewClient.class)
@ConditionalOnProperty(prefix = "logbrew.cache", name = "enabled", havingValue = "true", matchIfMissing = true)
public class LogBrewSpringBootCacheAutoConfiguration {
    /**
     * Registers a cache-manager post-processor when the app owns a LogBrew client bean.
     */
    @Bean(name = "logBrewSpringCacheManagerPostProcessor")
    public static BeanPostProcessor logBrewSpringCacheManagerPostProcessor(
        org.springframework.beans.factory.ObjectProvider<LogBrewClient> clientProvider,
        Environment environment
    ) {
        return new LogBrewSpringBootCacheManagerPostProcessor(clientProvider, environment);
    }
}
