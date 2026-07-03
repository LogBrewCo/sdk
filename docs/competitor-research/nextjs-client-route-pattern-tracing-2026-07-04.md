# Next.js Client Route Pattern Tracing, 2026-07-04

This pass focused on a real-user frontend trace gap: LogBrew had App Router server Route Handler spans, but client-side Next.js navigations still lacked stable route-template spans such as `/projects/[projectId]/settings`. Without route templates, dynamic paths fragment debugging and can expose user-specific identifiers.

## Public Source Evidence

- Sentry JavaScript `getsentry/sentry-javascript@68fe9e8fbcf70f1a92468410a1686787d4f724a6`: read `packages/nextjs/src/client/browserTracingIntegration.ts` (`browserTracingIntegration`), `packages/nextjs/src/client/routing/appRouterRoutingInstrumentation.ts` (`appRouterInstrumentPageLoad`, `appRouterInstrumentNavigation`, `patchRouter`), and `packages/nextjs/src/client/routing/parameterization.ts` (`maybeParameterizeRoute`, `findMatchingRoutes`, `getRouteSpecificity`). Pattern: Sentry runs a Next-specific browser tracing integration, starts page-load/navigation spans, uses an injected route manifest to prefer route names over raw URLs, and falls back to router/global patching for compatibility.
- Datadog Browser SDK `DataDog/browser-sdk@d2c7e303e4533f40e93d447042a67571f7ba97ff`: read `packages/browser-rum-nextjs/src/domain/nextJSRouter/datadogAppRouter.tsx` (`DatadogAppRouter`), `datadogPagesRouter.tsx` (`DatadogPagesRouter`), `computeViewNameFromParams.ts` (`computeViewNameFromParams`), and `nextjsPlugin.ts` (`startNextjsView`). Pattern: Datadog exposes framework-specific router components, uses `usePathname`/`useParams` for App Router view names, uses `router.pathname` for Pages Router templates, and strips query/hash for navigation detection.
- PostHog JS `PostHog/posthog-js@e480a3e23ecff45d2f9cf50332f6f59c54a7c736`: read `packages/web/src/posthog-web.ts` (`setupHistoryEventTracking`, `captureNavigationEvent`) and `packages/types/src/posthog-config.ts` (`capture_pageview`). Pattern: PostHog patches browser history and emits pageviews on pathname changes, but it does not provide Next route-template trace spans in this source path.
- OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@04d6f6af917d2858cc732cffbd1308caadab5a33`: read `packages/instrumentation-user-interaction/src/instrumentation.ts` (`_patchHistoryApi`, `_patchHistoryMethod`, `_updateInteractionName`). Pattern: OTel provides generic browser interaction/history patching, but no lightweight Next-specific route-template helper.

## LogBrew Implementation

- Added browser-safe `@logbrew/next/client` with `createLogBrewNextBrowserClient(...)`, `createNextRouteTemplate(...)`, `createNextNavigationSpanEvent(...)`, `captureNextNavigation(...)`, and `useLogBrewNextNavigation(...)`.
- Apps pass stable Next route patterns and the current `usePathname()` value. The helper supports dynamic segments, required catch-all segments, optional catch-all segments, and route-group segments.
- The helper records spans named `next.route <route-template>` with explicit W3C `traceparent` or explicit `traceId`/`spanId`.
- It deduplicates query/hash-only changes, captures navigation between two concrete dynamic paths that share a route template, and keeps burst behavior bounded through core queue controls.
- It has no `node:` imports, no Next router import, and no dependency on Next internals.
- It does not patch `fetch`, `XMLHttpRequest`, browser history, or the Next router, and it does not capture concrete paths, route params, query strings, hashes, headers, cookies, bodies, raw `traceparent`, baggage, tracestate, replay data, or screenshots.

## Verification

- RED: `bash scripts/real_user_next_smoke.sh` failed because the packed package did not include `client.js`, `client.cjs`, client type declarations, README guidance, or `@logbrew/next/client` exports.
- GREEN: `bash scripts/real_user_next_smoke.sh` packed local `@logbrew/sdk` and `@logbrew/next`, installed them into a temporary Next App Router app with `next@16.2.10`, `react@19.2.7`, and `react-dom@19.2.7`, built the app, verified package metadata and README guidance, proved ESM/CJS client imports, route-template matching, hook deduplication, TypeScript declarations, packaged example execution, server Route Handler behavior, 503-to-202 retry, and 80-span client navigation burst behavior with `maxQueueSize: 25` and 55 drops.
- Focused package check: `npm test --prefix js/logbrew-next`.

## Honest Comparison

- Better than before: Next.js apps can now get stable client route-template spans from the installed package, not only server Route Handler spans.
- Better than competitors in this slice: LogBrew is smaller, explicit, browser-safe by subpath, package-manager proven, queue-bounded under burst load, and privacy-bounded by default.
- Still worse than Sentry/Datadog: no automatic Next router patching, no build-time route manifest injection for client route names, no page-load/RSC fetch timing spans, no source-map upload/symbolication contract, no visual replay, and no broad Next server action/server component/edge instrumentation.
- Next high-impact fixes: browser resource/fetch timing spans, source-map upload/symbolication contract proof, and deeper Next App Router/client/server trace correlation without leaking user route values.
