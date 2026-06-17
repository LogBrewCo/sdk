# Backend Contract Report: Release Artifact Symbolication - 2026-06-13

## Status

This is an SDK-originated backend contract request. No SDK currently advertises source-map or native debug-symbol support as release-ready. SDK-side validation now has `scripts/create_js_release_artifact_manifest.py`, which creates a dry-run JavaScript source-map manifest without uploading or storing artifacts, `scripts/prepare_js_release_artifact_debug_ids.py`, which dry-runs or explicitly writes matching Debug IDs into built JavaScript/source-map pairs, `scripts/create_native_release_artifact_manifest.py`, which creates a dry-run native/mobile artifact manifest for iOS dSYM bundles, Android ProGuard/R8 mappings, and Android native `.so` symbols, and real-user smoke scripts that prove web `.js`, React Native-style `.jsbundle`, dSYM-structure, ProGuard-mapping, and Android ELF-symbol validation without backend upload. Backend handoff is pending because no backend automation/thread target is exposed in this session.

## Priority

P1 - This blocks production-grade frontend, mobile, native, and Unity debugging confidence against Sentry/Datadog-class expectations. Runtime SDKs can still ship safely, but LogBrew should not claim release-artifact symbolication support until backend upload, validation, lookup, and symbolicated error proof exist.

## User Impact

Developers comparing LogBrew with Sentry or Datadog will see a major production triage gap: minified JavaScript errors and native/mobile crashes remain hard to read unless LogBrew can match runtime stack frames to uploaded build artifacts. This weakens trust for frontend, React Native, mobile, Unity, and native SDK adoption even though runtime error capture works.

## Expected Backend Capability

LogBrew should support release-artifact ingestion separately from telemetry ingestion.

Required artifact identity:

- `release`: required, same product meaning as first-party telemetry ingest.
- `environment`: required for first-party parity and deployment isolation.
- `service`: required for multi-service apps and source-map matching.
- `artifactType`: one of `javascript_source_map`, `javascript_minified_source`, `ios_dsym`, `android_proguard_mapping`, `android_native_symbols`, `dotnet_pdb`, `breakpad_symbols`, `elf_debug`, `unity_symbols`.
- `debugId` or `artifactId`: optional at first, but required for debug-ID-based matching once SDK/tooling emits it.
- `minifiedPathPrefix` and `minifiedUrl`: required for JavaScript URL/path matching when no debug ID is present.
- `git.repositoryUrl` and `git.commitSha`: optional, app-owned, never inferred server-side.
- `artifactSha256`, `contentType`, `byteSize`, `createdAt`, and uploader SDK/tool version.

Suggested APIs:

- `POST /api/release-artifacts` for multipart upload of artifact file plus JSON metadata.
- `POST /api/release-artifacts/manifest` for dry-run validation without storing files.
- `GET /api/release-artifacts?release=...&environment=...&service=...` for deployment verification.
- Artifact retention endpoint for privacy requests and release hygiene.
- Internal symbolication lookup keyed by `release`, `environment`, `service`, `debugId` when present, otherwise normalized minified frame URL/path.

Validation and privacy behavior:

- Reject missing release, environment, service, artifact type, empty files, malformed source maps, and unsupported symbol formats.
- Enforce file size and artifact count limits per release.
- Normalize JavaScript frame URLs by removing query strings and fragments before matching.
- Treat source-map `sourcesContent` as sensitive. Accept it only when the uploader explicitly opts in; otherwise prefer maps without embedded source content and Git-link metadata.
- Store Git metadata only when provided by app-owned CI or tooling.
- Return structured validation errors with stable codes so SDK/CLI tests can assert behavior.

Runtime telemetry matching fields:

- Issue/error events should keep current release/environment requirements.
- Optional runtime fields should include `service`, `debugId`, `artifactId`, `bundleId`, `platform`, `runtime`, and stack frame `filename`/`lineno`/`colno`.
- SDKs must keep raw stack text opt-in. Symbolication should work with structured frames when available and avoid requiring raw unbounded stack strings as the only input.

## SDK Gap Observed

Current SDKs have no release artifact uploader, no framework build plugin, and no installed-app proof for source-map or debug-symbol lookup. The repo now has dry-run JavaScript artifact validation, Debug ID preparation, native/mobile dSYM, ProGuard/R8, and Android native `.so` manifest validation, and real-user build-output smokes in CI/release-readiness/public-verifier/checklist gates, but it is not a public upload or symbolication workflow. Runtime timeline helpers are strong, but they do not solve minified stack trace readability.

## Suggested SDK Work After Backend Contract

- Promote the local JavaScript manifest and Debug ID preparation scripts into a public artifact tool only after the backend contract exists; keep `upload` disabled until intake validation and auth behavior are proven.
- Start with Vite/Next generic build output before React Native debug-ID injection.
- Keep runtime packages dependency-light; do not add source-map parsing or upload dependencies to `@logbrew/sdk`.
- Add docs that teach release artifact setup separately from normal SDK install.
- Add real-user verifier apps that build minified JS, upload source maps to a local fake intake, emit a minified error with release/environment/service/debug ID, and assert a symbolicated result.
- After backend intake and lookup exist, add optional build-plugin proof for Vite/Next-style output so users can adopt artifact upload without adding dependencies to runtime SDK packages.
- Extend native/mobile contracts beyond the current dSYM-structure, ProGuard/R8, and Android native ELF dry-run manifests to PDB, Breakpad, Unity symbols, full UUID/build-id extraction, upload, lookup, and symbolicated-error proof.

## Competitor Evidence

- Sentry JavaScript docs describe source-map upload as a separate build/deploy workflow.
- Sentry public source at `getsentry/sentry-javascript@4e12c7a9013daa6b14e6b7e6106304e3eba42724` includes artifact bundle test utilities that pair minified source and source maps by `debug-id`, plus a SvelteKit Vite plugin that controls build source-map settings and upload timing.
- Datadog source-map docs and `DataDog/datadog-ci@74ed439f292a09a44d38de1f4f5ac092e9528b75` require service, release version, and minified path prefix for JavaScript source-map upload, validate source-map/minified files, attach optional Git metadata, and include React Native debug-ID injection.
- 2026-06-15 official-doc drift check: Sentry still recommends Debug IDs for source-map matching, while Datadog now documents an optional Source Maps build plugin that discovers `.js`/`.map` pairs and uploads them with Git metadata during builds.
- 2026-06-17 native/mobile source read: Sentry CLI `getsentry/sentry-cli@d9766db0b3c61cc6c0e445d8840c0765c42d6eea` has dry-run/no-upload ProGuard and debug-file commands in `src/commands/proguard/upload.rs`, `src/utils/proguard/upload.rs`, `src/utils/proguard/mapping.rs`, `src/commands/debug_files/upload.rs`, and `src/utils/dif_upload/mod.rs`. Sentry Android Gradle Plugin `getsentry/sentry-android-gradle-plugin@a5a55f8448cddd9e0282a89c436b339704b30ab3` wires ProGuard UUID generation/upload and native-symbol upload/no-upload tasks through `SentryGenerateProguardUuidTask.kt`, `SentryUploadProguardMappingsTask.kt`, `SentryUploadNativeSymbolsTask.kt`, and `SentryTasksProvider.kt`. Datadog CI `DataDog/datadog-ci@74ed439f292a09a44d38de1f4f5ac092e9528b75` exposes dSYM/ELF/Unity symbol dry-runs in `packages/base/src/commands/dsyms/upload.ts`, `dsyms/utils.ts`, `elf-symbols/upload.ts`, and `unity-symbols/upload.ts`.
- 2026-06-17 Android native symbol source read: Datadog CI `DataDog/datadog-ci@74ed439f292a09a44d38de1f4f5ac092e9528b75` `packages/base/src/commands/elf-symbols/elf.ts`, `upload.ts`, `interfaces.ts`, and `elf-constants.ts` parse ELF headers, GNU/Go build IDs, executable/shared-library type, architecture, `.debug_info`, `.symtab`, `.dynsym`, `.text`, code hash fallback, and symbol-source metadata before upload. LogBrew now mirrors the validation shape in a dependency-free dry-run manifest, but still has no backend upload, storage, lookup, or symbolicated-error proof.

## Verification Needed

- Backend unit tests for metadata validation, upload storage, duplicate artifact handling, and delete/list behavior.
- Symbolication tests for debug-ID match, release/environment/service mismatch, path-prefix match, query/hash stripping, and missing artifact fallback.
- Local fake-intake SDK tests for successful upload, auth failure, validation failure, oversized artifact, and retryable server failure. Dry-run manifest validation now has focused local tests for ready artifacts, React Native bundle artifacts, missing source maps, sensitive `sourcesContent`, debug-ID mismatch, dSYM structure, ProGuard/R8 class mapping validation, Android native ELF build ID/symbol-source validation, artifact-root confinement, and CLI nonzero exit on blocked manifests. Debug ID preparation now has focused local tests for dry-run-only behavior, explicit `--write` mutation, idempotency, React Native `.jsbundle` sibling-map fallback, map-only Debug ID propagation, mismatch blocking, and CLI nonzero exit on blocked plans. `scripts/real_user_js_release_artifact_smoke.sh` proves the local built-artifact flow end-to-end without backend upload: dry-run, explicit Debug ID write, idempotency, React Native-style bundle/map pairing, `sourcesContent` blocking, explicit allow, query/hash stripping, and no raw source content in the manifest. `scripts/real_user_native_release_artifact_smoke.sh` proves local dSYM, ProGuard/R8, and Android native ELF manifest validation without backend upload, absolute path leakage, symbol bytes, raw ELF debug-section bytes, or mapping class names in the manifest. These smokes are named in CI, release-readiness, the public verifier, and the SDK readiness checklist.
- Real temporary apps for Vite, Next, and React Native source maps before public SDK docs advertise support.
