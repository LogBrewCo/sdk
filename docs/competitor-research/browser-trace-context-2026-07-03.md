# Browser Trace Context Competitor Review - 2026-07-03

## Sources Checked

- Sentry JavaScript public repo `getsentry/sentry-javascript@68fe9e8fbcf70f1a92468410a1686787d4f724a6`
- Sentry paths read: `packages/browser/src/tracing/browserTracingIntegration.ts`, `packages/browser/src/tracing/request.ts`, `packages/browser/src/tracing/setActiveSpan.ts`, `packages/core/src/currentScopes.ts`, `packages/core/src/utils/spanUtils.ts`, `packages/opentelemetry/src/propagator.ts`
- Datadog browser SDK public repo `DataDog/browser-sdk@d2c7e303e4533f40e93d447042a67571f7ba97ff`
- Datadog paths read: `packages/browser-rum-core/src/domain/tracing/tracer.ts`, `packages/browser-rum-core/src/domain/resource/resourceCollection.ts`, `packages/browser-rum-core/src/domain/action/actionCollection.ts`, `packages/browser-rum-core/src/domain/view/trackViews.ts`
- OpenTelemetry JS public repo `open-telemetry/opentelemetry-js@d2d08f6457134bb63a28cea5192fd88954b144a2`
- OpenTelemetry paths read: `api/src/api/context.ts`, `api/src/api/trace.ts`, `api/src/trace/context-utils.ts`, `api/src/trace/spancontext-utils.ts`, `api/src/trace/NonRecordingSpan.ts`, `api/src/trace/span_context.ts`, `api/src/trace/trace_flags.ts`
- PostHog JS public repo `PostHog/posthog-js@e480a3e23ecff45d2f9cf50332f6f59c54a7c736`
- PostHog paths read: `packages/browser/src/extensions/tracing-headers.ts`, `packages/core/src/tracing-headers.ts`, `packages/browser/src/autocapture.ts`, `packages/browser/src/extensions/history-autocapture.ts`

## Competitor Pattern

Sentry and Datadog are stronger for browser debugging because page load, navigation, actions, resources, errors, and outbound requests share an active trace/view context. Sentry keeps an active browser span/scope, creates pageload and navigation spans, updates propagation context after idle spans finish, and can inject trace headers into matching fetch/XHR calls. Datadog keeps active view/action/resource context, injects W3C/Datadog/B3 headers into allowed requests, and correlates request trace/span IDs back into RUM resource events.

OpenTelemetry's useful primitive is the active context plus SpanContext model: validate trace IDs/span IDs/flags, attach the active span to execution context, and inject only explicit propagation fields. PostHog is lighter: it mostly patches fetch/XHR for configured targets and injects session/user correlation headers rather than full distributed trace spans.

## LogBrew Tradeoff

LogBrew should not copy hidden global fetch/XHR patching, replay, request/response body capture, broad header capture, query/hash capture, baggage, or tracestate from browser helpers. The safer product path is an explicit W3C trace context that users can inspect and pass to app-owned fetch wrappers, while default page view, action, error, rejection, and network milestone helpers share that context automatically.

## Implemented LogBrew Subset

`@logbrew/browser` now exposes `createBrowserTraceContext()` and returns `traceContext` from `installLogBrewBrowser()`. The installed browser context uses that same W3C trace ID/span ID for the first page-view span plus browser action, network milestone, synchronous error, and unhandled rejection metadata. `createTraceparentFetch()` accepts `traceContext` and injects exactly one normalized `traceparent` header only for `tracePropagationTargets`.

This keeps the browser helper explicit and privacy-bounded: no global HTTP patching, no payload/header/body capture, no full URL/query/hash defaults, no baggage, no tracestate, and no visual replay.

## Evidence

- Focused failing-first test: `node --test js/logbrew-browser/test/trace-context.test.mjs`
- Browser package gate: `npm test --prefix js/logbrew-browser`
- Installed tarball smoke: `bash scripts/real_user_browser_smoke.sh`
- Fake-intake/high-volume gate: `bash scripts/real_user_browser_fake_intake_smoke.sh`

## Remaining Gaps

Sentry and Datadog still remain stronger for fully automatic browser performance tracing, route-change span renewal, resource timing spans, request phase timings, and hidden framework-owned HTTP instrumentation. LogBrew should add those only in framework-owned integration packages or explicit app-owned helpers, not as hidden core browser side effects.
