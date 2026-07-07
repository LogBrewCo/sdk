# Kotlin Android Trace Correlation Research

## Gap

LogBrew Kotlin already had a dependency-light JVM client, Android activity/log/throwable helpers, product timeline helpers, metrics, `HttpTransport`, and installed-artifact proof. It did not expose an active trace context that could connect Android logs, issues, product actions, metrics, spans, network milestones, and outgoing W3C propagation under one operation. That made Kotlin Android weaker than Sentry Android, OpenTelemetry Java/Android instrumentation, and Datadog Android for the common debugging path where one mobile request or screen action should connect multiple signals.

## Competitor Source Read

- Sentry Java/Android, [`getsentry/sentry-java`](https://github.com/getsentry/sentry-java) at commit `6dff1c9970ad612ac431980c08abb138218465e0`.
- Read `sentry/src/main/java/io/sentry/PropagationContext.java`: `fromHeaders(...)`, `fromExistingTrace(...)`, `toSpanContext()`.
- Read `sentry/src/main/java/io/sentry/SentryTraceHeader.java`: trace header regex parsing and sampled flag extraction.
- Read `sentry-android-core/src/main/java/io/sentry/android/core/ActivityLifecycleIntegration.java`: `continueUiLoadTrace(...)`, transaction continuation, and scope binding through `applyScope(...)`.
- Read `sentry-android-core/src/main/java/io/sentry/android/core/InternalSentrySdk.java`: `setTrace(...)` for hybrid/native trace handoff.
- OpenTelemetry Java and Java instrumentation, [`open-telemetry/opentelemetry-java`](https://github.com/open-telemetry/opentelemetry-java) at commit `1ec8bce84b378508c802788215afb0a6c67cfbff` and [`open-telemetry/opentelemetry-java-instrumentation`](https://github.com/open-telemetry/opentelemetry-java-instrumentation) at commit `7a4599ea8c410876098ec1a84141b56d881949e7`.
- Read `api/all/src/main/java/io/opentelemetry/api/trace/propagation/W3CTraceContextPropagator.java`: `inject(...)`, `extract(...)`, and W3C traceparent validation.
- Read `context/src/main/java/io/opentelemetry/context/ThreadLocalContextStorage.java`: thread-local scope attach/close behavior.
- Read `api/all/src/main/java/io/opentelemetry/api/trace/Span.java`: `current()`, `fromContext(...)`, and `wrap(...)`.
- Read `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/internal/TracingInterceptor.java`: context start, scoped execution, and outbound propagation injection.
- Read `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/ContextInterceptor.java` and `internal/RequestHeaderSetter.java`: current-context propagation through OkHttp request builders.
- Datadog Android, [`DataDog/dd-sdk-android`](https://github.com/DataDog/dd-sdk-android) at commit `e07c4cc6a23b51d4a45602787cea3f3f1db7b8b0`.
- Read `features/dd-sdk-android-trace/src/main/kotlin/com/datadog/android/trace/internal/net/TraceContext.kt`: trace ID/span ID/sampling propagation model.
- Read `features/dd-sdk-android-trace/src/main/kotlin/com/datadog/android/trace/TraceContextInjection.kt`: sampled-only versus all-request injection behavior.
- Read `features/dd-sdk-android-trace/src/main/kotlin/com/datadog/android/trace/internal/FeatureSdkCoreExt.kt`: active trace context keyed by thread for log correlation.
- Read `features/dd-sdk-android-logs/src/main/kotlin/com/datadog/android/log/internal/domain/DatadogLogGenerator.kt`: bundling trace IDs into logs.
- Read `features/dd-sdk-android-trace/src/main/kotlin/com/datadog/android/trace/internal/DatadogSpanLogger.kt`: span-to-log trace ID/span ID stamping.
- Read `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/trace/TracingInterceptor.kt` and `internal/ApmInstrumentationOkHttpAdapter.kt`: OkHttp request tracing and feature-context updates.

## Patterns To Reuse Safely

- Sentry Android continues valid propagation into a fresh local span and binds the transaction to a scope so other SDK signals can pick it up.
- OpenTelemetry validates W3C `traceparent`, keeps current context scoped by thread, and injects outbound propagation explicitly through a request carrier.
- Datadog Android keeps active trace context available to logs by thread, stamps trace/span IDs into logs, and lets network instrumentation inject propagation while handling sampling choices separately.

## LogBrew Implementation

- Added dependency-free `LogBrewTraceContext`, `LogBrewTraceScope`, and `LogBrewTrace` to `logbrew-kotlin`.
- `LogBrewTrace.fromTraceparent(...)` validates W3C shape, normalizes uppercase IDs to lowercase, rejects forbidden or all-zero IDs, preserves sampled flags, and creates a fresh local span ID.
- `LogBrewTrace.continueOrCreate(...)` falls back to a local root trace when propagation is missing or malformed.
- `LogBrewTrace.use(...)` uses a `ThreadLocal` stack with close-by-scope-id semantics so nested and out-of-order scope close does not leak active context.
- `LogBrewClient` now adds active trace metadata to issue, log, action, and metric events, overwriting spoofed trace keys in app metadata.
- Android helpers inherit correlation through the client, so activity/log/throwable/product/network helpers can join the active trace without patching Android platform APIs.
- Added `LogBrewTrace.spanAttributes(...)` and `LogBrewTrace.outgoingHeaders()` for explicit spans and app-owned outbound clients.
- Added packaged `examples/trace_correlation/TraceCorrelation.kt` plus `scripts/check_kotlin_trace_correlation_payload.py` to prove one W3C trace links a Kotlin issue, log, action, span, `http.server.duration` metric, Android product action, Android network milestone, and outgoing `traceparent`.

## Tradeoffs

- LogBrew stays lighter than Sentry Android, OpenTelemetry, and Datadog Android by avoiding global OkHttp/HttpURLConnection patching, Android lifecycle auto-spans, baggage/tracestate, visual replay, payload/header capture, and broad dependency graphs.
- Kotlin Android now has a better first-useful explicit trace/log/error/product/network correlation path for apps that want small install footprint and app-owned instrumentation.
- Remaining gaps versus mature competitors: no Android lifecycle spans, OkHttp/HttpURLConnection child-span instrumentation, OpenTelemetry context ingestion, baggage/tracestate, coroutine context propagation, DB/cache/queue spans, rich span events/exceptions, or native crash/symbolication integration.

## 2026-06-17 Outbound Request Child-Span Follow-Up

### Source Re-Read

- Sentry Java/Android HEAD still resolves to `getsentry/sentry-java@6dff1c9970ad612ac431980c08abb138218465e0`.
- Re-read `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt`: `intercept(...)`, `TracingUtils.traceIfAllowed(...)` header injection, response/error span completion, and optional network body/detail capture.
- OpenTelemetry Java instrumentation HEAD now resolves to `open-telemetry/opentelemetry-java-instrumentation@2f94c787cb511ddd80c6e337cd89999798a2da2b`.
- Re-read `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/internal/TracingInterceptor.java`: `intercept(...)`, `instrumenter.start(...)`, scoped `chain.proceed(...)`, error completion, and immutable request rebuilding.
- Re-read `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/internal/RequestHeaderSetter.java`: `set(...)` injecting propagation headers into `Request.Builder`.
- Datadog Android HEAD still resolves to `DataDog/dd-sdk-android@e07c4cc6a23b51d4a45602787cea3f3f1db7b8b0`.
- Re-read `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/trace/TracingInterceptor.kt`: `interceptAndTrace(...)`, `buildSpan(...)`, `updateRequest(...)`, `handleResponse(...)`, and `handleThrowable(...)`.
- Re-read `features/dd-sdk-android-trace/src/main/kotlin/com/datadog/android/trace/TraceContextInjection.kt`: sampled-only versus all-request injection.

### Pattern And Tradeoffs

- Mature competitors solve outbound request correlation with interceptors that start child spans, inject propagation into immutable request builders, scope the child context during request execution, and finish spans from response/error paths.
- Sentry and Datadog also include optional body/header/network detail capture and richer automatic client behavior. That improves debugging depth but adds dependency, privacy, and configuration surface area.
- LogBrew should stay lighter for the core Kotlin artifact: explicit app-owned request spans that hand back one normalized `traceparent` header, require explicit response/error completion, and avoid OkHttp/HttpURLConnection patching, arbitrary header capture, payload capture, baggage, and tracestate.

### LogBrew Follow-Up Implementation

- Added `AndroidRequestSpan` plus `LogBrewAndroid.startRequestSpan(...)` and `LogBrewAndroid.captureRequestSpan(...)`.
- `startRequestSpan(...)` creates a fresh child context under the supplied or active `LogBrewTraceContext`, sanitizes method and route template, preserves primitive Android context and app metadata, and returns `headers` containing exactly one normalized `traceparent` value for app-owned request clients.
- `captureRequestSpan(...)` records an explicit `span` event with sanitized method/route/status/duration/error metadata, child span ID, active parent span ID, and spoofed trace-key overwrite.
- The helper intentionally avoids OkHttp interceptors, `HttpURLConnection` patching, Android lifecycle observers, coroutine context capture, payload/header/full-URL/query/hash capture, baggage, tracestate, and automatic retry or usage/quota interpretation.

### Updated Verification

- `LogBrewKotlinTest.kt` now proves request child context creation, one-header propagation, sanitized completion span metadata, status/duration validation, and no raw query/fragment/traceparent/spoofed trace leakage.
- Packaged `examples/trace_correlation/TraceCorrelation.kt` now emits a request child span and request-scoped outgoing `traceparent`.
- `scripts/check_kotlin_trace_correlation_payload.py` now verifies active traceparent and request traceparent separately, parent/child span linkage, sanitized request metadata, and no forbidden raw values.
- Package and installed-smoke scripts now require `AndroidRequestSpan`, README `startRequestSpan`/`captureRequestSpan` guidance, and installed trace-correlation proof.

### Remaining Gaps After Follow-Up

- Kotlin Android still lacks automatic lifecycle instrumentation, automatic OkHttp/HttpURLConnection interceptors, coroutine context propagation beyond explicit thread-local scopes, OpenTelemetry context ingestion, baggage/tracestate, rich span events/exceptions, DB/cache/queue spans, and native crash/symbolication integration.

## 2026-06-17 OpenTelemetry SpanContext Follow-Up

### Source Re-Read

- OpenTelemetry Java HEAD now resolves to `open-telemetry/opentelemetry-java@a00536a2c7b3a3f7a0952dbea12e9249da18611d`.
- Read `api/all/src/main/java/io/opentelemetry/api/trace/SpanContext.java`: `getTraceId()`, `getSpanId()`, `getTraceFlags()`, `isSampled()`, `isValid()`, and `isRemote()`.
- Read `api/all/src/main/java/io/opentelemetry/api/trace/TraceFlags.java`: `asHex()`, `isSampled()`, and sampled/default flag helpers.
- Read `api/all/src/main/java/io/opentelemetry/api/trace/Span.java`: `current()`, `fromContext(...)`, `wrap(...)`, and `getSpanContext()`.
- Read `api/all/src/main/java/io/opentelemetry/api/trace/propagation/W3CTraceContextPropagator.java`: `inject(...)`, `extract(...)`, and `extractContextFromTraceParent(...)`.
- Sentry Java/Android HEAD still resolves to `getsentry/sentry-java@6dff1c9970ad612ac431980c08abb138218465e0`.
- Re-read `sentry/src/main/java/io/sentry/PropagationContext.java`: `fromHeaders(...)`, `fromExistingTrace(...)`, and `toSpanContext()`.
- Re-read `sentry/src/main/java/io/sentry/SentryTraceHeader.java`: trace ID/span ID/sampled parsing and serialization.
- Datadog Android HEAD still resolves to `DataDog/dd-sdk-android@e07c4cc6a23b51d4a45602787cea3f3f1db7b8b0`.
- Re-read `features/dd-sdk-android-trace/src/main/kotlin/com/datadog/android/trace/internal/net/TraceContext.kt`: small trace/span/sampling carrier.
- Re-read `features/dd-sdk-android-trace/src/main/kotlin/com/datadog/android/trace/TraceContextInjection.kt`: all-request versus sampled-only injection policy.

### Pattern And Tradeoffs

- OpenTelemetry treats `SpanContext` as immutable propagation state with lowercase trace ID, span ID, trace flags, trace state, and validity/remote checks. It injects only valid contexts and can wrap a `SpanContext` in a non-recording span for downstream propagation.
- Sentry and Datadog both keep lightweight trace carriers separate from broader exporter/instrumentation machinery, then create or bind local spans/scopes from those carriers.
- LogBrew should not depend on OpenTelemetry, import trace state/baggage, or install processors. The useful subset is copying validated trace ID, parent span ID, and trace flags from an app-owned OTel span context into a fresh LogBrew child span.

### LogBrew Follow-Up Implementation

- Added dependency-free `LogBrewOpenTelemetrySpanContext` with validated `create(...)` factories for copied OTel `traceId`, `spanId`, and `traceFlags` or sampled boolean.
- Added `LogBrewTrace.fromOpenTelemetrySpanContext(...)` so apps can create a fresh LogBrew child context under an owned OTel span without adding OpenTelemetry dependencies to LogBrew.
- Added `LogBrewTrace.spanAttributesFromOpenTelemetrySpanContext(...)` for one-off child span attributes when apps want to report a LogBrew span parented to an OTel span.
- Packaged `examples/trace_correlation/TraceCorrelation.kt` now starts from a copied OTel-compatible parent and still proves trace-log-error-action-metric-network-request correlation under one W3C trace.
- The helper intentionally ignores tracestate, baggage, links, raw propagation metadata, payloads, arbitrary headers, global HTTP patching, processors, and exporters.

### Remaining Gaps After OTel Follow-Up

- Kotlin Android still lacks automatic lifecycle instrumentation, automatic OkHttp/HttpURLConnection interceptors, coroutine context propagation beyond explicit thread-local scopes, richer OpenTelemetry `Context`/`Span` extraction, baggage/tracestate, rich span events/exceptions, DB/cache/queue spans, and native crash/symbolication integration.

## 2026-06-17 Live OpenTelemetry Span/Context Follow-Up

### Source Re-Read

- OpenTelemetry Java HEAD still resolves to `open-telemetry/opentelemetry-java@a00536a2c7b3a3f7a0952dbea12e9249da18611d`.
- Re-read `api/all/src/main/java/io/opentelemetry/api/trace/Span.java`: `current()`, `fromContext(...)`, `wrap(...)`, and `getSpanContext()`.
- Re-read `api/all/src/main/java/io/opentelemetry/api/trace/SpanContext.java`: `getTraceId()`, `getSpanId()`, `getTraceFlags()`, `isSampled()`, and `isValid()`.
- Re-read `context/src/main/java/io/opentelemetry/context/Context.java`: `current()`, `root()`, and scoped current-context behavior.
- Sentry Java/Android HEAD now resolves to `getsentry/sentry-java@ba010111864967003758a5e4d750dfe04f995c18`.
- Re-read `sentry/src/main/java/io/sentry/PropagationContext.java`: `fromHeaders(...)`, `fromExistingTrace(...)`, `toSpanContext()`, and sampled trace handoff.
- Re-read `sentry/src/main/java/io/sentry/SpanContext.java`: trace/span ID storage plus sampling decision accessors.
- Datadog Android HEAD still resolves to `DataDog/dd-sdk-android@e07c4cc6a23b51d4a45602787cea3f3f1db7b8b0`.
- Re-read `features/dd-sdk-android-trace/src/main/kotlin/com/datadog/android/trace/internal/net/TraceContext.kt`: compact trace ID/span ID/sampling carrier.

### Pattern And Tradeoffs

- OpenTelemetry users often already have a live `Span.current()` or a scoped `Context`; forcing them to manually copy IDs is avoidable friction.
- Sentry and Datadog keep trace carriers separate from richer SDK/exporter state, which supports a LogBrew bridge that copies only the propagation fields.
- LogBrew should still avoid adding an OpenTelemetry dependency to the default Kotlin artifact, avoid exporter/processor ownership, and avoid reading tracestate, baggage, span attributes, links, events, payloads, or headers.

### LogBrew Follow-Up Implementation

- Added dependency-free `LogBrewOpenTelemetry` reflection bridge with `spanContextFromCurrentSpan()`, `traceContextFromCurrentSpan()`, `spanContextFromSpan(...)`, `traceContextFromSpan(...)`, `spanContextFromContext(...)`, and `traceContextFromContext(...)`.
- Apps that already install `io.opentelemetry:opentelemetry-api` can pass a live OTel `Span`, OTel `Context`, or rely on the current OTel span; LogBrew copies only valid trace ID/span ID/trace flags into `LogBrewOpenTelemetrySpanContext` and creates a fresh LogBrew child context when requested.
- The helpers return `null` when OpenTelemetry is absent, no valid span is active, or the object is not an OTel span/context. They intentionally do not install OTel exporters/processors, read attributes, copy baggage/tracestate, mutate global HTTP clients, or serialize raw propagation metadata.

### Updated Verification

- `LogBrewKotlinTest.kt` now validates dependency-free helper null behavior when OpenTelemetry classes are absent and unknown objects are passed, while the existing SpanContext-copy tests keep invalid/all-zero rejection covered.
- `scripts/real_user_kotlin_smoke.sh` now builds and runs an installed Gradle Java consumer that adds `io.opentelemetry:opentelemetry-api:1.63.0` and `io.opentelemetry:opentelemetry-context:1.63.0`, wraps a real OTel `SpanContext`, scopes it with `makeCurrent()`, and proves `LogBrewOpenTelemetry` copies live `Span.current()`, explicit `Span`, and `Context.current()` into fresh LogBrew child context.

### Remaining Gaps After Live OTel Follow-Up

- Kotlin Android still lacks automatic lifecycle instrumentation, automatic OkHttp/HttpURLConnection interceptors, coroutine context propagation beyond explicit thread-local scopes, baggage/tracestate, rich span events/exceptions, DB/cache/queue spans, and native crash/symbolication integration.

## 2026-06-18 OkHttp Header Setter / Child Scope Follow-Up

### Source Re-Read

- Sentry Java/Android HEAD resolves to `getsentry/sentry-java@7c1a728e8bd2faa42b8f1c25c9f16a145baab60f`.
- Re-read `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt`: `intercept(...)`, `TracingUtils.traceIfAllowed(...)`, request `newBuilder()`, `addHeader(...)`, `chain.proceed(...)`, response/error status handling, breadcrumb emission, and optional network detail/body/header capture paths.
- OpenTelemetry Java instrumentation HEAD resolves to `open-telemetry/opentelemetry-java-instrumentation@63de06bb3c29dd0cdf4059b5b755bb6bbde7fe71`.
- Re-read `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/internal/TracingInterceptor.java`: `intercept(...)`, `instrumenter.start(...)`, immutable request rebuilding, propagation injection, scoped `chain.proceed(...)`, and `instrumenter.end(...)`.
- Re-read `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/internal/RequestHeaderSetter.java`: `TextMapSetter<Request.Builder>.set(...)` uses `carrier.header(key, value)`.
- Re-read `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/ContextInterceptor.java` and `TracingCallFactory.java`: request execution/callbacks run under the captured calling context via `makeCurrent()`.
- Datadog Android HEAD resolves to `DataDog/dd-sdk-android@519550150648592709d441c677437d8b1c3a0707`.
- Re-read `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/trace/TracingInterceptor.kt`: `intercept(...)`, `interceptAndTrace(...)`, `buildSpan(...)`, `updateRequest(...)`, `handleResponse(...)`, and `handleThrowable(...)`.
- Re-read `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/internal/ApmInstrumentationOkHttpAdapter.kt`: current package layout for the APM/RUM adapter boundary.

### Pattern And Tradeoffs

- Mature OkHttp integrations create a child span, inject propagation into an immutable request builder, run the network call under the request context, and finish spans from response/error paths.
- Sentry and Datadog also support richer automatic behavior such as body/header/network detail capture and failed-request capture. That can be useful, but it expands dependency weight and privacy/configuration risk for teams that want explicit instrumentation.
- LogBrew should improve the request-builder ergonomics without adding an OkHttp dependency to the core Kotlin artifact. The safer subset is an app-owned header setter and a scoped block around the app-owned request call.

### LogBrew Follow-Up Implementation

- `AndroidRequestSpan` now exposes `applyHeadersTo(LogBrewHeaderSetter)` so OkHttp, `HttpURLConnection`, and custom clients can receive exactly the existing normalized `traceparent` header through an app-owned setter.
- `AndroidRequestSpan.withTrace { ... }` runs request-local logs, issues, actions, metrics, or app-defined spans under the request child trace context and reactivates the previous active trace afterward.
- Added `LogBrewHeaderSetter` as a tiny Java/Kotlin-friendly functional interface instead of importing OkHttp or patching `HttpURLConnection`.
- Packaged trace-correlation proof now applies the request header through the setter, runs an OkHttp-style request log inside `withTrace`, and validates that the log is parented to the request child span.

### Remaining Gaps After Header Setter Follow-Up

- Kotlin Android still lacks a typed optional OkHttp interceptor package, automatic lifecycle instrumentation, automatic `HttpURLConnection` instrumentation, coroutine context propagation beyond explicit thread-local scopes, baggage/tracestate, rich span events/exceptions, DB/cache/queue spans, and native crash/symbolication integration.

## 2026-06-19 Coroutine Context Element Follow-Up

### Source Re-Read

- Sentry Java/Android HEAD still resolves to `getsentry/sentry-java@7c1a728e8bd2faa42b8f1c25c9f16a145baab60f`.
- Read `sentry-kotlin-extensions/src/main/java/io/sentry/kotlin/SentryContext.kt`: `CopyableThreadContextElement`, `copyForChild()`, `mergeForChild(...)`, `updateThreadContext(...)`, and `restoreThreadContext(...)` keep Sentry scopes current across coroutine suspension and child coroutine copies.
- Read `sentry-kotlin-extensions/src/main/java/io/sentry/kotlin/SentryCoroutineExceptionHandler.kt`: coroutine exception handler captures handled coroutine exceptions through Sentry scopes.
- Datadog Android HEAD still resolves to `DataDog/dd-sdk-android@519550150648592709d441c677437d8b1c3a0707`.
- Read `integrations/dd-sdk-android-trace-coroutines/src/main/kotlin/com/datadog/android/trace/coroutines/CoroutineExt.kt`: `launchTraced(...)`, `asyncTraced(...)`, `runBlockingTraced(...)`, `awaitTraced(...)`, and `withContextTraced(...)` wrap coroutine work in spans.
- Read `integrations/dd-sdk-android-trace-coroutines/src/main/kotlin/com/datadog/android/trace/internal/coroutines/InternalCoroutineExt.kt` and `CoroutineScopeSpanImpl.kt`: coroutine blocks run inside a Datadog span and expose a scope/span composite.
- OpenTelemetry Java HEAD resolves to `open-telemetry/opentelemetry-java@824334c552cd800d6b89512f20225b2025fd5d16`.
- Read `extensions/kotlin/src/main/java/io/opentelemetry/extension/kotlin/KotlinContextElement.java`: `ThreadContextElement<Scope>` calls `Context.makeCurrent()` on resume and closes the scope on suspension.
- Read `extensions/kotlin/src/main/kotlin/io/opentelemetry/extension/kotlin/ContextExtensions.kt`: `Context.asContextElement()`, `ImplicitContextKeyed.asContextElement()`, and `CoroutineContext.getOpenTelemetryContext()`.

### Pattern And Tradeoffs

- Mature SDKs make coroutine context propagation explicit at the coroutine boundary instead of relying on plain thread-local state surviving dispatcher hops.
- Sentry and OpenTelemetry solve this with coroutine context elements; Datadog additionally creates traced coroutine spans around launch/async/withContext.
- LogBrew should close the coroutine propagation gap without adding `kotlinx-coroutines-core` as a required dependency, without creating hidden spans, and without reading coroutine names, baggage, tracestate, or payload-like values.

### LogBrew Follow-Up Implementation

- Added `LogBrewCoroutines.traceContextElement(context)` and `currentTraceContextElement()`.
- The bridge returns `null` when `kotlinx.coroutines.ThreadContextElement` is absent, so the default Maven artifact remains dependency-light.
- When coroutines are present, LogBrew creates a reflection-backed `CoroutineContext.Element` that also implements `ThreadContextElement`; coroutine resume pushes the supplied immutable `LogBrewTraceContext`, and suspension closes the pushed scope.
- The helper propagates only LogBrew trace IDs/span IDs/flags already present in `LogBrewTraceContext`. It does not install dispatchers, launch coroutines, create spans automatically, capture coroutine names, copy baggage/tracestate, inspect coroutine-local payloads, or patch OkHttp/HttpURLConnection.

### Updated Verification

- TDD red: `bash scripts/check_kotlin_package.sh` first failed with unresolved `LogBrewCoroutines`.
- `LogBrewKotlinTest.kt` now proves the bridge fails closed to `null` without `kotlinx.coroutines`.
- `scripts/check_kotlin_package.sh` verifies `LogBrewCoroutines.kt` in the sources jar, `LogBrewCoroutines.class` in the runtime jar, README guidance, and the standard Kotlin package/test/example suite.
- `scripts/real_user_kotlin_smoke.sh` now builds an installed Gradle consumer with `kotlinx-coroutines-core:1.10.2`, runs real `runBlocking` flows with both `withContext(Dispatchers.Default + element)` and `withContext(element + Dispatchers.Default)`, verifies trace metadata survives coroutine dispatcher hops and is restored afterward, and proves spoofed trace metadata is overwritten.

### Remaining Gaps After Coroutine Follow-Up

- Kotlin Android still lacks a typed optional OkHttp interceptor package, automatic lifecycle instrumentation, automatic `HttpURLConnection` instrumentation, baggage/tracestate, rich span events/exceptions, DB/cache/queue spans, and native crash/symbolication integration.

## 2026-06-19 HttpURLConnection Convenience Follow-Up

### Source Re-Read

- Sentry Java/Android HEAD still resolves to `getsentry/sentry-java@7c1a728e8bd2faa42b8f1c25c9f16a145baab60f`.
- Re-read `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt`: `intercept(...)` creates or reuses an HTTP client span, injects Sentry/W3C headers into an OkHttp request builder, runs `chain.proceed(...)`, records status/errors, and finishes in `finally`.
- Re-read `sentry/src/main/java/io/sentry/transport/HttpConnection.java`: `createConnection()` shows direct `HttpURLConnection` setup with explicit `setRequestProperty(...)`, method, timeout, SSL, and `connect()` ownership for Sentry's own transport.
- Datadog Android HEAD still resolves to `DataDog/dd-sdk-android@519550150648592709d441c677437d8b1c3a0707`.
- Re-read `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/trace/TracingInterceptor.kt`: `intercept(...)`, `interceptAndTrace(...)`, `updateRequest(...)`, `handleResponse(...)`, and `handleThrowable(...)` create spans, inject configured propagation headers, run the OkHttp chain, and finish/drop spans based on response/error.
- Re-read `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/DatadogInterceptor.kt`: `intercept(...)`, `handleResponse(...)`, and `handleThrowable(...)` combine RUM resource lifecycle with APM request spans.
- OpenTelemetry Java instrumentation HEAD still resolves to `open-telemetry/opentelemetry-java-instrumentation@63de06bb3c29dd0cdf4059b5b755bb6bbde7fe71`.
- Re-read `instrumentation/http-url-connection/javaagent/src/main/java/io/opentelemetry/javaagent/instrumentation/httpurlconnection/HttpUrlConnectionInstrumentation.java`: advice around `connect`, `getOutputStream`, `getInputStream`, and `getResponseCode` tracks one operation across `HttpURLConnection` lifecycle calls and handles response-code/error edge cases.
- Re-read `HttpUrlConnectionSingletons.java`, `HttpUrlState.java`, `HttpUrlHttpAttributesGetter.java`, and `RequestPropertySetter.java`: OTel stores per-connection state, injects propagation through `setRequestProperty(...)`, records request method/status, and clears state after finish.

### Pattern And Tradeoffs

- Mature SDKs improve developer ergonomics by wrapping request execution and finishing spans from response/error paths instead of asking users to remember every step.
- The automatic versions are stronger for drop-in coverage, but they own interceptors or bytecode instrumentation and may capture broader network/resource details. That is not the right default for LogBrew's dependency-light Kotlin artifact.
- The safer LogBrew-native subset is an explicit `HttpURLConnection` helper that sets exactly one normalized `traceparent`, scopes only the caller's request block, captures status/duration/error, and keeps URL/header/body data out of telemetry.

### LogBrew Follow-Up Implementation

- Added `LogBrewAndroid.withHttpURLConnectionSpan(...)`.
- It infers the method from the app-owned connection, defaults the route template from `connection.url` but sanitizes it to path-only, applies the existing request-span `traceparent` with `connection.setRequestProperty(...)`, runs the caller block under the child trace, reads the response code only after successful execution, records non-negative duration, captures exception type/message on thrown errors, and reactivates the previous active trace.
- The helper does not patch `HttpURLConnection`, open or close the connection, own request/response streams, inspect payloads, copy arbitrary headers, read full URLs/query/fragment, add baggage/tracestate, or create an OkHttp dependency.

### Updated Verification

- TDD red: `bash scripts/check_kotlin_package.sh` failed with unresolved `withHttpURLConnectionSpan`.
- `AndroidRequestSpanTests.kt` now proves header injection, request-child trace scoping, response status capture, duration metadata, parent trace restoration, route sanitization, and spoofed trace metadata overwrite with a fake `HttpURLConnection`.
- `scripts/real_user_kotlin_smoke.sh` now compiles an installed-artifact consumer that uses the packaged jar and a fake `HttpURLConnection`; it verifies one traceparent header, child-span correlation, response status/duration capture, query/fragment stripping, and no `traceparent`/spoofed-span leakage in payload previews.

### Remaining Gaps After HttpURLConnection Follow-Up

- Kotlin Android still lacks a typed optional OkHttp interceptor package, automatic lifecycle instrumentation, hidden/global `HttpURLConnection` instrumentation, baggage/tracestate, rich span events/exceptions, DB/cache/queue spans, and native crash/symbolication integration.

## 2026-06-19 Optional OkHttp Package Boundary Report

### Source Re-Read

- Sentry Java/Android HEAD still resolves to `getsentry/sentry-java@7c1a728e8bd2faa42b8f1c25c9f16a145baab60f`.
- Re-read `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt`: `intercept(...)` creates or reuses a child HTTP span, injects propagation into a cloned `Request.Builder`, runs `chain.proceed(...)`, records status or `IOException`, captures optional failed-request details, and finishes the span in `finally`.
- Re-read `SentryOkHttpInterceptor.finishSpan(...)`, `sendBreadcrumb(...)`, and `shouldCaptureClientError(...)`: Sentry adds request breadcrumbs, can capture response/request network detail, lets `BeforeSpanCallback` mutate or drop spans, and filters client-error reporting by status ranges and propagation targets.
- Datadog Android HEAD still resolves to `DataDog/dd-sdk-android@519550150648592709d441c677437d8b1c3a0707`.
- Re-read `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/trace/TracingInterceptor.kt`: `intercept(...)`, `interceptAndTrace(...)`, `buildSpan(...)`, `updateRequest(...)`, `handleResponse(...)`, `handleThrowable(...)`, and `Builder.build()` create an OkHttp interceptor, clone immutable requests, inject selected propagation header families, finish or drop spans, and expose a traced-request listener.
- Re-read `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/DatadogInterceptor.kt`: `intercept(...)`, `onRequestIntercepted(...)`, `handleResponse(...)`, and `handleThrowable(...)` combine RUM resource tracking with trace span completion and optional resource-header extraction.
- OpenTelemetry Java instrumentation HEAD still resolves to `open-telemetry/opentelemetry-java-instrumentation@63de06bb3c29dd0cdf4059b5b755bb6bbde7fe71`.
- Re-read `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/internal/TracingInterceptor.java`: `intercept(...)` starts an instrumenter context, injects it into a cloned request, scopes `chain.proceed(...)`, and ends the span from response or throwable.
- Re-read `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/TracingCallFactory.java`: `newCall(...)`, `execute()`, and callback wrappers preserve the calling context for synchronous and asynchronous OkHttp execution.

### Competitor Pattern

- Mature Android/Kotlin SDKs win on OkHttp ergonomics because developers add one interceptor or call factory and get child spans plus outbound propagation without hand-coding `startRequestSpan(...)`, header mutation, `try/finally`, status capture, and error capture on every call.
- The cost is real: Sentry and Datadog pull in dedicated OkHttp integration artifacts and larger product coupling. They may capture breadcrumbs, body sizes, header-derived resource data, failed-request events, baggage/tracestate, multiple propagation formats, and RUM/resource lifecycle data. OpenTelemetry's library is cleaner conceptually but still adds OTel dependencies and broader instrumenter abstractions.
- LogBrew's core `co.logbrew:logbrew-kotlin` should stay dependency-light. Adding `okhttp3.Interceptor` to core would make every Kotlin/JVM consumer pay for OkHttp even when they only need server-side, Android log, `HttpURLConnection`, or custom-client helpers.

### Recommended LogBrew-Native Design

- Add a separate optional Maven artifact, tentatively `co.logbrew:logbrew-kotlin-okhttp`, instead of adding OkHttp to the core artifact.
- The artifact should depend on `co.logbrew:logbrew-kotlin` and OkHttp, expose one app-owned interceptor such as `LogBrewOkHttpInterceptor`, and keep construction explicit: `OkHttpClient.Builder().addInterceptor(LogBrewOkHttpInterceptor(client, routeTemplate = ...))`.
- The interceptor should reuse `LogBrewAndroid.startRequestSpan(...)`, `AndroidRequestSpan.applyHeadersTo(...)`, `AndroidRequestSpan.withTrace(...)`, and `LogBrewAndroid.captureRequestSpan(...)` rather than duplicating trace logic.
- It should clone the immutable OkHttp request with exactly one normalized `traceparent`, run `chain.proceed(...)` under the child trace, capture response code and non-negative duration, capture exception type/message only, rethrow original exceptions, and return to the previous trace scope.
- It should default route metadata to method plus query/hash-free path, with an optional route-template resolver for apps that want low-cardinality patterns such as `/users/{id}`.
- It should not capture request/response bodies, arbitrary headers, cookies, full URLs, query strings, fragments, baggage, tracestate, resource-header extraction, RUM state, retry behavior, usage/quota state, or support-ticket diagnostics.

### Next Implementation Task

- Create `kotlin/logbrew-kotlin-okhttp/` as a new optional integration artifact with its own `pom.xml`, source, tests, README, and installed Gradle smoke.
- Update Maven release packaging only if the repo intentionally supports publishing a third Maven artifact; otherwise keep it source/example-only and explicitly state it is not a published artifact yet.
- First failing test should compile a fake OkHttp `Interceptor.Chain` or temporary Gradle app against the planned artifact and fail because `LogBrewOkHttpInterceptor` does not exist.
- Green implementation should prove traceparent injection, child trace scoping, response status/duration, error rethrow, route sanitization, prior trace restoration, no payload/header/full-URL/query leakage, and no core artifact OkHttp dependency.
- Verification should include `bash scripts/check_kotlin_style.sh`, Kotlin package checks updated for the optional artifact boundary, installed Gradle smoke with OkHttp, markdown links, confidentiality scan, release metadata checks, generated-artifact hygiene, and thermo review before commit.

### Status

- This cycle is a source-backed gap report and package-boundary decision, not an SDK implementation.
- LogBrew remains weaker than Sentry/Datadog for one-line OkHttp adoption until the optional artifact or source-packaged integration ships.
- LogBrew remains better for developers who need a small dependency-light core artifact, app-owned instrumentation, and privacy-bounded request spans without body/header/full-URL capture.

## 2026-06-19 Optional OkHttp Artifact Implementation

### Source Re-Read

- Refreshed `getsentry/sentry-java@7c1a728e8bd2faa42b8f1c25c9f16a145baab60f` and re-read `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt`: `intercept(...)`, `finishSpan(...)`, `sendBreadcrumb(...)`, and `shouldCaptureClientError(...)`.
- Refreshed `DataDog/dd-sdk-android@519550150648592709d441c677437d8b1c3a0707` and re-read `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/trace/TracingInterceptor.kt`: `intercept(...)`, `interceptAndTrace(...)`, `buildSpan(...)`, `updateRequest(...)`, `handleResponse(...)`, `handleThrowable(...)`, and `Builder.build()`.
- Re-read Datadog `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/DatadogInterceptor.kt`: `intercept(...)`, `onRequestIntercepted(...)`, `handleResponse(...)`, and `handleThrowable(...)`.
- Refreshed `open-telemetry/opentelemetry-java-instrumentation@63de06bb3c29dd0cdf4059b5b755bb6bbde7fe71` and re-read OkHttp library `TracingInterceptor.intercept(...)` plus `TracingCallFactory.newCall(...)`, `execute()`, and callback wrappers.

### LogBrew Implementation

- Added optional Maven artifact `co.logbrew:logbrew-kotlin-okhttp:0.1.0` with its own POM, README, source, tests, example, package verifier coverage, local installed smoke, release metadata, registry verification, and Maven Central bundle packaging.
- `LogBrewOkHttpInterceptor` depends on app-owned OkHttp, reuses `LogBrewAndroid.startRequestSpan(...)`, clones the immutable request, writes exactly one normalized `traceparent` with `Request.Builder.header(...)`, runs `chain.proceed(...)` under the request child trace, captures response status/duration or exception type/message, rethrows original OkHttp failures, and reports telemetry capture failures through `LogBrewOkHttpCaptureFailureHandler` without breaking the HTTP call.
- Core `co.logbrew:logbrew-kotlin` remains free of OkHttp classes. Apps install the optional artifact only when they already own an `OkHttpClient`.
- The interceptor intentionally avoids request/response body capture, arbitrary header capture, full URL/query/fragment capture, cookies, baggage, tracestate, RUM resources, support tickets, backend usage/quota state, backend symbolication, automatic retry, or global call-factory wrapping.

### Verification

- TDD red: `bash scripts/check_kotlin_package.sh` failed with unresolved `co.logbrew.sdk.okhttp.LogBrewOkHttpInterceptor`.
- Green: `bash scripts/check_kotlin_package.sh` passed with 26 core Kotlin tests, 3 OkHttp tests, core/OkHttp Maven metadata checks, source/javadoc/binary jar inspection, and a guard that the core jar contains no `co/logbrew/sdk/okhttp` classes.
- Installed-artifact proof: `bash scripts/real_user_kotlin_smoke.sh` passed with a temporary Gradle app resolving `co.logbrew:logbrew-kotlin-okhttp:0.1.0`, transitive `co.logbrew:logbrew-kotlin:0.1.0`, and OkHttp `4.12.0`; it ran a real `OkHttpClient` against a loopback JDK HTTP server and verified one outbound `traceparent`, request-child span correlation, route-template span naming, response status/duration, query/fragment stripping, and no raw `traceparent` in event JSON.
- Release proof: `bash scripts/build_maven_central_bundle.sh --output <tmp>` produced a 60-file bundle containing `logbrew-kotlin-okhttp` binary, sources, javadoc README, POM, and checksums.
- Supporting gates passed so far: `bash scripts/check_kotlin_style.sh` with ktlint `1.8.0`, `python3 scripts/check_release_metadata.py`, `python3 scripts/check_generated_artifacts.py`, `bash scripts/check_shell_static.sh` with ShellCheck `0.11.0`, and `git diff --check`.

### Remaining Gaps

- Kotlin Android still lacks automatic lifecycle instrumentation, hidden/global URLConnection instrumentation, baggage/tracestate, rich span events/exceptions, DB/cache/queue spans, and native crash/symbolication parity.

## 2026-06-19 OkHttp Async Context Follow-Up

### Source Re-Read

- Refreshed `open-telemetry/opentelemetry-java-instrumentation@8e25e07fb2bab7bd4e954d7bb744f977e9dbe785` and re-read `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/TracingCallFactory.java`: `newCall(...)`, `attachContextToRequest(...)`, `TracingCall.execute()`, `TracingCall.enqueue(...)`, `TracingCall.clone()`, and the internal callback wrapper.
- Re-read OpenTelemetry `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/internal/TracingInterceptor.java`: `intercept(...)` starts context, injects into immutable requests, scopes `chain.proceed(...)`, and ends spans on response/error.
- Re-read Sentry Java/Android `getsentry/sentry-java@7c1a728e8bd2faa42b8f1c25c9f16a145baab60f` `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt`: `intercept(...)`, `finishSpan(...)`, `sendBreadcrumb(...)`, and `shouldCaptureClientError(...)`.
- Re-read Sentry `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpEventListener.kt`: `callStart(...)`, phase event callbacks, `callEnd(...)`, and `callFailed(...)`.
- Re-read Datadog Android `DataDog/dd-sdk-android@519550150648592709d441c677437d8b1c3a0707` `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/trace/TracingInterceptor.kt`: `interceptAndTrace(...)`, `updateRequest(...)`, `handleResponse(...)`, and `handleThrowable(...)`.

### Pattern And Tradeoffs

- The important async pattern is OpenTelemetry's call-factory wrapper: capture the calling context at `newCall(...)`, attach it to the immutable request for later interceptor work, scope blocking `execute()`, and wrap `Callback.onResponse(...)` / `onFailure(...)` so app code sees the same context even on OkHttp dispatcher threads.
- Sentry and Datadog are stronger for rich network phase spans, breadcrumbs, RUM/resource correlation, and failed-request capture; they also accept more product coupling and broader capture surfaces.
- LogBrew's safer subset is explicit, app-owned wrapping: no global OkHttp patching, no body/header/full URL capture, no baggage/tracestate, no RUM/session replay, no support ticket creation, and no backend-owned symbolication behavior.

### LogBrew Follow-Up Implementation

- Added `LogBrewOkHttpCallFactory`, which wraps an app-owned `Call.Factory`, captures the active `LogBrewTraceContext` at `newCall(...)`, stores it in an OkHttp request tag, scopes blocking `execute()`, wraps async callbacks, and retags cloned calls with the current trace when available.
- Added `LogBrewOkHttpCallbacks.wrap(...)` for custom call flows that only need callback trace reactivation.
- Updated `LogBrewOkHttpInterceptor` to honor a request-tagged `LogBrewTraceContext` before starting its request child span. This lets async dispatcher-thread execution still inject a `traceparent` under the original app trace.
- Updated the installed OkHttp example to use `LogBrewOkHttpCallFactory(okHttp)` and prove both sync and async requests share the parent trace while still emitting request child spans through the interceptor.

### Verification

- TDD red: `bash scripts/check_kotlin_package.sh` first failed with unresolved `LogBrewOkHttpCallbacks`, then with unresolved `LogBrewOkHttpCallFactory`.
- Green: `bash scripts/check_kotlin_package.sh` passed with 26 core tests, 5 OkHttp tests, package metadata checks, source/javadoc/binary jar inspection, README guidance checks, and core-jar isolation from OkHttp classes.
- Installed-artifact proof: `bash scripts/real_user_kotlin_smoke.sh` passed after resolving the optional OkHttp artifact from a temporary Maven repository into a Gradle app; it runs sync and async OkHttp calls against a loopback HTTP server and verifies outbound `traceparent`, parent-trace callback scope, two captured request spans, route-template naming, status/duration capture, query/fragment stripping, and no raw `traceparent` leakage.

### Remaining Gaps After Async Follow-Up

- Kotlin Android still lacks automatic lifecycle instrumentation, hidden/global URLConnection instrumentation, baggage/tracestate, rich span events/exceptions, DB/cache/queue spans, and native crash/symbolication parity.

## 2026-06-19 Android Lifecycle Trace Follow-Up

### Source Re-Read

- Re-read Sentry Java/Android `getsentry/sentry-java@7c1a728e8bd2faa42b8f1c25c9f16a145baab60f` `sentry-android-core/src/main/java/io/sentry/android/core/ActivityLifecycleIntegration.java`: `register(...)`, `startTracing(...)`, `onActivityPreCreated(...)`, `onActivityCreated(...)`, `onActivityStarted(...)`, `onActivityResumed(...)`, `onActivityPrePaused(...)`, `onActivityPaused(...)`, and `onActivityDestroyed(...)`.
- Re-read Sentry `sentry-android-core/src/main/java/io/sentry/android/core/AppState.java` and `LifecycleWatcher.java`: `onStart(...)`, `onStop(...)`, `onForeground(...)`, and `onBackground(...)`.
- Re-read Datadog Android `DataDog/dd-sdk-android@519550150648592709d441c677437d8b1c3a0707` Activity lifecycle tracking source under `features/dd-sdk-android-rum/src/main/kotlin/com/datadog/android/rum/tracking/`: `register(...)`, `unregister(...)`, activity resumed, and activity stopped callbacks.
- Re-read Datadog Activity view and Navigation view tracking sources under the same directory: activity resumed, activity stopped, and `onDestinationChanged(...)`.
- Re-read Datadog Compose integration `integrations/dd-sdk-android-compose/src/main/kotlin/com/datadog/android/compose/internal/ComposeNavigationObserver.kt`: `onDestinationChanged(...)`, and `Navigation3.kt`: `rememberIsResumed(...)`.
- Re-read PostHog Android `posthog/src/main/java/com/posthog/PostHog.kt` at `screen(...)` and `stampCachedScreenName(...)`.

### Pattern And Tradeoffs

- Sentry and Datadog are stronger for automatic Activity, navigation, Compose, foreground/background, view, and session/RUM lifecycle capture. The tradeoff is heavier Android integration, hidden lifecycle registration, broader product coupling, and more chances to collect route/view/session details that LogBrew should keep app-owned unless a future integration package explicitly owns it.
- PostHog is lighter: apps call `screen(...)`, and the SDK stamps cached screen context onto later events. That is easier to reason about but is product-analytics oriented and does not provide trace-linked lifecycle spans.
- LogBrew should take the middle path for core Kotlin: explicit app-owned lifecycle callbacks, active trace correlation, previous-state duration spans, primitive metadata only, and no hidden `ActivityLifecycleCallbacks`, Navigation/Compose observers, session-health derivation, replay/profiling, baggage, tracestate, payload, header, or full URL capture.

### LogBrew Follow-Up Implementation

- Added dependency-free `AndroidLifecycleTracker` plus `LogBrewAndroid.createLifecycleTracker(...)`.
- Apps instantiate the tracker from their own lifecycle callback context, optionally under an active `LogBrewTrace`. `captureTransition(...)` emits one `android.lifecycle:<previous>-><next>` span with the previous state's duration, active trace correlation, primitive Android context metadata, spoofed trace-key overwrite, and same-state dedupe.
- The core Kotlin jar still has no Android SDK, OkHttp, coroutine, or OpenTelemetry dependency. This is explicit lifecycle telemetry, not hidden automatic instrumentation.

### Verification

- TDD red: `bash scripts/check_kotlin_package.sh` failed with unresolved `createLifecycleTracker` and `captureTransition`.
- Green: `bash scripts/check_kotlin_package.sh` passed with 26 core tests and 5 OkHttp tests, package metadata checks, source/javadoc/binary jar inspection, README guidance checks, packaged `AndroidLifecycleTracker.class`, and installed real-user smoke output proving one lifecycle span.
- Installed-artifact proof: `kotlin/logbrew-kotlin/examples/real_user_smoke/RealUserSmoke.kt` now creates a lifecycle tracker from the packaged jar, emits a `created->started` span under a parent trace, verifies duplicate transition dedupe, previous-state duration, Android context metadata, spoofed metadata dropping, and no raw `traceparent` leakage.

### Remaining Gaps After Lifecycle Follow-Up

- Kotlin Android still lacks hidden/global Activity/Navigation/Compose instrumentation for teams that want automatic RUM-style view tracking, hidden/global URLConnection instrumentation, baggage/tracestate, rich span events/exceptions, DB/cache/queue spans, and native crash/symbolication parity.

## Verification

- `bash scripts/check_kotlin_style.sh`: ktlint `1.8.0` passed.
- `bash scripts/check_kotlin_package.sh`: compiles JVM 11 sources/tests/examples, validates Maven metadata, package contents, canonical examples, and packaged trace correlation payload.
- `bash scripts/real_user_kotlin_smoke.sh`: installs from a local Maven-style artifact into a temporary Gradle app, proves dependency remove/re-add, validates installed examples, and runs installed trace correlation proof.
- `scripts/check_kotlin_trace_correlation_payload.py`: validates trace/span IDs, active issue/log/action/metric/product/network metadata, span attributes, outgoing `traceparent`, route query/fragment stripping, and no raw incoming propagation or spoofed trace leakage.
- Repo hygiene also passed: generated-artifact scan, ShellCheck, markdown links, confidentiality scan, backend contract reports, release metadata, and diff whitespace.

## 2026-06-23 Span Event Summary Follow-Up

### Source Re-Read

- Re-read Sentry Java/Android `getsentry/sentry-java@main` `sentry/src/main/java/io/sentry/ISpan.java`: `setThrowable(...)`, `setData(...)`, `setMeasurement(...)`, `setContext(...)`, `startChild(...)`, and span status/tag APIs.
- Re-read Sentry Java/Android `getsentry/sentry-java@main` `sentry/src/main/java/io/sentry/Span.java`: throwable/data/measurement capture and span finish behavior.
- Re-read Sentry Java/Android `getsentry/sentry-java@main` `sentry/src/main/java/io/sentry/SpanContext.java`: serialized tags, data, origin, baggage, measurements, and feature flags.
- Re-read OpenTelemetry Java `open-telemetry/opentelemetry-java@main` `api/all/src/main/java/io/opentelemetry/api/trace/Span.java`: `addEvent(...)`, `recordException(...)`, `addLink(...)`, attributes, and status APIs.

### Pattern And Tradeoffs

- Sentry and OpenTelemetry are stronger for rich span data, events, exceptions, links, baggage, and broader instrumentation context.
- The safer LogBrew subset for Kotlin dependency spans is a small `SpanEventSummary` list: low-cardinality event names, optional timestamp, primitive metadata, no links, no baggage, no tracestate, no stack traces, no exception messages, and no payload/header/query capture.
- Operation helpers sanitize event metadata with the same blocked-key policy as dependency metadata and cap events at eight entries to keep payloads bounded.

### LogBrew Follow-Up Implementation

- Added public `SpanEventSummary` and `SpanAttributes.withEvent(...)` / `withEvents(...)`.
- Added optional `events` to `DatabaseOperation`, `CacheOperation`, and `QueueOperation`; dependency spans include sanitized event summaries when supplied.
- Failed operations now add one type-only `exception` span event while preserving the existing `errorType` metadata and rethrowing the original app exception.
- Updated `spec/event-batch.schema.json` and `scripts/validate_fixtures.py` so span `events` are an explicit public payload contract with a maximum of eight summaries and primitive metadata only.

### Verification

- TDD red: `bash scripts/check_kotlin_package.sh` first failed with unresolved `SpanEventSummary` and missing operation `events`.
- TDD red: `python3 -m unittest tests.test_validate_fixtures` first failed because span `events` were not accepted by the fixture validator.
- Green: `python3 -m unittest tests.test_validate_fixtures` passed with coverage for primitive span-event metadata, nested metadata rejection, and max-event rejection.
- Green: `bash scripts/check_kotlin_package.sh` passed with 32 core Kotlin tests, 5 OkHttp tests, package metadata checks, README checks, jar-content checks, direct span-event cap validation, automatic exception-event budget validation, and the dependency-span example proving event sanitization and type-only exception events.

### Remaining Gaps After Span Event Summaries

- Kotlin still lacks OpenTelemetry-style links, baggage, tracestate, full exception payloads, automatic event capture, automatic HttpURLConnection instrumentation, and native symbolication parity. Those remain deliberate gaps until they have source-backed, privacy-bounded designs.

## 2026-07-03 OkHttp Route Template Follow-Up

### Source Re-Read

- Read Sentry Java/Android `getsentry/sentry-java@2ad4e0dfc7b8138bbce76e521555dbc1ccacdd0e` `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt`: constructor `beforeSpan`, `intercept(...)`, request builder propagation, response/error finish, and `SentryOkHttpInterceptorTest.kt` customizer coverage.
- Read Sentry `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpUtils.kt`: parameterized route limitation and query/fragment stripping.
- Read OpenTelemetry Java Instrumentation `open-telemetry/opentelemetry-java-instrumentation@43737cfdd5902e3d19c722f5f846bae085513ab4` `OkHttpTelemetryBuilder.java`: `setSpanNameExtractorCustomizer(...)`, plus `internal/TracingInterceptor.java` and `TracingCallFactory.java` for request-context propagation and scoped execution.
- Read Datadog Android `DataDog/dd-sdk-android@c1b82590987a81348f3d4236a71662cd2b8db7b0` `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/trace/TracingInterceptor.kt`: resource-name span setup, request update, response/error handling, and 404 resource-name redaction options.
- Read Datadog `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/internal/OkHttpRequestInfo.kt`: request identity model for RUM/APM resource tracking.
- Checked PostHog Android `PostHog/posthog-android@47eca08cccf002c576b5cf5e87aafa0ed3fe96aa`; no comparable OkHttp tracing/interceptor source was found.

### Pattern And Tradeoffs

- Mature OkHttp integrations give teams a way to avoid high-cardinality request names. Sentry exposes a broad span customizer, OpenTelemetry exposes a span-name extractor customizer, and Datadog derives sanitized resource names with configurable redaction behavior.
- Broad customizers are powerful but can also let app code attach full URLs, headers, payload-like values, or unstable IDs to spans. LogBrew should provide the common low-cardinality route-template path directly and keep richer mutation surfaces out until they have stronger privacy and verification evidence.

### LogBrew Follow-Up Implementation

- Added `LogBrewOkHttpRouteTemplates.tag(request, routeTemplate)` and builder overloads so API clients can tag each known request route such as `/api/orders/{order_id}` before the `OkHttpClient` executes it.
- `LogBrewOkHttpInterceptor` now prefers the request-local route template, then its constructor fallback, then the sanitized path. This makes one shared `OkHttpClient` useful across many endpoints without leaking path IDs, query strings, fragments, headers, payloads, baggage, or tracestate.
- `LogBrewAndroid.startRequestSpan(...)` now also emits low-cardinality semantic keys `http.request.method` and `http.route`; request completion adds `http.response.status_code`.
- README and packaged OkHttp example now show per-request route tagging as the primary path and interceptor-level `routeTemplate` only as a fallback for same-route clients.

### Verification

- TDD red: `bash scripts/check_kotlin_package.sh` failed on unresolved `LogBrewOkHttpRouteTemplates` before the helper existed.
- Green: `bash scripts/check_kotlin_package.sh` passed with 32 core Kotlin tests, 7 OkHttp tests, Maven metadata checks, source/javadoc/binary jar inspection, README checks, packaged example checks, and the core-jar isolation guard.
- Installed-artifact proof: `bash scripts/real_user_kotlin_smoke.sh` passed from a temporary Gradle app resolving local Maven artifacts; the OkHttp artifact now includes the route-template helper classes.

### Remaining Gaps After OkHttp Route Template Follow-Up

- Kotlin Android still lacks hidden/global OkHttp or HttpURLConnection instrumentation, request phase timings, baggage/tracestate, richer automatic span events/exceptions, DB/cache/queue automatic spans, and native crash/symbolication parity.

## 2026-07-03 OkHttp Phase Timing Follow-Up

### Source Re-Read

- Read Sentry Java/Android `getsentry/sentry-java@44d18f56b41c98a11883a40899745a8af3960284`
  `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpEventListener.kt`:
  `callStart`, `dnsStart`/`dnsEnd`, `connectStart`/`connectEnd`,
  `requestHeadersStart`/`requestHeadersEnd`,
  `responseHeadersStart`/`responseHeadersEnd`, `callEnd`, and `callFailed`.
- Re-read Sentry
  `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt`
  for request cloning, propagation, response/error span completion, and
  optional network detail capture boundaries.
- Read Datadog Android `DataDog/dd-sdk-android@c1b82590987a81348f3d4236a71662cd2b8db7b0`
  `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/trace/TracingInterceptor.kt`:
  `intercept`, `interceptAndTrace`, `updateRequest`, `handleResponse`,
  `handleThrowable`, and docs recommending network-level interceptors for
  redirect/retry insight.
- Read Datadog
  `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/DatadogInterceptor.kt`:
  `intercept`, `onRequestIntercepted`, `handleResponse`, and
  `handleThrowable` for combined RUM resource and APM span handling.
- Re-read OpenTelemetry Java Instrumentation
  `open-telemetry/opentelemetry-java-instrumentation@43737cfdd5902e3d19c722f5f846bae085513ab4`
  `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/internal/TracingInterceptor.java`
  and `.../TracingCallFactory.java` for immutable request propagation,
  scoped `chain.proceed`, sync/async call context, and callback wrapping.

### Pattern And Tradeoffs

- Sentry gets richer time-to-answer data by pairing its OkHttp interceptor with
  an `EventListener` that tracks DNS, connect, request, response, body, and
  failure phases, but it can also attach host/address/proxy/body-size details.
- Datadog exposes a simple interceptor path and recommends network-level
  instrumentation for redirect/retry insight, while also supporting richer RUM
  resources and optional header/body-derived metadata.
- OpenTelemetry keeps the core request span lifecycle in the interceptor/call
  factory and leaves low-level timing to instrumentation internals.
- LogBrew should improve debugging depth without copying the heavier capture
  surface: app-owned OkHttp `EventListener` timing, duration numbers only,
  same existing request span, no DNS names, IPs, proxies, protocols, TLS
  details, headers, payloads, full URLs, baggage, or tracestate.

### LogBrew Implementation

- Added `LogBrewOkHttpPhaseTimings.eventListenerFactory(...)` to the optional
  `co.logbrew:logbrew-kotlin-okhttp` artifact.
- Apps can install it with
  `OkHttpClient.Builder().eventListenerFactory(LogBrewOkHttpPhaseTimings.eventListenerFactory())`
  alongside `LogBrewOkHttpInterceptor`.
- The listener records only completed phase durations such as
  `okhttp.phase.dnsMs`, `okhttp.phase.connectMs`,
  `okhttp.phase.requestHeadersMs`, and
  `okhttp.phase.responseHeadersMs`, plus `okhttp.phase.recorded=true`.
- `LogBrewOkHttpInterceptor` merges those bounded phase durations into the
  existing sanitized request span through the app-owned `Call`; telemetry
  timing lookup failures go through the existing capture-failure seam and do
  not interrupt the HTTP call.
- Existing explicit boundaries remain: no hidden/global OkHttp patching, no
  request/response body capture, no arbitrary header capture, no full URL,
  query, fragment, DNS host, IP, proxy, protocol, TLS, baggage, tracestate,
  retry, usage/quota, support-ticket, or symbolication behavior.

### Verification

- TDD red: `bash scripts/check_kotlin_package.sh` failed on unresolved
  `LogBrewOkHttpPhaseTimings`.
- Green package gate: `bash scripts/check_kotlin_package.sh` passed with 32
  core Kotlin tests, 8 OkHttp tests, package metadata checks, README checks,
  source/javadoc/binary jar inspection, and core-jar isolation.
- Installed-artifact proof: `bash scripts/real_user_kotlin_smoke.sh` passed
  after packing local Maven artifacts into a temporary Gradle app. The app ran
  real OkHttp sync and async calls against a loopback server, installed
  `LogBrewOkHttpPhaseTimings.eventListenerFactory()`, and verified phase
  duration metadata on the captured spans without leaking traceparent, query,
  fragment, IP, protocol, or body data.

### Remaining Gaps After Phase Timings

- Kotlin Android still trails Sentry/Datadog/OpenTelemetry on hidden/global
  instrumentation, redirects/retries as separate spans, baggage/tracestate,
  richer automatic exception/span events, DB/cache/queue automatic spans,
  profiling, and native crash/symbolication parity.

## 2026-07-07 OkHttp Response-Body Completion Follow-Up

### Source Re-Read

- Read Sentry Java/Android `getsentry/sentry-java@61ba1d557461f830dfe2e117465190144ae487c1`
  `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpInterceptor.kt`:
  `intercept(...)`, `finishSpan(...)`, response/error span finish behavior,
  and the comment that its event listener waits until a response is closed.
- Read Sentry
  `sentry-okhttp/src/main/java/io/sentry/okhttp/SentryOkHttpEventListener.kt`:
  `responseBodyStart(...)`, `responseBodyEnd(...)`, `responseFailed(...)`,
  `callEnd(...)`, and `callFailed(...)` for response-body phase spans and
  call completion.
- Read OpenTelemetry Java Instrumentation
  `open-telemetry/opentelemetry-java-instrumentation@82511f09cc3fac0c30484001d35ecb800842016e`
  `instrumentation/okhttp/okhttp-3.0/library/src/main/java/io/opentelemetry/instrumentation/okhttp/v3_0/internal/TracingInterceptor.java`:
  `intercept(...)`, immutable request propagation, scoped `chain.proceed(...)`,
  and `instrumenter.end(...)` immediately after response return.
- Read Datadog Android `DataDog/dd-sdk-android@ed5ce03e26861835bc0c03fbe4476c31cab29059`
  `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/trace/TracingInterceptor.kt`:
  `interceptAndTrace(...)`, `handleResponse(...)`, `handleThrowable(...)`,
  and `finishRumAware(...)`.
- Read Datadog
  `integrations/dd-sdk-android-okhttp/src/main/kotlin/com/datadog/android/okhttp/DatadogEventListener.kt`
  and `.../internal/RumInstrumentationTimingsCounter.kt`: `responseBodyStart`,
  `responseBodyEnd`, `callEnd`, `sendTiming`, and `buildTiming` for download
  timing/resource metadata.
- Read PostHog Android `PostHog/posthog-android@47eca08cccf002c576b5cf5e87aafa0ed3fe96aa`
  `posthog/src/main/java/com/posthog/PostHogOkHttpInterceptor.kt` and
  `PostHogConfig.kt`: `intercept(...)`, `captureNetworkEvent(...)`, and
  `tracingHeaders` inject PostHog-specific session/distinct-id headers and
  session-replay network telemetry, not W3C request spans.

### Pattern And Tradeoffs

- Mature OkHttp integrations often finish the main trace span when
  `chain.proceed(...)` returns. Sentry and Datadog use separate event-listener
  paths for lower-level network/body phases; Datadog's RUM timing path includes
  download duration after `responseBodyEnd`.
- Sentry and PostHog can capture broader network details for replay-style
  products. That is useful for debugging but too broad for LogBrew's default
  SDK privacy posture.
- LogBrew's safer improvement is an opt-in body-completion mode on the
  existing app-owned interceptor: wrap only the returned `ResponseBody`, queue
  the same sanitized span once at body EOF/close/error, and attach bounded
  phase timing metadata when the app also installs the existing event listener.

### LogBrew Implementation

- Added `finishSpanOnResponseBodyClose` to `LogBrewOkHttpInterceptor`.
- The default remains immediate span capture when `chain.proceed(...)` returns.
- When `finishSpanOnResponseBodyClose = true` and a response body exists,
  LogBrew returns a wrapped `ResponseBody` that captures exactly once on EOF,
  close, read error, or close error.
- Delayed capture can add `okhttp.responseBodyCompletion` and
  `okhttp.phase.responseBodyMs` to the existing request span while making
  `durationMs` include app body consumption time.
- The wrapper preserves app response bytes/errors and does not read, buffer,
  log, or mutate body bytes. It also avoids DNS names, IPs, hosts, full URLs,
  query strings, fragments, arbitrary headers, cookies, payloads, raw
  propagation, baggage, tracestate, replay data, and network-location details.

### Verification

- TDD red: `bash scripts/check_kotlin_package.sh` failed on missing
  `finishSpanOnResponseBodyClose`.
- Green package gate: `bash scripts/check_kotlin_package.sh` passed with 32
  core Kotlin tests, 10 OkHttp tests, package metadata checks, source/javadoc/
  binary jar inspection, README checks, packaged example checks, and the
  core-jar isolation guard.
- Installed-artifact proof: `bash scripts/real_user_kotlin_smoke.sh` passed
  after packing local Maven artifacts into a temporary Gradle app. The app ran
  real OkHttp sync, redirect, and async calls against a loopback server,
  consumed response bodies, and verified `okhttp.responseBodyCompletion`,
  `okhttp.phase.responseBodyMs`, trace correlation, redirect counts, and
  privacy constraints without leaking body text, host, query, fragment,
  protocol, IP, traceparent, or headers.

### Remaining Gaps After Response-Body Completion

- Kotlin Android still trails Sentry/Datadog/OpenTelemetry on hidden/global
  instrumentation, richer retry/redirect span trees, baggage/tracestate,
  automatic DB/cache/queue spans, richer hosted trace UI, and native
  crash/symbolication parity.
