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

## Verification

- `bash scripts/check_kotlin_style.sh`: ktlint `1.8.0` passed.
- `bash scripts/check_kotlin_package.sh`: compiles JVM 11 sources/tests/examples, validates Maven metadata, package contents, canonical examples, and packaged trace correlation payload.
- `bash scripts/real_user_kotlin_smoke.sh`: installs from a local Maven-style artifact into a temporary Gradle app, proves dependency remove/re-add, validates installed examples, and runs installed trace correlation proof.
- `scripts/check_kotlin_trace_correlation_payload.py`: validates trace/span IDs, active issue/log/action/metric/product/network metadata, span attributes, outgoing `traceparent`, route query/fragment stripping, and no raw incoming propagation or spoofed trace leakage.
- Repo hygiene also passed: generated-artifact scan, ShellCheck, markdown links, confidentiality scan, backend contract reports, release metadata, and diff whitespace.
