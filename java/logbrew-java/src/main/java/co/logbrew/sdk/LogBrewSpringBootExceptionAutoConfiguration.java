package co.logbrew.sdk;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;
import org.springframework.web.servlet.HandlerExceptionResolver;

/**
 * Optional Spring Boot auto-configuration for controller exception issue capture.
 *
 * <p>The configuration activates only when Spring MVC and an application-provided
 * {@link LogBrewClient} bean are present. It observes exceptions without resolving them and
 * can be disabled with {@code logbrew.servlet.capture-exceptions=false}.</p>
 */
@AutoConfiguration(after = LogBrewSpringBootAutoConfiguration.class)
@ConditionalOnClass(HandlerExceptionResolver.class)
@ConditionalOnBean(LogBrewClient.class)
@ConditionalOnProperty(
    prefix = "logbrew.servlet",
    name = {"enabled", "capture-exceptions"},
    havingValue = "true",
    matchIfMissing = true
)
public class LogBrewSpringBootExceptionAutoConfiguration {
    /**
     * Registers the non-resolving Spring MVC exception observer.
     */
    @Bean
    @ConditionalOnMissingBean(LogBrewSpringExceptionResolver.class)
    public LogBrewSpringExceptionResolver logBrewSpringExceptionResolver(
        LogBrewClient client,
        Environment environment
    ) {
        return new LogBrewSpringExceptionResolver(
            client,
            LogBrewSpringBootAutoConfiguration.eventIdPrefix(environment),
            LogBrewSpringBootAutoConfiguration.springMetadata(environment)
        );
    }
}
