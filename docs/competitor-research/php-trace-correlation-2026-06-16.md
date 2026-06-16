# PHP Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority. The PHP SDK already had explicit W3C `Traceparent` helpers, first-useful telemetry, dependency-free HTTP transport, PSR-3 logging, and Monolog/Laravel logging support. It lacked the Sentry-competitive request-local correlation path where one request trace links PHP logs, captured issues, request spans, request-duration metrics, and outgoing propagation.

## Source Reviewed

- Sentry PHP `getsentry/sentry-php` at commit `d0c1a8f9e510db803c6dded07bbdcb342e48d17e`.
- Read `src/OpenTelemetry/Propagation/SentryPropagator.php`: `extract`, `inject`, and traceparent-priority remote-parent handling.
- Sentry Laravel `getsentry/sentry-laravel` at commit `fe9d07e3f4b8a09c94afac88cd241f01d14549a1`.
- Read `src/Sentry/Laravel/Tracing/Middleware.php`: `handle`, `terminate`, and `startTransaction`.
- Read `src/Sentry/Laravel/SentryHandler.php`: `doWrite` and `consumeContextAndApplyToScope`.
- Read `src/Sentry/Laravel/Logs/LogsHandler.php`: `doWrite`.
- OpenTelemetry PHP `open-telemetry/opentelemetry-php` at commit `2f1c57fda6b2b6172e42996fe4256915a08120b7`.
- Read `src/API/Trace/Propagation/TraceContextPropagator.php`: `inject`, `extract`, and `extractImpl`.
- Read `src/Context/Context.php`: `getCurrent`, `activate`, and `with`.
- Read `src/API/Trace/Span.php`: `getCurrent`, `wrap`, `activate`, and `storeInContext`.
- Read `src/API/Logs/LogRecord.php`: `setContext`.
- Datadog PHP tracer `DataDog/dd-trace-php` at commit `43427006ec94fa23a01bed64a955e436b9fde306`.
- Read `src/DDTrace/Integrations/Logs/LogsIntegration.php`: `getPlaceholders`, `appendTraceIdentifiersToMessage`, `replacePlaceholders`, `addTraceIdentifiersToContext`, and `getHookFn`.
- Read `src/DDTrace/ScopeManager.php`: `activate`, `getActive`, and `deactivate`.
- Read `src/DDTrace/SpanContext.php`: `createAsChild`, `createAsRoot`, and trace/span accessors.

## Competitor Patterns

- Sentry Laravel opens a request transaction in middleware, continues incoming propagation, stores active span state on the hub/scope, and finishes after route/status data is known.
- Sentry logger integrations apply record context/extra to the active scope before capturing messages or exceptions.
- OpenTelemetry PHP keeps an active context carrier, wraps remote parent span context on extract, and lets logs receive context explicitly through `LogRecord::setContext`.
- Datadog PHP uses an active scope manager and log-injection hooks so Monolog/PSR logs can receive trace/span identifiers without users passing IDs on every call.
- Mature competitors provide broader automatic framework instrumentation, but that comes with framework-specific middleware, context stacks, extension/agent behavior, and wider capture surfaces.

## LogBrew Improvement From This Pass

- Added `LogBrewTraceContext` for immutable W3C-shaped trace/span identity, local root generation, incoming `traceparent` continuation, outgoing `traceparent`, sampled flags, and primitive correlation metadata.
- Added `LogBrewTrace` and `LogBrewTraceScope` for request-local active trace access, previous-trace restoration, and `metadataWithCurrentTrace(...)` helpers.
- Added `LogBrewHttpRequestTelemetry` to emit one request span plus optional `http.server.duration` metric using the same trace/span IDs as PSR logs, Monolog records, issues, and outgoing propagation. Malformed incoming propagation falls back non-fatally to a local root trace.
- Updated `LogBrewPsrLogger` and `LogBrewMonologHandler` so active trace metadata is added automatically and app metadata cannot spoof correlation fields.
- Added packaged `examples/http_trace_correlation.php` plus installed-artifact validation for log, issue, span, metric, action, and outgoing propagation correlation from one W3C trace.

## Where LogBrew Is Better Today

- Lighter and more explicit for PHP services that want request trace-log-error-metric correlation without installing a framework package, PHP extension, Datadog agent, OpenTelemetry setup, global HTTP patching, payload capture, arbitrary header capture, or raw propagation serialization.
- The request helper records sanitized route templates and primitive metadata only; query strings/fragments and non-primitive values are omitted.
- PSR-3 and Monolog records inherit active trace metadata while preserving app-owned logger configuration and failure behavior.

## Where LogBrew Is Still Worse

- No Laravel or Symfony HTTP middleware package yet; users call `LogBrewHttpRequestTelemetry` from app-owned middleware or handlers.
- No OpenTelemetry context bridge yet, so apps already using OTel must explicitly pass W3C `traceparent` or a LogBrew trace context.
- No database, cache, queue, outbound HTTP, baggage, tracestate, rich span event, or exception-span modeling.
- Current public Packagist footprint is still worse than Sentry core/PostHog even though the local subtree proof is leaner.

## Updated Evidence

- `php php/logbrew-php/tests/run.php`: includes trace-context, request-helper, PSR active trace, Monolog active trace, malformed propagation fallback, validation, and duplicate-finish coverage.
- `bash scripts/real_user_php_smoke.sh`: builds a Composer archive, installs/removes/reinstalls it into a temporary app, validates README/package metadata, runs packaged examples, and validates `http_trace_correlation.php` from installed artifacts.
- `python3 scripts/check_php_http_trace_payload.py`: verifies one trace/span pair across a PSR log, issue, request span, and `http.server.duration` metric; verifies outbound W3C `traceparent`; and checks query strings, non-primitive metadata, and raw propagation headers are not serialized into LogBrew telemetry.
