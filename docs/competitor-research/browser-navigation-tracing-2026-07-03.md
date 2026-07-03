# Browser SPA Navigation Tracing, 2026-07-03

This pass focused on a user-visible browser weakness: single-page app route changes did not renew LogBrew trace context or capture route-level page-view spans. That made real debugging weaker than Sentry, Datadog, and PostHog for modern frontend apps where most useful actions happen after the initial page load.

## Public Source Evidence

- Sentry JavaScript `getsentry/sentry-javascript@68fe9e8fbcf70f1a92468410a1686787d4f724a6`: read `packages/browser/src/tracing/browserTracingIntegration.ts` (`browserTracingIntegration`, `addHistoryInstrumentationHandler`, `startBrowserTracingNavigationSpan`), `packages/react-router/src/client/createClientInstrumentation.ts` (`router.instrument`, `popstate` listener, numeric navigation handling), and `packages/react/src/reactrouter.tsx` (`reactRouterV4BrowserTracingIntegration`, history listener). Pattern: Sentry creates navigation spans from browser history and framework-router events, avoids some duplicate spans, updates names from route matching, and treats navigation as a first-class trace root.
- Datadog Browser SDK `DataDog/browser-sdk@d2c7e303e4533f40e93d447042a67571f7ba97ff`: read `packages/browser-rum-core/src/domain/view/trackViews.ts` (`trackViews`, `renewViewOnLocationChange`, `startNewView`), `packages/browser-rum-nextjs/src/domain/nextJSRouter/datadogPagesRouter.tsx` (`DatadogPagesRouter`), and `packages/browser-rum-react/src/domain/reactRouter/startReactRouterView.ts` (`startReactRouterView`, `computeViewName`). Pattern: Datadog renews the active view on location changes and framework route updates, using path-only matching and route patterns where frameworks expose them.
- PostHog JS `PostHog/posthog-js@e480a3e23ecff45d2f9cf50332f6f59c54a7c736`: read `packages/web/src/posthog-web.ts` (`startHistoryChangeTracking`, `captureNavigationEvent`) and `packages/types/src/posthog-config.ts` (`capture_pageview`). Pattern: PostHog has an explicit history-change pageview mode that patches `pushState`/`replaceState`, listens for `popstate`, and emits only when the pathname changes.
- OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@366df61d2dab9dfda93f60f49bb4436d9c49d157`: read `packages/auto-instrumentations-web/src/utils.ts` (`getWebAutoInstrumentations`) and `packages/instrumentation-document-load/src/instrumentation.ts` (`DocumentLoadInstrumentation._collectPerformance`). Pattern: OTel’s browser auto-instrumentation is broader and standards-based, especially document-load/fetch/user-interaction spans, but heavier than LogBrew’s default browser helper.

## LogBrew Implementation

- Added explicit `installLogBrewBrowserNavigationInstrumentation(context, options)` to `@logbrew/browser`.
- The helper observes app-owned browser history changes (`pushState`, `replaceState`, `popstate`), creates a fresh W3C browser trace context per path change, captures one page-view span, and updates `context.traceContext` so following actions/errors/network milestones correlate to the active route.
- Added dynamic `traceContext: () => logbrew.traceContext` support to `createTraceparentFetch()` so outbound `traceparent` headers use the current route trace at request time.
- Kept the boundary lighter than competitors: the helper is opt-in, reversible, path-only by default, and does not capture history state, full URLs, query strings, hash fragments, payloads, headers, cookies, screenshots, visual replay, baggage, or tracestate.

## Verification

- RED: `node --test js/logbrew-browser/test/trace-context.test.mjs` failed on missing `installLogBrewBrowserNavigationInstrumentation`.
- GREEN: `node --test js/logbrew-browser/test/trace-context.test.mjs`.
- Package gate: `npm test --prefix js/logbrew-browser`.
- Installed-artifact gate: `bash scripts/real_user_browser_smoke.sh` packed `@logbrew/browser`, installed it into a temporary app with `happy-dom@20.10.1`, verified ESM/CJS/type declarations, route trace renewal, dynamic `traceparent` propagation, lifecycle flush, persistence, beacon, and query/hash-free metadata.

## Honest Comparison

- Better than before: LogBrew now gives browser apps a small, inspectable route-trace helper that a developer can install without adopting hidden global fetch/XHR patching or broad page telemetry.
- Still worse than Sentry/Datadog: no framework-owned React Router/Next/Vue/Svelte route-pattern integrations, no browser performance timing spans, no automatic resource/fetch/XHR spans, no baggage/tracestate, no visual replay, and no backend source-map/symbolication end-to-end proof yet.
- Next high-impact browser work: add framework-owned route-pattern helpers for the most popular frontend frameworks, then add safe resource/navigation timing spans without copying full URLs or payloads.
