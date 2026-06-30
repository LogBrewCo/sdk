package co.logbrew.sdk;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.sql.DataSource;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

/**
 * Dependency-free test runner for Spring Boot JDBC auto-configuration.
 */
public final class LogBrewSpringBootJdbcAutoConfigurationTest {
    private int testsRun;

    public static void main(String[] args) throws Exception {
        new LogBrewSpringBootJdbcAutoConfigurationTest().run();
    }

    private void run() throws Exception {
        testPostProcessorWrapsDataSourceBeanWithDefaultStatementSpans();
        testPostProcessorCanBeDisabled();
        testPostProcessorUsesJdbcPropertiesForOptInAcquisitionAndTransactionSpans();
        System.out.println("java spring boot jdbc auto-configuration tests ok (" + testsRun + " tests)");
    }

    private void testPostProcessorWrapsDataSourceBeanWithDefaultStatementSpans() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        DataSource original = fakeDataSource(jdbc);
        BeanPostProcessor processor = new LogBrewSpringBootJdbcDataSourcePostProcessor(
            client,
            environment(Map.of(
                "spring.application.name", "checkout-service",
                "logbrew.jdbc.db-system", "postgresql",
                "logbrew.jdbc.db-name", "orders"
            ))
        );

        Object processed = processor.postProcessAfterInitialization(original, "checkoutDataSource");

        assertTrue(processed instanceof DataSource, "processed data source type");
        assertTrue(processed != original, "data source is wrapped");
        assertTrue(LogBrewJdbcTracing.isInstrumentedDataSource(processed), "marker identifies wrapped data source");
        ((DataSource) processed)
            .getConnection()
            .createStatement()
            .executeQuery("SELECT synthetic_column FROM orders WHERE lookup_key = 'synthetic_value'");

        assertEquals(1, jdbc.connectionCalls, "delegates one getConnection call");
        assertEquals(1, client.pendingEvents(), "default Spring JDBC wrapper emits statement span only");
        String payload = client.previewJson();
        assertContains(payload, "\"name\": \"jdbc:SELECT\"");
        assertContains(payload, "\"source\": \"jdbc.statement\"");
        assertContains(payload, "\"dbSystem\": \"postgresql\"");
        assertContains(payload, "\"dbName\": \"orders\"");
        assertContains(payload, "\"springApplicationName\": \"checkout-service\"");
        assertNotContains(payload, "synthetic_column");
        assertNotContains(payload, "synthetic_value");
        assertNotContains(payload, "checkoutDataSource");
        testsRun++;
    }

    private void testPostProcessorCanBeDisabled() {
        LogBrewClient client = sampleClient();
        DataSource original = fakeDataSource(new RecordingJdbc());
        BeanPostProcessor processor = new LogBrewSpringBootJdbcDataSourcePostProcessor(
            client,
            environment(Map.of("logbrew.jdbc.enabled", "false"))
        );

        Object processed = processor.postProcessAfterInitialization(original, "ordersDataSource");

        assertTrue(processed == original, "disabled Spring JDBC wrapper preserves original bean");
        testsRun++;
    }

    private void testPostProcessorUsesJdbcPropertiesForOptInAcquisitionAndTransactionSpans() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        BeanPostProcessor processor = new LogBrewSpringBootJdbcDataSourcePostProcessor(
            client,
            environment(Map.of(
                "spring.application.name", "checkout-service",
                "logbrew.jdbc.event-id-prefix", "spring_jdbc",
                "logbrew.jdbc.trace-connection-acquisition", "true",
                "logbrew.jdbc.trace-transactions", "true"
            ))
        );
        DataSource dataSource = (DataSource) processor.postProcessAfterInitialization(
            fakeDataSource(jdbc),
            "primaryDataSource"
        );

        Connection connection = dataSource.getConnection("jdbc_user_fixture", "jdbc_pass_fixture");
        connection.commit();

        assertEquals("jdbc_user_fixture", jdbc.username, "delegate receives username");
        assertEquals("jdbc_pass_fixture", jdbc.passphrase, "delegate receives second login value");
        assertEquals(2, client.pendingEvents(), "opt-in acquisition and transaction spans are queued");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"spring_jdbc_span_");
        assertContains(payload, "\"name\": \"jdbc:CONNECT\"");
        assertContains(payload, "\"source\": \"jdbc.connection\"");
        assertContains(payload, "\"dbOperation\": \"CONNECT\"");
        assertContains(payload, "\"name\": \"jdbc:COMMIT\"");
        assertContains(payload, "\"source\": \"jdbc.transaction\"");
        assertContains(payload, "\"springApplicationName\": \"checkout-service\"");
        assertNotContains(payload, "jdbc_user_fixture");
        assertNotContains(payload, "jdbc_pass_fixture");
        assertNotContains(payload, "primaryDataSource");
        testsRun++;
    }

    private static StandardEnvironment environment(Map<String, Object> values) {
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(new MapPropertySource("test", values));
        return environment;
    }

    private static DataSource fakeDataSource(RecordingJdbc jdbc) {
        return proxy(DataSource.class, (proxy, method, args) -> {
            String name = method.getName();
            if ("getConnection".equals(name)) {
                jdbc.connectionCalls++;
                if (args != null && args.length == 2) {
                    jdbc.username = (String) args[0];
                    jdbc.passphrase = (String) args[1];
                }
                return fakeConnection(jdbc);
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection fakeConnection(RecordingJdbc jdbc) {
        return proxy(Connection.class, (proxy, method, args) -> {
            String name = method.getName();
            if ("createStatement".equals(name)) {
                return fakeStatement(jdbc);
            }
            if ("commit".equals(name)) {
                jdbc.commits++;
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Statement fakeStatement(RecordingJdbc jdbc) {
        return proxy(Statement.class, (proxy, method, args) -> {
            if (method.getName().startsWith("execute")) {
                jdbc.statementCalls++;
                return jdbc.resultSet;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet fakeResultSet() {
        return proxy(ResultSet.class, (proxy, method, args) -> defaultValue(method.getReturnType()));
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<?> interfaceType, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(
            interfaceType.getClassLoader(),
            new Class<?>[] {interfaceType},
            (proxy, method, args) -> {
                if ("toString".equals(method.getName()) && method.getParameterCount() == 0) {
                    return interfaceType.getSimpleName() + "Proxy";
                }
                if ("hashCode".equals(method.getName()) && method.getParameterCount() == 0) {
                    return Integer.valueOf(System.identityHashCode(proxy));
                }
                if ("equals".equals(method.getName()) && method.getParameterCount() == 1) {
                    return Boolean.valueOf(proxy == args[0]);
                }
                return handler.invoke(proxy, method, args == null ? new Object[0] : args);
            }
        );
    }

    private static Object defaultValue(Class<?> type) throws SQLException {
        if (type == void.class) {
            return null;
        }
        if (type == boolean.class) {
            return Boolean.FALSE;
        }
        if (type == int.class) {
            return Integer.valueOf(0);
        }
        if (type == long.class) {
            return Long.valueOf(0L);
        }
        if (type == double.class) {
            return Double.valueOf(0.0);
        }
        if (type == float.class) {
            return Float.valueOf(0.0f);
        }
        if (type == short.class) {
            return Short.valueOf((short) 0);
        }
        if (type == byte.class) {
            return Byte.valueOf((byte) 0);
        }
        if (type == char.class) {
            return Character.valueOf('\0');
        }
        return null;
    }

    private static LogBrewClient sampleClient() {
        return LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
    }

    private static void assertContains(String text, String expected) {
        if (!text.contains(expected)) {
            throw new AssertionError("expected to contain " + expected + " in " + text);
        }
    }

    private static void assertNotContains(String text, String unexpected) {
        if (text.contains(unexpected)) {
            throw new AssertionError("expected not to contain " + unexpected + " in " + text);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + " but got " + actual);
        }
    }

    private static void assertTrue(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError(label);
        }
    }

    private static final class RecordingJdbc {
        private final ResultSet resultSet = fakeResultSet();
        private int connectionCalls;
        private int statementCalls;
        private int commits;
        private String username;
        private String passphrase;
    }
}
