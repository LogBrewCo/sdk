# Browser Error Grouping Hints - 2026-07-04

## User Gap

Frontend users need low-noise issue grouping so repeated production browser errors collapse into a useful debugging thread. Before this pass, LogBrew browser/source-map issue metadata could carry release, environment, trace/span, first frame, and Debug ID hints, but it did not emit a stable grouping hint or accept an app-owned grouping fingerprint.

## Source Reading

- Sentry JavaScript `68fe9e8fbcf70f1a92468410a1686787d4f724a6`
- `packages/core/src/scope.ts`: `setFingerprint(fingerprint: string[])`
- `packages/core/src/utils/scopeData.ts`: `applyFingerprintToEvent(...)`
- `packages/browser/src/eventbuilder.ts`: object/Event exception builder notes that grouping by stable exception shape is better than grouping by changing key values.
- Pattern: Sentry lets users set an explicit fingerprint at the scope/event layer and otherwise relies on structured exceptions plus stack frames for server-side grouping. The strong side is mature grouping control; the cost is a larger event pipeline and backend grouping dependency.

- Datadog Browser SDK `d2c7e303e4533f40e93d447042a67571f7ba97ff`
- `packages/browser-core/src/domain/error/error.ts`: `computeRawError(...)`, `tryToGetFingerprint(...)`
- `packages/browser-rum-core/src/domain/error/errorCollection.ts`: error event assembly maps `error.fingerprint` into the RUM error payload alongside `_dd.debug_ids`.
- Pattern: Datadog accepts an app-provided `dd_fingerprint` from the original error and carries it with runtime/source-map metadata. The strong side is simple user override; the risk is users can put high-cardinality or sensitive values in the fingerprint if they are not careful.

- PostHog JS `e480a3e23ecff45d2f9cf50332f6f59c54a7c736`
- `packages/browser/src/extensions/exception-autocapture/index.ts`: exception autocapture rate-limits by exception type.
- `packages/browser/src/posthog-exceptions.ts`: suppression rules match exception types/values.
- `packages/core/src/error-tracking/error-properties-builder.ts`: exception list builder records type/value/mechanism/frames.
- Pattern: PostHog focuses on exception shape, suppression, and rate limiting before hosted grouping. The useful lesson for LogBrew is to keep grouping hints stable and avoid message/query-value cardinality.

## LogBrew Change

- `@logbrew/sdk` `createIssueAttributesFromError(...)` now emits `issueGroupingKey` based on source, error type, and the sanitized first frame. If no frame is available, the key falls back to source plus error type.
- The helper accepts optional `fingerprint` and emits it as `issueFingerprint` with `issueGroupingSource: "explicit_fingerprint"`. Fingerprints are app-owned, trimmed, required to be non-empty strings, and documented as safe and low-cardinality.
- `@logbrew/browser` normalizes browser grouping-key frame files to path-only values, matching its existing first-frame and release-artifact metadata privacy behavior.
- `@logbrew/browser` manual error and unhandled-rejection event creation pass the optional fingerprint through to the core helper.

## Why This Is Lighter Than Competitors

- LogBrew does not claim hosted grouping parity from this SDK-only pass.
- It does not use error messages, full URLs, query strings, hash fragments, headers, payloads, cookies, replay data, baggage, or tracestate to build grouping hints.
- It gives backend grouping and agent diagnostics a stable, privacy-bounded hint now, while leaving richer grouping rules, suppression, cause-chain handling, source context, and hosted symbolicated stack presentation to public backend contracts.

## Verification

- RED: `node --test --test-name-pattern "createIssueAttributesFromError" js/logbrew-js/test/sdk.test.js` failed on missing `issueGroupingKey`, `issueGroupingSource`, and `issueFingerprint`.
- GREEN: `node --test --test-name-pattern "createIssueAttributesFromError" js/logbrew-js/test/sdk.test.js` passed 4 focused JS issue tests.
- GREEN: `node --test --test-name-pattern "browser.*grouping|installed browser errors attach release artifact" js/logbrew-browser/test/trace-context.test.mjs` passed installed browser source-map and grouping tests.
- GREEN: `npm --prefix js/logbrew-js test` passed 88 JS SDK tests.
- GREEN: `npm --prefix js/logbrew-browser test` passed module syntax checks and 26 browser tests.
- GREEN: `scripts/real_user_vite_release_artifact_smoke.sh` passed with packed `@logbrew/sdk`, packed `@logbrew/browser`, `vite@8.0.16`, path-only runtime source-map metadata, grouping-key assertions, local symbolication, and loopback fake-intake 503-to-202 retry proof.

## Remaining Gaps

- Sentry and Datadog still lead on hosted grouping engines, source-context UI, cause chains, suppression rules, grouping previews, and symbolicated stack presentation.
- PostHog still has useful exception suppression/rate-limiting ergonomics that LogBrew has not matched yet.
- Next highest-impact work should either unblock backend-hosted symbolication/grouping contracts or add safe SDK-side cause-chain and suppression-rule hints without capturing stack text by default.

## Follow-Up: Browser Error Suppression - 2026-07-06

### Additional Source Reading

- Sentry JavaScript `5abfc34cb4681ad90f32ab3ed865741955279778`
- `packages/core/src/integrations/eventFilters.ts`: `eventFiltersIntegration(...)`, `_mergeOptions(...)`, `_shouldDropEvent(...)`, `_isIgnoredError(...)`, `_isDeniedUrl(...)`, `_isAllowedUrl(...)`
- `packages/core/src/types/options.ts`: `ignoreErrors`, `allowUrls`, and `denyUrls` options
- `packages/core/src/client.ts`: `processBeforeSend(...)` handles `beforeSend` returning `null`
- Pattern: Sentry filters noisy errors in the client pipeline through option-driven matchers and `beforeSend`. The strong side is mature low-noise control; the tradeoff is a broader event pipeline with many integration defaults.

- Datadog Browser SDK `c2829e3dbf3e7e489508f2c1ea5a66035b1f7b55`
- `packages/browser-rum-core/src/domain/assembly.ts`: `shouldSend(...)`
- `packages/browser-rum-core/src/domain/configuration/configuration.ts`: `beforeSend` and `RumBeforeSend`
- Pattern: Datadog lets `beforeSend` return `false` to discard RUM events before delivery. The strong side is a simple user hook; the tradeoff is that apps must be careful not to inspect or forward sensitive event detail.

- PostHog JS `26b92fea20b9cf4c64ce251857aead8e859ed66c`
- `packages/browser/src/posthog-exceptions.ts`: `sendExceptionEvent(...)`, `_matchesSuppressionRule(...)`
- `packages/core/src/types.ts`: `before_send` returning `null`
- Pattern: PostHog combines exception-specific suppression rules with a generic pre-send hook. The useful lesson is explicit local noise control before hosted grouping.

### LogBrew Follow-Up Change

- `@logbrew/browser` now supports explicit `errorSuppressionRules` for browser errors and unhandled rejections. Rules can match source, error name, current path, path-only frame file, grouping key, fingerprint, or local message.
- `shouldCaptureError(event, summary)` can return `false` for app-owned suppression logic.
- Suppressed issues return `{ suppressed: true, reason }`, are not queued, and do not flush the transport.
- `onIssueSuppressed(summary, context, details)` receives a safe summary with source, error type, path, path-only frame file, grouping key, optional fingerprint, and reason.

### Privacy Boundary

- LogBrew suppression summaries omit raw messages, stacks, full URLs, hosts, query strings, hashes, headers, payloads, cookies, replay data, baggage, and tracestate.
- Rule reasons are normalized to stable low-cardinality strings.
- This is SDK-side noise control only; it does not claim hosted grouping, source context, issue merging, or symbolicated stack presentation parity.

### Additional Verification

- RED: `node --test --test-name-pattern "suppression|shouldCaptureError" js/logbrew-browser/test/trace-context.test.mjs` failed before implementation because noisy browser issues still queued/flushed.
- GREEN: the same focused browser tests pass with rule suppression, callback suppression, safe summaries, and no queued telemetry.
- Installed-artifact smoke now proves packaged README guidance, typed API exports, local suppression result, no transport delivery, no queued issue, and no leaked full URL/message/stack detail in suppression summaries.
