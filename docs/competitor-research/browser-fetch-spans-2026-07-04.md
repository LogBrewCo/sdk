# Browser Fetch Spans - 2026-07-04

## Sources Read

- Sentry JavaScript `getsentry/sentry-javascript@68fe9e8fbcf70f1a92468410a1686787d4f724a6`
- `packages/core/src/fetch.ts`: `instrumentFetchRequest`, `_INTERNAL_getTracingHeadersForFetchRequest`, `_callOnRequestSpanEnd`, `endSpan`
- `packages/core/src/instrument/fetch.ts`: `addFetchInstrumentationHandler`, `instrumentFetch`
- `packages/browser-utils/src/instrument/xhr.ts`: `addXhrInstrumentationHandler`, `instrumentXHR`
- Datadog Browser SDK `DataDog/browser-sdk@d2c7e303e4533f40e93d447042a67571f7ba97ff`
- `packages/browser-rum-core/src/domain/requestCollection.ts`: `startRequestCollection`, `trackXhr`, `trackFetch`
- `packages/browser-rum-core/src/domain/tracing/tracer.ts`: `startTracer`, `traceFetch`, `traceXhr`, `clearTracingIfNeeded`
- `packages/browser-rum-core/src/domain/resource/resourceCollection.ts`: `startResourceCollection`, `assembleResource`, `computeRequestTracingInfo`, `computeResourceEntryTracingInfo`, `computeNetworkHeaders`
- OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@04d6f6af917d2858cc732cffbd1308caadab5a33`
- `packages/auto-instrumentations-web/src/utils.ts`: `getWebAutoInstrumentations`
- PostHog JS `PostHog/posthog-js@e480a3e23ecff45d2f9cf50332f6f59c54a7c736`
- `packages/browser/src/extensions/tracing-headers.ts`: `TracingHeaders`, `_patchFetch`, `_patchXHR`
- `packages/browser/src/extensions/tracing-headers-types.ts`: trace-header options
- `packages/browser/src/extensions/replay/external/network-plugin.ts`: `initPerformanceObserver`

## Design Pattern Observed

- Sentry gets strong browser HTTP coverage by patching `fetch` and XHR, creating spans around request lifecycle, attaching tracing headers when rules match, and ending spans on response or error.
- Datadog tracks both XHR and fetch, links request lifecycle to resource entries, and injects multiple propagation styles behind URL-matching rules.
- OpenTelemetry web auto-instrumentation exposes a bundle of document-load, fetch, user-interaction, and XHR instrumentation for apps that want broader automatic tracing.
- PostHog keeps trace-header patching reversible and configurable, and separates network performance capture from replay capture.

## LogBrew Decision

LogBrew added a lighter `@logbrew/browser` fetch surface:

- `createLogBrewBrowserFetch(context, options)` wraps an app-owned `fetch` implementation.
- `installLogBrewBrowserFetchInstrumentation(context, options)` is explicit, reversible, and only patches `window.fetch` when an app calls it.
- `captureBrowserFetchSpan(...)` and `createBrowserFetchSpanEvent(...)` support explicit request summaries and tests.
- Fetch spans become child spans under the active browser trace and can inject exactly one normalized W3C `traceparent` for matching `tracePropagationTargets`.
- Captured metadata is limited to method, path or route template, status code, response content length when exposed, bounded duration, error type, and propagation status.
- The helper does not capture request or response bodies, arbitrary headers, full URLs, hosts, query strings, hash fragments, cookies, error messages, baggage, tracestate, replay, or XHR.

## Honest Comparison

LogBrew is now stronger for privacy-bounded, app-owned fetch tracing because it gives clear route templates, trace correlation, failure spans, and teardown without hidden global instrumentation by default. Sentry and Datadog remain stronger for zero-config fetch/XHR coverage, automatic request/resource joining, page-load attribution, and richer RUM analysis. The next highest-impact browser gaps are a similarly safe XHR helper, first-page document-load attribution, source-map symbolication proof, and optional framework-owned automatic instrumentation.

## Local Evidence

- TDD RED: `npm --prefix js/logbrew-browser test -- --test-reporter=spec test/fetch-spans.test.mjs` failed on missing fetch-span exports.
- GREEN: `npm --prefix js/logbrew-browser test` passed 13 browser tests including installed-artifact fetch wrapper, failure, and explicit instrumentation coverage.
- Installed-artifact proof: `scripts/real_user_browser_smoke.sh` installed packed `@logbrew/sdk` and `@logbrew/browser` into a temporary app and verified tarball contents, README snippets, ESM/CJS/types, explicit fetch spans, traceparent injection, failure rethrow, reversible patching, and no full URL/query/hash/body/header leakage.
