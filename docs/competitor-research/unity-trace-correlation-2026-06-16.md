# Unity Trace Correlation Research

## Gap

LogBrew Unity already had source-only UPM packaging, explicit spans, Unity scene/log/exception helpers, `HttpTransport`, retry proof, and installed-artifact smoke tests. It did not expose an active trace context that could connect Unity logs, issues, actions, helper events, spans, and outgoing W3C propagation under one operation. That made Unity weaker than Sentry Unity, Datadog Unity, and OpenTelemetry .NET for debugging a scene action or request across multiple signals.

## Competitor Source Read

- Sentry Unity, [`getsentry/sentry-unity`](https://github.com/getsentry/sentry-unity) at commit `4cda4392328f489a0b22490f0f0a2cc401cfc622`.
- Read `src/Sentry.Unity/Integrations/SceneManagerTracingIntegration.cs`: `Register(...)` and `SceneManagerTracingAPI.LoadSceneAsyncByNameOrIndex(...)` create scene-load tracing around Unity scene transitions.
- Read `src/Sentry.Unity/ScopeObserver.cs`: `SetTrace(...)` and `SetTraceImpl(...)` sync trace state into the active scope and native bridge.
- Read `src/Sentry.Unity.Android/SentryJava.cs`: `SetTrace(...)` forwards trace state to Android native SDK code.
- Read `src/Sentry.Unity/SentryMonoBehaviour.cs`: `StartAwakeSpan(...)`, `FinishAwakeSpan()`, and the main-thread queue connect Unity lifecycle spans.
- Follow-up coroutine read on 2026-06-17 re-read `src/Sentry.Unity/SentryMonoBehaviour.cs`: `QueueCoroutine(...)`, `Update()`, `StartCoroutine(...)`, `UpdatePauseStatus(...)`, `OnApplicationPause(...)`, `OnApplicationFocus(...)`, `StartAwakeSpan(...)`, and `FinishAwakeSpan()` show Sentry's hidden singleton `MonoBehaviour`, queued main-thread coroutine start, and lifecycle/auto-span hooks.
- Datadog Unity, [`DataDog/dd-sdk-unity`](https://github.com/DataDog/dd-sdk-unity) at commit `309e84de7c20af6ec47c2ff3e6c6f8d339937e93`.
- Read `packages/Datadog.Unity/Runtime/Rum/ResourceTrackingHelper.cs`: `GenerateTraceContext()`, `GenerateDatadogAttributes(...)`, `HeaderTypesForHost(...)`, and `GenerateTracingHeaders(...)` create trace contexts and outbound headers.
- Read `packages/Datadog.Unity/Runtime/Rum/TraceContext.cs`: `InjectHeaders(...)` writes W3C, Datadog, and B3 propagation headers.
- Read `packages/Datadog.Unity/Runtime/Rum/DatadogTrackedWebRequest.cs`: `SendWebRequest()` injects headers and tracks UnityWebRequest resources from start to completion.
- Read `packages/Datadog.Unity/Runtime/DdUnityLogHandler.cs`: Unity `ILogHandler` forwarding preserves app logging while adding Datadog logs/RUM context.
- Follow-up coroutine read on 2026-06-17 re-read `DdUnityLogHandler.Attach()`, `Detach()`, `LogException(...)`, and `LogFormat(...)`: Datadog wraps Unity logging and preserves the default handler in `finally`, a useful reliability pattern but still a hidden global integration LogBrew avoids by default.
- Read `packages/Datadog.Unity/Tests/Rum/ResourceTrackingHelperTest.cs`: tests trace context generation, W3C `traceparent`, sampled-only injection, and no-header behavior.
- OpenTelemetry .NET, [`open-telemetry/opentelemetry-dotnet`](https://github.com/open-telemetry/opentelemetry-dotnet) at commit `184b1cfd4a48f1fe6240a1b76f39c37efb38f465`.
- Read `src/OpenTelemetry.Api/Context/Propagation/TraceContextPropagator.cs`: `Extract(...)`, `Inject(...)`, and `TryExtractTraceparent(...)` validate W3C propagation and write normalized headers.
- Read `src/OpenTelemetry.Api/Context/RuntimeContext.cs` and `src/OpenTelemetry.Api/Context/AsyncLocalRuntimeContextSlot.cs`: current context registration and scoped storage pattern.
- Follow-up coroutine read on 2026-06-17 re-read `RuntimeContext.RegisterSlot(...)`, `SetValue(...)`, `GetValue(...)`, and `AsyncLocalRuntimeContextSlot<T>.Get()/Set(...)`: OTel uses ambient async-local context slots for propagation, while LogBrew Unity keeps explicit app-owned coroutine wrapping because Unity coroutines are frame-driven `IEnumerator` objects rather than standard async tasks.
- Read `src/OpenTelemetry.Api/Logs/LogRecordData.cs`: default log records pick up `Activity.Current?.Context` trace fields.

## Patterns To Reuse Safely

- Sentry Unity is better at binding trace state to Unity lifecycle work and native/mobile bridges, so Unity events created during a scene/load operation can correlate.
- Datadog Unity is better at app-owned resource tracking: it creates trace context, injects propagation headers, and preserves default Unity logging behavior while forwarding logs.
- OpenTelemetry .NET is better at strict W3C extraction/injection and current-context storage that logs can read without each log call receiving trace IDs explicitly.
- Follow-up lifecycle/request read on 2026-06-17 re-read the same current commits. Sentry `SentryMonoBehaviour.UpdatePauseStatus(...)`, `OnApplicationPause(...)`, and `OnApplicationFocus(...)` maintain pause/resume state before raising lifecycle events; `SceneManagerTracingAPI.LoadSceneAsyncByNameOrIndex(...)` wraps scene loads in transactions/spans. Datadog `DatadogTrackedWebRequest.SendWebRequest()` remains the heavier resource-tracking model with header injection and completion callbacks; `ResourceTrackingHelper.GenerateTracingHeaders(...)` and `TraceContext.InjectHeaders(...)` are the useful request-span/header pattern. OpenTelemetry `RuntimeContext` plus `AsyncLocalRuntimeContextSlot<T>` remains the ambient context pattern LogBrew avoids in Unity core to keep explicit app ownership.
- Follow-up coroutine read on 2026-06-17 compared Sentry's hidden coroutine queue and OTel's ambient slots with Datadog's default-handler preservation pattern. The safe LogBrew-native pattern is an explicit `IEnumerator` wrapper created while a trace is active, not automatic `MonoBehaviour` creation, global coroutine patching, or ambient async context assumptions.

## LogBrew Implementation

- Added dependency-free `LogBrewTraceContext` and `LogBrewTrace` to `co.logbrew.unity`.
- `LogBrewTraceContext.FromTraceparent(...)` validates W3C shape, normalizes uppercase IDs to lowercase, rejects unsupported versions and all-zero IDs, preserves trace flags, and creates a fresh local span ID.
- `LogBrewTraceContext.ContinueOrCreate(...)` falls back to a local root trace when propagation is missing or malformed.
- `LogBrewTrace.Activate(...)` uses a thread-local stack with close-by-scope-id semantics so nested/out-of-order scope disposal does not leak active trace context.
- `LogBrewClient` now adds active trace metadata to issue, log, and action events, overwriting spoofed trace metadata while preserving non-trace primitive metadata.
- Unity helpers inherit correlation through the client, so scene/log/exception helper events join the active trace without depending on `UnityEngine` in the core runtime.
- Added `LogBrewTrace.SpanAttributes(...)` for explicit spans and `LogBrewTrace.OutgoingHeaders()` for app-owned outbound request clients.
- `LogBrewUnity.CaptureLifecycleSpan(...)` records app-owned lifecycle transitions, such as `active -> paused`, as explicit spans with previous-state duration, active trace correlation, and primitive Unity metadata. It deliberately does not create a hidden `MonoBehaviour`, subscribe to global pause/focus callbacks, restart sessions, or infer health state.
- `LogBrewUnity.StartRequestSpan(...)` creates an explicit child trace context for app-owned request clients such as `UnityWebRequest`, exposes only `traceparent` through `UnityRequestSpan.Headers`, and sanitizes full URLs down to route-only metadata.
- `LogBrewUnity.CaptureRequestSpan(...)` records app-owned request completion as a child span with method, route template, status code, optional error type, active trace correlation, and primitive Unity context metadata. It deliberately does not wrap or patch `UnityWebRequest`, capture payloads, copy request headers, or keep query/hash values.
- `LogBrewUnity.TraceCoroutine(...)` captures an explicit or currently active trace and returns a source-only `IEnumerator` wrapper. Each `MoveNext()` or `Reset()` temporarily reactivates that trace around the app-owned coroutine step, then clears it afterward, so telemetry after a Unity frame yield can still correlate without hidden `MonoBehaviour` objects.
- Added packaged `examples/trace_correlation/TraceCorrelation.cs` plus `scripts/check_unity_trace_correlation_payload.py` to prove one W3C trace links a Unity issue, log, action, span, scene action, Unity log helper, exception helper, request span, coroutine resume action, outgoing active `traceparent`, and outgoing request `traceparent`.
- Added packaged `examples/lifecycle_spans/LifecycleSpans.cs` plus `scripts/check_unity_lifecycle_payload.py` to prove active/paused lifecycle spans reuse one active local span, include previous/current state and previous-state duration, preserve primitive Unity context, and reject spoofed trace metadata.

## Tradeoffs

- LogBrew stays lighter than Sentry Unity, Datadog Unity, and OpenTelemetry .NET by avoiding hidden `MonoBehaviour` lifecycle/coroutine instrumentation, global `UnityWebRequest` patching, automatic lifecycle/resource spans, baggage/tracestate, visual replay, payload capture, header capture, query capture, and broad dependency graphs.
- Unity now has a better first-useful explicit trace/log/error/helper correlation path for apps that want source-only UPM installation and app-owned instrumentation.
- Remaining gaps versus mature competitors: no automatic Unity lifecycle instrumentation, no automatic `UnityWebRequest` instrumentation, no automatic coroutine instrumentation, OpenTelemetry context ingestion, baggage/tracestate, DB/cache/queue spans, rich span events/exceptions, or native crash/symbolication integration.

## Verification

- Unity package test project: 19 tests now cover W3C validation, malformed fallback, scope disposal, active issue/log/action/helper correlation, lifecycle span correlation, request child-span correlation, coroutine step trace reactivation, route sanitization, span attributes, outgoing `traceparent`, and spoof-key overwrite.
- `scripts/check_unity_trace_correlation_payload.py`: validates trace/span IDs, active issue/log/action/helper metadata, span attributes, request span attributes/metadata, coroutine resume metadata, outgoing active/request `traceparent`, and no raw incoming propagation, query/hash, host, or spoofed trace leakage.
- `scripts/check_unity_lifecycle_payload.py`: validates lifecycle span names, active trace IDs, previous/current state metadata, previous-state duration, Unity context metadata, and no raw propagation or spoofed trace leakage.
- `bash scripts/check_unity_package.sh`: validates package metadata, package contents, README guidance, canonical examples, source trace-correlation payload, source lifecycle payload, and examples help.
- `bash scripts/real_user_unity_smoke.sh`: installs from a local UPM tarball into a temporary Unity-style project, proves dependency remove/re-add, validates installed canonical examples, installed trace-correlation and lifecycle payloads, and local HTTP 5xx-to-2xx retry delivery.

## 2026-06-17 Lifecycle Tracker Follow-Up

### Source Reading

- Re-checked upstream HEADs before implementation; Sentry Unity, Datadog Unity, and OpenTelemetry .NET still match the commits recorded above.
- Re-read Sentry Unity `SentryMonoBehaviour.UpdatePauseStatus(...)`, `OnApplicationPause(...)`, and `OnApplicationFocus(...)`: Sentry deduplicates startup/duplicate pause or focus callbacks behind a hidden singleton `MonoBehaviour` and emits resume/pause events from global lifecycle hooks.
- Re-read Datadog Unity `DdUnityLogHandler.Attach(...)`, `Detach(...)`, `LogException(...)`, and `LogFormat(...)`: Datadog demonstrates a useful explicit attach/detach reliability pattern, but it still replaces global Unity logging while forwarding to the original handler.
- Re-read OpenTelemetry .NET `RuntimeContext.RegisterSlot(...)`, `SetValue(...)`, `GetValue(...)`, and `AsyncLocalRuntimeContextSlot<T>`: OTel keeps ambient context in registered slots; LogBrew Unity still avoids ambient/global lifecycle state and keeps app-owned callback wiring.

### LogBrew Update

- Added source-only `UnityLifecycleTracker`, a small state tracker that apps instantiate in their own `MonoBehaviour` and call from `OnApplicationPause(...)` or `OnApplicationFocus(...)`.
- The tracker deduplicates repeated pause/focus notifications, computes previous-state duration from an app-supplied realtime clock, merges default and per-transition primitive Unity metadata, and calls the existing lifecycle span path so active trace metadata and spoof-key overwrite stay canonical.
- Packaged `examples/lifecycle_tracker/LifecycleTracker.cs` proves the tracker emits the same privacy-bounded lifecycle span payload as the explicit helper from both source and installed UPM tarballs.

### Tradeoffs

- This closes part of the "automatic lifecycle" gap with a lighter, explicit setup: apps get automatic transition spans after wiring their own callbacks.
- LogBrew still deliberately avoids Sentry-style hidden GameObject creation, global lifecycle subscriptions, local session-health inference, Unity API patching, payload/header/query capture, baggage, and tracestate.
- Remaining Unity gaps: `UnityWebRequest` convenience instrumentation, coroutine convenience instrumentation beyond explicit wrapping, OpenTelemetry context ingestion, rich span events/exceptions, URL/request phase timings, and native crash/symbolication integration.

## 2026-06-17 Request Tracker Follow-Up

### Source Reading

- Re-checked upstream HEADs before implementation; Sentry Unity, Datadog Unity, and OpenTelemetry .NET still match the commits recorded above.
- Re-read Sentry Unity `UnityWebRequestTransport.SendEnvelopeAsync(...)`, `CreateWebRequest(...)`, and `GetResponse(...)`: Sentry uses UnityWebRequest for its own transport, forwards HTTP headers into the request, maps connection errors separately from HTTP responses, and avoids treating transport response headers as user telemetry.
- Re-read Datadog Unity `DatadogTrackedWebRequest.SendWebRequest(...)`: Datadog injects tracing headers before send, starts a resource, registers an operation completion callback, records status/download bytes on protocol success, and records connection/data-processing errors separately.
- Re-read Datadog Unity `ResourceTrackingHelperTest.GeneratesCorrectTraceContextHeaders(...)` and `CustomResourceTrackingTest.ResourceTrackingHelperPermitsManualContextInjection()`: Datadog proves both wrapper-based and manual header injection paths, with W3C `traceparent` validation.
- Re-read OpenTelemetry .NET `TraceContextPropagator.Inject(...)`: OTel writes one normalized W3C `traceparent` through a caller-provided setter and skips invalid/null carriers rather than copying arbitrary request state.

### LogBrew Update

- Added source-only `UnityRequestTracker`, a small tracker that apps instantiate near app-owned `UnityWebRequest` code and start with a method, route template, optional trace context, and optional `Action<string,string>` header setter such as `request.SetRequestHeader`.
- `UnityRequestTracker.Start(...)` creates the existing sanitized child request span and applies exactly the returned propagation headers; `Capture(...)` computes duration from an app-supplied realtime clock, merges default plus per-request primitive Unity metadata, and emits through the canonical request span path.
- Packaged `examples/request_tracker/RequestTracker.cs` plus `scripts/check_unity_request_tracker_payload.py` prove source and installed UPM tarballs write one `traceparent`, record status/duration/error metadata, strip host/query/hash values, and overwrite spoofed trace keys.

### Tradeoffs

- This reduces the UnityWebRequest convenience gap without pulling `UnityEngine.Networking` into the core runtime or owning request disposal/completion callbacks.
- LogBrew still deliberately avoids Datadog-style wrapper ownership, hidden global request instrumentation, payload/header copying, full URL/query/hash capture, baggage, and tracestate.
- Remaining Unity gaps: coroutine convenience instrumentation beyond explicit wrapping, OpenTelemetry context ingestion, rich span events/exceptions, URL/request phase timings, and native crash/symbolication integration.

## 2026-06-17 Coroutine Tracker Follow-Up

### Source Reading

- Re-checked upstream HEADs before implementation: Sentry Unity and Datadog Unity still match the commits recorded above; OpenTelemetry .NET advanced to `184b1cfd4a48f1fe6240a1b76f39c37efb38f465`.
- Re-read Sentry Unity `SentryMonoBehaviour.QueueCoroutine(...)`, `Update()`, `StartCoroutine(...)`, `UpdatePauseStatus(...)`, `OnApplicationPause(...)`, `OnApplicationFocus(...)`, `StartAwakeSpan(...)`, and `FinishAwakeSpan()`: Sentry's convenience comes from a hidden singleton `MonoBehaviour`, a main-thread coroutine queue, and auto lifecycle/performance hooks.
- Re-read Datadog Unity `DdUnityLogHandler.Attach(...)`, `Detach(...)`, `LogException(...)`, and `LogFormat(...)`: the useful reliability pattern is defensive attach/detach plus `finally` forwarding, but it still owns a global Unity logging hook that LogBrew does not want in core.
- Re-read OpenTelemetry .NET `RuntimeContext.RegisterSlot(...)`, `SetValue(...)`, `GetValue(...)`, and `AsyncLocalRuntimeContextSlot<T>.Get()/Set(...)` at `184b1cfd4a48f1fe6240a1b76f39c37efb38f465`: OTel still uses ambient runtime context slots, which are not a clean fit for Unity's frame-driven `IEnumerator` coroutines.

### LogBrew Update

- Added source-only `UnityCoroutineTracker`, a small tracker that apps instantiate near app-owned coroutine starts and call with a name plus owned `IEnumerator`.
- `UnityCoroutineTracker.Trace(...)` creates a child trace context under the supplied or active trace, returns an `IEnumerator` for the app's own `StartCoroutine(...)`, reactivates that child context around each `MoveNext()`/`Reset()`, and emits one `unity.coroutine:<name>` span on completion.
- Exceptions record status `error`, outcome `exception`, and exception type only; messages, stacks, coroutine yielded values, payloads, headers, query strings, baggage, and tracestate are not copied into metadata.
- Packaged `examples/coroutine_tracker/CoroutineTracker.cs` plus `scripts/check_unity_coroutine_tracker_payload.py` prove source and installed UPM tarballs correlate coroutine log/action events under the child span, record completion duration from an app-supplied realtime clock, preserve primitive Unity metadata, and overwrite spoofed trace keys.

### Tradeoffs

- This reduces the coroutine convenience gap without creating hidden `MonoBehaviour` objects, scheduling coroutines globally, assuming ambient async context, patching Unity APIs, or owning cancellation/disposal semantics.
- LogBrew still deliberately avoids Sentry-style automatic coroutine/lifecycle instrumentation, Datadog-style global Unity hooks, OpenTelemetry baggage/tracestate, rich span event arrays, URL/request phase timings, and native crash/symbolication integration.
- Remaining Unity gaps: OpenTelemetry context ingestion, richer span events/exceptions beyond bounded summary fields, URL/request phase timings, hidden/global instrumentation for teams that explicitly want it, and native crash/symbolication parity.

## 2026-06-18 Request Timing Follow-Up

### Source Reading

- Refreshed Sentry Unity at `a9bebf56a8808b866ff11330bf42030685701cf9` and re-read `src/Sentry.Unity/Integrations/StartupTracingIntegration.cs`, `src/Sentry.Unity/Integrations/SceneManagerTracingIntegration.cs`, and `src/Sentry.Unity/SentryMonoBehaviour.cs`: Sentry is stronger for startup, scene-load, and `Awake` spans, but current public source does not expose a UnityWebRequest user-request timing helper.
- Refreshed Datadog Unity at `309e84de7c20af6ec47c2ff3e6c6f8d339937e93` and re-read `packages/Datadog.Unity/Runtime/Rum/DatadogTrackedWebRequest.cs`, `ResourceTrackingHelper.cs`, `Runtime/WebGL/ResourceTracker.cs`, and `Runtime/WebGL/DatadogWebGLRum.cs`: Datadog is stronger for resource tracking because its wrapper records resource duration, status, downloaded bytes, content type, error details, and tracing headers, but it owns request wrapping and keeps richer URL/resource metadata than LogBrew should copy by default.
- Checked Datadog Unity package mirror at `1dbbfe29d72028c430b800107a2cf3271a0aa163` and found the same runtime resource-tracking pattern.

### LogBrew Update

- Added dependency-free `UnityRequestTimings` for optional, fixed app-supplied request phase metadata: queued, name lookup, connect, TLS, send, wait, receive, and response-body byte count.
- `LogBrewUnity.CaptureRequestSpan(...)` and `UnityRequestTracker.Capture(...)` now merge those timings into the existing sanitized request span path, so request timing phases correlate with active trace context without a `UnityEngine.Networking` dependency.
- Packaged `examples/request_tracker/RequestTracker.cs` plus `scripts/check_unity_request_tracker_payload.py` prove source and installed UPM tarballs record timing phase metadata while still stripping host/query/hash values and overwriting spoofed trace keys.

### Tradeoffs

- This closes the "URL/request phase timings" gap with an explicit, lighter model suitable for app-owned UnityWebRequest code.
- LogBrew still deliberately avoids Datadog-style request wrapper ownership, automatic/global UnityWebRequest instrumentation, full URL capture, request/response headers, payloads, content type, error messages, baggage, tracestate, and raw propagation metadata.
- Remaining Unity gaps: OpenTelemetry context ingestion, richer span events/exceptions beyond bounded summary fields, native crash/symbolication parity, and optional heavier framework-owned instrumentation for teams that explicitly want it.
