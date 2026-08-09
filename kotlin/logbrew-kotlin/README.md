# LogBrew Kotlin SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Kotlin/JVM SDK for building, validating, previewing, and flushing LogBrew event batches.

The package is dependency-light, uses the Kotlin standard library only, and keeps Android helpers separate from the core JVM event builders.

## Install

For Maven or Gradle publishing, use the package coordinates:

```text
co.logbrew:logbrew-kotlin:0.2.1
```

## Usage

```kotlin
import co.logbrew.sdk.AndroidLogPriority
import co.logbrew.sdk.HttpTransport
import co.logbrew.sdk.IssueAttributes
import co.logbrew.sdk.IssueBreadcrumb
import co.logbrew.sdk.IssueBreadcrumbLevel
import co.logbrew.sdk.LogAttributes
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewTelemetry
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.MetricAttributes
import co.logbrew.sdk.RecordingTransport
import co.logbrew.sdk.ReleaseAttributes
import co.logbrew.sdk.SpanLinkSummary
import co.logbrew.sdk.TelemetryContext
import co.logbrew.sdk.TelemetryDeployment
import co.logbrew.sdk.TelemetryNamedVersion
import co.logbrew.sdk.TelemetryResource
import co.logbrew.sdk.TelemetrySessionContext

val client = LogBrewClient.create(
    apiKey = "LOGBREW_API_KEY",
    sdkName = "my-kotlin-app",
    sdkVersion = "1.0.0",
)

client.release(
    id = "evt_release_001",
    timestamp = "2026-06-02T10:00:00Z",
    attributes = ReleaseAttributes.create("1.2.3").withCommit("abc123def456"),
)

client.metric(
    id = "evt_metric_001",
    timestamp = "2026-06-02T10:00:06Z",
    attributes = MetricAttributes
        .create("checkout.duration", "histogram", 120.0, "ms", "delta")
        .withDescription("Duration of one completed checkout operation.")
        .withMetadata(mapOf("route" to "/checkout")),
)

LogBrewAndroid.captureActivityStarted(
    client = client,
    id = "evt_activity_started_001",
    timestamp = "2026-06-02T10:00:06Z",
    activityName = "MainActivity",
)

LogBrewAndroid.captureAndroidLog(
    client = client,
    id = "evt_android_log_001",
    timestamp = "2026-06-02T10:00:07Z",
    priority = AndroidLogPriority.WARN,
    tag = "CheckoutActivity",
    message = "checkout slow",
    throwable = IllegalStateException("retry budget reached"),
)

LogBrewAndroid.captureThrowable(
    client = client,
    id = "evt_android_throwable_001",
    timestamp = "2026-06-02T10:00:08Z",
    throwable = IllegalStateException("payment failed"),
)

LogBrewAndroid.captureNetworkMilestone(
    client = client,
    id = "evt_android_network_001",
    timestamp = "2026-06-02T10:00:09Z",
    method = "POST",
    routeTemplate = "/api/checkout",
    statusCode = 503,
    durationMs = 42.5,
)

println(client.previewJson())
val response = client.flush(RecordingTransport.alwaysAccept())
```

## Shared Investigation Context

Use `TelemetryContext` to give issues, logs, spans, metrics, actions, releases, and environments the same bounded service, deployment, runtime, framework, operating-system, device, application, trace, session, subject, and tag evidence. Configure stable defaults once on the client, then add a task/thread scope or a narrow event override:

```kotlin
val client = LogBrewClient.create(
    apiKey = "LOGBREW_API_KEY",
    sdkName = "checkout-android",
    sdkVersion = "1.0.0",
    context = TelemetryContext(
        resource = TelemetryResource(
            service = TelemetryNamedVersion("checkout", "2.4.0"),
            deployment = TelemetryDeployment(environment = "production", release = "2026.08.06"),
        ),
        tags = mapOf("region" to "eu"),
    ),
)

val session = TelemetryContext(session = TelemetrySessionContext("opaque-session-7"))
LogBrewTelemetry.withContext(session) {
    client.log(
        "evt_log_001",
        "2026-08-06T12:00:00Z",
        LogAttributes.create("checkout failed", "error"),
    )
}
```

For non-span signals, context merges in this order: conservative automatic Kotlin/JVM context, explicit client context, `LogBrewTelemetry` context, active `LogBrewTrace` correlation, and event context. Later layers win; resource fields and tags merge by field, while trace, session, and subject sections replace the earlier section. A span's own trace IDs are always authoritative over generic context. Pass `includeAutomaticContext = false` when defaults are not appropriate. Automatic context reads only Kotlin/JVM version, operating-system name/version, and architecture; application-owned session and subject identity must be explicit.

`LogBrewAndroid.createClient(...)` additionally supplies Android framework and application-name context. `AndroidContext.withDeviceModel(...)`, `withOsVersion(...)`, `withSessionId(...)`, and `withApplication(...)` promote those explicit values into typed context while retaining the existing compact Android metadata used by older readers.

## Structured Issue Evidence

Create issue evidence directly from a caught exception and record the steps that preceded it:

```kotlin
client.addBreadcrumb(
    IssueBreadcrumb(
        timestamp = "2026-08-06T12:00:00Z",
        category = "navigation",
        type = "screen",
        level = IssueBreadcrumbLevel.INFO,
        message = "Checkout opened",
        data = mapOf("screen" to "Checkout"),
    ),
)

client.issue(
    id = "evt_issue_001",
    timestamp = "2026-08-06T12:00:01Z",
    attributes = IssueAttributes.fromThrowable(
        throwable = caught,
        mechanismType = "kotlin.exception",
        handled = true,
    ),
)
```

`IssueAttributes.fromThrowable(...)` emits exception type, capture mechanism, handled state, and up to 32 newest-first structured frames with filename, function, module, and positive coordinates. It deliberately omits the exception message, raw stack text, locals, arguments, and absolute source paths. Pass the `message` argument only after the application has approved that text for telemetry. `LogBrewAndroid.captureThrowable(...)` uses the same safe default; `includeMessage = true` and `includeStackTrace = true` are separate explicit opt-ins.

Use `IssueException`, `IssueExceptionMechanism`, and `IssueStackFrame` directly when the application already owns normalized exception or source-map evidence instead of a JVM `Throwable`.

The client keeps at most 64 validated breadcrumbs in oldest-to-newest order. Older entries are evicted and the next issue carries `breadcrumbsTruncated = true`; call `clearBreadcrumbs()` at an application-owned privacy or session boundary. Breadcrumb data is limited to eight flat finite primitive fields.

Use `SpanLinkSummary` when a span has a real non-parent relationship to another trace or span:

```kotlin
val linked = SpanLinkSummary(
    traceId = "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId = "00f067aa0ba902b7",
    sampled = true,
    metadata = mapOf("relation" to "batch.parent"),
)

val attributes = SpanAttributes
    .create("queue.consume", traceId, spanId, "ok")
    .withLink(linked)
```

Links require non-zero W3C trace/span IDs, accept finite primitive metadata, and are capped at eight entries per span.

## W3C Trace Correlation

Use `LogBrewTrace` when an Android or JVM operation should connect logs, issues, product actions, metrics, spans, and outbound requests under one W3C trace. The helper reads only an explicit `traceparent` string you pass in, creates a fresh local span ID when continuing a trace, and falls back to a local root trace when propagation is missing or malformed:

```kotlin
val trace = LogBrewTrace.continueOrCreate(incomingTraceparent)

LogBrewTrace.use(trace).use {
    client.log(
        id = "evt_log_001",
        timestamp = "2026-06-02T10:00:03Z",
        attributes = LogAttributes
            .create("checkout handler failed", "error")
            .withLogger("CheckoutActivity"),
    )

    client.issue(
        id = "evt_issue_001",
        timestamp = "2026-06-02T10:00:04Z",
        attributes = IssueAttributes.create("Checkout timeout", "error"),
    )

    client.span(
        id = "evt_span_001",
        timestamp = "2026-06-02T10:00:05Z",
        attributes = LogBrewTrace.spanAttributes(
            name = "POST /checkout/{cart_id}",
            status = "error",
            durationMs = 37.5,
        ),
    )

    val headers = LogBrewTrace.outgoingHeaders()
}
```

If your app already owns an OpenTelemetry `SpanContext`, copy only the stable W3C fields into LogBrew without adding an SDK dependency or exporter bridge:

```kotlin
val copiedOtelParent =
    LogBrewOpenTelemetrySpanContext.create(
        traceId = otelSpanContext.traceId,
        spanId = otelSpanContext.spanId,
        traceFlags = otelSpanContext.traceFlags.asHex(),
    )

val trace = copiedOtelParent?.let(LogBrewTrace::fromOpenTelemetrySpanContext)
    ?: LogBrewTrace.createTraceContext()
```

If your app already has `io.opentelemetry:opentelemetry-api` on its classpath, `LogBrewOpenTelemetry` can copy a live current span, an explicit `Span`, or a `Context` without making OpenTelemetry a LogBrew dependency:

```kotlin
val trace = LogBrewOpenTelemetry.traceContextFromCurrentSpan()
    ?: LogBrewTrace.createTraceContext()

val currentParent = LogBrewOpenTelemetry.spanContextFromCurrentSpan()
val spanParent = LogBrewOpenTelemetry.spanContextFromSpan(otelSpan)
val contextParent = LogBrewOpenTelemetry.spanContextFromContext(otelContext)
```

Those helpers return `null` when OpenTelemetry is absent, no valid span is active, or the object is not an OpenTelemetry span/context. They copy only trace ID, span ID, and trace flags, then create a fresh LogBrew child span. LogBrew does not read OTel attributes, tracestate, baggage, links, events, exporters, processors, payloads, or headers.

While a `LogBrewTraceScope` is active, `LogBrewClient` adds authoritative structured trace context to every signal and retains the compatible `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled` metadata on issue, log, action, and metric events. `LogBrewAndroid.captureProductAction(...)`, `captureNetworkMilestone(...)`, `captureAndroidLog(...)`, and `captureThrowable(...)` receive the same correlation through the client. Trace metadata overwrites spoofed trace keys in app metadata, and the helper never captures raw propagation values, request bodies, response bodies, arbitrary headers, query strings, fragments, or visual replay. Use `LogBrewTrace.outgoingHeaders()` for app-owned HTTP clients when you want to forward only the normalized `traceparent` header.

If your app already uses `kotlinx-coroutines-core`, `LogBrewCoroutines` can create an optional coroutine context element that restores the active LogBrew trace whenever a coroutine resumes. The core LogBrew artifact does not depend on coroutines; the helper returns `null` when `kotlinx.coroutines.ThreadContextElement` is not on the app classpath:

```kotlin
val trace = LogBrewTrace.continueOrCreate(incomingTraceparent)
val traceElement = LogBrewCoroutines.traceContextElement(trace)
val telemetryElement = LogBrewCoroutines.telemetryContextElement(session)

withContext(
    Dispatchers.Default +
        (traceElement ?: EmptyCoroutineContext) +
        (telemetryElement ?: EmptyCoroutineContext),
) {
    client.log(
        "evt_coroutine_worker",
        "2026-06-02T10:00:29Z",
        LogAttributes.create("worker resumed with trace", "info"),
    )
}

LogBrewTrace.use(trace).use {
    val currentTraceElement = LogBrewCoroutines.currentTraceContextElement()
    // Pass currentTraceElement to launch, async, or withContext when work may hop threads.
}

LogBrewTelemetry.use(session).use {
    val currentContextElement = LogBrewCoroutines.currentTelemetryContextElement()
    // Pass currentContextElement when shared investigation context may hop threads.
}
```

`LogBrewCoroutines` restores only the immutable `LogBrewTraceContext` and `TelemetryContext` that you provide or that are currently active. It does not install coroutine dispatchers, create spans automatically, capture coroutine names, collect baggage/tracestate, or read coroutine-local payloads.

For app-owned Android or JVM request clients such as OkHttp or `HttpURLConnection`, use `LogBrewAndroid.startRequestSpan(...)` to create a child span and get exactly one `traceparent` header to attach to your request. Finish the span explicitly when the response or exception is available:

```kotlin
LogBrewTrace.use(trace).use {
    val requestSpan =
        LogBrewAndroid.startRequestSpan(
            method = "POST",
            routeTemplate = "/api/checkout",
            metadata = mapOf("funnel" to "checkout"),
        )

    requestSpan.applyHeadersTo { name, value ->
        okHttpRequestBuilder.header(name, value)
    }

    val response = requestSpan.withTrace {
        okHttpClient.newCall(okHttpRequestBuilder.build()).execute()
    }

    LogBrewAndroid.captureRequestSpan(
        client = client,
        id = "evt_request_001",
        timestamp = "2026-06-02T10:00:06Z",
        requestSpan = requestSpan,
        statusCode = response.code,
        durationMs = 42.5,
    )
}
```

For `HttpURLConnection`, `withHttpURLConnectionSpan(...)` applies the normalized `traceparent`, scopes the request block, captures the response status and duration, and reactivates the previous trace afterward:

```kotlin
val connection = URL("https://api.example.com/api/checkout?cart=123").openConnection() as HttpURLConnection

val body = LogBrewAndroid.withHttpURLConnectionSpan(
    client = client,
    id = "evt_http_url_connection_001",
    timestamp = "2026-06-02T10:00:07Z",
    connection = connection,
    routeTemplate = "/api/checkout",
) { tracedConnection ->
    tracedConnection.inputStream.bufferedReader().use { it.readText() }
}
```

If you use OkHttp or another request client, keep using `startRequestSpan(...)`, `applyHeadersTo(...)`, `withTrace { ... }`, and `captureRequestSpan(...)` around the app-owned request execution. The request helpers sanitize methods and route templates, strip query strings and fragments, record status, duration, and exception type, and overwrite spoofed trace metadata. They do not install an OkHttp interceptor, patch `HttpURLConnection`, capture exception descriptions or payloads, copy arbitrary headers, or send baggage/tracestate.

## Dependency Operation Spans

Use `LogBrewOperationTracing` when your app owns the database, cache, or queue call and wants one child span around the work without adding JDBC, Redis, Kafka, or Android framework dependencies to LogBrew:

```kotlin
val orderId = LogBrewOperationTracing.databaseOperation(
    client = client,
    operationName = "select checkout",
    config = DatabaseOperation(
        system = "postgresql",
        operationKind = "query",
        databaseName = "orders",
        statementTemplate = "SELECT * FROM orders WHERE id = ?",
        rowCount = 1,
        metadata = mapOf("component" to "checkout"),
        events = listOf(
            SpanEventSummary
                .create("db.pool.wait")
                .withMetadata(mapOf("phase" to "before_query")),
        ),
    ),
) {
    repository.loadOrder(orderId)
}
```

`databaseOperation`, `cacheOperation`, and `queueOperation` activate a fresh child `LogBrewTraceContext` while the callable runs, queue one span, preserve the original result or exception, and report telemetry capture failures through `onCaptureFailure` without replacing the app-owned operation result. Use `DatabaseOperation`, `CacheOperation`, and `QueueOperation` for low-cardinality system, operation kind, name, count, hit, `dbStatementTemplate`, primitive metadata fields, and optional `SpanEventSummary` entries. When an operation throws, LogBrew adds a type-only `exception` event and still rethrows the original error.

The helpers intentionally do not patch drivers or clients, open support tickets, inspect raw dependency statements or identifiers, capture payload-like values, copy arbitrary request metadata, collect network locations, add baggage, or send tracestate. Metadata keys that look like raw statements, parameters, identifiers, payloads, broker addresses, request metadata, browser state, access material, or resource locations are dropped before enqueue. Span events are capped to eight entries, automatic exception summaries share that cap, and event metadata accepts only primitive values; exception summaries include the exception type only, not messages or stacks.

## HTTP Delivery

Use `HttpTransport` when a JVM or Android app is ready to send queued batches to LogBrew. It posts JSON to the production intake by default, passes the SDK key through the `authorization` header, and supports custom endpoints, headers, and timeouts for local collectors or proxies:

```kotlin
val transport = HttpTransport(
    endpoint = "https://api.logbrew.co/v1/events",
    headers = mapOf("x-logbrew-source" to "checkout-android"),
    connectTimeoutMillis = 10_000,
    readTimeoutMillis = 10_000,
)

val response = client.flush(transport)
```

Keep personally sensitive values out of event messages and metadata before calling `flush(transport)`. Use `RecordingTransport.alwaysAccept()` when you want to inspect queued JSON before network delivery.

## Metrics

Use `metric(...)` when your application already owns a numeric measurement. LogBrew validates the metric name, kind, value, unit, temporality, and optional primitive metadata before queueing the event:

```kotlin
client.metric(
    id = "evt_metric_001",
    timestamp = "2026-06-02T10:00:06Z",
    attributes = MetricAttributes
        .create("queue.depth", "gauge", 42.0, "{items}", "instant")
        .withDescription("Number of items waiting in the checkout queue.")
        .withMetadata(mapOf("queue" to "checkout")),
)
```

An optional `withDescription(...)` gives people and investigation tools the stable meaning of the measurement. Keep it generic, single-line, between 1 and 1,024 Unicode scalar values, and free of identifiers, personal data, or changing values. It is not a query dimension. Use low-cardinality metadata such as route templates, queue names, feature names, or region names. Avoid raw URLs, user identifiers, stack traces, or high-cardinality labels.

## Android Product Timelines

Use `LogBrewAndroid.captureProductAction(...)` for product steps your Android app already understands, such as screen-level funnel steps, taps, retries, and submit decisions. Use `LogBrewAndroid.captureNetworkMilestone(...)` for important API milestones that should be correlated with the same screen, session, or trace:

```kotlin
val context =
    AndroidContext
        .create()
        .withActivityName("CheckoutActivity")
        .withScreenName("Checkout")
        .withSessionId("session_123")

LogBrewAndroid.captureProductAction(
    client = client,
    id = "evt_android_action_001",
    timestamp = "2026-06-02T10:00:09Z",
    name = "checkout.submit",
    context = context,
    metadata = mapOf("funnel" to "checkout", "step" to "submit"),
)

LogBrewAndroid.captureNetworkMilestone(
    client = client,
    id = "evt_android_network_001",
    timestamp = "2026-06-02T10:00:10Z",
    method = "POST",
    routeTemplate = "/api/checkout",
    statusCode = 503,
    durationMs = 42.5,
    context = context,
    metadata = mapOf("funnel" to "checkout", "traceId" to "trace_123"),
)
```

When your app already owns Activity, Fragment, Compose, or navigation lifecycle callbacks, create an explicit lifecycle tracker and call it from those callbacks. LogBrew records the previous state duration as a child span under the active trace and ignores duplicate same-state transitions:

```kotlin
val lifecycleTracker =
    LogBrewTrace.use(trace).use {
        LogBrewAndroid.createLifecycleTracker(
            initialState = "created",
            realtimeMs = 1_000.0,
            context = context,
            metadata = mapOf("phase" to "cold_start"),
        )
    }

lifecycleTracker.captureTransition(
    client = client,
    id = "evt_android_lifecycle_001",
    timestamp = "2026-06-02T10:00:11Z",
    nextState = "started",
    realtimeMs = 1_124.5,
)
```

`routeTemplate` is stripped of query strings and hashes before capture. Keep metadata primitive and low-cardinality: screen names, route templates, funnel names, lifecycle states, status codes, durations, session IDs, and trace IDs are appropriate. Do not send request bodies, response bodies, headers, user-entered form values, or full URLs with private query text. These helpers do not patch HTTP clients, install hidden `ActivityLifecycleCallbacks`, own navigation observers, or record visual replay.

## Examples

The `examples` directory contains copyable snippets for creating a client, sending through `HttpTransport`, capturing Android activity/product/API telemetry, and producing rich privacy-bounded issue and trace evidence. Run `make run-rich-investigation` to inspect the complete context, breadcrumb, exception, frame, and span-link payload.

## Behavior

- `previewJson()` returns the queued batch as pretty JSON.
- `LogBrewTrace` validates W3C `traceparent`, creates request/task-local-style scopes through `AutoCloseable`, adds active trace metadata to app-owned events, and creates outgoing `traceparent` headers without patching HTTP clients.
- `TelemetryContext` supplies one schema-v1 resource/correlation envelope to all seven signal types, and `LogBrewTelemetry` scopes deterministic task/thread context without global user state.
- `LogBrewOpenTelemetry` optionally copies trace ID, span ID, and trace flags from app-owned OpenTelemetry `Span`/`Context` objects when OpenTelemetry is already installed by the app; it returns `null` instead of installing exporters, processors, baggage, or tracestate support.
- `LogBrewCoroutines` optionally creates trace and telemetry-context `ThreadContextElement` bridges by reflection when `kotlinx-coroutines-core` is already installed by the app; it returns `null` instead of adding a coroutine dependency to LogBrew.
- `LogBrewAndroid.startRequestSpan()` and `captureRequestSpan()` create explicit outbound request child spans for app-owned OkHttp, `HttpURLConnection`, or other request clients with one normalized `traceparent` header and sanitized completion metadata. `AndroidRequestSpan.applyHeadersTo(...)` writes only that header through your request builder, `withTrace { ... }` scopes request-local telemetry under the child span, and `withHttpURLConnectionSpan(...)` handles the same pattern for app-owned `HttpURLConnection` calls.
- `LogBrewAndroid.createLifecycleTracker()` returns an `AndroidLifecycleTracker` for app-owned lifecycle callbacks; `captureTransition()` emits one `android.lifecycle:<previous>-><next>` span with previous-state duration, active trace correlation, primitive metadata, and same-state dedupe.
- `LogBrewOperationTracing` creates explicit database, cache, and queue child spans around app-owned callables without driver patching, Java agents, client dependencies, query/parameter capture, cache key/value capture, message-body capture, arbitrary header capture, baggage, or tracestate.
- `metric(...)` queues explicit, application-owned metric events with name, bounded description, kind, value, unit, temporality, and low-cardinality metadata validation.
- `flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `shutdown(transport)` flushes queued events and rejects later writes.
- `HttpTransport` uses JDK `HttpURLConnection`, supports endpoint/header/connect-timeout/read-timeout settings, and maps request failures to retryable `TransportException.network(...)` failures.
- `RecordingTransport.alwaysAccept()` is useful when you want to inspect queued JSON before network delivery.
- `SdkException` exposes stable `code` and `detailMessage` values.
- `LogBrewAndroid` helpers capture activity lifecycle, screen views, Android `Log` priority-style messages, caught `Throwable`s, and logcat-style messages without importing Android classes.
- `captureProductAction()` and `captureNetworkMilestone()` enqueue explicit Android `action` events for app-owned product and API milestones with primitive metadata, query/hash-free route templates, and no automatic HTTP patching.
- `captureAndroidLog()` accepts Android-compatible priority integers such as `AndroidLogPriority.WARN`, records the tag as the LogBrew logger, promotes explicit Android context, and records throwable type without message or stack text by default. `includeThrowableMessage` and `includeStackTrace` are explicit opt-ins.
- `IssueAttributes.fromThrowable()` and `captureThrowable()` emit typed exception/mechanism/handled/frame evidence while omitting exception descriptions and raw stack text by default; message and stack capture remain separate explicit opt-ins.
- `addBreadcrumb()` keeps the newest 64 validated steps and marks eviction; `clearBreadcrumbs()` resets the store at an app-owned privacy or session boundary.
- `SpanLinkSummary` adds up to eight validated W3C relationships to a span without copying baggage, headers, or linked payloads.
