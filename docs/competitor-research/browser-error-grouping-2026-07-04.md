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
