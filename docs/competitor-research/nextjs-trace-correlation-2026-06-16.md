# Next.js Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority after Node, Express, Fastify, and NestJS got request-local trace context. This pass targets the Next.js App Router gap: request spans existed, but Route Handler app code, custom callbacks, and thrown-error capture did not get an active trace object that could correlate app logs, product actions, request spans, and errors.

## Current Competitor Signals

- Sentry Next.js docs: <https://docs.sentry.io/platforms/javascript/guides/nextjs/>. Sentry positions Next.js setup around errors, logs, session replay, and tracing, with separate client/server/edge runtime initialization and request-error capture.
- Next.js Route Handler docs: <https://nextjs.org/docs/app/getting-started/route-handlers>. App Router Route Handlers use standard Web `Request` and `Response` APIs inside `app/route.js|ts`, so a useful wrapper must preserve those framework primitives instead of assuming Express-style request/response objects.
- OpenTelemetry JavaScript context docs: <https://opentelemetry.io/docs/languages/js/context/> and propagation docs: <https://opentelemetry.io/docs/languages/js/propagation/>. The baseline tracing expectation is active context continuity across async work plus W3C propagation across services.
- Datadog log/trace correlation docs: <https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/> and OpenTelemetry correlation docs: <https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/opentelemetry/>. Datadog confirms that trace and span IDs on logs are a core debugging workflow, but its mature path depends on tracer/logger integration.

## LogBrew Improvement From This Pass

- `@logbrew/next` now exposes `helpers.trace` when an incoming W3C `traceparent` is valid.
- `getActiveLogBrewTrace()` returns the same trace object inside asynchronous Route Handler work through Node's built-in `AsyncLocalStorage`.
- The default request span reuses the request-local child span ID, so the request span, app-owned logs, custom callbacks, and errors can reference the same operation.
- Custom `requestEvent`, `requestMetricEvent`, `onFlush`, `onCaptureError`, and `errorEvent` callbacks receive the active trace context.
- Default route error capture now adds `traceId`, `spanId`, `parentSpanId`, and `sampled` metadata when the failing request has a valid trace context.
- Public docs show app-owned log correlation through `helpers.trace` or `getActiveLogBrewTrace()` without raw propagation headers, request headers, request bodies, cookies, or query strings.

## Where LogBrew Is Better Today

- Lighter and more explicit than Sentry/Datadog for Route Handler teams that want W3C request spans plus trace-log-error correlation without global HTTP patching, logger monkey-patching, payload capture, header capture, cookie capture, or query capture.
- Safer defaults: malformed `traceparent` is ignored non-fatally, and the public trace helper contains only normalized IDs plus sampled state.
- App-owned logging remains flexible. Route code can attach `traceId` and `spanId` to its own logs or product actions without replacing the Next.js routing model or requiring a logger integration.

## Where LogBrew Is Still Worse

- No automatic Next.js server action, server component, or client/edge runtime tracing yet; Sentry's Next.js package is broader.
- No automatic logger trace injection yet; Datadog and Sentry ecosystems can correlate common structured loggers more automatically.
- No OpenTelemetry context manager interop yet; LogBrew continues W3C headers but does not read/write an existing OTel active span.
- Source-map/native symbolication and backend-owned setup/usage/quota contracts remain broader product gaps.
- Tracing gaps now move to Python, Go, Java, .NET, PHP, Ruby, mobile/native, and Rust OTel interop rather than only JavaScript framework wrappers.

## Updated Proof

- `npm --prefix js/logbrew-next test`
- `python3 scripts/check_js_sources.py js/logbrew-next`
- `bash scripts/real_user_next_smoke.sh` with `next@16.2.9`, `react@19.2.7`, and `react-dom@19.2.7`

The installed-artifact Next.js smoke packages local `@logbrew/sdk` and `@logbrew/next`, installs them into a temporary App Router app, verifies README/package contents, builds the app, verifies ESM/CJS exports, type-checks trace-aware Route Handler callbacks, proves async active-trace preservation, verifies app-log/request-span/error correlation from W3C `traceparent`, and checks that raw propagation and query text are not serialized by default.
