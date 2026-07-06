# Node HTTP Client Tracing Competitor Review - 2026-07-06

This note records the source-backed design decision for LogBrew's Node `http` / `https` client instrumentation.

## Sources Checked

- Sentry JavaScript public repo `getsentry/sentry-javascript@9d53b0cd8ccd894d7ce24530cb1b289f2607eb97`
- Sentry paths read:
  - `packages/node/src/integrations/http.ts`
  - `packages/node-core/src/integrations/http/SentryHttpInstrumentation.ts`
  - `packages/core/src/integrations/http/client-subscriptions.ts`
  - `packages/core/src/integrations/http/client-patch.ts`
- Sentry functions/classes read: `httpIntegration`, `instrumentSentryHttp`, `SentryHttpInstrumentation.init`, `getHttpClientSubscriptions`, `patchHttpModuleClient`, `outgoingRequestHook`, and `outgoingResponseHook`.
- Datadog JS public repo `DataDog/dd-trace-js@02cb1a1fc744c4589385d91c674a6c5720a5d747`
- Datadog paths read:
  - `packages/datadog-plugin-http/src/client.js`
  - `packages/datadog-instrumentations/src/http/client.js`
  - `packages/datadog-plugin-http/test/client.spec.js`
- Datadog functions/classes read: `HttpClientPlugin`, `bindStart`, `finish`, `error`, `shouldInjectTraceHeaders`, `combineOptions`, `normalizeHeaders`, `normalizeArgs`, `instrumentRequest`, and `setupResponseInstrumentation`.
- OpenTelemetry JS Contrib public repo `open-telemetry/opentelemetry-js-contrib@07607d0adab59f87c0e517075fa1fbd41c18f99e`
- OpenTelemetry source check: no dedicated Node core HTTP client instrumentation package was found in this checkout; the closest checked outbound pattern remains Undici diagnostic-channel instrumentation in `packages/instrumentation-undici/src/undici.ts`.
- PostHog JS public repo `PostHog/posthog-js@2af002652afd87401e299a18295da08443753e89`
- PostHog source check: `packages/node/src/client.ts` uses a configurable fetch seam for PostHog delivery and product APIs; no comparable Node core `http` / `https` client tracing integration was found.

## Competitor Pattern

Sentry and Datadog are stronger for broad Node HTTP coverage. Sentry instruments Node internal `http` and `https` modules, prefers diagnostics-channel support on newer Node versions, falls back to patching when needed, and injects trace headers plus outgoing request spans. Datadog hooks both `http` and `https`, normalizes call shapes, clones options/headers before propagation, tracks response/error lifecycle, records status, and supports URL filters, propagation filters, hooks, and optional request/response header tags.

The tradeoff is wider runtime ownership. These SDKs can see more requests with less user code, but they also own process-level module behavior and can expose richer URL, network address, header, error, or body details depending on configuration.

## LogBrew Design

LogBrew now exposes `installLogBrewHttpClientInstrumentation(...)` in `@logbrew/node`.

- Apps pass the exact `http` and/or `https` module objects they want LogBrew to wrap.
- LogBrew wraps `request()` and `get()` on those module objects only, returns `isInstalled()` / `uninstall()`, and puts the original functions back only if LogBrew still controls those function fields.
- Captured requests are target-scoped with the same string, regular expression, or predicate matcher style used by fetch and Axios helpers.
- For matching requests, LogBrew clones request options, writes one normalized W3C `traceparent`, records one `framework: "node:http"` or `framework: "node:https"` child span, and preserves the original request, response, and error behavior.

The implementation deliberately avoids patching modules that were not passed, silently installing default process-wide hooks, capturing request/response bodies, serializing arbitrary headers, keeping query strings/fragments, recording network addresses/socket details, storing raw `traceparent`, inferring baggage/tracestate, or including exception messages/stacks.

## Where LogBrew Is Better

LogBrew is safer for privacy-sensitive production services that want explicit module ownership, reversible teardown, target-gated propagation, caller-header immutability, installed-package proof, and type-only HTTP failure spans. It covers real `http.request(...)` and `http.get(...)` call shapes without adding dependencies.

## Where LogBrew Is Worse

Sentry and Datadog still lead on zero-code Node HTTP adapter breadth, diagnostics-channel lifecycle coverage, automatic support for more edge cases, richer peer/network metadata, hooks/filters, header configuration, metrics, and vendor trace UI. LogBrew requires users or framework packages to opt into module wrapping and configure targets.

## Verification

- RED: `bash scripts/real_user_node_http_client_smoke.sh` failed because packed `@logbrew/node` did not export `installLogBrewHttpClientInstrumentation`.
- GREEN: `bash scripts/real_user_node_http_client_smoke.sh` passed with packed local `@logbrew/sdk`, packed local `@logbrew/node`, `typescript@5.9.3`, and `@types/node@24.10.1`.
- The smoke proves install, uninstall, reinstall, ESM import, CommonJS require, TypeScript API compatibility, real local `http.request(...)`, real local `http.get(...)`, target pass-through, caller-header immutability, 200 and 503 spans, type-only `HttpStatusError` event, local fake-intake 503-to-202 retry/flush, traceparent child-span ID matching, 30-request high-load queue pressure with 10 drops from a 20-event queue, and no query/body/header/network-address/raw-propagation leakage.
