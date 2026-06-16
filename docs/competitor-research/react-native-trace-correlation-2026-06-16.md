# React Native Trace Correlation Research - 2026-06-16

## Gap

LogBrew React Native already shipped a thin provider/hook layer, screen/app-state helpers, handled error capture, product action and network milestone helpers, and target-scoped `traceparent` fetch propagation. It was still weaker than Sentry, Datadog, and OpenTelemetry for debugging a mobile operation because app-owned screen/action/error/network events did not share one active trace context by default.

## Public Source Reviewed

- Sentry React Native `getsentry/sentry-react-native@580fb5c7bf39cc1a8caf7a30af9078c887eb40b9`.
- Read `packages/core/src/js/scopeSync.ts`: `enableSyncToNative(...)` wraps scope mutation APIs and syncs primitive user/tags/context/breadcrumb/attribute state to native SDKs.
- Read `packages/core/src/js/wrapper.ts`: `fetchNativeLogAttributes(...)` and `setActiveSpanId(...)` bridge JS/native log and span context.
- Read `packages/core/src/js/tracing/span.ts`: `startIdleNavigationSpan(...)` reads the active span and manages route transaction state.
- Read `packages/core/src/js/tracing/reactnavigation.ts`: navigation dispatch starts route spans and calls `NATIVE.setActiveSpanId(...)` for time-to-display/native correlation.
- Read `packages/core/src/js/options.ts`: `propagateTraceparent` and `tracePropagationTargets` document W3C header propagation and CORS allow-list expectations.
- Datadog React Native `DataDog/dd-sdk-reactnative@92462dccefd689815d87dabbad0d41572cd06cca`.
- Read `packages/core/src/rum/instrumentation/resourceTracking/distributedTracing/headers.ts`: W3C, Datadog, B3, baggage, and tracestate header names.
- Read `packages/core/src/rum/instrumentation/resourceTracking/distributedTracing/distributedTracingSampling.ts`: stable trace sampling based on session or trace low bits.
- Read `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/DatadogRumResource/ResourceReporter.ts`: resource start/stop calls receive trace IDs and resource timing context.
- Read `packages/core/src/rum/instrumentation/interactionTracking/DdBabelInteractionTracking.ts`: user interaction wrappers add RUM actions around app-owned handlers.
- OpenTelemetry JS `open-telemetry/opentelemetry-js@96619ed69e84613846e0ea94453711fc0cd02e18`.
- Read `packages/opentelemetry-core/src/trace/W3CTraceContextPropagator.ts`: strict W3C extraction/injection with invalid-header fallback to unchanged context.
- Read `packages/opentelemetry-sdk-trace-web/test/StackContextManager.test.ts`: stack context manager returns to the previous context after nested `with(...)` calls.

## Competitor Pattern

- Sentry is stronger because React Native captures can read shared scope/span state, and navigation spans sync active span IDs to native timing/log layers.
- Datadog is stronger because resource and action instrumentation carries correlation context and tracing headers through mobile network/RUM flows.
- OpenTelemetry is stronger because W3C propagation is a dedicated context operation and malformed trace headers do not break user code.

## LogBrew Implementation

- Added dependency-free `createReactNativeTraceContext(...)` to continue valid W3C `traceparent` values with a fresh local span ID and fall back to local roots for missing or malformed incoming propagation.
- Added `getActiveLogBrewTrace()`, `withLogBrewTrace(...)`, and `bindLogBrewTrace(...)` as a stack-backed active trace surface for app-owned event handlers without pretending React Native has universal async context propagation.
- Added `getReactNativeTraceMetadata(...)`, `createReactNativeSpanAttributes(...)`, and `createReactNativeTraceHeaders(...)` for explicit logs, spans, and outbound request clients.
- Screen, app-state, product action, network, and handled error helpers now merge active or provider trace metadata and overwrite spoofed trace keys.
- `LogBrewNativeProvider` accepts `trace`, and `useLogBrewNativeActions()` passes that trace into hook helper captures. Hook `issue`, `log`, and `action` wrappers add trace metadata while preserving app-owned client setup.
- `createTraceparentFetch()` now reuses supplied or active trace context when no explicit `traceparentFactory` is provided, while still honoring target-scoped propagation and preserving existing headers.
- Added packaged `examples/trace-correlation.mjs` to prove one W3C trace links screen, action, network, error, span, and outgoing `traceparent`.

## Tradeoffs

- LogBrew intentionally did not copy Sentry native scope sync, navigation auto-instrumentation, Datadog XHR/fetch patching, Babel interaction rewriting, multi-format propagation, baggage, tracestate, replay, payload capture, or native bridge state.
- The React Native package remains a thin peer-dependency layer over `@logbrew/sdk`, React, and React Native. Async work after `await` should keep the returned trace object and pass it explicitly or use provider `trace`; this avoids stale global context leaks between unrelated mobile interactions.

## Evidence

- `python3 scripts/check_js_sources.py js/logbrew-react-native`
- `cd js/logbrew-react-native && npm test`
- `bash scripts/real_user_react_native_smoke.sh`
- `bash scripts/check_js_lint.sh`
- `bash scripts/check_js_package.sh`

## Remaining Gaps

- React Native still lacks automatic navigation/lifecycle spans, React Navigation route middleware, native bridge scope sync, `fetch`/XHR resource child spans, OTel context ingestion, baggage/tracestate, rich span events/exceptions, and source-map/native symbolication parity with Sentry/Datadog.
