package co.logbrew.sdk;

import jakarta.servlet.Filter;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;

/**
 * Optional Spring Boot auto-configuration for app-owned request tracing.
 *
 * <p>The configuration activates only when Spring Boot, Jakarta Servlet, and an
 * application-provided {@link LogBrewClient} bean are present. It does not create clients
 * from properties, load ingest config, patch servlet containers, or capture request bodies,
 * arbitrary headers, cookies, query strings, full URLs, baggage, or tracestate.</p>
 */
@AutoConfiguration
@ConditionalOnClass({Filter.class, FilterRegistrationBean.class})
@ConditionalOnBean(LogBrewClient.class)
@ConditionalOnProperty(prefix = "logbrew.servlet", name = "enabled", havingValue = "true", matchIfMissing = true)
public class LogBrewSpringBootAutoConfiguration {
    private static final String DEFAULT_EVENT_ID_PREFIX = "spring_boot_request";
    private static final int DEFAULT_FILTER_ORDER = 1;

    /**
     * Registers the LogBrew servlet filter when the application owns a LogBrew client bean.
     */
    @Bean(name = "logBrewServletFilterRegistration")
    @ConditionalOnMissingBean(
        value = LogBrewServletFilter.class,
        name = "logBrewServletFilterRegistration"
    )
    public FilterRegistrationBean<LogBrewServletFilter> logBrewServletFilterRegistration(
        LogBrewClient client,
        Environment environment
    ) {
        LogBrewServletFilter filter = new LogBrewServletFilter(
            client,
            eventIdPrefix(environment),
            springMetadata(environment)
        );
        FilterRegistrationBean<LogBrewServletFilter> registration = new FilterRegistrationBean<>(filter);
        registration.setOrder(filterOrder(environment));
        return registration;
    }

    private static String eventIdPrefix(Environment environment) {
        String value = environment.getProperty("logbrew.servlet.event-id-prefix");
        if (value == null || value.trim().isEmpty()) {
            return DEFAULT_EVENT_ID_PREFIX;
        }
        return value.trim();
    }

    private static int filterOrder(Environment environment) {
        String value = environment.getProperty("logbrew.servlet.order");
        if (value == null || value.trim().isEmpty()) {
            return DEFAULT_FILTER_ORDER;
        }
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException error) {
            return DEFAULT_FILTER_ORDER;
        }
    }

    private static Map<String, Object> springMetadata(Environment environment) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("springApplicationName", environment.getProperty("spring.application.name", "application"));
        String[] activeProfiles = environment.getActiveProfiles();
        if (activeProfiles.length > 0) {
            values.put("springActiveProfiles", String.join(",", activeProfiles));
        }
        return values;
    }
}
