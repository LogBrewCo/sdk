# LogBrew Unity SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Unity package for building, validating, previewing, and flushing LogBrew event batches from games and realtime apps.

The package is source-only, targets Unity `2021.3` or newer through UPM, and has no runtime package dependencies.

## Install

Add the package through Unity Package Manager from a Git URL or a local package path:

```json
{
  "dependencies": {
    "co.logbrew.unity": "file:../Packages/co.logbrew.unity"
  }
}
```

Use the placeholder key in examples only:

```csharp
using LogBrew.Unity;

var client = LogBrewUnity.CreateClient(
    apiKey: "LOGBREW_API_KEY",
    gameName: "my-unity-game");

client.Release(
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    ReleaseAttributes.Create("1.2.3").WithCommit("abc123def456"));

LogBrewUnity.CaptureSceneLoaded(
    client,
    "evt_scene_loaded_001",
    "2026-06-02T10:00:06Z",
    "MainMenu",
    context: UnityContext.Create().WithPlatform("ios").WithSessionId("session_001"));

string preview = client.PreviewJson();
TransportResponse response = client.Flush(RecordingTransport.AlwaysAccept());
```

## HTTP Delivery

Use `HttpTransport` when the game or realtime app is ready to send queued batches to LogBrew. It posts JSON to the production intake by default, passes the SDK key through the `authorization` header, and supports custom endpoints, headers, and timeouts for local collectors or proxies:

```csharp
var transport = new HttpTransport(
    new Uri("https://api.logbrew.co/v1/events"),
    new Dictionary<string, string> { ["x-logbrew-source"] = "unity-client" },
    TimeSpan.FromSeconds(10));

TransportResponse response = client.Flush(transport);
```

Keep personally sensitive values out of event messages and metadata before calling `Flush(transport)`. Use `RecordingTransport.AlwaysAccept()` when you want to inspect queued JSON before network delivery.

## W3C Trace Correlation

Use `LogBrewTrace` when a scene action, request, or frame should connect Unity logs, issues, actions, and spans under one W3C trace. The helper validates incoming `traceparent` values, creates a fresh local span ID, keeps the active trace on the current thread, and only adds primitive trace metadata to LogBrew events. It does not patch `UnityWebRequest`, capture request payloads, copy headers, or record query strings.

```csharp
var trace = LogBrewTraceContext.ContinueOrCreate(incomingTraceparent);

using (LogBrewTrace.Activate(trace))
{
    client.Log(
        "evt_checkout_log_001",
        "2026-06-02T10:00:21Z",
        LogAttributes.Create("checkout handler failed", "error").WithLogger("CheckoutController"));

    client.Span(
        "evt_checkout_span_001",
        "2026-06-02T10:00:22Z",
        LogBrewTrace.SpanAttributes("POST /checkout/{cart_id}", "error", 37.5));

    LogBrewUnity.CaptureLifecycleSpan(
        client,
        "evt_lifecycle_001",
        "2026-06-02T10:00:23Z",
        previousState: "active",
        currentState: "paused",
        durationMs: 1532.25,
        context: UnityContext.Create().WithSceneName("Checkout").WithSessionId("session_001"));

    UnityRequestSpan requestSpan = LogBrewUnity.StartRequestSpan(
        method: "GET",
        routeTemplate: "/api/checkout/status");
    IReadOnlyDictionary<string, string> requestHeaders = requestSpan.Headers;
    // Apply requestHeaders["traceparent"] to your app-owned UnityWebRequest.
    LogBrewUnity.CaptureRequestSpan(
        client,
        "evt_request_001",
        "2026-06-02T10:00:24Z",
        requestSpan,
        statusCode: 503,
        durationMs: 184.5,
        errorType: "UnityWebRequestError",
        context: UnityContext.Create().WithSceneName("Checkout"),
        timings: UnityRequestTimings.Create()
            .WithSendMs(12.5)
            .WithWaitMs(80)
            .WithReceiveMs(92)
            .WithResponseBodyBytes(2048));

    IReadOnlyDictionary<string, string> headers = LogBrewTrace.OutgoingHeaders();
    string traceparent = headers["traceparent"];

    var coroutineTracker = new UnityCoroutineTracker(
        client,
        idFactory: () => "evt_coroutine_001",
        timestampFactory: () => "2026-06-02T10:00:25Z",
        realtimeMilliseconds: () => Time.realtimeSinceStartupAsDouble * 1000);
    var tracedCoroutine = coroutineTracker.Trace("checkout.upload", UploadCheckoutCoroutine());
    // StartCoroutine(tracedCoroutine) in a MonoBehaviour you own.
}
```

Issue, log, action, and Unity helper events inherit active trace metadata while the scope is active. Spans stay explicit through `LogBrewTrace.SpanAttributes(...)`. Request spans are app-owned: `StartRequestSpan(...)` returns only `traceparent`, and `CaptureRequestSpan(...)` records route-only metadata, optional fixed `UnityRequestTimings` phase durations, and response byte counts without query strings, payloads, or copied request headers.
For app-owned `UnityWebRequest` calls, create a `UnityRequestTracker` and pass `request.SetRequestHeader` when starting the request; after `yield return request.SendWebRequest()`, call `Capture(...)` with the response status, Unity error type, and optional fixed request timing phases. The tracker writes exactly one `traceparent`, computes duration from your realtime clock, and records the existing sanitized request span without wrapping or patching Unity networking.
For app-owned lifecycle callbacks, create a `UnityLifecycleTracker` in your own `MonoBehaviour`, then call `CapturePause(...)` from `OnApplicationPause` or `CaptureFocus(...)` from `OnApplicationFocus`. The tracker deduplicates repeated pause/focus notifications and records previous-state duration spans, but it does not create hidden GameObjects, subscribe globally, infer session health, or patch Unity APIs.
For app-owned coroutines, use `LogBrewUnity.TraceCoroutine(...)` when you only need trace reactivation across `yield` boundaries. Use `UnityCoroutineTracker` when you also want a completion/failure span with duration from your realtime clock. Both helpers return an `IEnumerator` that you pass to your own `StartCoroutine(...)`; neither creates hidden `MonoBehaviour` objects, patches coroutine scheduling, or subscribes to lifecycle events.

## Sample Source

The package includes sample source for creating a client, sending through `HttpTransport`, recording scene transitions, mapping Unity logs, capturing exceptions, creating lifecycle, request, and coroutine spans, tracking app-owned lifecycle callbacks, applying app-owned request headers, recording request timing phases, preserving coroutine trace context, and correlating Unity telemetry with W3C `traceparent` in your own game or realtime app.

## Behavior

- `PreviewJson()` returns the queued batch as pretty JSON.
- `Flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `Shutdown(transport)` flushes queued events and rejects later writes.
- `HttpTransport` uses `HttpClient`, supports endpoint/header/timeout settings, and maps request failures to retryable `TransportException.Network(...)` failures.
- `LogBrewUnity.CaptureSceneLoaded()` records Unity scene transitions as action events.
- `LogBrewUnity.CaptureLogMessage()` maps Unity log types to LogBrew log levels.
- `LogBrewUnity.CaptureException()` records Unity exception details as issue events.
- `LogBrewUnity.CaptureLifecycleSpan()` records app-owned lifecycle transitions such as `active -> paused` as spans with previous-state duration.
- `UnityLifecycleTracker` turns app-owned pause/focus callbacks into deduplicated lifecycle spans without hidden `MonoBehaviour` creation or global subscriptions.
- `LogBrewUnity.StartRequestSpan()` returns a child trace context plus `traceparent` header for app-owned request clients such as `UnityWebRequest`.
- `LogBrewUnity.CaptureRequestSpan()` records app-owned request completions as child spans with method, route template, status code, optional error type, optional fixed `UnityRequestTimings`, and Unity context metadata.
- `UnityRequestTimings` records optional request phase durations and response byte counts without capturing URLs, headers, payloads, baggage, or tracestate.
- `UnityRequestTracker` combines app-owned request header injection with completion capture, duration calculation, and optional request timings while leaving `UnityWebRequest` ownership with your code.
- `LogBrewUnity.TraceCoroutine()` captures an explicit or active trace and reactivates it while each app-owned coroutine step executes.
- `UnityCoroutineTracker` wraps an app-owned coroutine with child trace context and records one completion or exception-type-only failure span.
- `UnityContext` adds scene, object, platform, session, and frame metadata while keeping the core event builders independent from `UnityEngine`.
- `LogBrewTrace` adds active trace metadata to issue, log, action, span, and Unity helper events without global HTTP patching or payload/header capture.
