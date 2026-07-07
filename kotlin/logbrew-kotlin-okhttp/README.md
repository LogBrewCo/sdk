# LogBrew Kotlin OkHttp Integration

Optional Kotlin/JVM integration for apps that already use OkHttp and want one interceptor to create privacy-bounded outbound request spans.

Core Kotlin users do not need this package. Install it only where the app already owns an `OkHttpClient`.

## Install

Install from Maven Central:

```kotlin
dependencies {
    implementation("co.logbrew:logbrew-kotlin-okhttp:0.1.1")
}
```

The package depends on `co.logbrew:logbrew-kotlin:0.1.1` and OkHttp `4.12.0`.

## Usage

```kotlin
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.okhttp.LogBrewOkHttpCallbacks
import co.logbrew.sdk.okhttp.LogBrewOkHttpCallFactory
import co.logbrew.sdk.okhttp.LogBrewOkHttpInterceptor
import co.logbrew.sdk.okhttp.LogBrewOkHttpPhaseTimings
import co.logbrew.sdk.okhttp.LogBrewOkHttpRouteTemplates
import okhttp3.OkHttpClient
import okhttp3.Request

val client = LogBrewClient.create(
    apiKey = "LOGBREW_API_KEY",
    sdkName = "checkout-android",
    sdkVersion = "1.0.0",
)

val okHttp =
    OkHttpClient
        .Builder()
        .addInterceptor(LogBrewOkHttpInterceptor(client))
        .eventListenerFactory(LogBrewOkHttpPhaseTimings.eventListenerFactory())
        .build()

LogBrewTrace.use(LogBrewTrace.continueOrCreate(incomingTraceparent)).use {
    val response =
        okHttp
            .newCall(
                LogBrewOkHttpRouteTemplates.tag(
                    Request.Builder().url("https://api.example.com/api/checkout?cart=123").build(),
                    "/api/checkout/{cart_id}",
                ),
            )
            .execute()

    response.close()
}
```

`LogBrewOkHttpInterceptor` clones the immutable request, writes exactly one normalized `traceparent` header, runs `chain.proceed(...)` under the request child trace, captures response status or exception type/message, records duration, and rethrows the original OkHttp failure.

The interceptor does not capture request or response bodies, arbitrary headers, full URLs, query strings, fragments, cookies, baggage, tracestate, visual replay, RUM resources, support tickets, backend usage/quota state, or symbolication data. Telemetry capture failures are reported to an optional `LogBrewOkHttpCaptureFailureHandler` and do not break the app-owned HTTP call.

When OkHttp returns a final response with a `priorResponse` chain, the interceptor adds bounded counts for `okhttp.priorResponseCount`, `okhttp.redirectCount`, and `okhttp.retryCount`. These help explain redirect/retry-heavy calls without recording prior response URLs, `Location` headers, arbitrary headers, bodies, query strings, fragments, trace headers, baggage, or tracestate.

`LogBrewOkHttpPhaseTimings.eventListenerFactory()` is optional. Add it when you want privacy-bounded request phase durations on the same request span, such as DNS, connect, request headers, and response headers. It records only bounded duration numbers and a boolean marker; it does not capture DNS names, IPs, proxies, protocols, TLS details, headers, bodies, URLs, query strings, fragments, redirects, baggage, or tracestate. If your app already owns an OkHttp `EventListener.Factory`, pass it to `eventListenerFactory(delegate)` so LogBrew wraps and preserves your listener.

When you also want the span duration and phase metadata to include response-body download/consumption, opt in to delayed completion:

```kotlin
val okHttp =
    OkHttpClient
        .Builder()
        .addInterceptor(LogBrewOkHttpInterceptor(client, finishSpanOnResponseBodyClose = true))
        .eventListenerFactory(LogBrewOkHttpPhaseTimings.eventListenerFactory())
        .build()
```

With `finishSpanOnResponseBodyClose = true`, LogBrew wraps only the returned `ResponseBody` and queues the span once the app reaches body EOF or closes the body. This can add `okhttp.responseBodyCompletion` and `okhttp.phase.responseBodyMs` to the same request span. The wrapper does not read, buffer, log, or alter body bytes. If the app never consumes or closes the body, the span remains unfinished, matching OkHttp's owned response lifecycle.

For asynchronous `enqueue(...)` calls, wrap the app-owned `OkHttpClient` as a `Call.Factory` when you want the active trace to survive OkHttp dispatcher threads. This lets the interceptor create the request child span under the trace that was active when `newCall(...)` was created and reactivates that trace for app callback code:

```kotlin
val tracedCalls = LogBrewOkHttpCallFactory(okHttp)

LogBrewTrace.use(LogBrewTrace.continueOrCreate(incomingTraceparent)).use {
    tracedCalls
        .newCall(Request.Builder().url("https://api.example.com/api/checkout").build())
        .enqueue(appCallback)
}
```

If your app already owns custom call creation and only needs callback scope, use `LogBrewOkHttpCallbacks.wrap(appCallback)` directly. `LogBrewOkHttpCallFactory` and `LogBrewOkHttpCallbacks.wrap(...)` do not create support tickets, patch OkHttp globally, capture callback payloads, or swallow callback exceptions.

Use a per-request route template when you know the endpoint pattern at call sites. This keeps span names low-cardinality even when one `OkHttpClient` talks to many endpoints:

```kotlin
val request =
    LogBrewOkHttpRouteTemplates.tag(
        Request.Builder().url("https://api.example.com/api/orders/ord_123?cart=123").build(),
        "/api/orders/{order_id}",
    )

okHttp.newCall(request).execute().close()
```

Use the interceptor `routeTemplate` only as a fallback for clients where every request has the same route pattern:

```kotlin
val okHttp =
    OkHttpClient
        .Builder()
        .addInterceptor(
            LogBrewOkHttpInterceptor(
                client = client,
                routeTemplate = "/api/checkout/{cart_id}",
            ),
        )
        .build()
```

For custom clients or `HttpURLConnection`, use the dependency-light helpers in `co.logbrew:logbrew-kotlin` instead of this OkHttp package.
