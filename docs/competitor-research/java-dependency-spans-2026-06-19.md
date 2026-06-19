# Java Dependency Spans - Competitor Research - 2026-06-19

## Goal

Reduce the Java backend dependency-tracing gap after LogBrew already shipped Java logging, request trace correlation, W3C helpers, request spans, and request metrics. Sentry, Datadog, and OpenTelemetry are stronger for automatic JDBC, Redis, and Kafka coverage. LogBrew needs a lighter default that helps developers debug request-to-dependency timing without a Java agent, driver proxy, client dependency, or broad metadata capture.

## Sources Read

- Sentry Java SDK: `getsentry/sentry-java@8da852cc8e39d8246ba5a712c88d38b64618b074`.
- Sentry files/functions: `sentry-jdbc/src/main/java/io/sentry/jdbc/SentryJdbcEventListener.java` (`onBeforeAnyExecute`, `onAfterAnyExecute`, transaction callbacks, `startSpan`, `finishSpan`, `applyDatabaseDetailsToSpan`), `sentry-jdbc/src/main/java/io/sentry/jdbc/DatabaseUtils.java` (`readFrom`, `parse`, DB URL parsing), and `sentry-jdbc/src/test/kotlin/io/sentry/jdbc/SentryJdbcEventListenerTest.kt` successful/error/no-running-transaction and transaction-tracing assertions.
- Datadog Java SDK: `DataDog/dd-trace-java@0e13e90dacf7c1270a92d01ee4a4f82e9d6230c6`.
- Datadog files/functions: `dd-java-agent/instrumentation/jdbc/src/main/java/datadog/trace/instrumentation/jdbc/JDBCDecorator.java` (`parseDBInfo`, connection metadata, DBM/comment settings), `dd-java-agent/instrumentation/jedis/jedis-4.0/src/main/java/redis/clients/jedis/JedisClientDecorator.java`, `dd-java-agent/instrumentation/lettuce/lettuce-5.0/src/main/java/datadog/trace/instrumentation/lettuce5/LettuceClientDecorator.java`, and `dd-java-agent/instrumentation/kafka/kafka-clients-0.11/src/main/java/datadog/trace/instrumentation/kafka_clients/KafkaDecorator.java`.
- OpenTelemetry Java Instrumentation: `open-telemetry/opentelemetry-java-instrumentation@61f44956e4d7dbfa46e1aa3a8934a1b3da88b69b`.
- OpenTelemetry files/functions: `instrumentation/jdbc/library/src/main/java/io/opentelemetry/instrumentation/jdbc/internal/JdbcInstrumenterFactory.java`, `JdbcAttributesGetter.java`, `instrumentation/lettuce/lettuce-5.1/library/src/main/java/io/opentelemetry/instrumentation/lettuce/v5_1/LettuceDbAttributesGetter.java`, `instrumentation/jedis/jedis-4.0/javaagent/src/main/java/io/opentelemetry/javaagent/instrumentation/jedis/v4_0/JedisDbAttributesGetter.java`, and `instrumentation/kafka/kafka-clients/kafka-clients-common-0.11/library/src/main/java/io/opentelemetry/instrumentation/kafkaclients/common/v0_11/internal/KafkaInstrumenterFactory.java` / `KafkaProducerAttributesGetter.java`.

## Runtime Evidence

- Attempted focused Sentry JDBC runtime check with `./gradlew :sentry-jdbc:test --tests io.sentry.jdbc.SentryJdbcEventListenerTest --no-daemon` from the sparse checkout. It did not start because the sparse checkout omitted `gradle/wrapper/gradle-wrapper.jar`.
- LogBrew local runtime/install evidence is the authoritative verifier for this cycle: Java source tests and installed-jar smoke both exercise the new dependency helper API.

## Competitor Pattern

- Sentry Java JDBC uses P6Spy listener callbacks around statement execution and optional transaction callbacks. It starts child spans only when a Sentry parent span exists, records SQL descriptions, marks span status from SQL exceptions, and parses DB system/name from connection URLs. This gives automatic JDBC coverage but requires P6Spy-style wrapping and can expose SQL descriptions.
- Datadog Java uses Java-agent instrumentation across JDBC, Jedis, Lettuce, Kafka, and many frameworks. It decorates spans with DB/cache/messaging service names, peer metadata, DBM propagation, SQL comments, Redis command names, Kafka topic/partition/offset/bootstrap metadata, and broker timing. This is broad and deep, but it adds agent/runtime coupling and more metadata risk.
- OpenTelemetry Java instrumentation offers library and Java-agent instrumenters for JDBC, Redis clients, and Kafka. It supports semantic attributes, metrics, sanitized SQL behavior, exception event extractors, messaging span links, propagation, and exporter integration. This is portable but requires OTel setup and client/instrumentation dependencies.

## LogBrew Implementation

- Added dependency-free `LogBrewOperationTracing.databaseOperation(...)`, `cacheOperation(...)`, and `queueOperation(...)` to Java core.
- Apps pass a `LogBrewClient`, operation name, app-owned callback, and a small config object. LogBrew creates a child `LogBrewTraceContext`, activates it for the callback, records one span, returns the original result, and rethrows the original operation error.
- Metadata is privacy-bounded:
  - DB: `source=database.operation`, `dbSystem`, `dbOperation`, `dbOperationKind`, optional `dbName`, optional statement template, optional row count, sampled flag, primitive caller metadata, and exception type.
  - Cache: `source=cache.operation`, `cacheSystem`, `cacheOperation`, `cacheOperationKind`, optional `cacheName`, hit flag, item size/count, sampled flag, primitive caller metadata, and exception type.
  - Queue: `source=queue.operation`, `queueSystem`, `queueOperation`, `queueOperationKind`, optional queue/task/message count, sampled flag, primitive caller metadata, and exception type.
- The helpers intentionally drop SQL/query/statement text from caller metadata, params, connection strings, hosts, usernames, URLs, cache keys/values, raw commands, payloads, message bodies, broker URLs, headers, cookies, auth-like fields, exception messages, and stack traces.

## Tradeoffs

- Better than default Sentry/Datadog/OTel automatic integrations for teams that want one explicit span around the dependency call that matters, no Java agent, no JDBC proxy, no Redis/Kafka dependencies in core, no exporter setup, original result/error preservation, and predictable privacy behavior.
- Worse than Sentry/Datadog/OTel for teams that want hidden automatic coverage across every JDBC statement, Redis command, Kafka publish/consume, richer semantic conventions, SQL/comment propagation, broker propagation, span links, metrics, and exporter/processor interop.
- The next safe Java step is optional explicit integration packages or snippets for JDBC/Redis/Kafka only if dependency/version proof justifies it. Core `logbrew-sdk` should stay dependency-free and explicit.

## Verification

- Red: `bash scripts/check_java_package.sh` failed because `LogBrewOperationTracing` and nested config types did not exist.
- Green: `bash scripts/check_java_package.sh` passed with 30 Java client tests, 6 trace-correlation tests, 3 operation-tracing tests, javadoc, Maven metadata, source jar, binary jar, and packaged example checks.
- Installed proof: `bash scripts/real_user_java_smoke.sh` passed after compiling a temporary app against the built jar and exercising DB/cache/queue spans, original result preservation, and unsafe metadata dropping.
