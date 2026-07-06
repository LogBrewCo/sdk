# JavaScript Issue-Event Symbolication Proof - 2026-07-06

## User Gap

LogBrew could locally resolve a manually supplied minified JavaScript frame and could attach source-map Debug ID metadata to SDK issue events, but the installed CLI did not prove that a captured SDK issue event itself contained enough sanitized identity for symbolication. That left the source-map story weaker than Sentry and Datadog from a real debugging workflow view, even before hosted symbolicated issue rendering.

## Source Reading

- Sentry JavaScript `getsentry/sentry-javascript@989396c8f4e390b02dd62bc1ad2c271c449bd79c`
- `packages/browser/src/eventbuilder.ts`: `exceptionFromError`, `eventFromError`, `parseStackFrames`
- `packages/core/src/utils/debug-ids.ts`: `getFilenameToDebugIdMap`, `getDebugImagesForResources`
- `packages/core/src/utils/prepareEvent.ts`: `applyDebugIds`, `applyDebugMeta`
- `packages/core/test/lib/prepareEvent.test.ts`: debug-ID-to-`debug_meta.images` behavior

- Datadog Browser SDK `DataDog/browser-sdk@c2829e3dbf3e7e489508f2c1ea5a66035b1f7b55`
- `packages/browser-core/src/tools/stackTrace/computeStackTrace.ts`: `computeStackTrace`
- `packages/browser-core/src/domain/error/error.ts`: `computeRawError`
- `packages/browser-core/src/domain/error/error.spec.ts`: source-code-context Debug ID tests
- `packages/browser-rum-core/src/domain/error/errorCollection.ts`: `processError`
- `packages/browser-rum-core/src/domain/error/errorCollection.spec.ts`: `_dd.debug_ids` error event proof
- `packages/browser-rum-core/src/domain/contexts/sourceCodeMfeContext.ts`: stack URL to source-code context lookup

## Pattern

Sentry builds structured exception frames, maps runtime filenames to Debug IDs, and moves those Debug IDs into event-level `debug_meta.images` for server-side symbolication. Datadog parses browser stack frames, resolves source-code context, and carries `_dd.debug_ids` on RUM error events together with service/version context. Both prove that symbolication depends on the runtime event carrying enough frame and Debug ID identity, not just on a separate source-map upload.

## LogBrew Change

`logbrew-release-artifacts symbolicate-js` now accepts either `--stack-frame <frame>` or `--issue-event <file>`. The issue-event path accepts real SDK issue shapes with `attributes.metadata` or direct issue attributes with `metadata`, requires matching `release`, `environment`, `service`, `releaseArtifactType: "sourcemap"`, `releaseArtifactDebugId`, `releaseArtifactCodeFile`, `errorFrameLine`, and `errorFrameColumn`, then resolves the event through the prepared manifest.

The verifier output includes only sanitized generated path/minified URL, Debug ID, source-map path, and original source path/line/column. It strips query/hash text through existing frame normalization and still rejects `sourcesContent` or local absolute source paths.

## Tradeoffs

- Better than a manual-frame-only verifier because it proves the actual SDK issue payload can be matched to local source-map artifacts.
- Safer than copying Sentry's hidden runtime Debug ID globals because LogBrew keeps runtime artifact identity explicit and app-owned.
- Smaller than Datadog RUM's broader event model because LogBrew does not add sessions, view context, source-code MFE context, or raw stack capture here.
- Still not hosted parity: backend upload, lookup, source-context rendering, grouping UI, and end-to-end symbolicated issue views remain backend-owned hosted proof.

## Verification

- RED: `npm --prefix js/logbrew-js test -- test/release-artifacts-cli.test.js` failed because `symbolicate-js` rejected `--issue-event` as an unknown option.
- GREEN: `npm --prefix js/logbrew-js test -- test/release-artifacts-cli.test.js`.
- GREEN: `bash scripts/real_user_js_release_artifact_cli_smoke.sh` packs `@logbrew/sdk`, installs it into a temporary app, runs `node_modules/.bin/logbrew-release-artifacts symbolicate-js --issue-event`, and verifies sanitized issue-event symbolication without source text, query/hash, temp path, or placeholder auth-value leakage.

## Remaining Gap

Sentry remains stronger for automatic build/runtime Debug ID integration and hosted issue rendering. Datadog remains stronger for RUM source-code-context enrichment and hosted error workflows. LogBrew's next highest-impact work is hosted release-artifact upload/lookup/symbolicated issue proof once backend verifier access/routes are available; SDK-side work should keep improving installed local proof without claiming hosted symbolication support.
