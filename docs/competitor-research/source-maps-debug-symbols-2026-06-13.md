# Source Maps and Debug Symbols Competitor Review - 2026-06-13

This note records why LogBrew is currently behind Sentry and Datadog for post-deploy stack trace quality, and what we should build without copying their heavy default behavior.

## Sources Checked

- Sentry JavaScript source maps docs: https://docs.sentry.io/platforms/javascript/sourcemaps/
- Sentry CLI source maps upload docs: https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/cli/
- Sentry JavaScript public repo at `getsentry/sentry-javascript@4e12c7a9013daa6b14e6b7e6106304e3eba42724`
- Sentry source paths read: `dev-packages/test-utils/src/sourcemap-upload-utils.ts`, `packages/sveltekit/src/vite/sourceMaps.ts`
- Datadog JavaScript source maps docs: https://docs.datadoghq.com/real_user_monitoring/guide/upload-javascript-source-maps/
- Datadog CI public repo at `DataDog/datadog-ci@74ed439f292a09a44d38de1f4f5ac092e9528b75`
- Datadog source paths read: `packages/base/src/commands/sourcemaps/README.md`, `packages/base/src/commands/sourcemaps/upload.ts`, `packages/base/src/commands/sourcemaps/interfaces.ts`, `packages/base/src/commands/sourcemaps/validation.ts`, `packages/base/src/helpers/git/format-git-sourcemaps-data.ts`, `packages/base/src/commands/react-native/injectDebugId.ts`

## What Competitors Do Better Today

Sentry and Datadog both treat source maps and native symbols as release artifacts, not as normal runtime telemetry. The user uploads build output and metadata before or during deploy, then runtime errors carry enough release and artifact identity for the backend to unminify or symbolicate stack frames later.

Sentry's JavaScript source shows two useful patterns:

- Artifact bundles connect minified source and source maps with `debug-id` metadata, so lookup does not depend only on file URL strings.
- Framework helpers can alter build settings, upload after framework output is complete, warn when source maps are disabled, and optionally delete local source maps after upload.

Datadog's CLI source shows a complementary set of patterns:

- Upload requires service, release version, and minified path prefix, which makes runtime matching explicit and avoids relying on raw browser URLs alone.
- Payloads include minified file, source map, and metadata as separate multipart parts.
- Git metadata can be attached for source links, but users can disable git collection or provide repository URL and commit SHA explicitly.
- Validation checks for missing and empty source maps or minified files before upload.
- React Native gets an explicit debug-ID injection command for bundle/source-map matching.

## Where LogBrew Is Worse

LogBrew SDKs can capture errors and releases, and stack text is intentionally opt-in for privacy. That is safer than many defaults, but it is not enough to compete on production JavaScript or native crash triage:

- There is no public artifact upload API for source maps, dSYMs, ProGuard mappings, PDBs, Breakpad symbols, ELF debug files, or Unity symbols.
- There is no artifact identity field such as `debugId` or `artifactId` in public runtime guidance.
- There is no build-time uploader, dry-run manifest, framework plugin, or CI example.
- There is no backend symbolication contract tying runtime issue frames to uploaded release artifacts.
- There is no real-user proof that a minified stack trace can be resolved without exposing source maps publicly.

## Product Direction

LogBrew should not copy heavyweight auto-instrumentation or upload raw source by default. The better LogBrew version should be explicit, auditable, and privacy-first:

- Make artifact upload separate from runtime SDK installation.
- Require explicit release, environment, service, and artifact identity.
- Default to dry-run and manifest previews in CLI/build tooling.
- Strip query strings and fragments from minified paths before matching.
- Treat `sourcesContent` as a sensitive opt-in, with a documented default to exclude or scrub source content where possible.
- Preserve Git metadata only when app-owned CI opts in, with `--disable-git` and explicit `repositoryUrl`/`commitSha` alternatives.
- Keep runtime SDKs dependency-light; source-map upload belongs in a separate tool/package or framework-owned build plugin.

## Concrete LogBrew Work

- Define the backend contract before adding SDK claims: upload, list, delete, validation error, and symbolication lookup shapes.
- Add a JS build-artifact helper only after the backend contract exists; start with a dry-run manifest and local verifier before real upload.
- Add runtime docs/API fields for optional `debugId` or `artifactId` only after ingestion and issue lookup can consume them.
- Add Vite/Next/React Native proof apps that create minified errors, upload artifacts to a local intake, and verify unminified output.
- Add native follow-up contracts for Swift/Kotlin/Unity/C/C++/Objective-C symbol formats instead of claiming crash symbolication from normal error capture.
