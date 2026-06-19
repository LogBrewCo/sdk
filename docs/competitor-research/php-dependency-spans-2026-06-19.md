# PHP Dependency Spans Competitor Research - 2026-06-19

## Sources Read

- Sentry PHP `getsentry/sentry-php@406b5cd69a4e87ea6bb9d0869b5954bf0dacf03f`
  - `src/Tracing/Span.php`: `__construct`, span identifiers, op/status/data fields, `finish`
  - `src/Tracing/Transaction.php`: `initSpanRecorder`, `finish`
  - `src/Tracing/GuzzleTracingMiddleware.php`: `trace`, `shouldAttachTracingHeaders`
- Datadog PHP tracer `DataDog/dd-trace-php@cce917e5826062ead490af26dc7505ea1df2cb61`
  - `src/DDTrace/Integrations/PDO/PDOIntegration.php`: `init`, PDO/PDOStatement hooks, DSN metadata extraction, error detection
  - `src/DDTrace/Integrations/PHPRedis/PHPRedisIntegration.php`: `init`, Redis command tracing, connection metadata cache
  - `src/DDTrace/Integrations/LaravelQueue/LaravelQueueIntegration.php`: `init`, worker/job/enqueue hooks, queue distributed tracing
  - `src/api/Tag.php` and `src/api/Type.php`: public SQL/queue tag constants
- OpenTelemetry PHP Contrib `open-telemetry/opentelemetry-php-contrib@01657de158acd071c549b958bdc5a1ad52d194b3`
  - `src/Instrumentation/PDO/src/PDOInstrumentation.php`: PDO hook registration, span start/end, SQL commenter, status recording
  - `src/Instrumentation/PDO/src/PDOTracker.php`: PDO/statement weak maps, DSN attribute extraction, DB system mapping
  - `src/Instrumentation/Laravel/src/Watchers/QueryWatcher.php`, `CacheWatcher.php`, and `RedisCommand/RedisCommandWatcher.php`: framework watcher shape

## Patterns And Tradeoffs

- Sentry PHP gives users span/transaction primitives and Guzzle middleware. Its middleware is convenient for HTTP clients, but it may record URL query/fragment and body sizes, and dependency coverage depends on integrations outside this explicit core path.
- Datadog PHP is much deeper for production dependency visibility: extension hooks cover PDO, Redis, Laravel Queue, row counts, errors, service/source tags, queue propagation, and framework behavior. The tradeoff is a heavier runtime extension, many global hooks, and a larger privacy/control surface.
- OpenTelemetry PHP Contrib uses hook-based instrumentation packages for PDO, Doctrine, MySQLi, Laravel, and other frameworks. It follows semantic conventions and context propagation well, but it brings OTel packages, hooks, DSN parsing, and optional SQL query capture.

## LogBrew Design Decision

LogBrew added a lighter explicit helper instead of auto-hooking PHP dependencies:

- `LogBrewOperationTracing::databaseOperation(...)`
- `LogBrewOperationTracing::cacheOperation(...)`
- `LogBrewOperationTracing::queueOperation(...)`

The helper wraps an app-owned callable, creates a child span under `LogBrewTrace::current()` when present, activates that child while the callback runs, returns to the previous scope, and emits one span with primitive metadata. It preserves callback return values and original exceptions; telemetry capture failures are isolated behind an optional `onCaptureError` callback.

Privacy boundaries are stricter than the heavier competitors by default: no PDO/Doctrine/Redis/Laravel hooks, no PHP extension requirement, and no SQL text, connection string, network location, login field, cache identifier, message body, arbitrary header, baggage, or tracestate capture. Metadata keys that look sensitive are dropped before enqueue.

## Remaining Gaps

- LogBrew is still weaker than Datadog and OTel for automatic PDO/Doctrine/Redis/Laravel Queue instrumentation, rich semantic DB attributes, row counts from real drivers, queue propagation, and framework watchers.
- LogBrew is intentionally stronger for first-adoption safety: dependency-free install, explicit app-owned wrapping, deterministic installed-package smoke proof, and tighter default redaction.
- Next PHP work should target optional framework-owned helpers for Laravel/Symfony middleware and queue jobs, still avoiding global patching unless a dedicated integration package owns it.
