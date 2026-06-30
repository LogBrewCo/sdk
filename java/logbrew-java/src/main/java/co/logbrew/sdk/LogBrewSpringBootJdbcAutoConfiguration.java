package co.logbrew.sdk;

import javax.sql.DataSource;
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
 * Optional Spring Boot auto-configuration for app-owned JDBC data-source tracing.
 *
 * <p>The configuration activates only when Spring Boot, {@link DataSource}, and an
 * application-provided {@link LogBrewClient} bean are present. It wraps initialized Spring-owned
 * {@code DataSource} beans through the bean lifecycle and reuses {@link LogBrewJdbcTracing}.
 * It does not create clients from properties, register drivers, patch {@code DriverManager}, probe
 * connection metadata, mutate SQL comments, or capture SQL text, bind values, connection URLs,
 * JDBC login arguments, exception messages, stacks, baggage, or tracestate.</p>
 */
@AutoConfiguration(afterName = {
    "org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration",
    "org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration"
})
@ConditionalOnClass({DataSource.class, BeanPostProcessor.class})
@ConditionalOnBean(LogBrewClient.class)
@ConditionalOnProperty(prefix = "logbrew.jdbc", name = "enabled", havingValue = "true", matchIfMissing = true)
public class LogBrewSpringBootJdbcAutoConfiguration {
    /**
     * Wraps initialized Spring {@code DataSource} beans when the application owns a LogBrew client.
     */
    @Bean(name = "logBrewJdbcDataSourcePostProcessor")
    @ConditionalOnMissingBean(name = "logBrewJdbcDataSourcePostProcessor")
    public static BeanPostProcessor logBrewJdbcDataSourcePostProcessor(
        ObjectProvider<LogBrewClient> clientProvider,
        Environment environment
    ) {
        return new LogBrewSpringBootJdbcDataSourcePostProcessor(clientProvider, environment);
    }
}
