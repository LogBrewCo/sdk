package co.logbrew.sdk;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;

/**
 * Dependency-free test runner for app-owned JDBC tracing.
 */
public final class LogBrewJdbcTracingTest {
    private int testsRun;

    public static void main(String[] args) throws Exception {
        new LogBrewJdbcTracingTest().run();
    }

    private void run() throws Exception {
        testStatementExecuteQueryQueuesSanitizedChildSpan();
        testPreparedStatementExecuteUpdateRecordsRowCountWithoutSqlText();
        testJdbcErrorsAreRethrownAndCapturedAsTypeOnlyEvents();
        testCommitAndRollbackAreTracedWhenEnabled();
        testInvalidConfiguredSpanIdsDoNotBreakJdbcCalls();
        testLeadingSqlCommentsDoNotBecomeOperationNames();
        testDataSourceReturnsTracedConnections();
        testDataSourceTwoArgumentConnectionDoesNotCaptureArguments();
        testDataSourceConnectionAcquisitionSpanIsOptIn();
        testDataSourceConnectionAcquisitionErrorsAreTypeOnly();
        System.out.println("java jdbc tracing tests ok (" + testsRun + " tests)");
    }

    private void testStatementExecuteQueryQueuesSanitizedChildSpan() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        Connection connection = LogBrewJdbcTracing.instrumentConnection(
            fakeConnection(jdbc),
            client,
            baseConfig()
                .eventIdPrefix("java_jdbc_statement")
                .spanIds("b7ad6b7169203401")
                .nowSequence(
                    Instant.parse("2026-06-29T10:00:00Z"),
                    Instant.parse("2026-06-29T10:00:00.015Z")
                )
        );
        LogBrewTraceContext parent = parentTrace();

        ResultSet resultSet;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            resultSet = connection
                .createStatement()
                .executeQuery("SELECT * FROM orders WHERE card_number = '4111111111111111'");
        } finally {
            scope.close();
        }

        assertTrue(resultSet == jdbc.resultSet, "statement preserves result set");
        assertEquals(parent.traceId(), jdbc.activeTrace.get().traceId(), "statement active trace id");
        assertEquals(parent.spanId(), jdbc.activeTrace.get().parentSpanId(), "statement parent span");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_jdbc_statement_span_b7ad6b7169203401\"");
        assertContains(payload, "\"name\": \"jdbc:SELECT\"");
        assertContains(payload, "\"durationMs\": 15.0");
        assertContains(payload, "\"source\": \"jdbc.statement\"");
        assertContains(payload, "\"framework\": \"jdbc\"");
        assertContains(payload, "\"dbSystem\": \"postgresql\"");
        assertContains(payload, "\"dbOperation\": \"SELECT\"");
        assertContains(payload, "\"dbOperationKind\": \"query\"");
        assertContains(payload, "\"dbName\": \"orders\"");
        assertContains(payload, "\"jdbcMethod\": \"executeQuery\"");
        assertContains(payload, "\"jdbcTarget\": \"statement\"");
        assertNotContains(payload, "4111111111111111");
        assertNotContains(payload, "card_number");
        assertNotContains(payload, "SELECT * FROM");
        testsRun++;
    }

    private void testPreparedStatementExecuteUpdateRecordsRowCountWithoutSqlText() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        Connection connection = LogBrewJdbcTracing.instrumentConnection(
            fakeConnection(jdbc),
            client,
            baseConfig()
                .eventIdPrefix("java_jdbc_prepared")
                .spanIds("b7ad6b7169203402")
                .nowSequence(
                    Instant.parse("2026-06-29T10:00:01Z"),
                    Instant.parse("2026-06-29T10:00:01.020Z")
                )
        );

        PreparedStatement statement = connection.prepareStatement(
            "UPDATE orders SET status = 'private' WHERE id = ?"
        );
        int rowCount = statement.executeUpdate();

        assertEquals(2, rowCount, "prepared update row count");
        assertEquals("UPDATE orders SET status = 'private' WHERE id = ?", jdbc.preparedSql, "delegate sql");
        String payload = client.previewJson();
        assertContains(payload, "\"name\": \"jdbc:UPDATE\"");
        assertContains(payload, "\"dbOperation\": \"UPDATE\"");
        assertContains(payload, "\"dbOperationKind\": \"write\"");
        assertContains(payload, "\"rowCount\": 2");
        assertContains(payload, "\"jdbcMethod\": \"executeUpdate\"");
        assertContains(payload, "\"jdbcTarget\": \"prepared\"");
        assertNotContains(payload, "private");
        assertNotContains(payload, "UPDATE orders SET");
        testsRun++;
    }

    private void testJdbcErrorsAreRethrownAndCapturedAsTypeOnlyEvents() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        SQLException original = new SQLException("private SQL and bind values leaked here");
        jdbc.failure = original;
        Connection connection = LogBrewJdbcTracing.instrumentConnection(
            fakeConnection(jdbc),
            client,
            baseConfig()
                .eventIdPrefix("java_jdbc_error")
                .spanIds("b7ad6b7169203403")
                .nowSequence(
                    Instant.parse("2026-06-29T10:00:02Z"),
                    Instant.parse("2026-06-29T10:00:02.005Z")
                )
        );

        SQLException thrown = expectException(SQLException.class, () ->
            connection.createStatement().execute("DELETE FROM orders WHERE session_marker = 'private'")
        );

        assertTrue(thrown == original, "same SQL exception object is rethrown");
        String payload = client.previewJson();
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"errorType\": \"SQLException\"");
        assertContains(payload, "\"name\": \"exception\"");
        assertContains(payload, "\"exceptionType\": \"SQLException\"");
        assertContains(payload, "\"exceptionEscaped\": true");
        assertNotContains(payload, "private SQL");
        assertNotContains(payload, "bind values");
        assertNotContains(payload, "DELETE FROM");
        testsRun++;
    }

    private void testCommitAndRollbackAreTracedWhenEnabled() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        Connection connection = LogBrewJdbcTracing.instrumentConnection(
            fakeConnection(jdbc),
            client,
            baseConfig()
                .eventIdPrefix("java_jdbc_transaction")
                .traceTransactions(true)
                .spanIds("b7ad6b7169203404", "b7ad6b7169203405")
                .nowSequence(
                    Instant.parse("2026-06-29T10:00:03Z"),
                    Instant.parse("2026-06-29T10:00:03.004Z"),
                    Instant.parse("2026-06-29T10:00:04Z"),
                    Instant.parse("2026-06-29T10:00:04.006Z")
                )
        );

        connection.commit();
        connection.rollback();

        assertEquals(1, jdbc.commits, "commit delegate count");
        assertEquals(1, jdbc.rollbacks, "rollback delegate count");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_jdbc_transaction_span_b7ad6b7169203404\"");
        assertContains(payload, "\"id\": \"java_jdbc_transaction_span_b7ad6b7169203405\"");
        assertContains(payload, "\"dbOperation\": \"COMMIT\"");
        assertContains(payload, "\"dbOperation\": \"ROLLBACK\"");
        assertContains(payload, "\"dbOperationKind\": \"transaction\"");
        assertContains(payload, "\"jdbcMethod\": \"commit\"");
        assertContains(payload, "\"jdbcMethod\": \"rollback\"");
        testsRun++;
    }

    private void testInvalidConfiguredSpanIdsDoNotBreakJdbcCalls() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        Connection connection = LogBrewJdbcTracing.instrumentConnection(
            fakeConnection(jdbc),
            client,
            baseConfig()
                .eventIdPrefix("java_jdbc_invalid_span")
                .spanIds("not-a-span-id")
                .nowSequence(
                    Instant.parse("2026-06-29T10:00:05Z"),
                    Instant.parse("2026-06-29T10:00:05.007Z")
                )
        );

        ResultSet resultSet = connection.createStatement().executeQuery("SELECT internal_note FROM orders");

        assertTrue(resultSet == jdbc.resultSet, "invalid custom span id preserves result set");
        assertEquals(1, client.pendingEvents(), "invalid custom span id still queues span");
        String payload = client.previewJson();
        assertContains(payload, "\"name\": \"jdbc:SELECT\"");
        assertNotContains(payload, "not-a-span-id");
        assertNotContains(payload, "SELECT internal_note");
        testsRun++;
    }

    private void testLeadingSqlCommentsDoNotBecomeOperationNames() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        Connection connection = LogBrewJdbcTracing.instrumentConnection(
            fakeConnection(jdbc),
            client,
            baseConfig()
                .eventIdPrefix("java_jdbc_comment")
                .spanIds("b7ad6b7169203406")
                .nowSequence(
                    Instant.parse("2026-06-29T10:00:06Z"),
                    Instant.parse("2026-06-29T10:00:06.008Z")
                )
        );

        connection
            .createStatement()
            .executeQuery("/* CommentMarker private */ SELECT * FROM orders");

        String payload = client.previewJson();
        assertContains(payload, "\"name\": \"jdbc:SELECT\"");
        assertContains(payload, "\"dbOperation\": \"SELECT\"");
        assertContains(payload, "\"dbOperationKind\": \"query\"");
        assertNotContains(payload, "CommentMarker");
        assertNotContains(payload, "COMMENTMARKER");
        assertNotContains(payload, "private */ SELECT");
        testsRun++;
    }

    private void testDataSourceReturnsTracedConnections() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        DataSource dataSource = LogBrewJdbcTracing.instrumentDataSource(
            fakeDataSource(jdbc),
            client,
            baseConfig()
                .eventIdPrefix("java_jdbc_datasource")
                .spanIds("b7ad6b7169203407")
                .nowSequence(
                    Instant.parse("2026-06-29T10:00:07Z"),
                    Instant.parse("2026-06-29T10:00:07.009Z")
                )
        );

        ResultSet resultSet = dataSource.getConnection()
            .createStatement()
            .executeQuery("SELECT * FROM orders WHERE card_number = '4111111111111111'");

        assertTrue(resultSet == jdbc.resultSet, "data source preserves result set");
        assertEquals(1, jdbc.dataSourceConnections, "data source delegate connection count");
        assertEquals(1, client.pendingEvents(), "data source defaults to statement span only");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_jdbc_datasource_span_b7ad6b7169203407\"");
        assertContains(payload, "\"name\": \"jdbc:SELECT\"");
        assertContains(payload, "\"source\": \"jdbc.statement\"");
        assertContains(payload, "\"jdbcTarget\": \"statement\"");
        assertNotContains(payload, "4111111111111111");
        assertNotContains(payload, "SELECT * FROM");
        testsRun++;
    }

    private void testDataSourceTwoArgumentConnectionDoesNotCaptureArguments() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        DataSource dataSource = LogBrewJdbcTracing.instrumentDataSource(
            fakeDataSource(jdbc),
            client,
            baseConfig()
                .eventIdPrefix("java_jdbc_datasource_two_arg")
                .spanIds("b7ad6b7169203408")
                .nowSequence(
                    Instant.parse("2026-06-29T10:00:08Z"),
                    Instant.parse("2026-06-29T10:00:08.012Z")
                )
        );

        int rowCount = dataSource
            .getConnection("private_user", "private_second_arg")
            .prepareStatement("UPDATE orders SET owner = 'private_user' WHERE id = ?")
            .executeUpdate();

        assertEquals(2, rowCount, "data source two-argument connection row count");
        assertEquals("private_user", jdbc.dataSourceUsername, "delegate receives username");
        assertEquals("private_second_arg", jdbc.dataSourceSecondArgument, "delegate receives second argument");
        String payload = client.previewJson();
        assertContains(payload, "\"name\": \"jdbc:UPDATE\"");
        assertContains(payload, "\"rowCount\": 2");
        assertNotContains(payload, "private_user");
        assertNotContains(payload, "private_second_arg");
        assertNotContains(payload, "UPDATE orders SET");
        testsRun++;
    }

    private void testDataSourceConnectionAcquisitionSpanIsOptIn() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        DataSource dataSource = LogBrewJdbcTracing.instrumentDataSource(
            fakeDataSource(jdbc),
            client,
            baseConfig()
                .eventIdPrefix("java_jdbc_acquire")
                .traceConnectionAcquisition(true)
                .spanIds("b7ad6b7169203409", "b7ad6b7169203410")
                .nowSequence(
                    Instant.parse("2026-06-29T10:00:09Z"),
                    Instant.parse("2026-06-29T10:00:09.003Z"),
                    Instant.parse("2026-06-29T10:00:10Z"),
                    Instant.parse("2026-06-29T10:00:10.011Z")
                )
        );
        LogBrewTraceContext parent = parentTrace();

        ResultSet resultSet;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(parent);
        try {
            resultSet = dataSource
                .getConnection()
                .createStatement()
                .executeQuery("SELECT * FROM orders WHERE card_number = '4111111111111111'");
        } finally {
            scope.close();
        }

        assertTrue(resultSet == jdbc.resultSet, "acquisition tracing preserves result set");
        assertEquals(parent.traceId(), jdbc.dataSourceActiveTrace.traceId(), "acquisition active trace id");
        assertEquals(parent.spanId(), jdbc.dataSourceActiveTrace.parentSpanId(), "acquisition parent span id");
        assertEquals(2, client.pendingEvents(), "acquisition tracing queues connection and statement spans");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_jdbc_acquire_span_b7ad6b7169203409\"");
        assertContains(payload, "\"id\": \"java_jdbc_acquire_span_b7ad6b7169203410\"");
        assertContains(payload, "\"name\": \"jdbc:CONNECT\"");
        assertContains(payload, "\"durationMs\": 3.0");
        assertContains(payload, "\"source\": \"jdbc.connection\"");
        assertContains(payload, "\"dbOperation\": \"CONNECT\"");
        assertContains(payload, "\"dbOperationKind\": \"connection\"");
        assertContains(payload, "\"jdbcMethod\": \"getConnection\"");
        assertContains(payload, "\"jdbcTarget\": \"dataSource\"");
        assertContains(payload, "\"name\": \"jdbc:SELECT\"");
        assertNotContains(payload, "4111111111111111");
        assertNotContains(payload, "SELECT * FROM");
        testsRun++;
    }

    private void testDataSourceConnectionAcquisitionErrorsAreTypeOnly() throws Exception {
        LogBrewClient client = sampleClient();
        RecordingJdbc jdbc = new RecordingJdbc();
        SQLException original = new SQLException("private pool endpoint and login details");
        jdbc.dataSourceFailure = original;
        DataSource dataSource = LogBrewJdbcTracing.instrumentDataSource(
            fakeDataSource(jdbc),
            client,
            baseConfig()
                .eventIdPrefix("java_jdbc_acquire_error")
                .traceConnectionAcquisition(true)
                .spanIds("b7ad6b7169203411")
                .nowSequence(
                    Instant.parse("2026-06-29T10:00:11Z"),
                    Instant.parse("2026-06-29T10:00:11.004Z")
                )
        );

        SQLException thrown = expectException(SQLException.class, dataSource::getConnection);

        assertTrue(thrown == original, "same data source exception object is rethrown");
        assertEquals(1, client.pendingEvents(), "failed acquisition queues one span");
        String payload = client.previewJson();
        assertContains(payload, "\"id\": \"java_jdbc_acquire_error_span_b7ad6b7169203411\"");
        assertContains(payload, "\"name\": \"jdbc:CONNECT\"");
        assertContains(payload, "\"status\": \"error\"");
        assertContains(payload, "\"source\": \"jdbc.connection\"");
        assertContains(payload, "\"errorType\": \"SQLException\"");
        assertContains(payload, "\"exceptionType\": \"SQLException\"");
        assertNotContains(payload, "private pool");
        assertNotContains(payload, "login details");
        testsRun++;
    }

    private static LogBrewJdbcTracing.ConnectionConfig baseConfig() {
        return LogBrewJdbcTracing.ConnectionConfig.create()
            .system("postgresql")
            .databaseName("orders")
            .metadata(Map.of(
                "service", "checkout",
                "connectionString", "jdbc:postgresql://private.example/orders",
                "sql", "SELECT private"
            ));
    }

    private static Connection fakeConnection(RecordingJdbc jdbc) {
        return proxy(Connection.class, (proxy, method, args) -> {
            String name = method.getName();
            if ("createStatement".equals(name)) {
                return fakeStatement(jdbc, "statement", null);
            }
            if ("prepareStatement".equals(name)) {
                jdbc.preparedSql = (String) args[0];
                return fakeStatement(jdbc, "prepared", jdbc.preparedSql);
            }
            if ("commit".equals(name)) {
                jdbc.activeTrace.set(LogBrewTrace.current().orElse(null));
                jdbc.commits++;
                return null;
            }
            if ("rollback".equals(name)) {
                jdbc.activeTrace.set(LogBrewTrace.current().orElse(null));
                jdbc.rollbacks++;
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static DataSource fakeDataSource(RecordingJdbc jdbc) {
        return proxy(DataSource.class, (proxy, method, args) -> {
            String name = method.getName();
            if ("getConnection".equals(name)) {
                jdbc.dataSourceConnections++;
                jdbc.dataSourceActiveTrace = LogBrewTrace.current().orElse(null);
                if (jdbc.dataSourceFailure != null) {
                    throw jdbc.dataSourceFailure;
                }
                if (args != null && args.length == 2) {
                    jdbc.dataSourceUsername = (String) args[0];
                    jdbc.dataSourceSecondArgument = (String) args[1];
                }
                return fakeConnection(jdbc);
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static <T> T fakeStatement(RecordingJdbc jdbc, String type, String sql) {
        Class<?> statementInterface = "prepared".equals(type) ? PreparedStatement.class : Statement.class;
        return proxy(statementInterface, (proxy, method, args) -> {
            String name = method.getName();
            if (name.startsWith("execute")) {
                jdbc.activeTrace.set(LogBrewTrace.current().orElse(null));
                jdbc.statementType = type;
                jdbc.statementSql = sql;
                if (jdbc.failure != null) {
                    throw jdbc.failure;
                }
                if (method.getReturnType() == ResultSet.class) {
                    return jdbc.resultSet;
                }
                if (method.getReturnType() == int.class) {
                    return Integer.valueOf(2);
                }
                if (method.getReturnType() == long.class) {
                    return Long.valueOf(2L);
                }
                if (method.getReturnType() == boolean.class) {
                    return Boolean.TRUE;
                }
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

    private static Object defaultValue(Class<?> type) {
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

    private static LogBrewTraceContext parentTrace() {
        return LogBrewTraceContext.fromTraceparent(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "a7ad6b7169203330"
        );
    }

    private static <T extends Throwable> T expectException(Class<T> type, ThrowingRunnable runnable) {
        try {
            runnable.run();
        } catch (Throwable error) {
            if (type.isInstance(error)) {
                return type.cast(error);
            }
            throw new AssertionError("expected " + type.getSimpleName() + " but got " + error, error);
        }
        throw new AssertionError("expected " + type.getSimpleName());
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

    private interface ThrowingRunnable {
        void run() throws Throwable;
    }

    private static final class RecordingJdbc {
        private final ResultSet resultSet = fakeResultSet();
        private final AtomicReference<LogBrewTraceContext> activeTrace = new AtomicReference<>();
        private String preparedSql;
        private String statementSql;
        private String statementType;
        private SQLException failure;
        private int commits;
        private int rollbacks;
        private int dataSourceConnections;
        private String dataSourceUsername;
        private String dataSourceSecondArgument;
        private SQLException dataSourceFailure;
        private LogBrewTraceContext dataSourceActiveTrace;
    }
}
