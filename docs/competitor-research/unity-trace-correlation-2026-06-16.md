# Unity Trace Correlation Research

## Gap

LogBrew Unity already had source-only UPM packaging, explicit spans, Unity scene/log/exception helpers, `HttpTransport`, retry proof, and installed-artifact smoke tests. It did not expose an active trace context that could connect Unity logs, issues, actions, helper events, spans, and outgoing W3C propagation under one operation. That made Unity weaker than Sentry Unity, Datadog Unity, and OpenTelemetry .NET for debugging a scene action or request across multiple signals.

## Competitor Source Read

- Sentry Unity, [`getsentry/sentry-unity`](https://github.com/getsentry/sentry-unity) at commit `4cda4392328f489a0b22490f0f0a2cc401cfc622`.
- Read `src/Sentry.Unity/Integrations/SceneManagerTracingIntegration.cs`: `Register(...)` and `SceneManagerTracingAPI.LoadSceneAsyncByNameOrIndex(...)` create scene-load tracing around Unity scene transitions.
- Read `src/Sentry.Unity/ScopeObserver.cs`: `SetTrace(...)` and `SetTraceImpl(...)` sync trace state into the active scope and native bridge.
- Read `src/Sentry.Unity.Android/SentryJava.cs`: `SetTrace(...)` forwards trace state to Android native SDK code.
- Read `src/Sentry.Unity/SentryMonoBehaviour.cs`: `StartAwakeSpan(...)`, `FinishAwakeSpan()`, and the main-thread queue connect Unity lifecycle spans.
- Datadog Unity, [`DataDog/dd-sdk-unity`](https://github.com/DataDog/dd-sdk-unity) at commit `309e84de7c20af6ec47c2ff3e6c6f8d339937e93`.
- Read `packages/Datadog.Unity/Runtime/Rum/ResourceTrackingHelper.cs`: `GenerateTraceContext()`, `GenerateDatadogAttributes(...)`, `HeaderTypesForHost(...)`, and `GenerateTracingHeaders(...)` create trace contexts and outbound headers.
- Read `packages/Datadog.Unity/Runtime/Rum/TraceContext.cs`: `InjectHeaders(...)` writes W3C, Datadog, and B3 propagation headers.
- Read `packages/Datadog.Unity/Runtime/Rum/DatadogTrackedWebRequest.cs`: `SendWebRequest()` injects headers and tracks UnityWebRequest resources from start to completion.
- Read `packages/Datadog.Unity/Runtime/DdUnityLogHandler.cs`: Unity `ILogHandler` forwarding preserves app logging while adding Datadog logs/RUM context.
- Read `packages/Datadog.Unity/Tests/Rum/ResourceTrackingHelperTest.cs`: tests trace context generation, W3C `traceparent`, sampled-only injection, and no-header behavior.
- OpenTelemetry .NET, [`open-telemetry/opentelemetry-dotnet`](https://github.com/open-telemetry/opentelemetry-dotnet) at commit `184b1cfd4a48f1fe6240a1b76f39c37efb38f465`.
- Read `src/OpenTelemetry.Api/Context/Propagation/TraceContextPropagator.cs`: `Extract(...)`, `Inject(...)`, and `TryExtractTraceparent(...)` validate W3C propagation and write normalized headers.
- Read `src/OpenTelemetry.Api/Context/RuntimeContext.cs` and `src/OpenTelemetry.Api/Context/AsyncLocalRuntimeContextSlot.cs`: current context registration and scoped storage pattern.
- Read `src/OpenTelemetry.Api/Logs/LogRecordData.cs`: default log records pick up `Activity.Current?.Context` trace fields.

## Patterns To Reuse Safely

- Sentry Unity is better at binding trace state to Unity lifecycle work and native/mobile bridges, so Unity events created during a scene/load operation can correlate.
- Datadog Unity is better at app-owned resource tracking: it creates trace context, injects propagation headers, and preserves default Unity logging behavior while forwarding logs.
- OpenTelemetry .NET is better at strict W3C extraction/injection and current-context storage that logs can read without each log call receiving trace IDs explicitly.
- Follow-up lifecycle read on 2026-06-17 re-read the same current commits. Sentry `SentryMonoBehaviour.UpdatePauseStatus(...)`, `OnApplicationPause(...)`, and `OnApplicationFocus(...)` maintain pause/resume state before raising lifecycle events; `SceneManagerTracingAPI.LoadSceneAsyncByNameOrIndex(...)` wraps scene loads in transactions/spans. Datadog `DatadogTrackedWebRequest.SendWebRequest()` remains the heavier resource-tracking model with header injection and completion callbacks. OpenTelemetry `RuntimeContext` plus `AsyncLocalRuntimeContextSlot<T>` remains the ambient context pattern LogBrew avoids in Unity core to keep explicit app ownership.

## LogBrew Implementation

- Added dependency-free `LogBrewTraceContext` and `LogBrewTrace` to `co.logbrew.unity`.
- `LogBrewTraceContext.FromTraceparent(...)` validates W3C shape, normalizes uppercase IDs to lowercase, rejects unsupported versions and all-zero IDs, preserves trace flags, and creates a fresh local span ID.
- `LogBrewTraceContext.ContinueOrCreate(...)` falls back to a local root trace when propagation is missing or malformed.
- `LogBrewTrace.Activate(...)` uses a thread-local stack with close-by-scope-id semantics so nested/out-of-order scope disposal does not leak active trace context.
- `LogBrewClient` now adds active trace metadata to issue, log, and action events, overwriting spoofed trace metadata while preserving non-trace primitive metadata.
- Unity helpers inherit correlation through the client, so scene/log/exception helper events join the active trace without depending on `UnityEngine` in the core runtime.
- Added `LogBrewTrace.SpanAttributes(...)` for explicit spans and `LogBrewTrace.OutgoingHeaders()` for app-owned outbound request clients.
- `LogBrewUnity.CaptureLifecycleSpan(...)` records app-owned lifecycle transitions, such as `active -> paused`, as explicit spans with previous-state duration, active trace correlation, and primitive Unity metadata. It deliberately does not create a hidden `MonoBehaviour`, subscribe to global pause/focus callbacks, restart sessions, or infer health state.
- Added packaged `examples/trace_correlation/TraceCorrelation.cs` plus `scripts/check_unity_trace_correlation_payload.py` to prove one W3C trace links a Unity issue, log, action, span, scene action, Unity log helper, exception helper, and outgoing `traceparent`.
- Added packaged `examples/lifecycle_spans/LifecycleSpans.cs` plus `scripts/check_unity_lifecycle_payload.py` to prove active/paused lifecycle spans reuse one active local span, include previous/current state and previous-state duration, preserve primitive Unity context, and reject spoofed trace metadata.

## Tradeoffs

- LogBrew stays lighter than Sentry Unity, Datadog Unity, and OpenTelemetry .NET by avoiding hidden `MonoBehaviour` lifecycle instrumentation, global `UnityWebRequest` patching, automatic lifecycle/resource spans, baggage/tracestate, visual replay, payload capture, header capture, query capture, and broad dependency graphs.
- Unity now has a better first-useful explicit trace/log/error/helper correlation path for apps that want source-only UPM installation and app-owned instrumentation.
- Remaining gaps versus mature competitors: no automatic Unity lifecycle instrumentation, `UnityWebRequest` child-span helpers, coroutine context propagation, OpenTelemetry context ingestion, baggage/tracestate, DB/cache/queue spans, rich span events/exceptions, or native crash/symbolication integration.

## Verification

- Unity package test project: 17 tests now cover W3C validation, malformed fallback, scope disposal, active issue/log/action/helper correlation, lifecycle span correlation, span attributes, outgoing `traceparent`, and spoof-key overwrite.
- `scripts/check_unity_trace_correlation_payload.py`: validates trace/span IDs, active issue/log/action/helper metadata, span attributes, outgoing `traceparent`, and no raw incoming propagation or spoofed trace leakage.
- `scripts/check_unity_lifecycle_payload.py`: validates lifecycle span names, active trace IDs, previous/current state metadata, previous-state duration, Unity context metadata, and no raw propagation or spoofed trace leakage.
- `bash scripts/check_unity_package.sh`: validates package metadata, package contents, README guidance, canonical examples, source trace-correlation payload, source lifecycle payload, and examples help.
- `bash scripts/real_user_unity_smoke.sh`: installs from a local UPM tarball into a temporary Unity-style project, proves dependency remove/re-add, validates installed canonical examples, installed trace-correlation and lifecycle payloads, and local HTTP 5xx-to-2xx retry delivery.
