# Node Outbound Fetch Tracing - 2026-06-19

## Competitor Source Read

- Sentry JavaScript: `getsentry/sentry-javascript@cb69761890fb5988d2dc9d24ccae070ee956abeb`
- Read `packages/core/src/fetch.ts`: `instrumentFetchRequest(...)`, `_INTERNAL_getTracingHeadersForFetchRequest(...)`, `endSpan(...)`, `getSpanStartOptions(...)`, and `getFetchSpanAttributes(...)`.
- Pattern: Sentry creates a fetch span around instrumented requests, shallow-clones caller options before adding propagation headers, records status/error on completion, and can merge Sentry trace/baggage headers without mutating user input.

- OpenTelemetry JS contrib: `open-telemetry/opentelemetry-js-contrib@f3d14c0a2996acbe5bce4bf83d36142640a413a0`
- Read `packages/instrumentation-undici/src/undici.ts`: `UndiciInstrumentation`, `enable()`, `onRequestCreated(...)`, `onRequestHeaders(...)`, `onResponseHeaders(...)`, `onDone(...)`, `onError(...)`, and `recordRequestDuration(...)`.
- Pattern: OpenTelemetry subscribes to Undici diagnostic channels, creates `CLIENT` spans, injects propagation after hooks, records response/error status, and records HTTP client duration metrics.

- 2026-06-25 refresh: Sentry JavaScript `getsentry/sentry-javascript@3bfeb64e312fbafbd6fea4b2aafdb73ea94febec`.
- Read `packages/core/src/integrations/http/get-outgoing-span-data.ts`: `getOutgoingRequestSpanData(...)` and `setIncomingResponseSpanData(...)` set HTTP request method/target/host details and response status attributes while keeping span naming low-cardinality.
- 2026-06-25 refresh: OpenTelemetry JS contrib `open-telemetry/opentelemetry-js-contrib@166db7bc8e8e810596ef5e87e69506aca58c6039` and OpenTelemetry JS `open-telemetry/opentelemetry-js@53337962f2506e2422196b532cb058a533f0b5e3`.
- Read `packages/instrumentation-undici/src/undici.ts`: request creation builds HTTP semantic attributes such as `http.request.method`, `url.path`, and response status; `semantic-conventions/src/stable_attributes.ts` defines stable keys including `http.request.method`, `http.response.status_code`, `http.route`, and `url.path`.

- Datadog dd-trace-js: `DataDog/dd-trace-js@655a49f1d68d1c79eb1c8a68d1628785107647dc`
- Read `packages/datadog-instrumentations/src/helpers/fetch.js`, `packages/datadog-instrumentations/src/fetch.js`, and `packages/datadog-instrumentations/src/undici.js`: `createWrapFetch(...)`, global fetch wrapping, and Undici wrapping/native diagnostics decisions.
- Pattern: Datadog wins drop-in coverage by wrapping global `fetch`/Undici and routing calls through tracing channels, but that is broader than LogBrew's default privacy and app-owned instrumentation boundary.

## LogBrew Design

LogBrew now ships `fetchWithLogBrewSpan(...)` in `@logbrew/node`.

- It wraps one app-owned `fetch` call instead of globally patching `fetch` or Undici.
- It clones caller headers, overwrites any caller-supplied `traceparent` with exactly one normalized W3C child traceparent, and does not mutate the caller's `init`.
- It queues one outbound client span with method, route template or query-free path, status code, duration, sampled flag, and W3C trace IDs.
- It also emits a safe portable semantic subset: `http.request.method`, `http.response.status_code`, `http.route`, and `url.path`, using the provided route template or query-free path instead of full URLs.
- It scopes the fetch promise under the child trace so async work inside the fetch implementation sees the child context.
- It avoids payload capture, arbitrary header capture, raw propagation serialization, baggage, tracestate, full URLs, query strings, and fragments.
- It reports telemetry capture failures through `onCaptureError` without hiding or replacing the original fetch response/error.

## Why This Is Better For LogBrew Users

Sentry, Datadog, and OpenTelemetry are stronger for hidden automatic coverage. LogBrew is now stronger for a dependency-light server path where developers can point to the important downstream call, verify exactly one span from an installed package, and keep privacy boundaries obvious.

## Evidence

- TDD red: installed package import failed with `SyntaxError: The requested module '@logbrew/node' does not provide an export named 'fetchWithLogBrewSpan'`.
- Green installed proof: `bash scripts/real_user_node_smoke.sh` on Node `v22.18.0`.
- 2026-06-25 green installed proof: `bash scripts/real_user_node_smoke.sh` on Node `v22.18.0` now verifies the HTTP semantic metadata aliases from the packed package.
- Package checks: `npm test` in `js/logbrew-node`, `python3 scripts/check_js_sources.py js/logbrew-node`, `bash scripts/check_js_lint.sh`, and `bash scripts/check_js_package.sh` passed.

## Remaining Gaps

- Node still lacks optional framework-owned automatic Undici/global fetch instrumentation for teams that explicitly want it.
- Server SDKs outside Node still need deeper outbound HTTP, DB, cache, and queue spans.
- LogBrew still avoids baggage/tracestate, response-body capture, and phase-timing streams. Bounded span events and span links now exist for explicit milestones, exception type summaries, and app-owned fan-out/batch relationships, not automatic full OpenTelemetry/Sentry event/link streams.
