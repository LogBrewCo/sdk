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

## Follow-Up Source Review

- Re-read Sentry React Native `packages/core/src/js/tracing/reactnavigation.ts`: `reactNavigationIntegration(...)`, `registerNavigationContainer(...)`, `updateLatestNavigationSpanWithCurrentRoute(...)`, and route transaction handling show why navigation spans need route-name continuity, previous-route context, and native span sync for deep mobile debugging.
- Re-read Sentry React Native `packages/core/src/js/tracing/span.ts`: `startIdleNavigationSpan(...)` and idle-span lifecycle handling show the value of route spans without making user handlers responsible for every transition.
- Re-read Datadog React Native `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/DatadogRumResource/ResourceReporter.ts`: `ResourceReporter.reportResource(...)`, `formatResourceStartContext(...)`, and `formatResourceStopContext(...)` show how resource spans attach method, URL-like resource names, status, size, timing, and tracing IDs.
- Re-read Datadog React Native `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/XHRProxy.ts`: `reportXhr(...)` and proxied `onreadystatechange` show the stronger-but-heavier pattern of automatic XHR interception, timing capture, status capture, response-size calculation, and optional GraphQL payload/error extraction.
- Re-read Datadog React Native `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/interfaces/RumResource.ts`: `RUMResource` confirms resource timing and tracing fields are first-class in stronger mobile SDKs.
- Re-read Sentry React Native `packages/core/src/js/options.ts`: `propagateTraceparent`, `tracePropagationTargets`, and `enableCaptureFailedRequests` show why outgoing `traceparent` must stay opt-in/target-scoped and why automatic failed-request capture crosses into heavier platform-specific instrumentation.
- Re-read OpenTelemetry JS `packages/opentelemetry-core/src/trace/W3CTraceContextPropagator.ts` and `packages/opentelemetry-sdk-trace-web/test/StackContextManager.test.ts`: propagation remains strict and stack scopes return to the previous context after nested work.

## Lifecycle Follow-Up Source Review

- Re-read Sentry React Native `packages/core/src/js/tracing/span.ts`: `startIdleSpan(...)` checks `AppState.currentState` and avoids starting spans when the app is already backgrounded or iOS-inactive.
- Re-read Sentry React Native `packages/core/src/js/tracing/onSpanEndUtils.ts`: `cancelInBackground(...)` subscribes to `AppState` changes, records when the app left foreground, cancels active spans on background, and handles iOS `inactive` as a delayed background signal.
- Re-read Datadog React Native `packages/react-native-navigation/src/rum/instrumentation/DdRumReactNativeNavigationTracking.tsx`: `startTracking(...)`, `stopTracking(...)`, and `appStateListener(...)` attach `AppState` changes to view start/stop behavior so foreground/background transitions affect the active mobile view.
- Re-read OpenTelemetry JS `packages/opentelemetry-sdk-trace-web/src/StackContextManager.ts` and `packages/opentelemetry-sdk-trace-web/test/StackContextManager.test.ts`: `with(...)` returns to the previous context in `finally`, which supports LogBrew's stack-backed trace scopes and explicit lifecycle callbacks without retaining global active context.

## LogBrew Implementation

- Added dependency-free `createReactNativeTraceContext(...)` to continue valid W3C `traceparent` values with a fresh local span ID and fall back to local roots for missing or malformed incoming propagation.
- Added `getActiveLogBrewTrace()`, `withLogBrewTrace(...)`, and `bindLogBrewTrace(...)` as a stack-backed active trace surface for app-owned event handlers without pretending React Native has universal async context propagation.
- Added `getReactNativeTraceMetadata(...)`, `createReactNativeSpanAttributes(...)`, and `createReactNativeTraceHeaders(...)` for explicit logs, spans, and outbound request clients.
- Screen, app-state, product action, network, and handled error helpers now merge active or provider trace metadata and overwrite spoofed trace keys.
- `LogBrewNativeProvider` accepts `trace`, and `useLogBrewNativeActions()` passes that trace into hook helper captures. Hook `issue`, `log`, and `action` wrappers add trace metadata while preserving app-owned client setup.
- `createTraceparentFetch()` now reuses supplied or active trace context when no explicit `traceparentFactory` is provided, while still honoring target-scoped propagation and preserving existing headers.
- Added packaged `examples/trace-correlation.mjs` to prove one W3C trace links screen, action, network, error, span, and outgoing `traceparent`.
- Added explicit `captureReactNativeNavigationSpan(...)`, `createReactNativeNavigationSpanEvent(...)`, `captureReactNativeResourceSpan(...)`, `createReactNativeResourceSpanEvent(...)`, and `createReactNavigationSpanListener(...)`.
- The React Navigation listener accepts app-owned container refs, captures optional initial route spans plus route-change spans, strips query/hash text from route paths, carries previous route name, and keeps route keys opt-in to avoid high-cardinality defaults.
- Resource span helpers capture method, route template, duration, status code, response size, screen, and session ID while mapping 4xx/5xx status codes to `error` without deriving payload/header details.
- Added packaged `examples/navigation-resource-spans.mjs` to prove one W3C trace links initial navigation, route-change navigation, successful resource, and failed resource spans with primitive-only metadata.
- Added the explicit `@logbrew/react-native/resource-fetch` subpath with `createReactNativeResourceFetch(...)`, an app-owned fetch wrapper that reuses `createTraceparentFetch(...)`, records a resource span for success or thrown fetch errors, strips query/hash text from route templates, preserves target-scoped `traceparent` propagation, and avoids global `fetch`/XHR patching.
- Added packaged `examples/resource-fetch-spans.mjs` to prove one W3C trace links a successful resource fetch span, a failed resource fetch span, sanitized route templates, provider trace propagation for matched API targets, and no `traceparent` on unmatched targets.
- Added the explicit `@logbrew/react-native/lifecycle` subpath with `createReactNativeLifecycleSpanEvent(...)`, `captureReactNativeLifecycleSpan(...)`, and `createAppStateLifecycleSpanListener(...)`.
- The lifecycle listener records AppState transitions such as `app_state:active->background`, measures duration from the previous observed AppState when possible, carries active/provider trace metadata, preserves primitive-only metadata, and avoids global React Native patching, native bridge scope sync, session-health derivation, or hidden foreground/background policy.
- Added packaged `examples/lifecycle-spans.mjs` to show one W3C trace links initial, inactive, background, and foreground lifecycle spans with listener removal and primitive-only metadata.

## Native Bridge Scope Sync Follow-Up - 2026-06-17

- Re-used the earlier source reading of Sentry React Native `packages/core/src/js/scopeSync.ts`, `packages/core/src/js/wrapper.ts`, and `packages/core/src/js/tracing/reactnavigation.ts` at `getsentry/sentry-react-native@580fb5c7bf39cc1a8caf7a30af9078c887eb40b9`: Sentry is stronger because JavaScript scope/span changes can be mirrored into native SDK state and navigation can call native active-span sync for timing/log correlation.
- Re-used Datadog React Native `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/DatadogRumResource/ResourceReporter.ts` and `packages/core/src/rum/instrumentation/resourceTracking/distributedTracing/headers.ts` at `DataDog/dd-sdk-reactnative@92462dccefd689815d87dabbad0d41572cd06cca`: Datadog is stronger because native/RUM resource reporting carries trace identifiers through automatic instrumentation, but pays complexity and privacy costs from broader interception.
- Added the explicit `@logbrew/react-native/native-bridge` subpath with `createLogBrewNativeBridgeScope(...)`, `syncLogBrewNativeBridgeScope(...)`, `clearLogBrewNativeBridgeScope(...)`, and `withLogBrewNativeBridgeScope(...)`.
- The helper accepts an app-owned bridge callback or object with `setLogBrewScope(...)`/`syncLogBrewScope(...)`, syncs only trace IDs, span IDs, flags, sampled state, and primitive logger/screen/session metadata, then clears the scope after sync or after an async callback settles.
- Added packaged `examples/native-bridge-scope.mjs` to prove native bridge sync, async clear behavior, primitive metadata dropping, and one correlated LogBrew log event from the installed tarball.
- LogBrew intentionally still avoids native module installation, automatic Sentry-style global scope sync, native SDK state ownership, bridge argument inspection, user/session identity sync, payload/header capture, automatic navigation/resource/lifecycle instrumentation, baggage, and tracestate.

## Reversible Instrumentation Kit Follow-Up - 2026-06-17

- Confirmed current upstream HEADs before implementation: Sentry React Native remains `getsentry/sentry-react-native@580fb5c7bf39cc1a8caf7a30af9078c887eb40b9`, Datadog React Native remains `DataDog/dd-sdk-reactnative@92462dccefd689815d87dabbad0d41572cd06cca`, and OpenTelemetry JS is now `open-telemetry/opentelemetry-js@e8b0b7618beaf29b79e2b8ab6e0235e0dfd60cfc`.
- Re-read Sentry React Native `packages/core/src/js/tracing/reactnavigation.ts`: `reactNavigationIntegration(...)`, `registerNavigationContainer(...)`, `startIdleNavigationSpan(...)`, `updateLatestNavigationSpanWithCurrentRoute(...)`, and native active-span calls show the stronger automatic route setup pattern and why route/listener state must be removable and guarded.
- Re-read Sentry React Native `packages/core/src/js/scopeSync.ts`: `enableSyncToNative(...)` wraps scope mutation methods and syncs primitive scope state to native. This supports LogBrew's explicit native bridge adapter but argues against hidden global scope mutation in a thin public SDK.
- Re-read Datadog React Native `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/XHRProxy.ts`: `onTrackingStart(...)`, `onTrackingStop(...)`, proxied `open`/`send`/`setRequestHeader`, `reportXhr(...)`, and GraphQL header handling show stronger automatic resource setup with real stop semantics, but also global XHR mutation, baggage/header rewriting, and payload-aware paths LogBrew should avoid by default.
- Re-read OpenTelemetry JS `packages/opentelemetry-sdk-trace-web/src/StackContextManager.ts` at `open-telemetry/opentelemetry-js@e8b0b7618beaf29b79e2b8ab6e0235e0dfd60cfc`: `with(...)` still returns to the previous context in `finally`, supporting LogBrew's stack/reversible setup model rather than ambient async context claims.
- Added explicit `@logbrew/react-native/instrumentation` with `createLogBrewReactNativeInstrumentation(...)`, a removable setup handle that composes existing AppState lifecycle spans, React Navigation spans, target-scoped resource fetch spans, and native bridge scope sync.
- The handle exposes `trace`, `resourceFetch(...)`, `syncNativeBridgeScope(...)`, `withNativeBridgeScope(...)`, `remove()`, and `stop()` while preserving one shared trace across installed integrations.
- Added packaged `examples/instrumentation-kit.mjs` to validate setup/removal behavior, listener removal, native bridge clear, target-scoped `traceparent`, lifecycle/navigation/resource/native-bridge correlation, and primitive-only metadata after installing the tarball.
- LogBrew intentionally still avoids global `fetch`/XHR patching, React Navigation monkey-patching, hidden AppState observers, native module installation, bridge argument inspection, GraphQL payload extraction, arbitrary header capture, full URL/query/hash capture, user/session identity sync, baggage, and tracestate.

## Opt-In Global Fetch Follow-Up - 2026-06-23

- Refreshed Sentry React Native `getsentry/sentry-react-native@88735e9773479a60cf16c986aa701112bbc137e4`.
- Re-read `packages/core/src/js/tracing/reactnavigation.ts`: `reactNavigationIntegration(...)`, `registerNavigationContainer(...)`, `startIdleNavigationSpan(...)`, route-state tracking, and latest-span handling show the stronger automatic integration style but also the amount of global navigation state it owns.
- Re-read `packages/core/src/js/scopeSync.ts`: `enableSyncToNative(...)` wraps scope mutation methods once and syncs primitive data into native. This supports reversible, one-time patching when explicitly enabled, but not hidden default mutation in LogBrew.
- Refreshed Datadog React Native `DataDog/dd-sdk-reactnative@92462dccefd689815d87dabbad0d41572cd06cca`.
- Re-read `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/XHRProxy.ts`: `onTrackingStart(...)`, `onTrackingStop(...)`, `proxyOpen(...)`, `proxySend(...)`, `proxySetRequestHeader(...)`, and `reportXhr(...)` show mature automatic resource tracking with reversible setup, response timing, status, tracing headers, baggage, and optional GraphQL metadata.
- Re-read `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/DatadogRumResource/ResourceReporter.ts`: `ResourceReporter.reportResource(...)`, `formatResourceStartContext(...)`, and `formatResourceStopContext(...)` show how automatic network spans become resource start/stop calls with tracing IDs and timing metadata.
- Refreshed OpenTelemetry JS `open-telemetry/opentelemetry-js@248759a5d8d95366ecd957e9452f2fcfb2147e58`.
- Re-read `packages/opentelemetry-sdk-trace-web/src/StackContextManager.ts`: `with(...)` returns to the previous context in `finally`, reinforcing LogBrew's reversible setup and no-leaked-context design.
- Added opt-in `instrumentGlobalFetch` to `createLogBrewReactNativeInstrumentation(...)`. When enabled, LogBrew wraps the supplied `globalObject.fetch` or `globalThis.fetch`, delegates through the existing sanitized resource span path, keeps outbound `traceparent` target-scoped, exposes `globalFetch.remove()`/`stop()`, and puts the original fetch back only if LogBrew still owns the slot.
- Added installed-package tests and expanded packaged `examples/instrumentation-kit.mjs` so the tarball proof now covers global fetch patching, resource span capture, target-scoped propagation, primitive metadata dropping, and teardown after `remove()`.
- LogBrew still avoids default global patching, XHR interception, GraphQL payload/header parsing, response-size/timing phase capture, baggage, tracestate, arbitrary header capture, request/response body inspection, full URL/query/hash capture, native module ownership, and persisted/offline mobile request queues.

## Opt-In Global XHR Follow-Up - 2026-06-23

- Refreshed Sentry React Native `getsentry/sentry-react-native@88735e9773479a60cf16c986aa701112bbc137e4` and Sentry JavaScript `getsentry/sentry-javascript@8febb527fc0f1b5178632864443d00e183ef9661`.
- Re-read Sentry React Native `packages/core/src/js/tracing/reactnavigation.ts`: `reactNavigationIntegration(...)`, `registerNavigationContainer(...)`, and `updateLatestNavigationSpanWithCurrentRoute(...)` remain stronger for automatic mobile navigation span ownership, but are not XHR-specific.
- Read Sentry JavaScript `packages/browser-utils/src/instrument/xhr.ts`: `addXhrInstrumentationHandler(...)` and `instrumentXHR()` patch `XMLHttpRequest.prototype.open`/`send`, attach a readystatechange listener, collect method/status/start/end timestamps, and intercept `setRequestHeader` for internal request-header metadata. This shows the mature automatic XHR pattern and the privacy risk LogBrew should avoid by default.
- Read Sentry JavaScript `packages/browser-utils/test/instrument/xhr.test.ts`: current public test coverage confirms instrumentation is safe when `XMLHttpRequest` is missing.
- Re-read Datadog React Native `DataDog/dd-sdk-reactnative@92462dccefd689815d87dabbad0d41572cd06cca` `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/XHRProxy.ts`: `onTrackingStart(...)`, `onTrackingStop(...)`, `proxyOpen(...)`, `proxySend(...)`, `proxySetRequestHeader(...)`, and `reportXhr(...)` show reversible prototype patching, response-start timing, status/size collection, tracing header injection, baggage handling, and optional GraphQL extraction.
- Re-read Datadog React Native `packages/core/src/rum/instrumentation/resourceTracking/requestProxy/XHRProxy/DatadogRumResource/ResourceReporter.ts`: `ResourceReporter.reportResource(...)`, `formatResourceStartContext(...)`, and `formatResourceStopContext(...)` turn XHR context into resource start/stop timing metadata.
- Added opt-in `instrumentGlobalXMLHttpRequest` to `createLogBrewReactNativeInstrumentation(...)`. When enabled, LogBrew patches only `open`/`send` on the supplied `globalObject.XMLHttpRequest.prototype`, records sanitized resource spans with status and response-start timing, writes one target-scoped W3C `traceparent` through the app's existing `setRequestHeader`, exposes `globalXMLHttpRequest.remove()`/`stop()`, and puts original prototype methods back when it is safe to do so.
- LogBrew intentionally does not capture request bodies, response bodies, arbitrary request headers, response headers, cookies, GraphQL payloads, full URLs with query/hash text, baggage, tracestate, response-size heuristics, or native RUM ownership. XHR remains off by default.

## Tradeoffs

- LogBrew intentionally did not copy Sentry native scope sync, navigation auto-instrumentation, Datadog default XHR/fetch patching, GraphQL payload extraction, Babel interaction rewriting, multi-format propagation, baggage, tracestate, replay, payload capture, or native bridge state.
- The React Native package remains a thin peer-dependency layer over `@logbrew/sdk`, React, and React Native. Async work after `await` should keep the returned trace object and pass it explicitly or use provider `trace`; this avoids stale global context leaks between unrelated mobile interactions.
- Navigation/resource spans stay explicit and app-owned by default. LogBrew does not globally patch React Navigation, and global `fetch`/XHR patching requires explicit `instrumentGlobalFetch: true` or `instrumentGlobalXMLHttpRequest: true`; target-scoped propagation and helper calls keep privacy defaults obvious and reversible. The resource-fetch subpath remains available so teams can wrap only selected calls.
- Lifecycle spans stay explicit, app-owned, and separated behind their own subpath. LogBrew records AppState transitions that an app chooses to listen for, but it does not cancel spans, auto-restart views, infer session health, or synchronize JS scope into native SDKs like heavier mobile SDKs.
- Native bridge scope sync is explicit and app-owned. This narrows the Sentry native-scope gap for teams with their own native modules while avoiding a new native SDK contract or background bridge synchronization.
- The instrumentation kit narrows the setup-friction gap without claiming full automatic instrumentation. It subscribes only to objects the app passes in and returns `remove()`/`stop()` so teams can test, scope, and undo LogBrew wiring.

## Evidence

- `python3 scripts/check_js_sources.py js/logbrew-react-native`
- `cd js/logbrew-react-native && npm test`
- `bash scripts/real_user_react_native_smoke.sh`
- Packaged `examples/navigation-resource-spans.mjs` ran through `real_user_react_native_smoke.sh` after installing the generated tarball.
- Packaged `examples/resource-fetch-spans.mjs` runs through `real_user_react_native_smoke.sh` after installing the generated tarball.
- Packaged `examples/lifecycle-spans.mjs` runs through `real_user_react_native_smoke.sh` after installing the generated tarball.
- Packaged `examples/native-bridge-scope.mjs` runs through `real_user_react_native_smoke.sh` after installing the generated tarball and through the installed examples npm helper.
- Packaged `examples/instrumentation-kit.mjs` runs through `real_user_react_native_smoke.sh` after installing the generated tarball and through the installed examples npm helper; as of 2026-06-23 it proves opt-in global fetch/XHR patching, target-scoped propagation, response-start timing, privacy-bounded metadata, and teardown.
- `npm pack --json --dry-run` package proof after the instrumentation subpath: 33 files, 199,844 bytes unpacked, 34,537 bytes compressed.
- `bash scripts/check_js_lint.sh`
- `bash scripts/check_js_package.sh`

## Remaining Gaps

- React Native still lacks default automatic navigation/lifecycle/native-bridge instrumentation, response-size heuristics, full phase timing capture, OTel context ingestion, baggage/tracestate, rich span events/exceptions, XHR GraphQL-aware metadata, and source-map/native symbolication parity with Sentry/Datadog. The explicit lifecycle, resource-fetch, native-bridge, opt-in global fetch/XHR, and instrumentation-kit helpers intentionally reduce setup friction without claiming hidden default instrumentation.
