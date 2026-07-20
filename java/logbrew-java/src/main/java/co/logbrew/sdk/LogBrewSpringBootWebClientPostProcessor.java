package co.logbrew.sdk;

import java.util.List;
import java.util.Objects;
import java.util.function.Supplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import org.springframework.web.reactive.function.client.ExchangeFilterFunction;
import org.springframework.web.reactive.function.client.WebClient;

final class LogBrewSpringBootWebClientPostProcessor implements BeanPostProcessor, Ordered {
    private static final int ORDER = Ordered.LOWEST_PRECEDENCE - 20;
    private static final String SCOPED_TARGET_PREFIX = "scopedTarget.";

    private final Supplier<LogBrewClient> clientSupplier;
    private final Environment environment;

    LogBrewSpringBootWebClientPostProcessor(LogBrewClient client, Environment environment) {
        LogBrewClient fixedClient = Objects.requireNonNull(client, "client");
        this.clientSupplier = () -> fixedClient;
        this.environment = Objects.requireNonNull(environment, "environment");
    }

    LogBrewSpringBootWebClientPostProcessor(
        ObjectProvider<LogBrewClient> clientProvider,
        Environment environment
    ) {
        this.clientSupplier = Objects.requireNonNull(clientProvider, "clientProvider")::getIfAvailable;
        this.environment = Objects.requireNonNull(environment, "environment");
    }

    @Override
    public Object postProcessBeforeInitialization(Object bean, String beanName) {
        return instrument(bean, beanName);
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        return instrument(bean, beanName);
    }

    @Override
    public int getOrder() {
        return ORDER;
    }

    private Object instrument(Object bean, String beanName) {
        if (!enabled() || isScopedTarget(beanName) || !(bean instanceof WebClient.Builder)) {
            return bean;
        }
        LogBrewClient client = clientSupplier.get();
        if (client == null) {
            return bean;
        }
        WebClient.Builder builder = (WebClient.Builder) bean;
        builder.filters(filters -> instrument(filters, client));
        return bean;
    }

    private static void instrument(List<ExchangeFilterFunction> filters, LogBrewClient client) {
        if (filters.stream().noneMatch(LogBrewSpringWebClientTracing::isTracingFilter)) {
            filters.add(LogBrewSpringWebClientTracing.filter(client));
        }
    }

    private boolean enabled() {
        return booleanProperty("logbrew.http-client.enabled", true);
    }

    private boolean booleanProperty(String key, boolean defaultValue) {
        String value = environment.getProperty(key);
        if (value == null || value.trim().isEmpty()) {
            return defaultValue;
        }
        return Boolean.parseBoolean(value.trim());
    }

    private static boolean isScopedTarget(String beanName) {
        return beanName != null && beanName.startsWith(SCOPED_TARGET_PREFIX);
    }
}
