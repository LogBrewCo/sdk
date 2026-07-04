# React Browser Instrumentation Competitor Review - 2026-07-04

## Sources Checked

- Sentry JavaScript public repo `getsentry/sentry-javascript@68fe9e8fbcf70f1a92468410a1686787d4f724a6`
- Sentry source paths read: `packages/react/src/profiler.tsx`, `packages/react/src/reactrouter.compat.tsx`, `packages/react/src/reactrouter-compat-utils/instrumentation.tsx`, `packages/browser/src/tracing/browserTracingIntegration.ts`, and `packages/browser-utils/src/metrics/*`
- Datadog Browser SDK public repo `DataDog/browser-sdk@d2c7e303e4533f40e93d447042a67571f7ba97ff`
- Datadog source paths read: `packages/browser-rum-core/src/domain/view/viewMetrics/trackInteractionToNextPaint.ts` and `packages/browser-rum-core/src/domain/view/viewCollection.ts`
- OpenTelemetry JS Contrib public repo `open-telemetry/opentelemetry-js-contrib@04d6f6af917d2858cc732cffbd1308caad5a33`
- OpenTelemetry source paths read: `packages/instrumentation-user-interaction/src/instrumentation.ts` and `packages/auto-instrumentations-web/src/utils.ts`
- PostHog JS public repo `PostHog/posthog-js@e480a3e23ecff45d2f9cf50332f6f59c54a7c736`
- PostHog source paths read: `packages/react/src/context/PostHogProvider.tsx` and `packages/browser/src/extensions/web-vitals/index.ts`

## Competitor Pattern

Sentry splits responsibilities cleanly: React owns framework lifecycle wrappers such as router tracing and component profiling, while browser tracing owns page-load/navigation/interaction/long-task collection. `createReactRouterV6CompatibleTracingIntegration(...)` composes `browserTracingIntegration(...)` with React Router hooks and disables duplicate browser page-load/navigation capture so the React integration can own route semantics. `browserTracingIntegration.setup(...)` then conditionally starts interaction and long-animation-frame tracking from browser-level code. `Profiler` records component mount/update spans only when a parent span exists.

Datadog's browser RUM code is stronger for INP quality. `trackInteractionToNextPaint(...)` uses Event Timing entries, keeps a bounded list of longest interactions, computes a p98-style candidate, extracts input/processing/presentation subparts, and caps outliers. The tradeoff is a larger RUM runtime that owns more browser lifecycle behavior.

OpenTelemetry's browser auto-instrumentation favors pluggable automatic patching. `getWebAutoInstrumentations(...)` wires document-load, fetch, user-interaction, and XHR instrumentation, while `UserInteractionInstrumentation` patches `zone.js` or `addEventListener` and records element/XPath-like attributes. That is powerful but heavier and more privacy-sensitive than LogBrew's current SDK defaults.

PostHog's React provider focuses on app-owned client initialization and StrictMode safety, while web-vitals capture lives in the browser package and is server/config gated. This is a useful packaging pattern: React should expose an explicit provider-aware bridge without making all React users pay for browser instrumentation.

## LogBrew Direction

LogBrew should keep the Sentry/PostHog split but stay lighter: `@logbrew/react` owns React provider ergonomics and an optional React effect hook, while `@logbrew/browser` owns Web Vitals and PerformanceObserver span construction. The optional subpath keeps the default React import dependency-light.

Implemented lighter subset:

- `@logbrew/react/browser` exports `useLogBrewBrowserInstrumentation(...)` and `createLogBrewReactBrowserContext(...)`.
- Apps explicitly install `@logbrew/browser` when they want browser timing spans.
- The hook runs from React effect lifecycle, unregisters observers on unmount, and delegates Web Vitals plus interaction timing to `@logbrew/browser`.
- It defaults `flushOnCapture` to `false`, so timing spans join the SDK queue and do not send network traffic unless the app flushes through an app-owned transport.
- It avoids global fetch/XHR patching, element selectors, full URLs, query strings, hashes, headers, payloads, screenshots, replay data, baggage, and tracestate.

## Remaining Gap

Sentry and Datadog still have deeper automatic frontend observability: route/page lifecycle breadth, richer span events, hosted source-map symbolication, and mature grouping. LogBrew's next React/browser priorities are framework-owned Web Vitals examples for common app setups, real minified-error source-map proof, and a careful decision on whether heavier automatic fetch/XHR or replay-like features are worth the privacy and runtime cost.
