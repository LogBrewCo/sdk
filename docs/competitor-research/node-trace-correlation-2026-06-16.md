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

## 2026-06-25 Rich Span Events Follow-Up

Refreshed source reads:

- Sentry JavaScript `getsentry/sentry-javascript@83fd9601d266897deb43c6ca1756f77533509dc8`: `packages/core/src/types/span.ts` (`Span.addEvent`, `addLink`, `addLinks`, `recordException`), `packages/core/src/tracing/sentrySpan.ts` (`SentrySpan.addEvent`, link storage, span JSON/streamed JSON conversion), `packages/core/src/utils/spanUtils.ts` (`convertSpanLinksForEnvelope`, `spanToJSON`, OpenTelemetry SDK span handling), `packages/core/src/types/link.ts` (`SpanLink`), and `packages/node/src/integrations/tracing/postgres/{vendored/instrumentation.ts,vendored/utils.ts}` (`query` wrapping, `handleConfigQuery`, DB attributes, error status/end behavior).
- OpenTelemetry JS `open-telemetry/opentelemetry-js@53337962f2506e2422196b532cb058a533f0b5e3`: `api/src/trace/span.ts` (`addEvent`, `addLink`, `addLinks`, `recordException`), `api/src/trace/link.ts` (`Link`), and `api/src/trace/SpanOptions.ts` (`links` at span creation).

Competitor pattern: mature JS tracing models spans as recording objects with attributes, events, links, status, exception hooks, and many automatic driver/framework integrations. Sentry's Postgres integration wraps driver calls and ends spans on callback/promise completion; OpenTelemetry's API treats events and links as first-class trace data. The tradeoff is much larger patching/exporter surface and higher privacy risk if raw SQL, headers, payloads, or exception text is captured.

LogBrew now ships the safer subset in JavaScript/Node:

- Core `@logbrew/sdk` `SpanAttributes` accepts optional `events: SpanEventSummary[]`, capped at eight entries, with non-empty event names, optional timestamp validation, and primitive-only event metadata.
- `spanAttributesFromTraceparent(...)` preserves the same safe span events for W3C-derived spans.
- `@logbrew/node` fetch/database/cache/queue helpers accept optional app-supplied event summaries and add a type-only `exception` event on failed dependency operations.
- The helper-generated exception event includes only `exceptionType` and `exceptionEscaped`; it does not include exception messages, stacks, SQL, cache keys, message bodies, headers, raw propagation data, full URLs, query strings, baggage, or tracestate.

Evidence:

- TDD red: `npm test --prefix js/logbrew-js` failed because span events were dropped, oversized event lists were accepted, and traceparent-derived spans lost events.
- TDD red installed proof: `scripts/real_user_node_smoke.sh` reached the generated app and failed before Node helpers emitted dependency exception events.
- Green proof: `npm test --prefix js/logbrew-js`, `npm test --prefix js/logbrew-node`, and `NPM_CONFIG_CACHE=/private/tmp/logbrew-node-npm-cache bash scripts/real_user_node_smoke.sh` passed with Node `v22.18.0`.

Remaining Node rich-trace gaps after events: Sentry/Datadog/OpenTelemetry remain stronger for automatic driver/framework instrumentation, span links, baggage/tracestate, full OpenTelemetry exporter/processor interop, richer semantic conventions, phase timing, response-size heuristics, and optional deep auto-instrumentation packages.

## 2026-06-25 Span Links Follow-Up

Refreshed source reads:

- Sentry JavaScript `getsentry/sentry-javascript@a5957d9960765da8b7686df1a802319cc25a1826`: `packages/core/src/types/span.ts` (`Span.addLink`, `Span.addLinks`, creation-context `links`), `packages/core/src/types/link.ts` (`SpanLink`, `SpanLinkJSON`), `packages/core/src/tracing/sentrySpan.ts` (`_links`, `addLink`, `addLinks`, JSON/stream conversion), and `packages/core/src/utils/spanUtils.ts` (`convertSpanLinksForEnvelope`, `getStreamedSpanLinks`).
- OpenTelemetry JS `open-telemetry/opentelemetry-js@53337962f2506e2422196b532cb058a533f0b5e3`: `api/src/trace/link.ts` (`Link`), `api/src/trace/SpanOptions.ts` (`links` at span creation), and `api/src/trace/span.ts` (`addLink`, `addLinks`). The OTel API documents links for batch processing and untrusted public endpoint context where parent-child is not the right model.

Competitor pattern: Sentry and OpenTelemetry treat links as first-class span relationships, preferably supplied at span creation so sampling/exporters can see them. Sentry flattens link context into envelope/stream JSON. OTel keeps a `SpanContext` plus attributes and supports dropped-attribute accounting. This is powerful for fan-out, batch, queue, and cross-trace debugging, but it also expands the shape that SDKs may serialize.

LogBrew now ships the lighter safe subset:

- Core `@logbrew/sdk` `SpanAttributes` accepts optional `links: SpanLinkSummary[]`, capped at eight entries.
- Each link requires valid non-zero W3C-shaped `traceId` and `spanId`, optional `sampled`, and optional primitive-only metadata.
- `spanAttributesFromTraceparent(...)` preserves the same sanitized links for W3C-derived spans.
- `@logbrew/node` fetch/database/cache/queue helpers pass app-supplied links through core validation so users can explain fan-out, retry, batch, and queue relationships from installed packages.
- LogBrew still does not copy Sentry/OTel baggage, tracestate, arbitrary attributes, raw propagation headers, payloads, SQL, headers, stack traces, automatic link inference, exporter/processor behavior, or dropped-attribute accounting.

Evidence:

- TDD red: `npm test --prefix js/logbrew-js` failed because links were dropped, oversized link lists were accepted, and traceparent-derived spans lost links.
- TDD red: `python3 -m unittest tests.test_validate_fixtures` failed because public fixtures rejected the new `links` field before validating it.
- Green proof: `npm test --prefix js/logbrew-js`, `python3 -m unittest tests.test_validate_fixtures`, `npm test --prefix js/logbrew-node`, and `NPM_CONFIG_CACHE=/private/tmp/logbrew-node-npm-cache bash scripts/real_user_node_smoke.sh` passed with Node `v22.18.0`.

Remaining Node rich-trace gaps: Sentry/Datadog/OpenTelemetry remain stronger for automatic driver/framework instrumentation, automatic or SDK-generated links, baggage/tracestate, full OTel exporter/processor interop, richer semantic conventions, phase timing, response-size heuristics, and optional deep auto-instrumentation packages.

## 2026-06-28 Pino/Winston Trace Correlation Follow-Up

Refreshed source reads:

- Sentry JavaScript `getsentry/sentry-javascript@54e995da76381f18f61f39b0ceecadf5a0b06b11`: `packages/node-core/src/integrations/pino.ts` (`pinoIntegration`, `trackLogger`, `untrackLogger`, diagnostics-channel capture), `packages/node-core/src/integrations/winston.ts` (`createSentryWinstonTransport`), and node integration-test subjects for Pino/Winston logger capture.
- OpenTelemetry JS contrib `open-telemetry/opentelemetry-js-contrib@eb98ccc85069304a1f0c2e6b33be1b2ca961b4be`: `packages/instrumentation-pino/src/instrumentation.ts` (`_getMixinFunction`, `_callHook`) and `packages/instrumentation-winston/src/instrumentation.ts` (`_handleLogCorrelation`, `_getPatchedWrite`, `_getPatchedLog`).
- Datadog dd-trace-js `DataDog/dd-trace-js@27dcc31908d9a6264b1536a2118534c8bc4da0f6`: `packages/datadog-plugin-pino/src/index.js`, `packages/datadog-plugin-winston/src/index.js`, `packages/dd-trace/src/plugins/log_injection.js`, and plugin tests around active-span `trace_id`/`span_id` injection.

Competitor pattern: Sentry treats Pino/Winston as first-class log integrations; OpenTelemetry and Datadog inject active trace/span fields into common logger records only when a valid active context exists, and avoid propagating hook failures into app logging. This is stronger for drop-in correlation, but it depends on automatic module patching, diagnostics channels, global tracer context, or proxy mutation paths.

LogBrew now ships the lighter opt-in subset in `@logbrew/sdk`:

- `createLogBrewPinoDestination(...)` and `createLogBrewWinstonTransport(...)` accept `traceProvider`, intended to be wired to `getActiveLogBrewTrace` from `@logbrew/node` or framework helpers.
- The provider is called per log record; valid W3C-shaped `traceId` and `spanId` are copied into log metadata with optional `parentSpanId` and `sampled`.
- Invalid, absent, or throwing providers do not break application logging; provider errors go through the existing adapter `onError` path.
- The adapters still avoid global logger patching, raw `traceparent`, baggage, tracestate, request/header/body/query capture, arbitrary active-context serialization, and stack text unless already explicitly enabled.

Evidence:

- TDD red: `npm test --prefix js/logbrew-js` failed because Pino/Winston log helpers preserved caller metadata but did not add active trace metadata.
- Green proof: `npm test --prefix js/logbrew-js`, `python3 scripts/check_js_sources.py js/logbrew-js`, `bash scripts/check_js_lint.sh`, `bash scripts/check_js_package.sh`, and `NPM_CONFIG_CACHE=/private/tmp/logbrew-js-npm-cache PNPM_STORE_DIR=/private/tmp/logbrew-js-pnpm-store bash scripts/real_user_js_smoke.sh` passed.

Remaining logger gap: Sentry/Datadog/OpenTelemetry are still stronger for hidden automatic logger patching, log shipping, custom logger version matrices, and existing OpenTelemetry context-manager interop. LogBrew's current advantage is a small app-owned adapter path that gives real Pino/Winston users trace-linked logs without mutating logger globals or broadening privacy capture.
