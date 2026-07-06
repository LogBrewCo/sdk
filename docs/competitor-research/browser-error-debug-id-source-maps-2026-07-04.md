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

## Follow-Up: Real Vite Runtime Proof

- Sentry bundler plugins `988efd30691e08c059eb577e499d0b4346434f3c`
- `packages/bundler-plugins/src/core/debug-id-upload.ts`: `prepareBundleForDebugIdUpload`, `determineDebugIdFromBundleSource`, `prepareSourceMapForDebugIdUpload`
- `packages/bundler-plugins/src/core/build-plugin-manager.ts`: debug-ID injection and source-map upload write-bundle flow
- Pattern: build plugin injects Debug IDs, prepares matching bundle/source-map pairs, and uploads them with release context so runtime frames can match `debug_meta.images`.

- Datadog CI `3bac12402541936f16532104884240b3f3a5ad64`
- `packages/base/src/commands/sourcemaps/upload.ts`: `execute`, `getMatchingSourcemaps`, `upload`
- `packages/base/src/commands/sourcemaps/validation.ts`: `validatePayload`
- `packages/base/src/helpers/upload.ts` and `packages/base/src/helpers/retry.ts`: multipart upload and retry behavior
- Pattern: CI tooling pairs source maps with minified URLs, requires release/service context, validates local files before upload, and retries transient upload failures.

- LogBrew now proves the connected local path with `scripts/real_user_vite_release_artifact_smoke.sh`: a temporary Vite app installs packed `@logbrew/sdk` and `@logbrew/browser`, builds a minified bundle/source map, creates a release-artifact manifest, resolves an actual thrown minified stack frame, then creates a browser runtime issue payload from the built asset URL and the manifest Debug ID map.
- The proof asserts the runtime issue includes the same `releaseArtifactDebugId`, path-only `releaseArtifactCodeFile`/`errorFrameFile`, release, environment, service, runtime, and trace/span IDs while omitting the CDN host, query/hash, temp paths, raw source sentinel, and user-like URL data.
- The same smoke still uploads the real manifest, source map, and minified bundle to a loopback fake intake with 503-to-202 retry proof.

## Follow-Up: Real Next.js Runtime Proof

- Sentry JavaScript `9d53b0cd8ccd894d7ce24530cb1b289f2607eb97`
- `packages/core/src/utils/debug-ids.ts`: `getFilenameToDebugIdMap`, `getDebugImagesForResources`
- `packages/core/src/utils/prepareEvent.ts`: `applyDebugIds`, `applyDebugMeta`
- `packages/nextjs/src/client/clientNormalizationIntegration.ts`: `nextjsClientStackFrameNormalizationIntegration`
- `packages/nextjs/src/config/handleRunAfterProductionCompile.ts`: `handleRunAfterProductionCompile`
- Pattern: Next client frames are normalized to `app:///_next/...`, runtime filenames are connected to Debug IDs, and event preparation moves frame Debug IDs into source-map debug images.

- Datadog CI `3bac12402541936f16532104884240b3f3a5ad64`
- `packages/base/src/commands/sourcemaps/interfaces.ts`: `Sourcemap.asMultipartPayload`
- `packages/base/src/commands/sourcemaps/upload.ts`: `SourcemapsUploadCommand.upload`
- `packages/base/src/commands/sourcemaps/validation.ts`: `validatePayload`
- Pattern: uploaded artifacts keep release, service, minified URL, source map, and minified file identity explicit before network upload.

- LogBrew now extends `scripts/real_user_next_release_artifact_smoke.sh`: a temporary Next app installs packed `@logbrew/sdk`, `@logbrew/next`, and `@logbrew/browser`, builds real `.next/static/chunks` output, proves local symbolication, then creates a browser runtime issue payload from the built Next chunk URL and manifest Debug ID map.
- The proof asserts the issue includes the same `releaseArtifactDebugId`, path-only `releaseArtifactCodeFile`/`errorFrameFile`, release, environment, service, runtime, and trace/span IDs while omitting the static asset host, query/hash placeholders, temp paths, raw source sentinel, and user-like URL data.
- The same smoke still proves loopback upload retry for the real Next manifest, source map, and minified chunk.

## Verification

- RED: `node --test js/logbrew-browser/test/trace-context.test.mjs` failed because browser issue metadata had no `errorFrameFile` or release-artifact Debug ID fields.
- GREEN: `npm test --prefix js/logbrew-browser` passed 25 browser tests, including the new installed browser error Debug ID metadata test.
- GREEN: `bash scripts/real_user_browser_smoke.sh` passed with packed `@logbrew/sdk`, packed `@logbrew/browser`, `happy-dom@20.10.1`, package README assertions, ESM/CJS/types proof, global `ErrorEvent` source-map Debug ID metadata, path-only privacy assertions, and existing transport/retry/lifecycle/timing checks.
- RED: `python3 -m unittest tests/test_release_artifact_smoke_gates.py` failed because the Vite release-artifact smoke did not install `@logbrew/browser` or prove runtime issue Debug ID linkage.
- GREEN: `python3 -m unittest tests/test_release_artifact_smoke_gates.py` passed 7 release-artifact smoke gate tests.
- GREEN: `bash scripts/real_user_vite_release_artifact_smoke.sh` passed with packed `@logbrew/sdk`, packed `@logbrew/browser`, `vite@8.0.16`, real minified build, manifest/source-map Debug ID proof, runtime browser issue payload proof, local symbolication proof, and loopback upload retry proof.
- RED: `python3 -m unittest tests.test_release_artifact_smoke_gates` failed because the Next.js release-artifact smoke did not install `@logbrew/browser` or prove runtime issue Debug ID linkage.
- GREEN: `python3 -m unittest tests.test_release_artifact_smoke_gates` passed 8 release-artifact smoke gate tests.
- GREEN: `bash scripts/real_user_next_release_artifact_smoke.sh` passed with packed `@logbrew/sdk`, packed `@logbrew/next`, packed `@logbrew/browser`, `next@16.2.9`, real `.next/static/chunks` output, manifest/source-map Debug ID proof, runtime browser issue payload proof, local symbolication proof, and loopback upload retry proof.

## Remaining Gaps

- LogBrew still does not claim hosted source-map upload/lookup/symbolication parity from this local proof.
- LogBrew still trails Sentry/Datadog on automatic exception grouping, source context UI, cause chains, frame modifiers, suppression rules, and hosted symbolicated stack presentation.
- Next high-impact frontend/source-map work should prove hosted release-artifact upload/lookup/symbolicated runtime errors when the public backend contract is available, then improve grouping and source-context ergonomics.
