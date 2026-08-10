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

## Shared Context and Metrics

`TelemetryContext` gives issues, logs, spans, metrics, actions, releases, and environments the same bounded service, deployment, Unity/runtime, OS, device architecture, application, trace, session, subject, and tag evidence. Configure stable defaults once, add an ambient scope for one player flow, and use an event override only for facts that change on that event:

```csharp
var defaults = TelemetryContext.Create()
    .WithResource(TelemetryResource.Create()
        .WithDeployment("production", "2.3.0")
        .WithApplication("Checkout Game", "2.3.0", "204")
        .Build())
    .WithTag("region", "eu")
    .Build();

var client = LogBrewUnity.CreateClient(
    "LOGBREW_API_KEY",
    "checkout-game",
    context: defaults);

var playerFlow = TelemetryContext.Create()
    .WithSession("opaque-session-7")
    .WithSubject("opaque-player-42", "user")
    .WithTag("journey", "checkout")
    .Build();

using (LogBrewTelemetry.ActivateContext(playerFlow))
{
    client.Metric(
        "evt_frame_duration_001",
        "2026-06-02T10:00:09Z",
        MetricAttributes.Create("frame.duration", "histogram", 16.6, "ms", "delta")
            .WithDescription("Duration of one rendered frame.")
            .WithMetadata(new Dictionary<string, object?> { ["scene"] = "Checkout" }));
}
```

By default the client adds non-unique runtime, OS, architecture, application, Unity framework, and platform facts when they are available. Pass `includeAutomaticContext: false` to omit runtime-discovered values; the explicit game name and SDK framework identity remain. Subject and session IDs are never discovered from accounts, device identifiers, cookies, or platform services. Provide only opaque IDs approved by your application, and clear or replace the scope at your own privacy boundary.

Metric kinds are `counter`, `gauge`, and `histogram`. Gauges require `instant`; counters and histograms require `delta` or `cumulative` and non-negative values. Values must be finite and units must be non-empty. An optional `WithDescription(...)` gives people and investigation tools the stable meaning of the measurement. Keep it generic, single-line, between 1 and 1,024 Unicode scalar values, and free of identifiers, personal data, or changing values. It is not a query dimension. Keep metric metadata low-cardinality: scene, route template, game mode, or feature flag names are suitable; player IDs, request IDs, raw URLs, and payload values are not.

## Rich Issue Evidence

Keep breadcrumbs as bounded machine-readable steps, then capture either an application-owned `Exception` or a Unity log-callback stack. The client retains the newest 64 breadcrumbs, marks eviction with `breadcrumbsTruncated`, keeps at most 32 frames, reduces absolute source paths to basenames, and never copies an automatic exception message into the issue:

```csharp
client.AddBreadcrumb(
    IssueBreadcrumb.Create("2026-06-02T10:00:07Z", "checkout.request")
        .WithType("http")
        .WithLevel("warning")
        .WithMessage("retry started")
        .WithData(new Dictionary<string, object?> { ["attempt"] = 2 }));

try
{
    SubmitCheckout();
}
catch (Exception error)
{
    LogBrewUnity.CaptureException(
        client,
        "evt_checkout_issue_001",
        "2026-06-02T10:00:08Z",
        error,
        handled: true,
        context: UnityContext.Create().WithSceneName("Checkout"));
}
```

Use `IssueExceptionInfo`, `IssueExceptionMechanism`, and `IssueStackFrame` when your game already owns normalized source-map or IL2CPP symbol evidence. Call `ClearBreadcrumbs()` at a player, session, consent, or account boundary. Breadcrumb data accepts at most eight flat finite primitive fields; it rejects nested objects and unbounded text.

Automatic exception capture follows `InnerException` and
`AggregateException` members into a bounded parent-first
`IssueExceptionChain`. Messages remain redacted, per-node stack availability is
explicit, and cycles or the eight-node cap mark truncation. Games with
normalized IL2CPP evidence can build the same graph through
`IssueExceptionChainEntry`; the reported root must match the legacy exception
and frames. See the shared
[exception-chain contract](../../docs/exception-chain-evidence.md).

## Span Events and Links

Use bounded span events for important points inside one operation and links for causal-but-not-parent relationships such as queued work or batch fan-in:

```csharp
client.Span(
    "evt_checkout_span_001",
    "2026-06-02T10:00:10Z",
    SpanAttributes.Create(
            "checkout.submit",
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "00f067aa0ba902b7",
            "error")
        .WithEvent(SpanEventSummary.Create("retry")
            .WithMetadata(new Dictionary<string, object?> { ["attempt"] = 2 }))
        .WithLink(SpanLinkSummary.Create(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbb").WithSampled(false)));
```

Each span accepts at most eight events and eight links. Event/link metadata is flat and primitive. Links require normalized non-zero W3C trace and span IDs; they are evidence, not a parent-child claim.

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

All seven signal types support typed trace context. Issue, log, metric, action, release, and environment events inherit the active trace while the scope is active; issue, log, metric, and action events also keep compatible primitive correlation fields. Spans stay explicit through `LogBrewTrace.SpanAttributes(...)`. Request spans are app-owned: `StartRequestSpan(...)` returns only `traceparent`, and `CaptureRequestSpan(...)` records route-only metadata, optional fixed `UnityRequestTimings` phase durations, and response byte counts without query strings, payloads, or copied request headers.
For app-owned `UnityWebRequest` calls, create a `UnityRequestTracker` and pass `request.SetRequestHeader` when starting the request; after `yield return request.SendWebRequest()`, call `Capture(...)` with the response status, Unity error type, and optional fixed request timing phases. The tracker writes exactly one `traceparent`, computes duration from your realtime clock, and records the existing sanitized request span without wrapping or patching Unity networking.
For app-owned lifecycle callbacks, create a `UnityLifecycleTracker` in your own `MonoBehaviour`, then call `CapturePause(...)` from `OnApplicationPause` or `CaptureFocus(...)` from `OnApplicationFocus`. The tracker deduplicates repeated pause/focus notifications and records previous-state duration spans, but it does not create hidden GameObjects, subscribe globally, infer session health, or patch Unity APIs.
For app-owned coroutines, use `LogBrewUnity.TraceCoroutine(...)` when you need trace and telemetry-context reactivation across `yield` boundaries. Use `UnityCoroutineTracker` when you also want a completion/failure span with duration from your realtime clock. Both helpers return an `IEnumerator` that you pass to your own `StartCoroutine(...)`; neither creates hidden `MonoBehaviour` objects, patches coroutine scheduling, or subscribes to lifecycle events.

## Sample Source

The package includes sample source for creating a client, sending through `HttpTransport`, adding shared context, recording metrics, breadcrumbs, structured exceptions and frames, span events and links, scene transitions, lifecycle/request/coroutine spans, and W3C `traceparent` correlation in your own game or realtime app.

## Behavior

- `PreviewJson()` returns the queued batch as pretty JSON.
- `Flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `Shutdown(transport)` flushes queued events and rejects later writes.
- `HttpTransport` uses `HttpClient`, supports endpoint/header/timeout settings, and maps request failures to retryable `TransportException.Network(...)` failures.
- `LogBrewUnity.CaptureSceneLoaded()` records Unity scene transitions as action events.
- `LogBrewUnity.CaptureLogMessage()` maps Unity log types to LogBrew log levels.
- `LogBrewUnity.CaptureException()` records typed exception identity, mechanism/handled state, bounded basename-only frames, and the current breadcrumb snapshot without automatically copying private exception messages.
- `MetricAttributes` validates counter, gauge, and histogram measurements and carries the same context and trace correlation as other signals.
- `TelemetryContext` merges client, ambient, active-trace, and event context in that order; event values win without mutating the caller's context.
- `SpanEventSummary` and `SpanLinkSummary` add up to eight bounded evidence records of each kind to a span.
- `LogBrewUnity.CaptureLifecycleSpan()` records app-owned lifecycle transitions such as `active -> paused` as spans with previous-state duration.
- `UnityLifecycleTracker` turns app-owned pause/focus callbacks into deduplicated lifecycle spans without hidden `MonoBehaviour` creation or global subscriptions.
- `LogBrewUnity.StartRequestSpan()` returns a child trace context plus `traceparent` header for app-owned request clients such as `UnityWebRequest`.
- `LogBrewUnity.CaptureRequestSpan()` records app-owned request completions as child spans with method, route template, status code, optional error type, optional fixed `UnityRequestTimings`, and Unity context metadata.
- `UnityRequestTimings` records optional request phase durations and response byte counts without capturing URLs, headers, payloads, baggage, or tracestate.
- `UnityRequestTracker` combines app-owned request header injection with completion capture, duration calculation, and optional request timings while leaving `UnityWebRequest` ownership with your code.
- `LogBrewUnity.TraceCoroutine()` captures an explicit or active trace and reactivates it while each app-owned coroutine step executes.
- `UnityCoroutineTracker` wraps an app-owned coroutine with child trace context and records one completion or exception-type-only failure span.
- `UnityContext` adds scene, object, platform, session, frame, and optional typed telemetry context while keeping core event builders independent from a compile-time `UnityEngine` dependency.
- `LogBrewTrace` adds active typed trace context to all signals without global HTTP patching or payload/header capture.
