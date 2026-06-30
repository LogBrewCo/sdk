package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import javax.sql.DataSource;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;

final class LogBrewSpringBootJdbcDataSourcePostProcessor implements BeanPostProcessor, Ordered {
    private static final int ORDER = Ordered.LOWEST_PRECEDENCE - 20;
    private static final String SCOPED_TARGET_PREFIX = "scopedTarget.";
    private static final Class<?> ROUTING_DATA_SOURCE_CLASS = routingDataSourceClass();

    private final ObjectProvider<LogBrewClient> clientProvider;
    private final Environment environment;

    LogBrewSpringBootJdbcDataSourcePostProcessor(LogBrewClient client, Environment environment) {
        this(new SingleLogBrewClientProvider(client), environment);
    }

    LogBrewSpringBootJdbcDataSourcePostProcessor(
        ObjectProvider<LogBrewClient> clientProvider,
        Environment environment
    ) {
        this.clientProvider = Objects.requireNonNull(clientProvider, "clientProvider");
        this.environment = Objects.requireNonNull(environment, "environment");
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) throws BeansException {
        if (!enabled() || !(bean instanceof DataSource) || isScopedTarget(beanName)) {
            return bean;
        }
        if (LogBrewJdbcTracing.isInstrumentedDataSource(bean) || isRoutingDataSource(bean)) {
            return bean;
        }
        LogBrewClient client = clientProvider.getIfAvailable();
        if (client == null) {
            return bean;
        }
        return LogBrewJdbcTracing.instrumentDataSource(
            (DataSource) bean,
            client,
            LogBrewJdbcTracing.ConnectionConfig.create()
                .system(environment.getProperty("logbrew.jdbc.db-system"))
                .databaseName(environment.getProperty("logbrew.jdbc.db-name"))
                .eventIdPrefix(environment.getProperty("logbrew.jdbc.event-id-prefix"))
                .traceTransactions(booleanProperty("logbrew.jdbc.trace-transactions", false))
                .traceConnectionAcquisition(booleanProperty(
                    "logbrew.jdbc.trace-connection-acquisition",
                    false
                ))
                .metadata(springMetadata())
        );
    }

    @Override
    public int getOrder() {
        return ORDER;
    }

    private boolean enabled() {
        return booleanProperty("logbrew.jdbc.enabled", true);
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

    private static boolean isRoutingDataSource(Object bean) {
        return ROUTING_DATA_SOURCE_CLASS != null && ROUTING_DATA_SOURCE_CLASS.isInstance(bean);
    }

    private static Class<?> routingDataSourceClass() {
        try {
            return Class.forName("org.springframework.jdbc.datasource.lookup.AbstractRoutingDataSource");
        } catch (ClassNotFoundException ignored) {
            return null;
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
