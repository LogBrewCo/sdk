# Browser Error Debug ID Source-Map Hints - 2026-07-04

## User Gap

Frontend users need a production browser error to point at the right release, environment, service, trace/span, and minified source artifact without sending raw stack text or leaking full URLs. Before this pass, `@logbrew/sdk` could build JavaScript issue attributes with source-map Debug ID metadata, but `@logbrew/browser` did not expose that path for browser `error` or `unhandledrejection` capture.

## Source Reading

- Sentry JavaScript `68fe9e8fbcf70f1a92468410a1686787d4f724a6`
- `packages/browser/src/eventbuilder.ts`: `exceptionFromError`, `eventFromError`, `parseStackFrames`
- `packages/browser/src/integrations/globalhandlers.ts`: `_installGlobalOnErrorHandler`, `_installGlobalOnUnhandledRejectionHandler`
- `packages/core/src/utils/debug-ids.ts`: `getFilenameToDebugIdMap`, `getDebugImagesForResources`
- `packages/core/src/utils/prepareEvent.ts`: `applyDebugIds`, `applyDebugMeta`
- Pattern: browser/global handlers preserve parsed stack frames, core preparation maps runtime `_sentryDebugIds`/`_debugIds` to frames, then moves them into `debug_meta.images` with `{ type: "sourcemap", code_file, debug_id }`.
- Tradeoff: strong automatic symbolication context, but it is broader than LogBrew's current browser privacy defaults because it keeps source URLs as debug image code files.

- Datadog Browser SDK `d2c7e303e4533f40e93d447042a67571f7ba97ff`
- `packages/browser-core/src/domain/error/trackRuntimeError.ts`: `trackRuntimeError`, `instrumentOnError`, `instrumentUnhandledRejection`
- `packages/browser-core/src/domain/error/error.ts`: `computeRawError`, `getErrorDebugIds`
- `packages/browser-rum-core/src/domain/error/errorCollection.ts`: `startErrorCollection`, `processError`
- `packages/browser-logs/src/domain/createErrorFieldFromRawError.ts`: `createErrorFieldFromRawError`
- Pattern: runtime errors become raw errors with stack trace URLs, causes, fingerprint, context, and `debugIds`; RUM errors carry `_dd.debug_ids`.
- Tradeoff: excellent time-to-answer when using Datadog RUM, but LogBrew should not copy the heavier RUM/session context model before explicit user value and privacy review.

- PostHog JS `e480a3e23ecff45d2f9cf50332f6f59c54a7c736`
- `packages/browser/src/extensions/exception-autocapture/index.ts`: `ExceptionObserver`, `captureException`
- `packages/browser/src/posthog-exceptions.ts`: `PostHogExceptions.buildProperties`, `sendExceptionEvent`
- `packages/core/src/error-tracking/error-properties-builder.ts`: `ErrorPropertiesBuilder.buildFromUnknown`, `parseStacktrace`, `applyChunkIds`
- `packages/core/src/error-tracking/chunk-ids.ts`: `getFilenameToChunkIdMap`
- Pattern: optional exception autocapture loads a browser extension, rate-limits by exception type, builds exception lists, and maps runtime `_posthogChunkIds` to parsed frames.
- Tradeoff: useful exception pipeline plus rate limiting and suppression, but source-map/chunk metadata is tied to PostHog's event shape.

- OpenTelemetry JS `d9c170c94884e345dff6d67322794e85e6e07f18`
- `api/src/common/Exception.ts`: `Exception`
- `api/src/trace/span.ts`: `recordException`
- `experimental/packages/opentelemetry-instrumentation-http/src/utils.ts`: `setSpanWithError`
- Pattern: standard exception data is recorded as span events and error status. OpenTelemetry is the portability baseline, not a browser source-map Debug ID solution.

## LogBrew Change

- `@logbrew/browser` now routes browser `error` and `unhandledrejection` issue creation through the existing `@logbrew/sdk` `createIssueAttributesFromError(...)` helper.
- Browser setup/options accept `debugIdMap`, `release`, `environment`, `service`, `runtime`, `platform`, and opt-in `includeErrorStack`.
- Browser issue metadata records error type/message, path-only first frame, line, column, release, environment, service, runtime, trace/span IDs, and optional `{ releaseArtifactType: "sourcemap", releaseArtifactCodeFile, releaseArtifactDebugId }`.
- Browser `releaseArtifactCodeFile` and `errorFrameFile` are normalized to paths, so full URLs, hosts, query strings, hash fragments, raw stack text, headers, payloads, cookies, replay, baggage, and tracestate remain out by default.

## Verification

- RED: `node --test js/logbrew-browser/test/trace-context.test.mjs` failed because browser issue metadata had no `errorFrameFile` or release-artifact Debug ID fields.
- GREEN: `npm test --prefix js/logbrew-browser` passed 25 browser tests, including the new installed browser error Debug ID metadata test.
- GREEN: `bash scripts/real_user_browser_smoke.sh` passed with packed `@logbrew/sdk`, packed `@logbrew/browser`, `happy-dom@20.10.1`, package README assertions, ESM/CJS/types proof, global `ErrorEvent` source-map Debug ID metadata, path-only privacy assertions, and existing transport/retry/lifecycle/timing checks.

## Remaining Gaps

- LogBrew still does not claim hosted source-map upload/lookup/symbolication parity in this package.
- LogBrew still trails Sentry/Datadog on automatic exception grouping, source context UI, cause chains, frame modifiers, suppression rules, and hosted symbolicated stack presentation.
- Next high-impact frontend work should prove a real Vite/Next minified browser error through local fake-intake and prepared release artifacts, then keep backend contract blockers explicit if hosted symbolication is not ready.
