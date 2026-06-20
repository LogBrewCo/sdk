# Kotlin Dependency Spans - Competitor Research - 2026-06-20

## Goal

Reduce the Kotlin/JVM dependency-tracing gap after LogBrew already shipped Kotlin trace correlation, coroutine propagation, explicit request spans, `HttpURLConnection`, lifecycle spans, and optional OkHttp helpers. Sentry, Datadog, and OpenTelemetry are stronger for automatic JDBC, Redis, and Kafka coverage. LogBrew needs a smaller default that gives developers one useful child span around the app-owned dependency call without a Java agent, JDBC proxy, Redis/Kafka dependency, or broad metadata capture.

## Sources Read

- Sentry Java SDK: `getsentry/sentry-java@8da852cc8e39d8246ba5a712c88d38b64618b074`.
- Sentry files/functions: `sentry-jdbc/src/main/java/io/sentry/jdbc/SentryJdbcEventListener.java` (`onBeforeAnyExecute`, `onAfterAnyExecute`, `startSpan`, `finishSpan`, `applyDatabaseDetailsToSpan`) and `sentry-jdbc/src/main/java/io/sentry/jdbc/DatabaseUtils.java` (`readFrom`, `parse`, database URL parsing).
- Datadog Java SDK: `DataDog/dd-trace-java@0e13e90dacf7c1270a92d01ee4a4f82e9d6230c6`.
- Datadog files/functions: `dd-java-agent/instrumentation/jdbc/src/main/java/datadog/trace/instrumentation/jdbc/JDBCDecorator.java` (`parseDBInfo`, `onConnection`, `onStatement`, DBM tag paths), `dd-java-agent/instrumentation/jedis/jedis-4.0/src/main/java/redis/clients/jedis/JedisClientDecorator.java`, and `dd-java-agent/instrumentation/kafka/kafka-clients-0.11/src/main/java/datadog/trace/instrumentation/kafka_clients/KafkaDecorator.java`.
- OpenTelemetry Java Instrumentation: `open-telemetry/opentelemetry-java-instrumentation@61f44956e4d7dbfa46e1aa3a8934a1b3da88b69b`.
- OpenTelemetry files/functions: `instrumentation/jdbc/library/src/main/java/io/opentelemetry/instrumentation/jdbc/internal/JdbcInstrumenterFactory.java`, `instrumentation/jedis/jedis-4.0/javaagent/src/main/java/io/opentelemetry/javaagent/instrumentation/jedis/v4_0/JedisDbAttributesGetter.java`, and `instrumentation/kafka/kafka-clients/kafka-clients-common-0.11/library/src/main/java/io/opentelemetry/instrumentation/kafkaclients/common/v0_11/internal/KafkaInstrumenterFactory.java`.

## Competitor Pattern

- Sentry JDBC wraps statement execution through listener callbacks, starts spans from active Sentry transactions, records SQL descriptions, finishes spans on success/error, and parses DB details from connection URLs. This gives automatic database spans, but requires wrapper integration and can expose statement text.
- Datadog Java uses broad agent instrumentation for JDBC, Redis, and Kafka. It decorates spans with connection, command, topic, partition, offset, bootstrap, DBM, and service metadata. This is deep, but materially increases runtime coupling and metadata surface.
- OpenTelemetry Java instrumentation builds JDBC and Kafka instrumenters with semantic attribute extractors, exception event extractors, messaging span names, and optional header capture. It is portable, but expects OTel setup plus instrumentation dependencies or a Java agent.

## LogBrew Implementation

- Added dependency-free `LogBrewOperationTracing.databaseOperation(...)`, `cacheOperation(...)`, and `queueOperation(...)` to Kotlin core.
- Apps pass a `LogBrewClient`, operation name, app-owned callable, and a small `DatabaseOperation`, `CacheOperation`, or `QueueOperation` config. LogBrew creates a child `LogBrewTraceContext`, activates it while the callable runs, records one span, returns the original result, and rethrows the original operation error.
- Metadata is privacy-bounded:
  - DB: `source=database.operation`, `dbSystem`, `dbOperation`, `dbOperationKind`, optional `dbName`, optional `dbStatementTemplate`, optional `rowCount`, sampled flag, primitive caller metadata, and exception type.
  - Cache: `source=cache.operation`, `cacheSystem`, `cacheOperation`, `cacheOperationKind`, optional `cacheName`, hit flag, item size/count, sampled flag, primitive caller metadata, and exception type.
  - Queue: `source=queue.operation`, `queueSystem`, `queueOperation`, `queueOperationKind`, optional queue/task/message count, sampled flag, primitive caller metadata, and exception type.
- The helpers intentionally drop SQL/query/statement text from caller metadata, params, connection strings, hosts, usernames, URLs, cache keys/values, raw commands, payloads, message bodies, broker URLs, headers, cookies, auth-like fields, exception messages, stack traces, baggage, and tracestate.

## Tradeoffs

- Better than automatic defaults for teams that want one explicit span around the dependency call that matters, no Java agent, no JDBC/Redis/Kafka dependency in `co.logbrew:logbrew-kotlin`, original result/error preservation, and predictable privacy behavior.
- Worse than Sentry, Datadog, and OpenTelemetry for teams that want hidden coverage across every JDBC statement, Redis command, Kafka publish/consume, richer semantic conventions, DBM/SQL comment propagation, broker propagation, span links, metrics, and exporter/processor interop.
- The next safe Kotlin step is optional typed JDBC/Redis/Kafka integration packages only if dependency/version proof justifies them. Core should stay dependency-light and explicit.

## Verification

- Red: `bash scripts/check_kotlin_package.sh` failed because `CacheOperation`, `DatabaseOperation`, `QueueOperation`, and `LogBrewOperationTracing` did not exist.
- Green: `bash scripts/check_kotlin_package.sh` passed with 29 Kotlin core tests, 5 OkHttp tests, source/binary jar class checks, README guidance checks, and Maven metadata checks.
- Installed proof: `bash scripts/real_user_kotlin_smoke.sh` passed after compiling a temporary app against the built jar and exercising DB/cache/queue spans, original result/error preservation, unsafe metadata dropping, and packaged README/class presence.
