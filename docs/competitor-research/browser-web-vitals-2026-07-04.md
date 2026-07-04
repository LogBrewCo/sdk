# Browser Web Vitals Trace Correlation - 2026-07-04

Goal: improve the browser SDK where real users compare LogBrew against Sentry first: page performance debugging should connect Web Vitals to the same page or route trace as page-load, route, fetch, XHR, resource, action, log, and error events.

## Competitor Source Read

- Sentry JavaScript `68fe9e8fbcf70f1a92468410a1686787d4f724a6`: read `packages/browser-utils/src/metrics/browserMetrics.ts` (`startTrackingWebVitals`, `_trackCLS`, `_trackLCP`, `_trackTtfb`, `_trackFpFcp`, `addWebVitalsToSpan`) and `packages/browser/src/tracing/browserTracingIntegration.ts` (`browserTracingIntegration` Web Vitals integration wiring). Pattern: Sentry attaches Web Vitals to pageload spans or emits standalone spans, guards visibility/lifecycle edge cases, and can record richer UI/long-task performance spans.
- Datadog Browser SDK `d2c7e303e4533f40e93d447042a67571f7ba97ff`: read `packages/browser-rum-core/src/domain/view/viewMetrics/trackInitialViewMetrics.ts`, `trackCommonViewMetrics.ts`, `trackLargestContentfulPaint.ts`, `trackCumulativeLayoutShift.ts`, and `trackInteractionToNextPaint.ts`. Pattern: Datadog treats Web Vitals as view metrics, tracks LCP/CLS/INP with bounded state, computes attribution/subparts, caps outliers, and updates the current RUM view over time.
- PostHog JS `e480a3e23ecff45d2f9cf50332f6f59c54a7c736`: read `packages/browser/src/extensions/web-vitals/index.ts` (`WebVitalsAutocapture`, `_addToBuffer`, `_flushToCapture`, `_startCapturing`). Pattern: PostHog loads Web Vitals callbacks when configured, buffers metrics by current URL/session, masks query params, and optionally includes attribution while dropping raw target elements.
- OpenTelemetry JS Contrib `04d6f6af917d2858cc732cffbd1308caadab5a33`: read `packages/auto-instrumentations-web/src/utils.ts` (`getWebAutoInstrumentations`). Pattern: OTel bundles document-load, fetch, user-interaction, and XHR instrumentations, but does not provide the same hosted Web Vitals UX layer by default.

## LogBrew Implementation

- Added `captureBrowserWebVital()` and `createBrowserWebVitalEvent()` in `@logbrew/browser` for app-owned Web Vital metric objects.
- Added `installLogBrewBrowserWebVitalsInstrumentation()` for apps that pass their own `web-vitals` callbacks or module exports. LogBrew registers only requested callbacks and stops queuing after `uninstall()`.
- Web Vital spans use the active page or route trace, create a child span ID, keep metric name/value/unit/rating/navigation type/delta, and copy only safe timing subparts such as TTFB and resource load duration.
- Privacy boundary: no Web Vital dependency by default; no external script loading; no hidden global observers unless the app passes callbacks; no DOM selectors, interaction targets, raw attribution entries, full URLs, hosts, query strings, hash fragments, headers, payloads, cookies, user text, baggage, or tracestate.

## Verification

- `npm test --prefix js/logbrew-browser`: 20 tests passed, including installed-package Web Vital capture and callback instrumentation tests.
- `bash scripts/real_user_browser_smoke.sh`: passed with `happy-dom@20.10.1`; packages `@logbrew/sdk` and `@logbrew/browser`, installs them into a temp npm app, verifies tarball files, README contents, TypeScript imports, CommonJS exports, Web Vital LCP/CLS span shape, trace correlation, teardown behavior, and privacy constraints.

## Honest Comparison

LogBrew is now stronger for teams that want a small, explicit, dependency-free Web Vital trace link with installed-artifact proof and strict privacy defaults. Sentry and Datadog are still stronger for automatic page/view performance collection, richer LCP/CLS/INP attribution, long-task and interaction span graphs, outlier heuristics, automatic route/view lifecycle ownership, and hosted UI workflows. The next browser gaps are richer automatic Web Vital collection in a framework-owned package, real minified-error/source-map proof, and hosted release-artifact upload/symbolication support.
