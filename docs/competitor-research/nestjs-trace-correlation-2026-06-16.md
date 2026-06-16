# NestJS Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority after Node, Express, and Fastify got request-local trace context. This pass targets the NestJS wrapper gap: request spans existed, but controllers, custom interceptor callbacks, and thrown-error capture did not get a request-local trace object that app code could use for log/error/product-action correlation.

## Current Competitor Signals

- Sentry NestJS setup docs: <https://docs.sentry.io/platforms/javascript/guides/nestjs/>. Sentry treats NestJS as a first-class JavaScript framework target for error capture plus tracing.
- Sentry NestJS tracing docs: <https://docs.sentry.io/platforms/javascript/guides/nestjs/tracing/>. Sentry positions request tracing as a core debugging path across services.
- NestJS interceptor docs: <https://docs.nestjs.com/interceptors>. Nest interceptors wrap request handling through RxJS, so useful request tracing must preserve context through the subscription path and into controller async work.
- OpenTelemetry JavaScript context and propagation docs: <https://opentelemetry.io/docs/languages/js/context/> and <https://opentelemetry.io/docs/languages/js/propagation/>. The baseline expectation is async context continuity plus W3C propagation between services.
- Datadog Node log/trace correlation docs: <https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/nodejs/>. Datadog confirms trace/span IDs on structured logs are useful, but its mature path relies on tracer/logger integration.

## LogBrew Improvement From This Pass

- `@logbrew/nestjs` now attaches `request.logbrew.trace` when an incoming W3C `traceparent` is valid.
- `getActiveLogBrewTrace()` exposes the same trace context inside asynchronous controller work by wrapping the NestJS/RxJS subscription with Node's built-in `AsyncLocalStorage`.
- The default request span reuses the request-local child span ID, so the request span, app-owned logs, custom callbacks, and errors can reference the same operation.
- Custom `requestEvent`, `requestMetricEvent`, `onFlush`, `onCaptureError`, and `errorEvent` callbacks receive the active trace context.
- Default error capture can add `traceId`, `spanId`, `parentSpanId`, and `sampled` metadata when the failing request has a valid trace context.
- Public docs show app-owned log correlation through `request.logbrew.trace` or `getActiveLogBrewTrace()` without raw propagation headers, request bodies, headers, query strings, or undefined metadata fields.

## Where LogBrew Is Better Today

- Lighter and more explicit than Sentry/Datadog for NestJS teams that want framework request spans plus trace-log-error correlation without global HTTP patching, logger monkey-patching, payload capture, header capture, or query capture.
- Safer defaults: malformed `traceparent` is ignored non-fatally, and the trace context contains only normalized W3C IDs plus sampled state.
- App-owned logging remains flexible. Controllers can attach `traceId` and `spanId` to their own logs or product actions without replacing Nest's logging or exception pipeline.

## Where LogBrew Is Still Worse

- No automatic Nest logger trace injection yet; Sentry/Datadog ecosystems can provide more automatic correlation for common logging paths.
- No OpenTelemetry context manager interop yet; LogBrew continues W3C headers but does not read/write an existing OTel active span.
- Next.js still needs the Node/Express/Fastify/NestJS active-trace/error-correlation pattern.
- Source-map/native symbolication and backend-owned setup/usage/quota contracts remain broader product gaps.

## Updated Proof

- `npm --prefix js/logbrew-nestjs test`
- `python3 scripts/check_js_sources.py js/logbrew-nestjs`
- `bash scripts/real_user_nestjs_smoke.sh` with `@nestjs/common@11.1.27`, `@nestjs/core@11.1.27`, and `@nestjs/platform-express@11.1.27`

The installed-artifact NestJS smoke packages local `@logbrew/sdk` and `@logbrew/nestjs`, installs them into a temporary app, verifies ESM/CJS exports, type-checks trace-aware interceptor callbacks, proves controller async active-trace preservation, verifies request span continuation from W3C `traceparent`, and checks error metadata correlation without raw propagation leakage.
