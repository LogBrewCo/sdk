package co.logbrew.sdk;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Supplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestTemplate;

final class LogBrewSpringBootHttpClientPostProcessor implements BeanPostProcessor, Ordered {
    private static final int ORDER = Ordered.LOWEST_PRECEDENCE - 20;
    private static final String SCOPED_TARGET_PREFIX = "scopedTarget.";

    private final Supplier<LogBrewClient> clientSupplier;
    private final Environment environment;

    LogBrewSpringBootHttpClientPostProcessor(LogBrewClient client, Environment environment) {
        LogBrewClient fixedClient = Objects.requireNonNull(client, "client");
        this.clientSupplier = () -> fixedClient;
        this.environment = Objects.requireNonNull(environment, "environment");
    }

    LogBrewSpringBootHttpClientPostProcessor(
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
        if (!enabled() || isScopedTarget(beanName)) {
            return bean;
        }
        boolean restClientBuilder = bean instanceof RestClient.Builder;
        boolean restTemplate = bean instanceof RestTemplate;
        if (!restClientBuilder && !restTemplate) {
            return bean;
        }
        LogBrewClient client = clientSupplier.get();
        if (client == null) {
            return bean;
        }
        if (restClientBuilder) {
            instrumentBuilder((RestClient.Builder) bean, client);
        } else {
            instrumentTemplate((RestTemplate) bean, client);
        }
        return bean;
    }

    private static void instrumentBuilder(RestClient.Builder builder, LogBrewClient client) {
        builder.requestInterceptors(interceptors -> {
            if (!containsLogBrewInterceptor(interceptors)) {
                interceptors.add(LogBrewSpringHttpTracing.restClientInterceptor(client));
            }
        });
    }

    private static void instrumentTemplate(RestTemplate template, LogBrewClient client) {
        List<ClientHttpRequestInterceptor> interceptors = template.getInterceptors();
        if (containsLogBrewInterceptor(interceptors)) {
            return;
        }
        List<ClientHttpRequestInterceptor> updated = new ArrayList<>(interceptors);
        updated.add(LogBrewSpringHttpTracing.restTemplateInterceptor(client));
        template.setInterceptors(updated);
    }

    private static boolean containsLogBrewInterceptor(List<ClientHttpRequestInterceptor> interceptors) {
        return interceptors.stream().anyMatch(LogBrewSpringHttpTracing::isTracingInterceptor);
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
