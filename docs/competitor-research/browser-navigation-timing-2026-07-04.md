# Browser document-load timing spans, July 4 2026

## Question

Can LogBrew explain a slow first browser page load with trace-correlated timing evidence as well as Sentry, Datadog, OpenTelemetry, and PostHog, without adding hidden global capture or leaking full URLs?

## Sources read

- Sentry JavaScript `68fe9e8fbcf70f1a92468410a1686787d4f724a6`: `packages/browser/src/tracing/browserTracingIntegration.ts` (`browserTracingIntegration`, `startBrowserTracingPageLoadSpan`, `startBrowserTracingNavigationSpan`) and `packages/browser-utils/src/metrics/browserMetrics.ts` (`_addNavigationSpans`, `_addPerformanceNavigationTiming`, `_addRequest`).
- Datadog Browser SDK `d2c7e303e4533f40e93d447042a67571f7ba97ff`: `packages/browser-rum-core/src/domain/view/viewMetrics/trackNavigationTimings.ts` (`trackNavigationTimings`, `processNavigationEntry`, `waitAfterLoadEvent`), `packages/browser-rum-core/src/browser/performanceUtils.ts` (`getNavigationEntry`, `sanitizeFirstByte`), and `packages/browser-rum-core/src/domain/view/viewCollection.ts` view timing fields.
- OpenTelemetry JS Contrib `04d6f6af917d2858cc732cffbd1308caadab5a33`: `packages/instrumentation-document-load/src/instrumentation.ts` (`DocumentLoadInstrumentation`, `_waitForPageLoad`, `_collectPerformance`, `_addResourcesSpans`, `_startSpan`, `_endSpan`), `src/utils.ts` (`getPerformanceNavigationEntries`), and `src/types.ts` document-load network event config.
- PostHog JS `e480a3e23ecff45d2f9cf50332f6f59c54a7c736`: `packages/browser/src/extensions/web-vitals/index.ts` (`WebVitalsAutocapture`), `packages/browser/src/page-view.ts` (`PageViewManager`), and `packages/browser/src/extensions/replay/external/network-plugin.ts` (`initPerformanceObserver`).

## Competitor patterns

- Sentry is strongest for rich trace debugging: it starts a `pageload` span from browser time origin, creates navigation phase spans for unload, redirect, name lookup, connect, TLS, pre-request wait, document request/response, and links Web Vitals to the pageload span. Tradeoff: heavier automatic integration, more global instrumentation, and more SDK-owned span graph behavior.
- Datadog is strongest for RUM summary reliability: it waits until after load completion, ignores incomplete navigation data, records first byte plus DOM/load milestones on the initial view, and handles broken modern navigation entries with a legacy timing fallback. Tradeoff: it is a RUM view model, not a small explicit SDK helper.
- OpenTelemetry has a dedicated document-load instrumentation that waits for load, extracts traceparent from a meta tag, creates document load/fetch/resource spans, and adds network events. Tradeoff: it includes full URL/user-agent attributes by default and assumes an OTel tracer pipeline.
- PostHog focuses more on product analytics, pageview duration, replay network timing, and Web Vitals events. It does not appear to provide a first-class document-load tracing span comparable to Sentry/OTel in the browser SDK.

## LogBrew implementation

Added explicit `@logbrew/browser` document-load timing helpers:

- `captureBrowserNavigationTiming(entry, context, options)` records one `browser.document <path>` child span under the active LogBrew browser trace.
- `createBrowserNavigationTimingEvent(entry, browserWindow, options)` builds the sanitized event without queueing it.
- `installLogBrewBrowserNavigationTimingInstrumentation(context, options)` is an opt-in one-shot helper that waits for browser load when needed, reads the current navigation entry once, and returns `uninstall()`.

The LogBrew version intentionally copies only path/template metadata and bounded primitive timings: first byte, redirect, worker, pre-request wait, name lookup, connect, TLS, request, response, DOM interactive/content-loaded/complete, load event, status, sizes, navigation type, and redirect count. It does not capture full URLs, hosts, query strings, hash fragments, server timing records, headers, bodies, cookies, baggage, tracestate, user agent, or document title by default.

## Verification

- `npm --prefix js/logbrew-browser test`: 18 browser tests passed, including installed package imports for direct navigation timing capture and opt-in one-shot instrumentation.
- `bash scripts/real_user_browser_smoke.sh`: passed with a packed temporary app, local package tarballs, `happy-dom@20.10.1`, ESM/CJS import checks, TypeScript compile, direct and installed document-load span proof, path-only metadata checks, and no generated artifacts left in the repo.

## Honest comparison

LogBrew is now better than PostHog for trace-correlated browser document-load debugging and safer by default than OTel's document-load instrumentation because it avoids full URL and user-agent attributes unless app code chooses otherwise. LogBrew is still behind Sentry for automatic pageload/span graph richness and behind Datadog for full RUM view-level loading-time modeling. The next high-impact browser gaps are Web Vitals span correlation, backend symbol/source-map upload contract proof, and richer first-page time-to-answer docs.
