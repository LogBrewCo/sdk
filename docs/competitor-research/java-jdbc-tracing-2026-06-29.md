# Java JDBC Tracing Comparison - 2026-06-29

## Scope

Reduce the Java rich-trace gap for backend services that debug slow or failing SQL calls. The target is safer JDBC statement and optional DataSource acquisition spans from app-owned JDBC objects, without a Java agent, driver registration, SQL comment mutation, pool/vendor hooks, or global `DriverManager` patching.

## Competitor Sources Read

- Sentry Java `getsentry/sentry-java@012eaebafc1507c0a4767236b7acc5c26fca1988`
- `sentry-jdbc/src/main/java/io/sentry/jdbc/SentryJdbcEventListener.java`: `onBeforeAnyExecute`, `onAfterAnyExecute`, transaction callbacks, `startSpan`, `finishSpan`, `applyDatabaseDetailsToSpan`.
- `sentry-jdbc/src/main/java/io/sentry/jdbc/DatabaseUtils.java`: `readFrom`, `parse`, database URL parsing helpers.
- `sentry-jdbc/src/test/kotlin/io/sentry/jdbc/SentryJdbcEventListenerTest.kt`: `Fixture.getSut`, `P6DataSource` wrapping, statement/error/span assertions.
- `sentry-spring-7/src/main/java/io/sentry/spring7/cache/SentryCacheBeanPostProcessor.java`: Spring bean wrapping pattern for already-created app beans.
- `sentry-spring-7/src/main/java/io/sentry/spring7/kafka/SentryKafkaProducerBeanPostProcessor.java` and `SentryKafkaConsumerBeanPostProcessor.java`: framework bean post-processing, composition, and safe fallback when custom factories/interceptors prevent wrapping.
- Datadog Java `DataDog/dd-trace-java@9f98ca9fac131d056dd025313b4acf9c3223528d`
- `dd-java-agent/instrumentation/jdbc/src/main/java/datadog/trace/instrumentation/jdbc/StatementInstrumentation.java`: `methodAdvice`, `StatementAdvice.onEnter`, `StatementAdvice.stopSpan`.
- `dd-java-agent/instrumentation/jdbc/src/main/java/datadog/trace/instrumentation/jdbc/JDBCDecorator.java`: `parseDBInfo`, `parseDBInfoFromConnection`, `onStatement`, `onPreparedStatement`, trace-context/DBM comment helpers.
- `dd-java-agent/instrumentation/jdbc/src/main/java/datadog/trace/instrumentation/jdbc/DataSourceInstrumentation.java`: `defaultEnabled`, `hierarchyMatcher`, `methodAdvice`, `GetConnectionAdvice.start`, `GetConnectionAdvice.stopSpan`.
- `dd-java-agent/instrumentation/jdbc/src/main/java/datadog/trace/instrumentation/jdbc/DataSourceDecorator.java`: `DATABASE_CONNECTION`, `JAVA_JDBC_CONNECTION`, instrumentation naming.
- `dd-java-agent/instrumentation/jdbc/src/main/java/datadog/trace/instrumentation/jdbc/HikariDataSourceInstrumentation.java`: `HikariGetConnectionAdvice.start`, pool-name metadata propagation.
- OpenTelemetry Java Instrumentation `open-telemetry/opentelemetry-java-instrumentation@27aad94670ac3de1948a82f150fa0ca76edecf89`
- `instrumentation/jdbc/library/src/main/java/io/opentelemetry/instrumentation/jdbc/internal/OpenTelemetryConnection.java`: `wrapStatement`, `wrapPreparedStatement`, `wrapCallableStatement`, `createStatement`, `prepareStatement`, `prepareCall`, transaction wrapping.
- `instrumentation/jdbc/library/src/main/java/io/opentelemetry/instrumentation/jdbc/internal/JdbcInstrumenterFactory.java`: statement and transaction instrumenter builders, DB attributes, metrics, exception event extractor.
- `instrumentation/jdbc/library/src/main/java/io/opentelemetry/instrumentation/jdbc/datasource/JdbcTelemetry.java`: `wrap`.
- `instrumentation/jdbc/library/src/main/java/io/opentelemetry/instrumentation/jdbc/datasource/JdbcTelemetryBuilder.java`: datasource/statement/transaction toggles and query sanitization options.
- `instrumentation/jdbc/library/src/main/java/io/opentelemetry/instrumentation/jdbc/datasource/OpenTelemetryDataSource.java`: no-argument and two-argument `getConnection`, `wrapCall`, valid-parent-span guard, `getDbInfo`.
- `instrumentation/jdbc/library/src/test/java/io/opentelemetry/instrumentation/jdbc/datasource/JdbcTelemetryTest.java`: datasource wrapping, disabled datasource spans, enabled datasource spans, transaction spans, wrapped statement connection assertions.
- `instrumentation/spring/spring-boot-autoconfigure/src/main/java/io/opentelemetry/instrumentation/spring/autoconfigure/internal/instrumentation/jdbc/JdbcInstrumentationAutoConfiguration.java`: static auto-configuration bean registered after Spring DataSource auto-configuration.
- `instrumentation/spring/spring-boot-autoconfigure/src/main/java/io/opentelemetry/instrumentation/spring/autoconfigure/internal/instrumentation/jdbc/DataSourcePostProcessor.java`: `BeanPostProcessor` using `ObjectProvider<OpenTelemetry>`, scoped/routing DataSource skips, and `LOWEST_PRECEDENCE - 20` ordering.

## Pattern Observed

- Sentry uses P6Spy/P6DataSource plus JDBC listener callbacks to start/finish child spans around statement execution and optional transaction operations. It can parse database details from connection information and records throwable status on failure; the source read did not show a separate `getConnection` span.
- Sentry's Spring modules use bean post-processors for framework-owned beans such as cache managers and Kafka factories, composing around app beans when safe and warning/falling back when custom factories prevent instrumentation. The inspected source did not show a Spring Boot DataSource auto-wrapper; JDBC coverage stays centered on P6Spy.
- Datadog uses Java-agent bytecode advice around public `execute*` calls and `DataSource.getConnection`, decorates spans with DB metadata, and optionally adds pool-specific metadata such as Hikari pool names or DBM trace context through SQL comments/session state. Its generic datasource instrumentation is disabled by default and skips top-level connection spans when there is no active span.
- OpenTelemetry exposes an explicit `JdbcTelemetry.wrap(DataSource)` API and a Spring Boot `DataSourcePostProcessor` auto-configuration. Its data-source wrapper returns wrapped connections/statements, can optionally create `getConnection` spans, and supports transaction spans, semantic DB attributes, metrics, sanitization settings, and exception events. Its Spring post-processor registers early through a static bean, uses `ObjectProvider` so the actual telemetry object is resolved later, skips routing/scoped data sources, and orders near the end of bean post-processing. Its `wrapCall` guard also avoids datasource spans without a valid parent span because connection acquisition can be noisy.

The mature competitor advantage is breadth: automatic JDBC coverage, richer semantic conventions, query sanitization modes, DB metrics, and deeper backend/exporter integration. The tradeoff is heavier runtime coupling and a larger metadata surface, especially around SQL descriptions, URLs, connection metadata, and DBM/comment propagation.

## LogBrew Design

- Added dependency-free `LogBrewJdbcTracing.instrumentConnection(...)` and `instrumentDataSource(...)` to the Java SDK.
- Apps pass one owned `java.sql.Connection` or `javax.sql.DataSource` and their existing `LogBrewClient`; LogBrew returns a proxy for that object only.
- The data-source proxy delegates normal data-source behavior and wraps only connections returned by no-argument or two-argument `getConnection`.
- The connection proxy wraps statements returned by `createStatement`, `prepareStatement`, and `prepareCall`.
- `execute*` methods emit one `jdbc:<VERB>` child span with active trace correlation, `framework=jdbc`, `dbSystem`, `dbOperation`, `dbOperationKind`, optional `dbName`, `jdbcMethod`, `jdbcTarget`, update row count when JDBC returns one, sampled state, and type-only error metadata.
- Optional `traceConnectionAcquisition(true)` emits one `jdbc:CONNECT` child span around DataSource `getConnection`, with `source=jdbc.connection`, `dbOperation=CONNECT`, `dbOperationKind=connection`, `jdbcMethod=getConnection`, and `jdbcTarget=dataSource`.
- Optional `traceTransactions(true)` emits `COMMIT` and `ROLLBACK` spans.
- The helper preserves JDBC return values and rethrows the original `SQLException` object.
- Added `LogBrewSpringBootJdbcAutoConfiguration` for Spring Boot users who already expose a `LogBrewClient` bean and a Spring-owned `DataSource` bean.
- The Spring post-processor follows the OpenTelemetry/Sentry bean-wrapping pattern but stays lighter: it resolves the app-owned client lazily through `ObjectProvider`, wraps only initialized Spring `DataSource` beans, skips scoped-target/routing/already wrapped data sources, and records only Spring application/profile metadata.
- Spring properties can set `logbrew.jdbc.db-system`, `logbrew.jdbc.db-name`, `logbrew.jdbc.event-id-prefix`, `logbrew.jdbc.trace-transactions`, `logbrew.jdbc.trace-connection-acquisition`, and `logbrew.jdbc.enabled=false`.

## Privacy and Runtime Boundary

LogBrew intentionally avoids Java agents, driver registration, `DriverManager` patching, pool/vendor hooks, SQL comment mutation, connection metadata probing, SQL text capture, bind values, result rows, connection URLs, network addresses, JDBC login argument values, Spring bean names, arbitrary JDBC properties, baggage, tracestate, exception messages, and stack traces. DataSource acquisition spans are opt-in because pool wait and connection calls can be high-volume in some applications.

## Verification

- RED: `bash scripts/check_java_package.sh` failed because `LogBrewJdbcTracing` did not exist.
- RED: `bash scripts/check_java_package.sh` failed on missing `instrumentDataSource(...)` after adding data-source tests.
- RED: `bash scripts/check_java_package.sh` failed on missing `traceConnectionAcquisition(...)` after adding acquisition-span tests.
- RED: `bash scripts/check_java_package.sh` failed on missing Spring Boot JDBC auto-configuration and `isInstrumentedDataSource(...)` after adding the Spring post-processor tests.
- GREEN: `bash scripts/check_java_package.sh` passed with 32 core Java tests, 6 trace tests, 2 servlet tests, 2 span-event tests, 3 OpenTelemetry tests, 4 operation-tracing tests, 10 JDBC-tracing tests, 3 Spring Boot JDBC auto-configuration tests, 2 support-ticket tests, Maven metadata, javadocs, source jar, binary jar, README checks, and packaged examples.
- Installed-artifact proof: `bash scripts/real_user_java_smoke.sh` passed after packing the jar, compiling a temporary app against it, exercising statement, prepared statement, row-count, SQL-error, leading-comment, data-source, two-argument data-source, and opt-in acquisition-span paths through standard JDBC interfaces, and proving no SQL literals, raw statements, leading comment text, connection URL values, JDBC login argument values, or exception messages leaked.
- Spring Boot installed-artifact proof: `bash scripts/real_user_spring_boot_smoke.sh` builds a temporary Spring Boot 4.0.6 app against the locally packed jar, exposes an app-owned `LogBrewClient` and `DataSource`, lets auto-configuration wrap the data source, sends one request through the real servlet stack, and verifies log/request/JDBC acquisition/statement/transaction spans plus duration metric in one flushed batch without raw request path, query string, propagation header, SQL column/literal, JDBC login argument, Spring bean name, or stack-text leakage.
- Resilience proof: invalid caller-supplied diagnostic span IDs fall back to generated IDs and still preserve the app-owned JDBC return path.
- Privacy proof: leading SQL comments and quoted prefixes are skipped before deriving the safe operation verb, so comment contents cannot become span names or operation metadata.

## Remaining Gaps

LogBrew is now safer and lighter for app-owned JDBC/DataSource tracing and more convenient for Spring Boot apps that already expose a `LogBrewClient`, but Sentry, Datadog, and OpenTelemetry remain stronger for hidden automatic driver-wide JDBC instrumentation, richer pool wait analysis with vendor metadata, SQL sanitization modes, DB metrics, DBM/comment correlation, semantic-convention depth, span links, baggage/tracestate, and full exporter/processor interop.
