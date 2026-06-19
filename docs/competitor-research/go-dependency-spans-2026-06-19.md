# Go Dependency Spans - Competitor Research - 2026-06-19

## Goal

Reduce the Go backend dependency-tracing gap after LogBrew already shipped `net/http`, `slog`, W3C trace context, and outbound HTTP helpers. Sentry, Datadog, and OpenTelemetry are stronger for automatic `database/sql`, Redis, Kafka, and framework instrumentation. LogBrew needs a lighter default that helps developers debug request-to-dependency timing without adding driver dependencies or monkeypatching.

## Sources Read

- Sentry Go SDK: `getsentry/sentry-go@c299195fc44e4c637d24a6ba1f2b38e0ccedb816`.
- Sentry files/functions: `sql/span.go` (`startQuerySpan`, `startTxSpan`, `spanParent`, `setSQLData`, `finishSpan`), `sql/conn.go` (`QueryContext`, `ExecContext`, `PrepareContext`, transaction wrapping), and `sql/integration_test.go` query/exec/transaction span assertions.
- Datadog Go SDK: `DataDog/dd-trace-go@e5efa84083621f1667f10b430135ee7f7f9ab1bb`.
- Datadog files/functions: `orchestrion/all/orchestrion.tool.go` integration inventory; `contrib/go-redis/redis.v7/redis.go` (`NewClient`, `WrapClient`, `BeforeProcess`, `AfterProcess`, pipeline hooks, raw-command option handling); SQL/Redis/Kafka integration package paths under `contrib/database/sql`, `contrib/go-redis`, and `contrib/segmentio/kafka-go`.
- OpenTelemetry Go Contrib: `open-telemetry/opentelemetry-go-contrib@844e2a9ea49b8cadf3fc5346a615bbab31af3ecb`.
- OpenTelemetry files/functions: instrumentation package inventory under `instrumentation/go.mongodb.org/mongo-driver/mongo/otelmongo`, `instrumentation/net/http/otelhttp`, `instrumentation/google.golang.org/grpc/otelgrpc`, and framework instrumentation packages.

## Runtime Evidence

- Sentry Go SQL integration runtime check passed with `go test ./sql` in `getsentry/sentry-go@c299195fc44e4c637d24a6ba1f2b38e0ccedb816`.
- Ecosystem drift: Sentry Go currently auto-downloaded Go `1.25.0` on this machine before the SQL integration test ran.

## Competitor Pattern

- Sentry wraps `database/sql/driver` connections, statements, queries, exec calls, and transactions. It starts child spans only when a Sentry parent span exists, obfuscates SQL descriptions, records DB system/driver/namespace/server metadata, and marks spans by operation outcome. This is useful automatic SQL visibility, but it owns driver wrapping and can include server/user metadata depending on configuration.
- Datadog exposes broad Go integration packages and Orchestrion coverage for SQL, Redis, Kafka, Pub/Sub, HTTP routers, loggers, gRPC, and more. Its Redis wrappers can record command, argument length, pipeline length, DB system, component, and optional raw command text. This is deep but adds client-version coupling and broader metadata risk.
- OpenTelemetry Go Contrib favors separate instrumentation packages per framework/client with standards-rich span attributes and metrics. It is portable but requires apps to adopt OTel tracer/provider/exporter setup and the relevant instrumentation packages.

## LogBrew Implementation

- Added dependency-free `DatabaseOperationWithLogBrewSpan(...)`, `CacheOperationWithLogBrewSpan(...)`, and `QueueOperationWithLogBrewSpan(...)` to `go/logbrew`.
- Apps pass a `context.Context`, `*Client`, operation name, app-owned callback, and a small config object. LogBrew creates a child `TraceContext`, activates it for the callback, records one span, returns the original result, and re-raises the original error.
- Metadata is privacy-bounded:
  - DB: `source=database.operation`, `dbSystem`, `dbOperation`, `dbOperationKind`, optional `dbName`, optional `dbStatementTemplate`, optional `rowCount`, sampled flag, primitive caller metadata, and exception type.
  - Cache: `source=cache.operation`, `cacheSystem`, `cacheOperation`, `cacheOperationKind`, optional `cacheName`, hit flag, item size/count, sampled flag, primitive caller metadata, and exception type.
  - Queue: `source=queue.operation`, `queueSystem`, `queueOperation`, `queueOperationKind`, optional queue/task/message count, sampled flag, primitive caller metadata, and exception type.
- The helpers intentionally drop SQL/query/statement text from caller metadata, params, connection strings, hosts, usernames, URLs, cache keys/values, raw commands, payloads, message bodies, broker URLs, headers, cookies, auth-like fields, exception messages, and stack traces.

## Tradeoffs

- Better than default Sentry/Datadog/OTel automatic integrations for teams that want one explicit dependency span around the operation that matters, no Go driver/client imports, no global instrumentation, no local agent/exporter setup, and predictable privacy behavior.
- Worse than Sentry/Datadog/OTel for teams that want automatic coverage across every SQL query, Redis command, Kafka publish/consume, richer semantic conventions, transaction hierarchy, propagation through brokers, raw-command debugging, or standards-native OTel exporter/processor interop.
- The next safe step is optional integration packages or source snippets for specific Go clients only if demand justifies dependency/version proof. Core `go/logbrew` should stay dependency-free and explicit.

## Verification

- Red: `go test ./...` failed because `DatabaseOperationWithLogBrewSpan`, `CacheOperationWithLogBrewSpan`, `QueueOperationWithLogBrewSpan`, and their config types did not exist.
- Green: `cd go/logbrew && go test ./...` passed, including result preservation, original error preservation, child trace activation, DB/cache/queue span capture, capture-failure isolation, and unsafe metadata dropping.
- Installed proof: `bash scripts/real_user_go_smoke.sh` passed from a generated Go module proxy, including package zip/source checks, README guidance, reinstall/remove/reinstall, `go doc` checks for the new configs/functions, and existing HTTP/trace/transport proof.
- Static proof: `bash scripts/check_go_static.sh` passed with Staticcheck `2025.1.1`.
