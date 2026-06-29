package co.logbrew.sdk;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Queue;
import java.util.function.Consumer;
import java.util.function.Supplier;
import javax.sql.DataSource;

/**
 * App-owned JDBC connection tracing without a Java agent or global driver patching.
 */
public final class LogBrewJdbcTracing {
    private static final String ZERO_SPAN_ID = "0000000000000000";
    private static final String[] BLOCKED_JDBC_METADATA_KEYS = {
        "args",
        "arguments",
        "auth",
        "authorization",
        "body",
        "connectionstring",
        "cookie",
        "cookies",
        "header",
        "headers",
        "host",
        "hostname",
        "key",
        "param",
        "params",
        "password",
        "payload",
        "query",
        "secret",
        "sql",
        "statement",
        "token",
        "url",
        "username",
        "value"
    };

    private LogBrewJdbcTracing() {
    }

    /**
     * Wraps one caller-owned JDBC connection so statements created through it emit safe DB spans.
     */
    public static Connection instrumentConnection(
        Connection connection,
        LogBrewClient client,
        ConnectionConfig config
    ) {
        Objects.requireNonNull(connection, "connection");
        Objects.requireNonNull(client, "client");
        ConnectionConfig safeConfig = config == null ? ConnectionConfig.create() : config;
        return Connection.class.cast(Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            new ConnectionHandler(connection, client, safeConfig)
        ));
    }

    /**
     * Wraps one caller-owned JDBC data source so returned connections emit safe DB spans.
     */
    public static DataSource instrumentDataSource(
        DataSource dataSource,
        LogBrewClient client,
        ConnectionConfig config
    ) {
        Objects.requireNonNull(dataSource, "dataSource");
        Objects.requireNonNull(client, "client");
        ConnectionConfig safeConfig = config == null ? ConnectionConfig.create() : config;
        return DataSource.class.cast(Proxy.newProxyInstance(
            DataSource.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            new DataSourceHandler(dataSource, client, safeConfig)
        ));
    }

    private static final class DataSourceHandler implements InvocationHandler {
        private final DataSource delegate;
        private final LogBrewClient client;
        private final ConnectionConfig config;

        private DataSourceHandler(DataSource delegate, LogBrewClient client, ConnectionConfig config) {
            this.delegate = delegate;
            this.client = client;
            this.config = config;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws SQLException {
            Object[] safeArgs = args == null ? new Object[0] : args;
            Object objectResult = handleObjectMethod(proxy, method, safeArgs);
            if (objectResult != Unhandled.INSTANCE) {
                return objectResult;
            }
            Object wrapperResult = handleWrapperMethod(proxy, delegate, method, safeArgs);
            if (wrapperResult != Unhandled.INSTANCE) {
                return wrapperResult;
            }
            String methodName = method.getName();
            if ("getConnection".equals(methodName)) {
                Connection connection = config.traceConnectionAcquisition
                    ? (Connection) traceJdbcCall(
                        client,
                        config,
                        "CONNECT",
                        methodName,
                        "dataSource",
                        "connection",
                        () -> invokeDelegate(delegate, method, safeArgs)
                    )
                    : (Connection) invokeDelegate(delegate, method, safeArgs);
                return connection == null ? null : instrumentConnection(connection, client, config);
            }
            return invokeDelegate(delegate, method, safeArgs);
        }
    }

    private static final class ConnectionHandler implements InvocationHandler {
        private final Connection delegate;
        private final LogBrewClient client;
        private final ConnectionConfig config;

        private ConnectionHandler(Connection delegate, LogBrewClient client, ConnectionConfig config) {
            this.delegate = delegate;
            this.client = client;
            this.config = config;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws SQLException {
            Object[] safeArgs = args == null ? new Object[0] : args;
            Object objectResult = handleObjectMethod(proxy, method, safeArgs);
            if (objectResult != Unhandled.INSTANCE) {
                return objectResult;
            }
            Object wrapperResult = handleWrapperMethod(proxy, delegate, method, safeArgs);
            if (wrapperResult != Unhandled.INSTANCE) {
                return wrapperResult;
            }

            String methodName = method.getName();
            if ("createStatement".equals(methodName)) {
                Object statement = invokeDelegate(delegate, method, safeArgs);
                return wrapStatement(statement, Statement.class, client, config, "statement", null);
            }
            if ("prepareStatement".equals(methodName)) {
                Object statement = invokeDelegate(delegate, method, safeArgs);
                return wrapStatement(statement, PreparedStatement.class, client, config, "prepared", firstSql(safeArgs));
            }
            if ("prepareCall".equals(methodName)) {
                Object statement = invokeDelegate(delegate, method, safeArgs);
                return wrapStatement(statement, CallableStatement.class, client, config, "callable", firstSql(safeArgs));
            }
            if (config.traceTransactions && ("commit".equals(methodName) || "rollback".equals(methodName))) {
                return traceJdbcCall(
                    client,
                    config,
                    methodName.toUpperCase(Locale.ROOT),
                    methodName,
                    "connection",
                    "transaction",
                    () -> invokeDelegate(delegate, method, safeArgs)
                );
            }
            return invokeDelegate(delegate, method, safeArgs);
        }
    }

    private static Object wrapStatement(
        Object statement,
        Class<?> statementInterface,
        LogBrewClient client,
        ConnectionConfig config,
        String statementType,
        String preparedSql
    ) {
        if (statement == null) {
            return null;
        }
        return Proxy.newProxyInstance(
            statementInterface.getClassLoader(),
            new Class<?>[] {statementInterface},
            new StatementHandler(statement, client, config, statementType, preparedSql)
        );
    }

    private static final class StatementHandler implements InvocationHandler {
        private final Object delegate;
        private final LogBrewClient client;
        private final ConnectionConfig config;
        private final String statementType;
        private final String preparedSql;

        private StatementHandler(
            Object delegate,
            LogBrewClient client,
            ConnectionConfig config,
            String statementType,
            String preparedSql
        ) {
            this.delegate = delegate;
            this.client = client;
            this.config = config;
            this.statementType = statementType;
            this.preparedSql = preparedSql;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws SQLException {
            Object[] safeArgs = args == null ? new Object[0] : args;
            Object objectResult = handleObjectMethod(proxy, method, safeArgs);
            if (objectResult != Unhandled.INSTANCE) {
                return objectResult;
            }
            Object wrapperResult = handleWrapperMethod(proxy, delegate, method, safeArgs);
            if (wrapperResult != Unhandled.INSTANCE) {
                return wrapperResult;
            }
            if (!shouldTraceStatementMethod(method)) {
                return invokeDelegate(delegate, method, safeArgs);
            }

            String methodName = method.getName();
            String sql = firstSql(safeArgs);
            if (sql == null) {
                sql = preparedSql;
            }
            String operation = operationName(methodName, sql);
            return traceJdbcCall(
                client,
                config,
                operation,
                methodName,
                statementType,
                operationKind(operation),
                () -> invokeDelegate(delegate, method, safeArgs)
            );
        }
    }

    private static Object traceJdbcCall(
        LogBrewClient client,
        ConnectionConfig config,
        String operationName,
        String jdbcMethod,
        String statementType,
        String operationKind,
        ThrowingOperation operation
    ) throws SQLException {
        Validation.requireNonEmpty("operation name", operationName);
        LogBrewTraceContext trace = childTrace(config.nextSpanId());
        Instant startedAt = config.now();
        Throwable operationError = null;
        Object result = null;
        LogBrewTrace.Scope scope = LogBrewTrace.activate(trace);
        try {
            result = operation.call();
            return result;
        } catch (SQLException error) {
            operationError = error;
            throw error;
        } catch (RuntimeException error) {
            operationError = error;
            throw new IllegalStateException("JDBC delegate failed", error);
        } catch (Error error) {
            operationError = error;
            throw error;
        } finally {
            scope.close();
            Instant finishedAt = config.now();
            captureJdbcSpan(
                client,
                config,
                operationName,
                jdbcMethod,
                statementType,
                operationKind,
                trace,
                result,
                operationError,
                Duration.between(startedAt, finishedAt),
                finishedAt
            );
        }
    }

    private static LogBrewTraceContext childTrace(String configuredSpanId) {
        String normalizedConfiguredSpanId = normalizedSpanIdOrNull(configuredSpanId);
        String spanId = normalizedConfiguredSpanId == null
            ? LogBrewTraceContext.generate().spanId()
            : normalizedConfiguredSpanId;
        return LogBrewTrace.current()
            .map(parent -> LogBrewTraceContext.create(parent.traceId(), spanId, parent.spanId(), parent.traceFlags()))
            .orElseGet(() -> {
                LogBrewTraceContext root = LogBrewTraceContext.generate();
                if (normalizedConfiguredSpanId == null) {
                    return root;
                }
                return LogBrewTraceContext.create(root.traceId(), spanId);
            });
    }

    private static String normalizedSpanIdOrNull(String spanId) {
        if (spanId == null || spanId.trim().isEmpty()) {
            return null;
        }
        String normalized = spanId.trim().toLowerCase(Locale.ROOT);
        if (ZERO_SPAN_ID.equals(normalized) || normalized.length() != 16) {
            return null;
        }
        for (int index = 0; index < normalized.length(); index++) {
            char value = normalized.charAt(index);
            if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) {
                return null;
            }
        }
        return normalized;
    }

    private static void captureJdbcSpan(
        LogBrewClient client,
        ConnectionConfig config,
        String operationName,
        String jdbcMethod,
        String statementType,
        String operationKind,
        LogBrewTraceContext trace,
        Object result,
        Throwable operationError,
        Duration duration,
        Instant finishedAt
    ) {
        Map<String, Object> metadata = config.jdbcMetadata(jdbcMethod, statementType);
        metadata.put("source", sourceForOperationKind(operationKind));
        metadata.put("sampled", Boolean.valueOf(trace.sampled()));
        addString(metadata, "dbSystem", config.system == null || config.system.trim().isEmpty() ? "jdbc" : config.system);
        addString(metadata, "dbOperation", operationName);
        addString(metadata, "dbOperationKind", operationKind);
        addString(metadata, "dbName", config.databaseName);
        Integer rows = rowCount(result);
        if (rows != null) {
            metadata.put("rowCount", rows);
        }
        if (operationError != null) {
            metadata.put("errorType", operationError.getClass().getSimpleName());
        }

        SpanAttributes attributes = SpanAttributes
            .create("jdbc:" + operationName, trace.traceId(), trace.spanId(), operationError == null ? "ok" : "error")
            .durationMs(duration.toNanos() / 1_000_000.0)
            .metadata(metadata);
        if (trace.parentSpanId() != null) {
            attributes.parentSpanId(trace.parentSpanId());
        }
        if (operationError != null) {
            attributes.events(List.of(SpanEventSummary.create("exception").metadata(Map.of(
                "exceptionType", operationError.getClass().getSimpleName(),
                "exceptionEscaped", Boolean.TRUE
            ))));
        }
        try {
            client.span(config.resolvedEventIdPrefix() + "_span_" + trace.spanId(), finishedAt.toString(), attributes);
        } catch (SdkException error) {
            config.reportCaptureError(error);
        }
    }

    private static boolean shouldTraceStatementMethod(Method method) {
        String name = method.getName();
        if (!name.startsWith("execute")) {
            return false;
        }
        Class<?> returnType = method.getReturnType();
        return returnType == boolean.class
            || returnType == int.class
            || returnType == long.class
            || returnType == int[].class
            || returnType == long[].class
            || returnType == ResultSet.class
            || returnType == void.class;
    }

    private static String sourceForOperationKind(String operationKind) {
        if ("transaction".equals(operationKind)) {
            return "jdbc.transaction";
        }
        if ("connection".equals(operationKind)) {
            return "jdbc.connection";
        }
        return "jdbc.statement";
    }

    private static Object invokeDelegate(Object delegate, Method method, Object[] args) throws SQLException {
        try {
            return method.invoke(delegate, args);
        } catch (InvocationTargetException error) {
            Throwable target = error.getTargetException();
            if (target instanceof SQLException) {
                throw (SQLException) target;
            }
            if (target instanceof Error) {
                throw (Error) target;
            }
            throw new IllegalStateException(target);
        } catch (IllegalAccessException error) {
            throw new IllegalStateException("unable to call JDBC delegate method", error);
        }
    }

    private static Object handleObjectMethod(Object proxy, Method method, Object[] args) {
        if (method.getDeclaringClass() != Object.class) {
            return Unhandled.INSTANCE;
        }
        String name = method.getName();
        if ("toString".equals(name)) {
            return "LogBrewJdbcTracing(" + proxy.getClass().getInterfaces()[0].getSimpleName() + ")";
        }
        if ("hashCode".equals(name)) {
            return Integer.valueOf(System.identityHashCode(proxy));
        }
        if ("equals".equals(name)) {
            return Boolean.valueOf(proxy == args[0]);
        }
        return Unhandled.INSTANCE;
    }

    private static Object handleWrapperMethod(Object proxy, Object delegate, Method method, Object[] args) {
        String name = method.getName();
        if ("unwrap".equals(name) && args.length == 1 && args[0] instanceof Class<?>) {
            Class<?> iface = (Class<?>) args[0];
            if (iface.isInstance(proxy)) {
                return iface.cast(proxy);
            }
            if (iface.isInstance(delegate)) {
                return iface.cast(delegate);
            }
        }
        if ("isWrapperFor".equals(name) && args.length == 1 && args[0] instanceof Class<?>) {
            Class<?> iface = (Class<?>) args[0];
            if (iface.isInstance(proxy) || iface.isInstance(delegate)) {
                return Boolean.TRUE;
            }
        }
        return Unhandled.INSTANCE;
    }

    private static String firstSql(Object[] args) {
        if (args.length > 0 && args[0] instanceof String) {
            return (String) args[0];
        }
        return null;
    }

    private static String operationName(String methodName, String sql) {
        if (methodName.toLowerCase(Locale.ROOT).contains("batch")) {
            return "BATCH";
        }
        String operation = firstSqlOperation(sql);
        if (operation != null) {
            return operation;
        }
        return "EXECUTE";
    }

    private static String firstSqlOperation(String sql) {
        if (sql == null) {
            return null;
        }
        int index = 0;
        while (index < sql.length()) {
            int nextIndex = skipSqlPrefix(sql, index);
            if (nextIndex != index) {
                index = nextIndex;
                continue;
            }
            char value = sql.charAt(index);
            if (Character.isLetter(value)) {
                int start = index;
                while (index < sql.length() && Character.isLetter(sql.charAt(index))) {
                    index++;
                }
                return sql.substring(start, index).toUpperCase(Locale.ROOT);
            }
            index++;
        }
        return null;
    }

    private static int skipSqlPrefix(String sql, int index) {
        char value = sql.charAt(index);
        if (Character.isWhitespace(value)) {
            return index + 1;
        }
        if (value == '-' && index + 1 < sql.length() && sql.charAt(index + 1) == '-') {
            return skipSqlLineComment(sql, index + 2);
        }
        if (value == '#') {
            return skipSqlLineComment(sql, index + 1);
        }
        if (value == '/' && index + 1 < sql.length() && sql.charAt(index + 1) == '*') {
            return skipSqlBlockComment(sql, index + 2);
        }
        if (value == '\'' || value == '"') {
            return skipSqlQuotedValue(sql, index + 1, value);
        }
        return index;
    }

    private static int skipSqlLineComment(String sql, int index) {
        while (index < sql.length()) {
            char value = sql.charAt(index);
            if (value == '\n' || value == '\r') {
                return index + 1;
            }
            index++;
        }
        return index;
    }

    private static int skipSqlBlockComment(String sql, int index) {
        while (index + 1 < sql.length()) {
            if (sql.charAt(index) == '*' && sql.charAt(index + 1) == '/') {
                return index + 2;
            }
            index++;
        }
        return sql.length();
    }

    private static int skipSqlQuotedValue(String sql, int index, char quote) {
        while (index < sql.length()) {
            char value = sql.charAt(index);
            if (value == quote) {
                if (index + 1 < sql.length() && sql.charAt(index + 1) == quote) {
                    index += 2;
                    continue;
                }
                return index + 1;
            }
            index++;
        }
        return index;
    }

    private static String operationKind(String operation) {
        String normalized = operation == null ? "" : operation.toUpperCase(Locale.ROOT);
        switch (normalized) {
            case "SELECT":
            case "WITH":
            case "SHOW":
            case "DESCRIBE":
            case "EXPLAIN":
                return "query";
            case "INSERT":
            case "UPDATE":
            case "DELETE":
            case "MERGE":
            case "REPLACE":
            case "UPSERT":
                return "write";
            case "CREATE":
            case "ALTER":
            case "DROP":
            case "TRUNCATE":
                return "schema";
            case "CALL":
            case "EXEC":
            case "EXECUTE":
                return "procedure";
            case "COMMIT":
            case "ROLLBACK":
                return "transaction";
            case "BATCH":
                return "batch";
            default:
                return "execute";
        }
    }

    private static void addString(Map<String, Object> metadata, String key, String value) {
        if (value != null && !value.trim().isEmpty()) {
            metadata.put(key, value.trim());
        }
    }

    private static Map<String, Object> safeJdbcMetadata(Map<String, ?> input) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        Map<String, Object> copied = Validation.copyMetadata(input);
        if (copied == null) {
            return metadata;
        }
        for (Map.Entry<String, Object> entry : copied.entrySet()) {
            if (!blockedJdbcMetadataKey(entry.getKey())) {
                metadata.put(entry.getKey(), entry.getValue());
            }
        }
        return metadata;
    }

    private static boolean blockedJdbcMetadataKey(String key) {
        String normalized = key == null ? "" : key.trim().toLowerCase(Locale.ROOT)
            .replace("_", "")
            .replace("-", "")
            .replace(".", "");
        for (String candidate : BLOCKED_JDBC_METADATA_KEYS) {
            if (normalized.equals(candidate) || normalized.contains(candidate)) {
                return true;
            }
        }
        return false;
    }

    private static Integer rowCount(Object value) {
        if (value instanceof Integer && ((Integer) value).intValue() >= 0) {
            return (Integer) value;
        }
        if (value instanceof Long) {
            long longValue = ((Long) value).longValue();
            if (longValue >= 0 && longValue <= Integer.MAX_VALUE) {
                return Integer.valueOf((int) longValue);
            }
        }
        if (value instanceof int[]) {
            return sumRows((int[]) value);
        }
        if (value instanceof long[]) {
            return sumRows((long[]) value);
        }
        return null;
    }

    private static Integer sumRows(int[] rows) {
        long total = 0L;
        for (int row : rows) {
            if (row < 0) {
                return null;
            }
            total += row;
            if (total > Integer.MAX_VALUE) {
                return null;
            }
        }
        return Integer.valueOf((int) total);
    }

    private static Integer sumRows(long[] rows) {
        long total = 0L;
        for (long row : rows) {
            if (row < 0) {
                return null;
            }
            total += row;
            if (total > Integer.MAX_VALUE) {
                return null;
            }
        }
        return Integer.valueOf((int) total);
    }

    private enum Unhandled {
        INSTANCE
    }

    private interface ThrowingOperation {
        Object call() throws SQLException;
    }

    /**
     * Configuration for one app-owned JDBC connection or data-source wrapper.
     */
    public static final class ConnectionConfig {
        private String system;
        private String databaseName;
        private String eventIdPrefix;
        private boolean traceTransactions;
        private boolean traceConnectionAcquisition;
        private Map<String, ?> metadata;
        private Consumer<SdkException> onError;
        private Supplier<Instant> now = Instant::now;
        private Supplier<String> spanIdSupplier;

        private ConnectionConfig() {
        }

        public static ConnectionConfig create() {
            return new ConnectionConfig();
        }

        public ConnectionConfig system(String value) {
            this.system = value;
            return this;
        }

        public ConnectionConfig databaseName(String value) {
            this.databaseName = value;
            return this;
        }

        public ConnectionConfig eventIdPrefix(String value) {
            this.eventIdPrefix = value;
            return this;
        }

        public ConnectionConfig traceTransactions(boolean value) {
            this.traceTransactions = value;
            return this;
        }

        /**
         * Enables one sanitized span around DataSource getConnection calls.
         */
        public ConnectionConfig traceConnectionAcquisition(boolean value) {
            this.traceConnectionAcquisition = value;
            return this;
        }

        public ConnectionConfig metadata(Map<String, ?> value) {
            this.metadata = Validation.copyMetadata(value);
            return this;
        }

        public ConnectionConfig onError(Consumer<SdkException> value) {
            this.onError = value;
            return this;
        }

        public ConnectionConfig now(Supplier<Instant> value) {
            this.now = Objects.requireNonNull(value, "now");
            return this;
        }

        public ConnectionConfig spanIdSupplier(Supplier<String> value) {
            this.spanIdSupplier = Objects.requireNonNull(value, "spanIdSupplier");
            return this;
        }

        public ConnectionConfig spanIds(String... values) {
            Queue<String> ids = new ArrayDeque<>();
            if (values != null) {
                for (String value : values) {
                    ids.add(value);
                }
            }
            this.spanIdSupplier = ids::poll;
            return this;
        }

        public ConnectionConfig nowSequence(Instant... values) {
            Queue<Instant> instants = new ArrayDeque<>();
            if (values != null) {
                for (Instant value : values) {
                    instants.add(Objects.requireNonNull(value, "now value"));
                }
            }
            this.now = () -> {
                Instant next = instants.poll();
                return next == null ? Instant.now() : next;
            };
            return this;
        }

        private Map<String, Object> jdbcMetadata(String jdbcMethod, String statementType) {
            Map<String, Object> values = safeJdbcMetadata(metadata);
            values.put("framework", "jdbc");
            values.put("jdbcMethod", jdbcMethod);
            values.put("jdbcTarget", statementType);
            return values;
        }

        private String resolvedEventIdPrefix() {
            if (eventIdPrefix == null || eventIdPrefix.trim().isEmpty()) {
                return "java_jdbc";
            }
            return eventIdPrefix.trim();
        }

        private String nextSpanId() {
            return spanIdSupplier == null ? null : spanIdSupplier.get();
        }

        private Instant now() {
            return now.get();
        }

        private void reportCaptureError(SdkException error) {
            if (onError == null) {
                return;
            }
            try {
                onError.accept(error);
            } catch (RuntimeException ignored) {
                // Preserve the app-owned JDBC result even if diagnostics handling fails.
            }
        }
    }
}
