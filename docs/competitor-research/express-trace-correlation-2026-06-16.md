# Express Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority and the Node active-trace slice. This pass targets the Express wrapper gap: request spans existed, but app code and error middleware did not get a request-local trace context that could correlate logs, product actions, metrics, and handler errors without dropping down to `@logbrew/node`.

## Current Competitor Signals

- Sentry Express tracing docs: <https://docs.sentry.io/platforms/javascript/guides/express/tracing/> and distributed tracing docs: <https://docs.sentry.io/platforms/javascript/guides/express/tracing/distributed-tracing/>. Sentry positions tracing as automatic request performance visibility across services.
- Sentry Express v7-to-v8 migration docs: <https://docs.sentry.io/platforms/javascript/guides/express/migration/v7-to-v8/>. Sentry's current Express path leans on Node/OpenTelemetry-style instrumentation, which confirms that Express users expect framework spans, trace continuation, and error correlation.
- OpenTelemetry JavaScript context and propagation docs: <https://opentelemetry.io/docs/languages/js/context/> and <https://opentelemetry.io/docs/languages/js/propagation/>. The baseline expectation is async context continuity plus W3C propagation between services.
- Express 5 error handling docs: <https://expressjs.com/en/guide/error-handling/>. Rejected promises are forwarded to error handlers, so useful Express tracing must preserve request context through async handlers and into error middleware.
- Datadog Node log/trace correlation docs: <https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/nodejs/>. Datadog proves user demand for trace/span IDs on structured logs, but its mature path relies on tracer/logger integration.

## LogBrew Improvement From This Pass

- `@logbrew/express` now attaches `req.logbrew.trace` when an incoming W3C `traceparent` is valid.
- `getActiveLogBrewTrace()` exposes the same trace context from async work started inside the Express middleware through Node's built-in `AsyncLocalStorage`.
- The default request span reuses the request-local child span ID instead of creating a separate ID from the event builder.
- Custom `requestEvent`, `requestMetricEvent`, `onFlush`, `onCaptureError`, and `onError` callbacks receive the active trace context.
- Default error capture now adds `traceId`, `spanId`, `parentSpanId`, and `sampled` metadata when the failing request passed through LogBrew middleware with a valid trace.
- Public docs show app-owned log correlation through `req.logbrew.trace` or `getActiveLogBrewTrace()` without including undefined metadata fields or raw propagation headers.

## Where LogBrew Is Better Today

- Lighter and more explicit than Sentry/Datadog for teams that want framework request spans and trace-log-error correlation without global HTTP patching, logger monkey-patching, request payload capture, header capture, or raw URL/query capture.
- Safer defaults: malformed `traceparent` is ignored non-fatally, and the public trace context contains only normalized IDs plus sampled state.
- App-owned logging remains flexible; users can add `traceId` and `spanId` to their chosen logger or product action metadata without handing LogBrew control of the logging pipeline.

## Where LogBrew Is Still Worse

- No automatic Pino/Winston/Bunyan trace injection yet; Datadog and Sentry ecosystems can correlate more automatically for common loggers.
- No OpenTelemetry context manager interop yet; Express continues W3C headers but does not read or write an existing OTel active span.
- Fastify, NestJS, and Next.js still need this same active-trace/error-correlation pattern.
- Source-map/native symbolication and backend-owned setup/usage/quota contracts remain broader product gaps.

## Updated Proof

- `npm --prefix js/logbrew-express test`
- `python3 scripts/check_js_sources.py js/logbrew-express`
- `bash scripts/real_user_express_smoke.sh` with `express@5.2.1` and `@types/express@5.0.6`

The installed-artifact Express smoke packages local `@logbrew/sdk` and `@logbrew/express`, installs them into a temporary app, verifies ESM/CJS exports, type-checks trace-aware middleware callbacks, proves async active-trace preservation, verifies request span continuation from W3C `traceparent`, and checks default error metadata correlation without raw propagation leakage.
