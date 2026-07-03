# React Router Route Pattern Tracing, 2026-07-04

This pass focused on a real-user frontend debugging gap left after browser SPA navigation tracing: LogBrew could detect route changes, but React apps still lacked a framework-owned way to name route spans by stable React Router templates such as `/projects/:projectId/settings`. Without route templates, dynamic paths fragment debugging and can leak user-specific identifiers.

## Public Source Evidence

- Sentry JavaScript `getsentry/sentry-javascript@68fe9e8fbcf70f1a92468410a1686787d4f724a6`: read `packages/react/src/reactrouter-compat-utils/instrumentation.tsx` (`ReactRouterOptions`, `updateNavigationSpan`, `createReactRouterV6CompatibleTracingIntegration`, `createV6CompatibleWrapUseRoutes`) and `packages/browser/src/tracing/browserTracingIntegration.ts` (`startBrowserTracingNavigationSpan`). Pattern: Sentry disables generic browser navigation for React Router integrations, accepts app-supplied router functions, derives transaction names from route matches, updates span names when lazy routes resolve, and treats route names as stronger than raw URL names.
- Datadog Browser SDK `DataDog/browser-sdk@d2c7e303e4533f40e93d447042a67571f7ba97ff`: read `packages/browser-rum-react/src/domain/reactRouter/startReactRouterView.ts` (`startReactRouterView`, `computeViewName`), `packages/browser-rum-react/src/domain/reactRouter/useRoutes.ts` (`wrapUseRoutes`), `packages/browser-rum-react/src/entries/reactRouterV7.ts` (`createBrowserRouter`, `createMemoryRouter`, `useRoutes`, `Routes`), and `packages/browser-rum-nextjs/src/domain/nextJSRouter/datadogPagesRouter.tsx` (`DatadogPagesRouter`). Pattern: Datadog ships router-specific entrypoints, computes low-cardinality view names from route matches, and asks users to opt into framework-owned router wrappers.
- PostHog JS `PostHog/posthog-js@e480a3e23ecff45d2f9cf50332f6f59c54a7c736`: read `packages/web/src/posthog-web.ts` (`startHistoryChangeTracking`, `captureNavigationEvent`) and `packages/types/src/posthog-config.ts` (`capture_pageview`). Pattern: PostHog tracks history changes and only emits pageviews when the pathname changes, but it does not provide React Router route-template span naming in the same way Sentry/Datadog do.
- OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@04d6f6af917d2858cc732cffbd1308caadab5a33`: read `packages/instrumentation-user-interaction/src/instrumentation.ts` (`_patchHistoryApi`, `_patchHistoryMethod`) and searched web packages for React Router-specific instrumentation. Pattern: OTel has broader generic browser/user-interaction hooks, but no lightweight React Router route-template helper comparable to Sentry/Datadog’s router-specific naming.

## LogBrew Implementation

- Added dependency-free React Router helpers to `@logbrew/react`: `createReactRouterRouteTemplate(...)`, `createReactRouterNavigationSpanEvent(...)`, `captureReactRouterNavigation(...)`, and `useLogBrewReactRouterNavigation(...)`.
- Apps keep ownership of their React Router version and pass route matches directly, or pass `routes` plus their own `matchRoutes` and `location`.
- The helper queues spans named `react.route <route-template>`, records primitive metadata only, and correlates with explicit W3C `traceparent` or explicit `traceId`/`spanId`.
- It deduplicates re-renders for the same concrete pathname while still capturing navigation between two concrete dynamic paths that share the same route template.
- `createLogBrewReactClient(...)` passes through core queue controls (`maxQueueSize`, `eventFilter`, `onEventDropped`, `maxRetries`) so React apps can bound heavy UI bursts without losing drop visibility.
- It does not import or patch React Router, does not capture route params, history state, query strings, hashes, full URLs, headers, payloads, browser storage, baggage, tracestate, replay data, or screenshots.

## Verification

- RED: `bash scripts/real_user_react_smoke.sh` failed because the packed README/API did not expose `useLogBrewReactRouterNavigation` or `createReactRouterRouteTemplate`.
- GREEN: `bash scripts/real_user_react_smoke.sh` packed `@logbrew/react`, installed it into a temporary React app with React/React DOM/React Test Renderer `19.2.7`, proved route-template derivation, direct route span creation, hook deduplication, TypeScript declarations, CommonJS exports, packaged example execution, 503-to-202 shutdown retry, bounded 80-span route burst behavior with `maxQueueSize: 25` and 55 drop callbacks, and no dynamic route/query/hash leakage.
- Focused package checks: `npm test --prefix js/logbrew-react`, `python3 scripts/check_js_sources.py js/logbrew-react`, `bash scripts/check_js_lint.sh`, `bash scripts/check_js_package.sh`, and `shellcheck scripts/real_user_react_smoke.sh`.

## Honest Comparison

- Better than before: React apps can now get stable route-pattern spans from installed `@logbrew/react` without adopting global router patching or an extra framework package.
- Better than competitors in this slice: the LogBrew helper is smaller, explicit, dependency-free, reversible by normal React unmounting, queue-bounded under burst load, and privacy-bounded by default.
- Still worse than Sentry/Datadog: no first-party React Router wrapper entrypoints, no lazy-route name upgrade, no automatic route object wrapping, no Next.js client route-pattern helper, no browser resource/fetch timing spans, no visual replay, and no backend source-map/symbolication proof.
- Next high-impact frontend work: add source-backed Next.js client route-pattern spans and then safe browser resource/fetch timing spans, while keeping route/query/header/payload capture opt-in and privacy-bounded.
