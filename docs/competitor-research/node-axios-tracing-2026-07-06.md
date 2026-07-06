# Node Axios Tracing Competitor Review - 2026-07-06

This note records the source-backed design decision for LogBrew's Node Axios outbound tracing helpers.

## Sources Checked

- Sentry JavaScript public repo `getsentry/sentry-javascript@9d53b0cd8ccd894d7ce24530cb1b289f2607eb97`
- Sentry paths read:
  - `packages/node/src/integrations/http.ts`
  - `packages/node-core/src/integrations/http/SentryHttpInstrumentation.ts`
  - `packages/core/src/integrations/http/inject-trace-propagation-headers.ts`
  - `packages/core/src/integrations/http/get-outgoing-span-data.ts`
  - `packages/core/src/integrations/http/client-subscriptions.ts`
  - `packages/core/src/integrations/http/client-patch.ts`
- Sentry functions/classes read: `httpIntegration`, `SentryHttpInstrumentation`, `instrumentSentryHttp`, `instrumentSentryNodeHttp`, `injectTracePropagationHeaders`, `getOutgoingSpanData`, `addChildSpanToSpan`, and `clientRequestHook`.
- Datadog JS public repo `DataDog/dd-trace-js@02cb1a1fc744c4589385d91c674a6c5720a5d747`
- Datadog paths read:
  - `packages/datadog-plugin-axios/test/integration-test/client.spec.js`
  - `packages/datadog-plugin-axios/test/integration-test/server.mjs`
  - `packages/datadog-plugin-axios/test/suite.js`
  - `packages/datadog-plugin-http/src/client.js`
  - `packages/datadog-instrumentations/src/http/client.js`
  - `packages/datadog-plugin-http/test/client.spec.js`
- Datadog functions/classes read: `HttpPlugin`, `makeClientTrace`, `requestStart`, `requestFinish`, `requestError`, `requestInject`, `web.addTraceData`, and Axios integration test flows that import `dd-trace/init.js` before `axios`.
- OpenTelemetry JS Contrib public repo `open-telemetry/opentelemetry-js-contrib@07607d0adab59f87c0e517075fa1fbd41c18f99e`
- OpenTelemetry source check:
  - No dedicated Axios instrumentation package was found in this tree.
  - Comparable outbound source read: `packages/instrumentation-undici/src/undici.ts`, `packages/instrumentation-undici/src/types.ts`, and `packages/instrumentation-undici/test/undici.test.ts`.
- PostHog Node public repo `PostHog/posthog-node@fe534177f0257f1f8400bf8189d9bdd6c3e20aea` and current `posthog-js@2af002652afd87401e299a18295da08443753e89`
- PostHog source check: no comparable outbound Axios or general Node HTTP tracing integration was found in the checked Node package source; the current repository focuses on product events, feature flags, and error-tracking helpers.

## Competitor Pattern

Sentry and Datadog are stronger for automatic Axios coverage because Axios normally rides Node HTTP adapters. Sentry patches/subscribes to Node HTTP behavior, injects trace propagation headers for matching targets, starts outbound spans, and records response/error details. Datadog has Axios integration tests but the real coverage comes from its HTTP client instrumentation, which clones headers before injection, tracks request lifecycle, records status/error, and supports filters and hooks.

Those approaches give broad hidden coverage, but they are heavier and more global than LogBrew's preferred SDK surface. They also can expose richer URL, peer, header, or error detail unless users configure filtering correctly. OpenTelemetry's checked source shows the same diagnostic-channel pattern for Undici, but no dedicated Axios package in this tree. PostHog did not show comparable outbound tracing.

## LogBrew Design

LogBrew now exposes two explicit Axios helpers in `@logbrew/node`:

- `instrumentLogBrewAxiosInstance(axiosInstance, options)` installs Axios request/response interceptors on the app-owned instance and returns `uninstall()` / `isInstalled()`.
- `axiosRequestWithLogBrewSpan(axiosInstance, config, options)` wraps one app-owned request.

Both paths create child spans from the active or supplied LogBrew trace, inject exactly one normalized W3C `traceparent`, and capture one `framework: "node:axios"` span with method, query-free route/path, status, duration, sampled flag, and trace IDs. The implementation deliberately avoids installing Axios, patching all Node HTTP clients, serializing arbitrary headers, keeping query strings/fragments, capturing request/response bodies, storing raw `traceparent`, inferring baggage/tracestate, and including exception messages or stacks.

## Where LogBrew Is Better

LogBrew is safer and easier to reason about for teams that prefer explicit, reversible instrumentation on the Axios instance they own. The installed-artifact proof checks real `axios@1.18.1`, TypeScript declarations with `AxiosInstance`, uninstall behavior, traceparent child-span ID matching, status/error spans, high-load queue backpressure, local fake-intake flush, and privacy omissions.

## Where LogBrew Is Worse

Sentry and Datadog still lead on automatic Node HTTP adapter coverage, out-of-the-box Axios capture without app code changes, hosted trace UI, richer peer/network metadata, hooks, filters, and mature grouping/source-context workflows. LogBrew's current Axios helper is intentionally explicit and privacy-bounded, so users must install it on each Axios instance or wrap selected calls.

## Verification

- RED: `bash scripts/real_user_node_axios_smoke.sh` failed because packed `@logbrew/node` did not export `axiosRequestWithLogBrewSpan`.
- GREEN: `bash scripts/real_user_node_axios_smoke.sh` passed with packed local `@logbrew/sdk`, packed local `@logbrew/node`, `axios@1.18.1`, `typescript@5.9.3`, and `@types/node@24.10.1`.
- The smoke proves install, uninstall, reinstall, ESM import, CommonJS require, TypeScript API compatibility, success span, 503 error span, direct helper span, interceptor uninstall, 30-request high-load queue pressure with 10 drops from a 20-event queue, local fake-intake flush, traceparent child-span ID matching, and no query/body/header/error-message/full-host/raw-propagation leakage.
