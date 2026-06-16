# Fastify Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority, after Node and Express got request-local trace context. This pass targets the Fastify wrapper gap: request spans existed, but Fastify route handlers, lifecycle callbacks, and error capture did not get a request-local trace object that app code could use for log/error/product-action correlation.

## Current Competitor Signals

- Sentry Fastify tracing docs: <https://docs.sentry.io/platforms/javascript/guides/fastify/tracing/>. Sentry positions Fastify tracing as automatic request performance tracking across services.
- Sentry Fastify setup docs: <https://docs.sentry.io/platforms/javascript/guides/fastify/>. The current setup path confirms Fastify is a first-class framework target for error plus trace capture.
- Fastify hooks docs: <https://fastify.io/docs/latest/Reference/Hooks/>. `onResponse` runs after the response is sent and is a suitable lifecycle point for external telemetry, while `onError` observes thrown route errors before normal error handling completes.
- OpenTelemetry JavaScript context and propagation docs: <https://opentelemetry.io/docs/languages/js/context/> and <https://opentelemetry.io/docs/languages/js/propagation/>. The baseline expectation is async context continuity plus W3C propagation between services.
- Datadog Node log/trace correlation docs: <https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/nodejs/>. Datadog confirms trace/span IDs on structured logs are valuable, but its mature path relies on tracer/logger integration.

## LogBrew Improvement From This Pass

- `@logbrew/fastify` now attaches `request.logbrew.trace` when an incoming W3C `traceparent` is valid.
- `getActiveLogBrewTrace()` exposes the same context from asynchronous route work after the plugin's `onRequest`/`preHandler` lifecycle.
- The default request span reuses the request-local child span ID, so the request span, app-owned logs, custom callbacks, and errors can reference the same operation.
- Custom `requestEvent`, `requestMetricEvent`, `onFlush`, `onCaptureError`, and `errorEvent` callbacks receive the active trace context.
- Default error capture now adds `traceId`, `spanId`, `parentSpanId`, and `sampled` metadata when the failing request has a valid trace context.
- Public docs show app-owned log correlation through `request.logbrew.trace` or `getActiveLogBrewTrace()` without exposing raw propagation headers or undefined metadata fields.

## Where LogBrew Is Better Today

- Lighter and more explicit than Sentry/Datadog for Fastify teams that want route spans plus trace-log-error correlation without global HTTP patching, logger monkey-patching, payload capture, header capture, or query capture.
- Safer defaults: malformed `traceparent` is ignored non-fatally, and the trace context contains only normalized W3C IDs plus sampled state.
- Fastify lifecycle ownership stays with the app. The plugin uses framework hooks and app-owned clients/transports instead of replacing the logging pipeline.

## Where LogBrew Is Still Worse

- No automatic Pino trace injection yet, which matters because Fastify users commonly use structured logging.
- No OpenTelemetry context manager interop yet; LogBrew continues W3C headers but does not read/write an existing OTel active span.
- NestJS and Next.js still need this active-trace/error-correlation pattern.
- Source-map/native symbolication and backend-owned setup/usage/quota contracts remain broader product gaps.

## Updated Proof

- `npm --prefix js/logbrew-fastify test`
- `python3 scripts/check_js_sources.py js/logbrew-fastify`
- `bash scripts/real_user_fastify_smoke.sh` with `fastify@5.8.5`

The installed-artifact Fastify smoke packages local `@logbrew/sdk` and `@logbrew/fastify`, installs them into a temporary app, verifies ESM/CJS exports, type-checks trace-aware plugin callbacks, proves async active-trace preservation through Fastify route handling, verifies request span continuation from W3C `traceparent`, and checks default error metadata correlation without raw propagation leakage.
