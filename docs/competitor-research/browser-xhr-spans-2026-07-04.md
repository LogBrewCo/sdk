# Browser XHR Spans - 2026-07-04

## Sources Read

- Sentry JavaScript `getsentry/sentry-javascript@68fe9e8fbcf70f1a92468410a1686787d4f724a6`
- `packages/browser-utils/src/instrument/xhr.ts`: `addXhrInstrumentationHandler`, `instrumentXHR`, proxied `open`, `send`, `setRequestHeader`, readystatechange completion, `parseXhrUrlArg`
- `packages/browser-utils/test/instrument/xhr.test.ts`: missing-`XMLHttpRequest` no-throw behavior
- Datadog Browser SDK `DataDog/browser-sdk@d2c7e303e4533f40e93d447042a67571f7ba97ff`
- `packages/browser-rum-core/src/domain/requestCollection.ts`: `startRequestCollection`, `trackXhr`, `trackFetch`, `REQUEST_STARTED`, `REQUEST_COMPLETED`
- `packages/browser-rum-core/src/domain/tracing/tracer.ts`: `startTracer`, `traceXhr`, `traceFetch`, `clearTracingIfNeeded`
- OpenTelemetry JS `open-telemetry/opentelemetry-js@d9c170c94884e345dff6d67322794e85e6e07f18`
- `experimental/packages/opentelemetry-instrumentation-xml-http-request/src/xhr.ts`: `XMLHttpRequestInstrumentation`, `_patchOpen`, `_patchSend`, `_addHeaders`, `_createSpan`, `enable`, `disable`
- `experimental/packages/opentelemetry-instrumentation-xml-http-request/test/xhr.test.ts`: XHR patch and no-throw tests
- OpenTelemetry JS Contrib `open-telemetry/opentelemetry-js-contrib@04d6f6af917d2858cc732cffbd1308caadab5a33`
- `packages/auto-instrumentations-web/src/utils.ts`: `getWebAutoInstrumentations`
- `packages/auto-instrumentations-web/test/utils.test.ts`: default web auto-instrumentation set and override behavior
- PostHog JS `PostHog/posthog-js@e480a3e23ecff45d2f9cf50332f6f59c54a7c736`
- `packages/browser/src/extensions/tracing-headers.ts`: `TracingHeaders`, `_startCapturing`, `_stopCapturing`, `_patchXHR`, `_patchFetch`
- `packages/browser/src/extensions/tracing-headers-types.ts`: target allow-list and header configuration

## Design Pattern Observed

- Sentry patches XHR prototype methods to collect request lifecycle data and correlate completion while keeping the app's original XHR API.
- Datadog tracks XHR and fetch together, starts request records, injects propagation headers for configured targets, and later joins request data with browser resource information.
- OpenTelemetry's XHR instrumentation wraps `open` and `send`, can inject headers, creates spans, observes resource timing, and supports enable/disable.
- PostHog uses a lighter reversible patch for tracing headers and keeps target configuration explicit.

## LogBrew Decision

LogBrew added a lighter XHR surface for `@logbrew/browser`:

- `installLogBrewBrowserXhrInstrumentation(context, options)` explicitly patches `XMLHttpRequest.prototype.open/send` and returns `uninstall()`.
- `captureBrowserXhrSpan(...)` and `createBrowserXhrSpanEvent(...)` support app-owned wrappers and tests without prototype patching.
- XHR spans become child spans under the active browser trace and can inject exactly one normalized W3C `traceparent` only for matching `tracePropagationTargets`.
- Captured metadata is limited to method, path or route template, status code, response content length when exposed, bounded duration, failure event type, and propagation status.
- The helper does not capture request or response bodies, arbitrary headers, full URLs, hosts, query strings, hash fragments, cookies, error messages, baggage, tracestate, replay payloads, or GraphQL/request payload content.

## Honest Comparison

LogBrew is now stronger for privacy-bounded, explicit XHR tracing because it gives route templates, trace-log-action correlation, failure spans, and teardown without default hidden instrumentation. Sentry, Datadog, and OpenTelemetry remain stronger for automatic broad XHR coverage, request/resource timing joining, richer RUM analysis, and mature auto-instrumentation bundles. The next highest-impact browser gaps are first-page document-load attribution, hosted source-map/symbolication proof, optional framework-owned automatic instrumentation, and richer request/resource phase correlation without leaking URLs or payloads.

## Local Evidence

- TDD RED: `npm --prefix js/logbrew-browser test -- --test-reporter=spec test/xhr-spans.test.mjs` failed on missing XHR exports.
- GREEN: `npm --prefix js/logbrew-browser test` passed 16 browser tests including installed-artifact XHR success, timeout failure, direct summary helpers, teardown proof, and a non-deterministic child-span guard proving the emitted span ID matches the injected `traceparent` span ID.
- Installed-artifact proof: `scripts/real_user_browser_smoke.sh` installed packed `@logbrew/sdk` and `@logbrew/browser` into a temporary app with `happy-dom@20.10.1`, verified tarball/README/ESM/CJS/types, explicit XHR spans, traceparent injection, timeout failure spans, reversible prototype patching, sanitized metadata, and no full URL/query/hash/body/header leakage.
