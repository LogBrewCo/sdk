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

## 2026-07-03 Reversible Global Fetch Follow-Up

Fresh source reads for the next rich-trace gap:

- Sentry JavaScript `getsentry/sentry-javascript@cf895c95995a6dff121484eadfa3a82980646f91`: read `packages/core/src/fetch.ts` (`instrumentFetchRequest(...)`, shallow option cloning, trace header attachment, span end hooks), `packages/node-core/src/integrations/node-fetch/undici-instrumentation.ts` (`instrumentUndici(...)`, diagnostics-channel subscription lifecycle, propagation decision cache), and `packages/node-core/src/utils/outgoingFetchRequest.ts` (`instrumentOutgoingFetchRequest(...)`, target-gated propagation).
- OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@2353bd7fbb75ae682c8dde42f32caa10a82bc315`: read `packages/instrumentation-undici/src/undici.ts` (`UndiciInstrumentation.enable/disable`, `onRequestCreated`, `onRequestHeaders`, `onResponseHeaders`, `onDone`, `onError`, propagation injection, HTTP duration metric recording).
- Datadog JavaScript `DataDog/dd-trace-js@80c5d963ec7ff5d20c7fc2d662deff463fd47843`: read `packages/datadog-plugin-undici/src/index.js` (`UndiciPlugin`, native diagnostic-channel handlers, fallback `bindStart`, header normalization, request filtering and propagation).
- PostHog JavaScript `PostHog/posthog-js@cc01eea218219b1f36145143c62586c66c459e84`: read `packages/node/src/client.ts` (`fetch(...)`, `captureException(...)`, `captureExceptionImmediate(...)`) and `packages/ai/src/otel/processor.ts` (`PostHogSpanProcessor`, blank project-key no-op, AI-span filtering before export). PostHog has a narrower fetch seam and AI/exception instrumentation, not broad Node HTTP client auto-instrumentation.

Competitor pattern: Sentry, OpenTelemetry, and Datadog win on automatic or instrumentation-owned fetch/Undici coverage. They create spans at request creation, inject propagation, record status/error and some timing, and can hook all Undici traffic through diagnostics channels. The tradeoff is wider runtime ownership, duplicate-instrumentation risk, optional header capture, more semantic data, and vendor/runtime coupling.

LogBrew now ships the safer subset in `@logbrew/node`: `installLogBrewFetchInstrumentation(...)` wraps only the fetch function the app opts into (`globalThis.fetch` by default or another app-supplied `globalObject.fetch`), captures only URLs matching `tracePropagationTargets` or `captureTargets`, writes one normalized W3C `traceparent`, records the same privacy-bounded `node:fetch` spans as `fetchWithLogBrewSpan(...)`, and puts the original function back through `uninstall()` only when LogBrew still owns that fetch slot. It drops unsafe wrapper metadata keys such as bodies, payloads, headers, URLs, query text, cookies, auth values, raw `traceparent`, and exception messages.

Evidence:

- RED: a packed temp app importing `installLogBrewFetchInstrumentation` from `@logbrew/node` failed with `SyntaxError: The requested module '@logbrew/node' does not provide an export named 'installLogBrewFetchInstrumentation'`.
- GREEN: `bash scripts/real_user_node_smoke.sh` now packs `@logbrew/sdk` and `@logbrew/node`, installs them into a disposable npm app, proves ESM/CJS/TypeScript surfaces, target-scoped global fetch propagation, unmatched pass-through, caller-header immutability, failure span exception-type-only capture, unsafe metadata/query/error-message dropping, and uninstall restoration.

Honest comparison: LogBrew is still worse than Sentry/Datadog/OpenTelemetry for zero-code all-Undici diagnostics-channel coverage, automatic phase timing, HTTP duration metrics, broad semantic conventions, baggage/tracestate, and automatic framework/client instrumentation. LogBrew is better for teams that want a small opt-in global fetch bridge with exact target scope, reversible teardown, installed-artifact proof, and safer defaults.

## 2026-07-03 App-Owned Timing Follow-Up

Fresh source reads for the next rich-trace timing gap:

- Sentry JavaScript `getsentry/sentry-javascript@cf895c95995a6dff121484eadfa3a82980646f91`: re-read `packages/node-core/src/integrations/node-fetch/undici-instrumentation.ts` (`instrumentUndici(...)`, `onRequestCreated`, `onRequestHeaders`, `onResponseHeaders`, `onDone`, `onError`) and `packages/core/src/fetch.ts` (`endSpan(...)`, response content-length handling).
- OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@2353bd7fbb75ae682c8dde42f32caa10a82bc315`: re-read `packages/instrumentation-undici/src/undici.ts` (`onRequestCreated`, `onRequestHeaders`, `onResponseHeaders`, `onDone`, `onError`, `recordRequestDuration(...)`) and `packages/instrumentation-undici/src/types.ts` (`requestHook`, `responseHook`, `startSpanHook`, `headersToSpanAttributes`).
- Datadog JavaScript `DataDog/dd-trace-js@80c5d963ec7ff5d20c7fc2d662deff463fd47843`: re-read `packages/datadog-plugin-undici/src/index.js` (`#onNativeRequestCreate`, `#onNativeRequestHeaders`, `#onNativeRequestTrailers`, `#onNativeRequestError`, `addConfiguredHeaders`, `normalizeHeaders`) and `packages/datadog-plugin-http/test/client.spec.js` semantic HTTP assertions.
- PostHog JavaScript `PostHog/posthog-js@cc01eea218219b1f36145143c62586c66c459e84`: re-read `packages/node/src/client.ts` fetch seam and exception capture paths; still no comparable broad Node HTTP client tracing source path found.

Competitor pattern: Sentry, OpenTelemetry, and Datadog use instrumentation-owned lifecycle hooks to add response status, network peer attributes, optional header-derived attributes, exception status, and request-duration metrics. This is strong for time-to-answer and low setup, but it expands runtime ownership and can expose broader metadata if users enable header capture.

LogBrew now adds the lighter timing subset to `fetchWithLogBrewSpan(...)` and `installLogBrewFetchInstrumentation(...)`: apps may pass a `timings` object or function with only finite non-negative numeric phase durations/content sizes. The timing function receives emitted method, route-template path, duration, response/error, and trace context, not full URLs or request headers. LogBrew records safe keys such as `http.phase.name_lookup_ms`, `http.phase.connect_ms`, `http.phase.tls_ms`, `http.phase.wait_ms`, `http.phase.response_ms`, `http.request_content_length`, and `http.response_content_length`; invalid values and unknown keys are dropped.

Evidence:

- RED: packed temp app smoke failed because `fetchWithLogBrewSpan(...)` and global fetch instrumentation did not emit timing metadata from installed artifacts.
- GREEN: `bash scripts/real_user_node_smoke.sh` on Node `v22.18.0` now proves app-owned timing metadata for explicit fetch and reversible global fetch, TypeScript declarations for timing objects/functions, invalid value dropping, unknown-key dropping, route-template-only timing context, failure-span timing, and existing no-query/no-unsafe-content guards.

Honest comparison: LogBrew remains worse than Sentry/Datadog/OpenTelemetry for automatic all-Undici timing and HTTP duration metrics. LogBrew is better for privacy-bounded apps that want explicit timing context without hidden global diagnostics-channel subscriptions or header/body/full-URL capture.
