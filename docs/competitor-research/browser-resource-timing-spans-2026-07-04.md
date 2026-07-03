# Browser Resource Timing Spans - 2026-07-04

## Sources Read

- Sentry JavaScript `getsentry/sentry-javascript@68fe9e8fbcf70f1a92468410a1686787d4f724a6`
- `packages/core/src/fetch.ts`: `instrumentFetchRequest`, `_INTERNAL_getTracingHeadersForFetchRequest`, `_callOnRequestSpanEnd`
- `packages/core/src/instrument/fetch.ts`: `addFetchInstrumentationHandler`, `instrumentFetch`, `parseFetchArgs`
- `packages/replay-internal/src/util/createPerformanceEntries.ts`: `createResourceEntry`
- Datadog Browser SDK `DataDog/browser-sdk@d2c7e303e4533f40e93d447042a67571f7ba97ff`
- `packages/browser-rum-core/src/domain/resource/resourceCollection.ts`: `startResourceCollection`, `assembleResource`, `computeRequestTracingInfo`, `computeResourceEntryTracingInfo`, `discardZeroStatus`, `computeNetworkHeaders`
- `packages/browser-rum-core/src/domain/resource/resourceUtils.ts`: `computeResourceEntryType`, `computeResourceEntryDuration`, `computeResourceEntryDetails`, `hasValidResourceEntryTimings`, `computeResourceEntrySize`, `isAllowedRequestUrl`
- `packages/browser-rum-core/src/domain/resource/trackManualResources.ts`: `trackManualResources`, `startManualResource`, `stopManualResource`
- OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@04d6f6af917d2858cc732cffbd1308caadab5a33`
- `packages/instrumentation-document-load/src/instrumentation.ts`: `DocumentLoadInstrumentation`, `_addResourcesSpans`, `_initResourceSpan`, `_startSpan`, `_endSpan`
- `packages/instrumentation-document-load/src/types.ts`: `DocumentLoadInstrumentationConfig`, `ResourceFetchCustomAttributeFunction`
- PostHog JS `PostHog/posthog-js@e480a3e23ecff45d2f9cf50332f6f59c54a7c736`
- `packages/types/src/posthog-config.ts`: `PerformanceCaptureConfig`, `capture_performance`
- `packages/browser/src/extensions/replay/external/network-plugin.ts`: `initPerformanceObserver`

## Design Pattern Observed

- Sentry patches browser `fetch` to create HTTP spans, attach tracing headers when enabled, and end spans on response or error. This gives strong coverage but increases global instrumentation and privacy review surface.
- Datadog combines `PerformanceObserver` resource entries with request tracking to produce rich RUM resource events, including duration, type, status, sizes, and phase timings. It avoids zero-status resource events and uses allow/deny logic for intake URLs.
- OpenTelemetry document-load instrumentation converts navigation and resource timing entries into spans, with optional callbacks for custom attributes and network events.
- PostHog treats network timing mainly as replay/performance capture, behind explicit config and filtering.

## LogBrew Decision

LogBrew added a lighter `@logbrew/browser` resource timing surface:

- `captureBrowserResourceTiming(entry, context, options)` emits one sanitized child span from an app-provided timing entry.
- `installLogBrewBrowserResourceTimingInstrumentation(context, options)` is opt-in, `PerformanceObserver`-based, and reversible with `uninstall()`.
- `resourcePathTemplate` lets apps collapse dynamic IDs before events are queued.
- Captured metadata is limited to primitive path/template, initiator type, status code when exposed, sizes, and bounded phase durations.
- The helper preserves the active trace ID, creates a child span ID, and records `parentSpanId`.
- It does not patch global `fetch` or XHR, capture headers/bodies/cookies, store full URLs/hosts/query/hash, emit baggage/tracestate, or install replay.

## Honest Comparison

LogBrew is better for privacy-bounded, app-owned setup because resource spans are explicit, templateable, reversible, and do not collect request payload data. Sentry and Datadog are still stronger for zero-config coverage, broader automatic fetch/XHR linkage, page-load attribution, and richer RUM analysis. The next high-impact browser gaps are safe fetch/XHR framework integration, first-page document-load/resource attribution, source-map symbolication proof, and backend release-artifact upload/lookup support.

## Local Evidence

- `npm --prefix js/logbrew-browser test -- --test-reporter=spec test/resource-timing.test.mjs`
- `scripts/real_user_browser_smoke.sh` now installs packed `@logbrew/sdk` and `@logbrew/browser` into a temporary app and verifies direct resource timing capture, observer install/uninstall, TypeScript declarations, CommonJS exports, and no full URL/query/hash leakage.
