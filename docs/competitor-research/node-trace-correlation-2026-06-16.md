# Node Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority. Tested the Node.js gap where apps already have request spans, but user logs and handler errors still need a low-friction way to correlate with the active request trace without globally patching HTTP clients or application loggers.

## Current Competitor Signals

- Sentry Node tracing docs: <https://docs.sentry.io/platforms/javascript/guides/node/tracing/>. Sentry positions tracing as automatic performance tracking across services and explicitly notes that logs emitted during a trace are linked for diagnostic context.
- OpenTelemetry JavaScript context docs: <https://opentelemetry.io/docs/languages/js/context/> and propagation docs: <https://opentelemetry.io/docs/languages/js/propagation/>. The ecosystem expectation is active context propagation so child spans/logs can attach to the request trace across asynchronous execution.
- Node.js `AsyncLocalStorage` docs: <https://nodejs.org/api/async_context.html>. Node's built-in async context storage is stable and intended for request-lifetime state across callbacks and promise chains.
- Datadog Node log/trace correlation docs: <https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/nodejs/>. Datadog's mature path injects trace/span IDs into structured logs for common loggers, which confirms user value but relies on tracer/logger integration.

## LogBrew Improvement From This Pass

- `@logbrew/node` now creates a request-local trace context when an incoming W3C `traceparent` is valid.
- The wrapped handler receives `logbrew.trace` with normalized `traceId`, generated request `spanId`, upstream `parentSpanId`, and sampled state.
- `getActiveLogBrewTrace()` exposes the same context from asynchronous work started by the wrapped handler using Node's built-in `AsyncLocalStorage`.
- Default handler-error capture now adds trace/span correlation metadata when a request trace exists; `errorEvent`, `onFlush`, `onCaptureError`, `onError`, and custom `requestEvent` callbacks also receive the trace context.
- The default request span reuses the same request-local span ID, so request spans, app logs, metrics metadata, product actions, network milestones, and errors can point at the same operation.
- The public docs and first-useful example now use `logbrew.trace` instead of asking users to parse `traceparent` manually.

## Where LogBrew Is Better Today

- Lighter and more explicit than Sentry/Datadog for apps that want trace-log-error correlation without automatic logger patching, HTTP monkey-patching, payload capture, or arbitrary header capture.
- Privacy defaults remain strict: the trace context contains only normalized W3C IDs and sampled state, never raw `traceparent`, request bodies, response bodies, headers, query strings, or raw URLs.
- The API is app-owned: users choose where to add `traceId`/`spanId` to logs, product actions, metrics, and downstream milestones.

## Where LogBrew Is Still Worse

- No automatic Pino/Winston/Bunyan trace ID injection yet, while Datadog and Sentry-style ecosystems can do more automatically.
- No OpenTelemetry context manager interop yet; LogBrew continues W3C request headers but does not read/write an existing OTel active span.
- Framework wrappers such as Express, Fastify, NestJS, and Next.js should get the same active trace/error correlation pattern so users do not need to drop to `@logbrew/node`.
- Source-map/native symbolication and backend-owned setup/usage/quota contracts remain broader product gaps.

## Updated Proof

- `npm --prefix js/logbrew-node test`
- `python3 scripts/check_js_sources.py js/logbrew-node`
- `bash scripts/check_js_lint.sh`
- `bash scripts/check_js_package.sh`
- `bash scripts/real_user_node_smoke.sh` with Node `v22.18.0`

The installed-artifact Node smoke packages local `@logbrew/sdk` and `@logbrew/node`, installs them into a temporary app, verifies ESM/CJS exports, type-checks the new trace types, runs the packaged first-useful and real-user examples, proves request span continuation from W3C `traceparent`, verifies async `getActiveLogBrewTrace()` preservation, and checks handler-error metadata correlation.
