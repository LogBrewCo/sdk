# LogBrew Kotlin SDK

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

## Examples

The `examples` directory contains copyable snippets for creating a client, sending through `HttpTransport`, and capturing Android activity/log/exception events in your own app.

## Behavior

- `previewJson()` returns the queued batch as pretty JSON.
- `flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `shutdown(transport)` flushes queued events and rejects later writes.
- `HttpTransport` uses JDK `HttpURLConnection`, supports endpoint/header/connect-timeout/read-timeout settings, and maps request failures to retryable `TransportException.network(...)` failures.
- `RecordingTransport.alwaysAccept()` is useful when you want to inspect queued JSON before network delivery.
- `SdkException` exposes stable `code` and `detailMessage` values.
- `LogBrewAndroid` helpers capture activity lifecycle, screen views, Android `Log` priority-style messages, caught `Throwable`s, and logcat-style messages without importing Android classes.
- `captureAndroidLog()` accepts Android-compatible priority integers such as `AndroidLogPriority.WARN`, records the tag as the LogBrew logger, captures primitive Android context metadata, and records throwable type/message without stack text by default.
- `captureThrowable()` turns caught exceptions into issue events with throwable type/message metadata and keeps stack text opt-in through `includeStackTrace = true`.
