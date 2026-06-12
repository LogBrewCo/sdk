# LogBrew Kotlin SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Kotlin/JVM SDK for building, validating, previewing, and flushing LogBrew event batches.

The package is dependency-light, uses the Kotlin standard library only, and keeps Android helpers separate from the core JVM event builders.

## Install

For Maven or Gradle publishing, use the package coordinates:

```text
co.logbrew:logbrew-kotlin:0.1.0
```

## Usage

```kotlin
import co.logbrew.sdk.AndroidLogPriority
import co.logbrew.sdk.HttpTransport
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.MetricAttributes
import co.logbrew.sdk.RecordingTransport
import co.logbrew.sdk.ReleaseAttributes

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

## HTTP Delivery

Use `HttpTransport` when a JVM or Android app is ready to send queued batches to LogBrew. It posts JSON to the production intake by default, passes the SDK key through the `authorization` header, and supports custom endpoints, headers, and timeouts for local collectors or proxies:

```kotlin
val transport = HttpTransport(
    endpoint = "https://api.logbrew.com/v1/events",
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
        .withMetadata(mapOf("queue" to "checkout")),
)
```

Use low-cardinality metadata such as route templates, queue names, feature names, or region names. Avoid raw URLs, user identifiers, stack traces, or high-cardinality labels.

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

`routeTemplate` is stripped of query strings and hashes before capture. Keep metadata primitive and low-cardinality: screen names, route templates, funnel names, step names, status codes, durations, session IDs, and trace IDs are appropriate. Do not send request bodies, response bodies, headers, user-entered form values, or full URLs with private query text. These helpers do not patch HTTP clients or record visual replay.

## Examples

The `examples` directory contains copyable snippets for creating a client, sending through `HttpTransport`, and capturing Android activity, product action, API milestone, log, and exception events in your own app.

## Behavior

- `previewJson()` returns the queued batch as pretty JSON.
- `metric(...)` queues explicit, application-owned metric events with name, kind, value, unit, temporality, and low-cardinality metadata validation.
- `flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `shutdown(transport)` flushes queued events and rejects later writes.
- `HttpTransport` uses JDK `HttpURLConnection`, supports endpoint/header/connect-timeout/read-timeout settings, and maps request failures to retryable `TransportException.network(...)` failures.
- `RecordingTransport.alwaysAccept()` is useful when you want to inspect queued JSON before network delivery.
- `SdkException` exposes stable `code` and `detailMessage` values.
- `LogBrewAndroid` helpers capture activity lifecycle, screen views, Android `Log` priority-style messages, caught `Throwable`s, and logcat-style messages without importing Android classes.
- `captureProductAction()` and `captureNetworkMilestone()` enqueue explicit Android `action` events for app-owned product and API milestones with primitive metadata, query/hash-free route templates, and no automatic HTTP patching.
- `captureAndroidLog()` accepts Android-compatible priority integers such as `AndroidLogPriority.WARN`, records the tag as the LogBrew logger, captures primitive Android context metadata, and records throwable type/message without stack text by default.
- `captureThrowable()` turns caught exceptions into issue events with throwable type/message metadata and keeps stack text opt-in through `includeStackTrace = true`.
