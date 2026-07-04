# Browser Interaction Timing Trace Correlation - 2026-07-04

Goal: improve browser trace usefulness where real users compare LogBrew against Sentry first: slow clicks, input delay, and long main-thread work should be visible next to page, route, fetch, XHR, resource, Web Vital, action, log, and error telemetry without capturing DOM targets or replay payloads.

## Competitor Source Read

- Sentry JavaScript `68fe9e8fbcf70f1a92468410a1686787d4f724a6`: read `packages/browser-utils/src/metrics/browserMetrics.ts` (`startTrackingInteractions`, `startTrackingLongTasks`, `startTrackingLongAnimationFrames`) and `packages/browser-utils/src/metrics/inp.ts` (`_trackINP`, `registerInpInteractionListener`, `getCachedInteractionContext`). Pattern: Sentry links browser interactions, INP, long tasks, and long animation frames into the active span graph, caches interaction context, and can enrich spans with component/HTML tree context.
- Datadog Browser SDK `d2c7e303e4533f40e93d447042a67571f7ba97ff`: read `packages/browser-rum-core/src/domain/longTask/longTaskCollection.ts` (`startLongTaskCollection`, `processEntry`) and `packages/browser-rum-core/src/domain/view/viewMetrics/trackInteractionToNextPaint.ts` (`trackInteractionToNextPaint`, `trackLongestInteractions`, `createSubPartsTracker`). Pattern: Datadog observes long tasks or long animation frames, keeps bounded top interactions, computes INP/subpart metrics, and ties them to the current RUM view.
- OpenTelemetry JS Contrib `04d6f6af917d2858cc732cffbd1308caadab5a33`: read `packages/instrumentation-long-task/src/instrumentation.ts` (`LongTaskInstrumentation`, `_createSpanFromEntry`) and `packages/instrumentation-user-interaction/src/instrumentation.ts` (`UserInteractionInstrumentation`, `_createSpan`, event listener/history/zone patching methods). Pattern: OTel exposes reusable long-task and user-interaction spans, but user-interaction instrumentation patches broad browser APIs when enabled.
- PostHog JS `e480a3e23ecff45d2f9cf50332f6f59c54a7c736`: read `packages/browser/src/extensions/web-vitals/index.ts` (`WebVitalsAutocapture`, `_addToBuffer`, `_startCapturing`) and `packages/browser/src/autocapture.ts` (`_captureEvent`). Pattern: PostHog can autocapture UI events and Web Vital attribution, but deliberately drops raw `interactionTargetElement` from Web Vital buffering.

## LogBrew Implementation

- Added `captureBrowserInteractionTiming()` and `createBrowserInteractionTimingEvent()` in `@logbrew/browser` for app-owned `PerformanceEventTiming`, `first-input`, and `longtask` entries.
- Added `installLogBrewBrowserInteractionTimingInstrumentation()` for explicit `PerformanceObserver` capture of `event` and `longtask` entries. It returns `uninstall()` and is not enabled by default.
- Interaction spans use the active browser trace, create child span IDs, and keep bounded primitive metadata: entry type, interaction type, interaction ID, input delay, processing duration, presentation delay, start time, task name, path, and route template.
- Privacy boundary: no DOM target, selector, element text, long-task attribution script URL, full URL, host, query string, hash, header, body, cookie, replay, baggage, or tracestate capture.

## Verification

- `node --test js/logbrew-browser/test/interaction-timing.test.mjs`: 2 tests passed, including installed temp-app capture and opt-in observer teardown.
- `npm test --prefix js/logbrew-browser`: 22 tests passed, including syntax checks, ESM/CJS package imports, interaction timing spans, and browser regression tests.
- `bash scripts/real_user_browser_smoke.sh`: passed with `happy-dom@20.10.1`; packs `@logbrew/sdk` and `@logbrew/browser`, installs them into a temp npm app, verifies tarball files, README contents, TypeScript declarations, CommonJS exports, direct and observed interaction/long-task spans, trace correlation, teardown behavior, and privacy constraints.

## Honest Comparison

LogBrew is now stronger for teams that want explicit, small, dependency-free browser interaction timing spans with installed-artifact proof and strict privacy defaults. Sentry and Datadog remain stronger for automatic interaction-to-view lifecycle ownership, INP ranking, long-animation-frame detail, rich UI/component attribution, and hosted performance views. The next browser gaps are richer INP/interaction aggregation, optional framework-owned automatic instrumentation, real minified-error/source-map proof, and backend release-artifact upload/symbolication support.
