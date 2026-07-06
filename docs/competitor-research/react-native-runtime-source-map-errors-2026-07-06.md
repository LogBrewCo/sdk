# React Native Runtime Source-Map Errors - 2026-07-06

## User Gap

React Native users need handled JavaScript errors to connect back to uploaded Metro bundle source maps. LogBrew already had local React Native release-artifact preparation and upload dry-runs, but runtime `captureReactNativeError()` did not attach Debug ID, release, environment, service, runtime, or sanitized frame metadata. That made source-map-ready errors weaker than Sentry's runtime Debug ID story.

## Competitor Source Read

- Sentry React Native `getsentry/sentry-react-native@b5288f646ce32ce1859dcf7e1285d7cd43b14fea`
- Sentry paths read: `packages/core/src/js/tools/sentryMetroSerializer.ts`, `packages/core/src/js/tools/utils.ts`, `packages/core/scripts/has-sourcemap-debugid.js`, `packages/core/scripts/copy-debugid.js`, `packages/expo-upload-sourcemaps/cli.js`, `packages/core/src/js/integrations/debugsymbolicator.ts`, `packages/core/src/js/integrations/debugsymbolicatorutils.ts`, and `packages/core/src/js/profiling/debugid.ts`
- Sentry functions/classes read: Metro Debug ID serializer helpers, `createDebugIdSnippet`, `copy-debugid.js` Debug ID propagation, Expo source-map upload Debug ID normalization, DebugSymbolicator stack parsing/source context helpers, and profiling Debug ID extraction
- Datadog React Native `DataDog/dd-sdk-reactnative@fbaedbbd043d123017c7ef90f2e77d3fb272644e`
- Datadog paths read: `packages/codepush/src/index.ts`, `packages/codepush/src/__tests__/index.test.tsx`, `packages/react-native-navigation/src/__tests__/rum/instrumentation/DdRumReactNativeNavigationTracking.test.tsx`, and `packages/core/src/types.tsx`

## Pattern

Sentry is stronger for this exact gap: its Metro/build tooling injects Debug IDs into bundles and maps, maintains Hermes source-map Debug ID continuity, and exposes runtime Debug ID lookup paths. Datadog's React Native public SDK source focuses more on RUM configuration, CodePush version alignment, navigation, native crash/error settings, and source-map upload through Datadog CI rather than a comparable in-SDK runtime Debug ID map.

The useful pattern for LogBrew is not hidden global patching. It is explicit release-artifact metadata flowing from build output to runtime issue events: release, environment, service, runtime, a frame file that can match the minified bundle, and a Debug ID that can join to the prepared source map.

## LogBrew Change

`@logbrew/react-native` now lets `createReactNativeErrorEvent()` and `captureReactNativeError()` accept `debugIdMap`, `release`, `environment`, `service`, `runtime`, and `fingerprint`. It reuses the core `createIssueAttributesFromError()` helper, keeps stack text opt-in, and then normalizes React Native frame metadata to path-only values so runtime hosts, query strings, fragments, and local absolute paths do not leak into issue metadata.

The installed React Native release-artifact smoke now builds a real Metro bundle, prepares a Debug-ID source-map manifest, synthesizes a runtime error stack from the generated bundle position, queues an issue through an installed `@logbrew/react-native` client, and proves `releaseArtifactDebugId`, path-only `releaseArtifactCodeFile`/`errorFrameFile`, release/environment/service/runtime, issue grouping, and trace/span IDs.

## Tradeoffs

- Better than copying Sentry's runtime global snippet for privacy: apps pass an explicit Debug ID map and LogBrew avoids hidden globals.
- Weaker than Sentry for zero-setup runtime Debug ID discovery because LogBrew does not inject or read a global Debug ID table from app startup.
- Better than broad URL matching: metadata strips host, query, hash, and local absolute paths before issue serialization.
- Still not hosted symbolication: this proves local runtime metadata and source-map readiness, not backend upload, lookup, source context, or rendered symbolicated stack traces.

## Verification

- RED: `python3 -m unittest tests.test_release_artifact_smoke_gates.ReleaseArtifactSmokeGateTests.test_react_native_smoke_links_runtime_error_to_release_artifact_debug_id` failed on missing React Native runtime source-map issue proof.
- GREEN: `node --test --test-name-pattern "React Native error events attach" js/logbrew-react-native/test/instrumentation.test.js`
- GREEN: `npm --prefix js/logbrew-react-native test`
- GREEN: `python3 -m unittest tests.test_release_artifact_smoke_gates.ReleaseArtifactSmokeGateTests.test_react_native_smoke_links_runtime_error_to_release_artifact_debug_id`
- GREEN: `bash scripts/real_user_react_native_release_artifact_smoke.sh` with `react-native@0.86.0`, `react@19.2.7`, `@react-native-community/cli@20.2.0`

## Remaining Gap

Sentry remains ahead on automatic React Native build integration, runtime Debug ID globals, hosted source-map lookup, source-context rendering, native crash symbolication, and end-to-end symbolicated issue UI. Next highest-impact LogBrew work is hosted upload/lookup/symbolicated-runtime-error proof, followed by optional framework-owned build integration that stays explicit and reversible.
