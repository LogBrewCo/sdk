# LogBrew .NET SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public .NET SDK for building, validating, previewing, and flushing LogBrew event batches, with `System.Net.Http` delivery, W3C trace correlation, and opt-in `Microsoft.Extensions.Logging` provider support.

The library targets `netstandard2.0` and .NET 8, uses `System.Net.Http` for built-in HTTP delivery, and depends on `Microsoft.Extensions.Logging` for the standard .NET logging provider surface. Existing manual and memory-only APIs remain available on both targets; encrypted restart delivery is available only to .NET 8 applications.

## Install

```bash
dotnet add package LogBrew
```

Optional integration packages install only when you need their runtime:

```bash
dotnet add package LogBrew.AspNetCore
dotnet add package LogBrew.EntityFrameworkCore
dotnet add package LogBrew.HttpClient
dotnet add package LogBrew.StackExchangeRedis
dotnet add package LogBrew.OpenTelemetry
```

## Usage

```csharp
using LogBrew;

var client = LogBrewClient.Create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "my-dotnet-app",
    sdkVersion: "1.0.0");

client.Release(
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    ReleaseAttributes.Create("1.2.3").WithCommit("abc123def456"));
client.Action(
    "evt_action_001",
    "2026-06-02T10:00:05Z",
    ActionAttributes.Create("deploy", "success"));

Console.WriteLine(client.PreviewJson());
TransportResponse response = client.Shutdown(RecordingTransport.AlwaysAccept());
Console.Error.WriteLine(response.StatusCode);
```

## Shared Telemetry Context

`TelemetryContext` gives issues, logs, spans, actions, metrics, releases, and environments the same versioned resource and correlation vocabulary. Set stable service/deployment identity once with `LogBrewClientOptions`, activate request or job identity with `LogBrewTelemetry.ActivateContext(...)`, and use an attribute's `WithContext(...)` only for an event-specific override.

```csharp
using LogBrew;

var serviceContext = TelemetryContext.Create()
    .WithResource(
        TelemetryResource.Create()
            .WithService("checkout-api", "1.4.2")
            .WithDeployment("production", "checkout-api@1.4.2")
            .WithFramework("aspnetcore", "10.0")
            .WithApplication("checkout", "1.4.2", "104")
            .Build())
    .WithTag("region", "eu")
    .Build();

var client = LogBrewClient.Create(
    "LOGBREW_API_KEY",
    "checkout-dotnet-service",
    "1.0.0",
    new LogBrewClientOptions { Context = serviceContext });

var requestContext = TelemetryContext.Create()
    .WithTrace(
        "4bf92f3577b34da6a3ce929d0e0e4736",
        "b7ad6b7169203331",
        "00f067aa0ba902b7",
        sampled: true)
    .WithSession("session_01")
    .WithSubject("subject_opaque_42", "user")
    .WithTag("journey", "checkout")
    .Build();

using (LogBrewTelemetry.ActivateContext(requestContext))
{
    client.Log(
        "evt_checkout",
        "2026-08-03T08:15:30Z",
        LogAttributes.Create("checkout started", "info"));
}
```

The final merge order is client context, current async-local context plus `LogBrewTrace.Current`, then event context. Resource sections and tags merge field by field; a later trace, session, or subject replaces the earlier section. Builders validate and detach inputs before queueing, and disposing an ambient scope reinstates the exact earlier context. For span events, the required top-level trace and span IDs remain canonical and integrations also attach the matching typed context so related non-span signals can join the same trace.

By default, the client adds only .NET runtime name/version, OS family, and process architecture beneath explicit context. Set `DisableRuntimeContext = true` in `LogBrewClientOptions` to turn those defaults off without discarding caller context. Runtime defaults do not inspect environment variables, machine names, user names, network addresses, startup arguments, working directories, files, cloud metadata, or application configuration.

Context uses `schemaVersion: 1`. Strings are limited to 256 Unicode scalar values, session and subject IDs to 200, and tags to 32 low-cardinality string dimensions with 64-character ASCII keys. Control characters, malformed Unicode, invalid or all-zero W3C identifiers, and empty resource sections fail before queueing. Use opaque session and subject IDs; never put names, email addresses, IP addresses, authentication material, raw URLs, or free-form user input in context or tags.

## Typed Issue Diagnostics

Use `IssueAttributes.FromException(...)` for privacy-bounded exception identity,
capture mechanism and handled state, and up to 32 newest-first structured
frames. Automatic projection keeps basename-only source identity plus bounded
function and module names. It deliberately omits the exception message, raw
stack text, source snippets, locals, and absolute paths; add an approved issue
message explicitly only when your application has a suitable data policy.

```csharp
using System;
using System.Collections.Generic;
using LogBrew;

try
{
    SubmitCheckout();
}
catch (InvalidOperationException error)
{
    client.Issue(
        "evt_issue_checkout",
        "2026-08-02T08:15:31Z",
        IssueAttributes.FromException(
                error,
                "Checkout failed",
                "dotnet.exception_handler",
                true)
            .WithBreadcrumb(
                IssueBreadcrumb.Create("2026-08-02T08:15:30Z", "checkout.retry")
                    .WithType("http")
                    .WithLevel("warning")
                    .WithData(new Dictionary<string, object?>
                    {
                        ["attempt"] = 2,
                        ["retryable"] = true
                    })));
}
```

For app-owned payloads, use `IssueExceptionInfo`,
`IssueExceptionMechanism`, `IssueStackFrame`, and `IssueBreadcrumb` directly.
Frames are capped at 32; breadcrumbs are capped at 64 and stay
oldest-to-newest. Breadcrumb data accepts at most eight flat finite primitive
fields. `WithBreadcrumbsTruncated(true)` records that older entries were
evicted. Filenames, coordinates, exception/mechanism names, timestamps,
breadcrumb fields, Debug IDs, and severity aliases are validated against the
shared event contract. The packaged `examples/IssueDiagnostics.cs` file proves
the same API from an installed package.

## Automatic Delivery

`LogBrewClient.Create(...)` remains manual and starts no worker. Use `CreateAutomatic(...)` only when this client should own delivery scheduling through one transport:

```csharp
using System;
using LogBrew;

using var transport = new HttpTransport(new HttpTransportOptions
{
    Timeout = TimeSpan.FromSeconds(5)
});
var client = LogBrewClient.CreateAutomatic(
    "LOGBREW_API_KEY",
    "my-dotnet-app",
    "1.0.0",
    transport,
    new AutomaticDeliveryOptions
    {
        FlushAtQueueSize = 100,
        FlushInterval = TimeSpan.FromSeconds(5),
        MaxRetries = 2
    });

client.Log(
    "evt_log_automatic_001",
    "2026-06-02T10:00:02Z",
    LogAttributes.Create("automatic delivery is ready", "info"));

DeliveryHealthSnapshot health = client.DeliveryHealth();
TransportResponse shutdown = client.Shutdown();
```

The lazy client-owned worker starts on the first accepted event and coalesces interval and queue-threshold wakeups. Delivery uses one ordered queue, one in-flight request, immutable failed-prefix retries, and requests capped at 100 events and 256 KiB. Defaults retain at most 1,000 events and 4 MiB of serialized event data; `DroppedEvents()` and the optional drop callback explain local bounds without changing application outcomes.

Retryable `408` and `5xx` responses use capped jitter with zero to ten configured retries. A single valid `Retry-After` delta-seconds or IMF-fixdate value from `HttpTransport` can raise that delay up to `MaxRetryDelay`; malformed or ambiguous guidance falls back to local jitter. Authentication, quota, validation, and other non-retryable outcomes pause automatic sends without removing the failed prefix. Call `RecoverAutomaticDelivery()` after correcting the cause. `Flush()` and `Shutdown()` serialize with the worker; shutdown rejects later capture and joins the owned worker. The application remains responsible for bounding custom transport calls, including timeouts.

`DeliveryHealth()` returns fixed lifecycle, activity, outcome, status-class, queue, retry, accepted, and drop fields. It never includes event content, endpoint or authorization data, response text, exceptions, filesystem paths, or process metadata. Remote acceptance followed by a lost response remains an at-least-once ambiguity: retry may deliver the same immutable request again.

### Encrypted Restart Delivery (.NET 8+)

Use `CreateAutomaticDurable(...)` when one .NET 8 process should retain accepted telemetry across application restarts. The application authorizes a parent directory and supplies a 256-bit key; the SDK owns one fixed child directory and never persists the key. Windows requires Windows 10 version 1709 (build 16299) or newer.

```csharp
using System;
using LogBrew;

var keyBytes = Convert.FromHexString(
    "00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF");
using var key = new DurableDeliveryKey("primary-2026", keyBytes);
using var storage = new DurableDeliveryOptions("/app-owned/telemetry", key);
using var transport = new HttpTransport();
var client = LogBrewClient.CreateAutomaticDurable(
    "LOGBREW_API_KEY",
    "my-dotnet-app",
    "1.0.0",
    transport,
    storage,
    new AutomaticDeliveryOptions());
```

Durable admission writes one authenticated AES-256-GCM record per event before adding it to the in-memory queue. Before network delivery, the SDK also authenticates the exact immutable request prefix and its ordered record names. A successful response removes only that prefix after durable acknowledgement; interruption after remote acceptance may replay the same request, but does not discard later work. Normal shutdown retains unsent authenticated records for the next process.

Only one process may own a store. Recovery fails closed for missing or wrong keys, corruption, unknown files, unsafe ownership, links, or replacement. Supply one primary key and a bounded list of previous keys to rotate records during recovery; new records always use the primary key. Key IDs identify keys but are not secret and must contain only stable letters, numbers, `.`, `_`, or `-`.

Storage failures pause automatic delivery with `DeliveryPauseReason.Storage`. After correcting a transient storage problem, call `RecoverAutomaticDelivery()`. If records cannot be recovered, call `PurgeDurableDelivery()` only while the client is paused and idle, then call `RecoverAutomaticDelivery()` explicitly. Purge removes only SDK-owned durable records and retains the authorized parent and ownership marker. Keep key material available for every process that must recover pending telemetry.

## Explicit Metrics

Metrics answer "how much?", "how often?", "how long?", and "what is the current level?" across many events. They power dashboard trends, comparisons, regression detection, and alert thresholds; they do not explain a root cause by themselves. Attach the same service, deployment, session, and trace context as nearby logs, issues, and spans so a human or AI can move from an abnormal chart to the evidence that explains it.

Use `MetricAttributes` when your application already knows the measurement it wants to report:

```csharp
using System;
using System.Collections.Generic;
using LogBrew;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "my-dotnet-app", "1.0.0");
client.Metric(
    "evt_metric_001",
    "2026-06-02T10:00:06Z",
    MetricAttributes.Create("queue.depth", "gauge", 42, "{items}", "instant")
        .WithContext(
            TelemetryContext.Create()
                .WithTag("queue", "default")
                .Build()));
```

Use a `counter` for an amount that accumulates, such as completed jobs or failures; use a `gauge` for a point-in-time level, such as queue depth or active connections; and use a `histogram` sample for a distribution, such as request duration or payload size. Counters and histograms use `delta` or `cumulative` temporality and must be non-negative; gauges use `instant` temporality and may go up or down. Prefer stable route templates and low-cardinality dimensions—never raw user, session, trace, URL, or request IDs as metric tags. This SDK does not automatically collect CLR, runtime, or framework metrics yet.

## Product and Network Timelines

Use `ProductTimeline` when your .NET service already knows important product steps or API milestones. The helpers create normal `action` events with primitive metadata that AI assistants can analyze across sessions without visual replay, HTTP client patching, request/response payload capture, or header capture.

```csharp
using LogBrew;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "my-dotnet-app", "1.0.0");
var timelineContext = TelemetryContext.Create()
    .WithSession("session_123")
    .WithSubject("subject_opaque_42", "user")
    .WithTag("journey", "checkout")
    .Build();
var timelineTrace = LogBrewTraceContext.FromTraceparent(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "b7ad6b7169203331");

client.Action(
    "evt_action_checkout_submit",
    "2026-06-02T10:00:05Z",
    ProductTimeline.ProductAction("checkout.submit")
        .WithRouteTemplate("/checkout/:step")
        .WithContext(timelineContext)
        .WithTraceContext(timelineTrace)
        .WithScreen("Checkout")
        .WithFunnel("checkout")
        .WithStep("submit")
        .WithMetadata(new Dictionary<string, object?> { ["cartTier"] = "gold" })
        .ToActionAttributes());

client.Action(
    "evt_network_payment",
    "2026-06-02T10:00:06Z",
    ProductTimeline.NetworkMilestone("https://api.example.com/v1/payments/:id?debug=sample")
        .WithMethod("POST")
        .WithStatusCode(202)
        .WithDurationMs(183.4)
        .WithContext(timelineContext)
        .WithTraceContext(timelineTrace)
        .ToActionAttributes());
```

`ProductTimeline` strips query strings and fragments from route templates, keeps metadata primitive-only, and leaves all product action and network milestone capture under app control. `WithSessionId(...)` and `WithTraceId(...)` remain available for legacy flat metadata, but new integrations should use typed context and exact W3C trace IDs.

## First Useful Service Telemetry

For first useful .NET service telemetry, combine release, environment, logs, product actions, network milestones, metrics, and a W3C-linked span in one small app-owned flow:

```csharp
using System.Collections.Generic;
using LogBrew;

const string incomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const string childSpanId = "b7ad6b7169203331";
var traceparent = Traceparent.Parse(incomingTraceparent);
var serviceContext = TelemetryContext.Create()
    .WithResource(
        TelemetryResource.Create()
            .WithService("checkout-api", "1.4.2")
            .WithDeployment("production", "checkout-api@1.4.2")
            .Build())
    .Build();
var client = LogBrewClient.Create(
    "LOGBREW_API_KEY",
    "checkout-dotnet-service",
    "1.0.0",
    new LogBrewClientOptions { Context = serviceContext });

client.Release("evt_release_checkout", "2026-06-02T10:00:00Z", ReleaseAttributes.Create("checkout-api@1.4.2"));
client.Environment("evt_environment_checkout", "2026-06-02T10:00:01Z", EnvironmentAttributes.Create("production"));

var requestContext = TelemetryContext.Create()
    .WithTrace(traceparent.TraceId, childSpanId, traceparent.ParentSpanId, traceparent.Sampled)
    .WithSession("sess_checkout_123")
    .WithSubject("subject_checkout_opaque", "user")
    .WithTag("journey", "checkout")
    .Build();

using (LogBrewTelemetry.ActivateContext(requestContext))
{
    client.Log(
        "evt_log_checkout_started",
        "2026-06-02T10:00:02Z",
        LogAttributes.Create("checkout request started", "info")
            .WithLogger("checkout.http")
            .WithMetadata(new Dictionary<string, object?>
            {
                ["routeTemplate"] = "/checkout/:cart_id"
            }));

    client.Action(
        "evt_action_payment_api",
        "2026-06-02T10:00:04Z",
        ProductTimeline.NetworkMilestone("https://payments.example/payments/:payment_id?card=sample")
            .WithMethod("POST")
            .WithStatusCode(202)
            .WithDurationMs(183.4)
            .ToActionAttributes());

    client.Metric(
        "evt_metric_http_server_duration",
        "2026-06-02T10:00:05Z",
        MetricAttributes.Create("http.server.duration", "histogram", 183.4, "ms", "delta")
            .WithMetadata(new Dictionary<string, object?>
            {
                ["method"] = "POST",
                ["routeTemplate"] = "/checkout/:cart_id",
                ["statusCode"] = 202
            }));

    client.Span(
        "evt_span_checkout_request",
        "2026-06-02T10:00:06Z",
        Traceparent.SpanAttributesFromTraceparent(
            incomingTraceparent,
            TraceparentSpanInput.Create("POST /checkout/:cart_id", childSpanId, "ok")
                .WithDurationMs(183.4)));
}

var outgoingHeaders = Traceparent.CreateHeaders(traceparent.TraceId, childSpanId, traceparent.TraceFlags);
```

`Traceparent` validates W3C shape, rejects forbidden or all-zero IDs, normalizes IDs, exposes the sampled flag, creates outbound `traceparent` headers, and builds child span attributes with primitive metadata only. The ambient context lets each request signal carry the same typed trace, session, subject, and journey identity without duplicating those values in flat metadata. The packaged `examples/FirstUsefulTelemetry.cs` file shows the complete release, environment, log, product action, network milestone, metric, and span flow.

## Request Trace Correlation

Use `LogBrewHttpRequestTelemetry` when your service owns request handling and wants one W3C request span to connect request logs, handler errors, metrics, and outgoing propagation. The helper keeps capture explicit: it does not patch global HTTP clients, read payloads, or collect request headers.

```csharp
using System;
using System.Collections.Generic;
using LogBrew;
using Microsoft.Extensions.Logging;

const string incomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "1.0.0");
var request = LogBrewHttpRequestTelemetry.Start(
    client,
    "POST",
    "https://shop.example/checkout/:cart_id?coupon=sample#review",
    incomingTraceparent);
var requestContext = TelemetryContext.Create()
    .WithTrace(request.Trace)
    .WithSession("sess_checkout_123")
    .WithSubject("subject_checkout_opaque", "user")
    .WithTag("journey", "checkout")
    .Build();

using ILoggerFactory factory = LoggerFactory.Create(builder =>
{
    builder.AddLogBrew(client, new LogBrewLoggerOptions { EventIdPrefix = "checkout_trace" });
});

using (LogBrewTelemetry.ActivateContext(requestContext))
{
    using (request.Activate())
    {
        ILogger logger = factory.CreateLogger("CheckoutTrace");
        logger.LogWarning("checkout slow for {CartId}", "cart_123");

        try
        {
            SubmitCheckout();
        }
        catch (InvalidOperationException error)
        {
            client.Issue(
                "evt_issue_checkout_trace",
                "2026-06-02T10:00:04Z",
                IssueAttributes.FromException(
                        error,
                        "Checkout handler failed",
                        "dotnet.request_handler",
                        true)
                    .WithMetadata(new Dictionary<string, object?>
                    {
                        ["routeTemplate"] = request.RouteTemplate
                    }));
        }
    }

    request.FinishSpanAndMetric(
        "evt_span_checkout_trace",
        "evt_metric_checkout_trace",
        "2026-06-02T10:00:06Z",
        503);
}

IReadOnlyDictionary<string, string> outgoingHeaders = request.OutgoingHeaders;
```

`LogBrewTraceContext` generates W3C-shaped non-zero trace/span IDs, continues valid incoming `traceparent` values, preserves sampled flags, and omits malformed propagation values non-fatally for request helpers. `LogBrewTrace.Activate()` and `LogBrewTelemetry.ActivateContext(...)` use .NET `AsyncLocal`, so normal async work keeps both the active trace and the approved session/subject/tags. Request spans, metrics, issues, logs, actions, dependency integrations, and `ILogger` records receive matching typed trace context; the logger also retains compatible flat trace metadata. `MetadataWithCurrentTrace()` remains available for older app-owned metadata flows. `FromException(...)` adds typed diagnostics without copying the raw exception message or stack text. ASP.NET Core apps can supply approved opaque request identity through `WithContextProvider(...)`. The packaged `examples/HttpTraceCorrelation.cs` file shows copyable request trace, async logger, handler error, span, metric, and outgoing propagation usage.

If your service already creates `System.Diagnostics.Activity` spans through OpenTelemetry or framework instrumentation, create a LogBrew child context from the current Activity instead of reparsing headers:

```csharp
using System.Diagnostics;
using LogBrew;

var activity = Activity.Current;
if (activity != null && LogBrewTraceContext.TryCreateChildFromActivity(activity, out var trace) && trace != null)
{
    var request = LogBrewHttpRequestTelemetry.StartWithTraceContext(
        client,
        "POST",
        "/checkout/:cart_id",
        trace);

    using (request.Activate())
    {
        logger.LogInformation("checkout Activity correlation for {CartId}", "cart_123");
    }

    request.FinishSpanAndMetric("evt_span_activity", "evt_metric_activity", "2026-06-02T10:00:06Z", 202);

    LogBrewActivitySpanTelemetry.Capture(
        client,
        activity,
        LogBrewActivitySpanOptions.Create()
            .WithEventIdPrefix("dotnet_activity_source"));
}
```

`TryCreateChildFromCurrentActivity()`, `TryCreateChildFromActivity(...)`, and `TryCreateChildFromActivityContext(...)` copy only valid W3C Activity trace ID, span ID, and recorded flag into a fresh LogBrew child span. Use `LogBrewActivitySpanTelemetry.Capture(...)` when you also want the app-owned `Activity` itself represented as one LogBrew span, usually after your app or framework has finished that Activity. It copies W3C trace/span IDs, parent span ID, recorded flag, duration, Activity name/kind/source, capped Activity event summaries, capped Activity link summaries, safe `service.name`/`service.version`/`deployment.environment.name`/`telemetry.sdk.name` resource-convention tags, and a small allowlist of safe primitive semantic tags such as HTTP method/route/status, DB system/operation, messaging system/operation, and exception type. These helpers return `false` for null, unstarted, non-W3C, or default/all-zero contexts and report capture failures through optional `OnError(...)`. They do not add an OpenTelemetry dependency, own exporters/processors, install Activity listeners, read tracestate or baggage, patch HTTP clients, capture payloads, serialize raw propagation headers, include arbitrary resource attributes, include full URLs/headers/query strings, include exception messages/stacks, or change `Activity.Current`. The packaged `examples/ActivityTraceCorrelation.cs` file shows installed-package Activity-to-LogBrew log/action/span/metric correlation.

If your app already emits `ActivitySource` spans and you want one opt-in bridge without owning OpenTelemetry exporters, start a source-filtered listener during app setup:

```csharp
using System.Collections.Generic;
using System.Diagnostics;
using LogBrew;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "1.0.0");
using var listener = LogBrewActivitySourceListener.Start(
    client,
    options => options
        .WithHttpClientSources()
        .WithEventIdPrefix("dotnet_activity_source")
        .WithServiceName("checkout-dotnet-service")
        .WithServiceVersion("1.0.0")
        .WithDeploymentEnvironment("production")
        .WithMetadataProvider(activity => new Dictionary<string, object?>
        {
            ["component"] = activity.Source.Name
        }));

using var source = new ActivitySource("System.Net.Http", "10.0.0");
using (var activity = source.StartActivity("checkout.pay", ActivityKind.Client))
{
    activity?.SetTag("http.request.method", "POST");
    activity?.SetTag("http.route", "/checkout/:cart_id");
    activity?.SetTag("http.response.status_code", 202);
}
```

`LogBrewActivitySourceListener` captures only stopped Activities from explicit `WithSourceName(...)` entries or source-backed presets such as `WithHttpClientSources()`, `WithAspNetCoreSources()`, `WithEntityFrameworkCoreSources()`, `WithSqlClientSources()`, `WithStackExchangeRedisSources()`, and `WithCommonDotNetSources()`. Use `WithServiceName(...)`, `WithServiceVersion(...)`, and `WithDeploymentEnvironment(...)` to attach the same low-cardinality service context competitors expose through OpenTelemetry resources or unified service tagging, without enabling arbitrary resource attributes. It delegates payload construction to `LogBrewActivitySpanTelemetry` and reports SDK capture errors through optional `OnError(...)`. Calling `Start(client)` without source names is fail-closed and captures no Activities. It does not create OpenTelemetry processors, exporters, tracestate, baggage, global HTTP instrumentation, payload/header capture, full URL/query capture, or environment-variable scraping.

The packaged `examples/ActivitySourceListenerTelemetry.cs` file shows the same listener in a small console app, including safe route naming, explicit source filtering, low-cardinality service context, and primitive-only metadata.

If your app already owns an OpenTelemetry `TracerProvider`, install the optional `LogBrew.OpenTelemetry` package and add LogBrew as one processor in that app-owned pipeline:

```csharp
using LogBrew;
using LogBrew.OpenTelemetry;
using OpenTelemetry;
using OpenTelemetry.Trace;
using System.Diagnostics;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "1.0.0");
using var source = new ActivitySource("Checkout.Api", "1.0.0");
using var provider = Sdk.CreateTracerProviderBuilder()
    .AddSource("Checkout.Api")
    .AddLogBrew(client, options => options
        .WithEventIdPrefix("checkout_otel")
        .WithServiceName("checkout-dotnet-service")
        .WithServiceVersion("1.0.0")
        .WithDeploymentEnvironment("production"))
    .Build();

using (var activity = source.StartActivity("GET /checkout/{id}", ActivityKind.Server))
{
    activity?.SetTag("http.request.method", "GET");
    activity?.SetTag("http.route", "/checkout/{id}");
    activity?.SetTag("http.response.status_code", 200);
}
```

`LogBrew.OpenTelemetry` adds `LogBrewOpenTelemetrySpanProcessor`, `TracerProviderBuilder.AddLogBrew(...)`, and `LogBrewOpenTelemetrySpanExporter` for ended, recorded W3C Activities. Use the processor helper when you want one LogBrew registration call, or pass the exporter into standard OpenTelemetry processors such as `SimpleActivityExportProcessor` or `BatchActivityExportProcessor` when your app already centralizes exporter setup. Both paths reuse the same safe Activity span conversion as the core SDK, including capped event/link summaries, type-only OpenTelemetry exception event counts, escaped-exception error inference, low-cardinality service context, and the safe resource-convention tag allowlist. The package does not create an OpenTelemetry provider, sampler, resource detector, instrumentation package, baggage/tracestate reader, global Activity listener, HTTP/database patch, arbitrary resource copier, payload/header/full-URL/query capture, exception message/stack capture, support ticket, OTLP forwarding path, or background upload path. The packaged `examples/OpenTelemetrySpanProcessorTelemetry.cs` file proves installed-package OpenTelemetry processor/exporter span correlation, exception summary metadata, and redaction.

For outbound calls, use `LogBrewHttpClientTelemetry` when your app owns the `HttpClient` request and wants one child span plus one normalized downstream `traceparent`:

```csharp
using System.Collections.Generic;
using System.Net.Http;
using LogBrew;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "1.0.0");
var parent = LogBrewTraceContext.FromTraceparent(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "b7ad6b7169203331");

using var httpClient = new HttpClient();
using var request = new HttpRequestMessage(HttpMethod.Post, "https://payments.example/v1/payments/cart_123?card=sample");
using (LogBrewTrace.Activate(parent))
using (var response = await LogBrewHttpClientTelemetry.SendAsync(
    client,
    httpClient,
    request,
    LogBrewHttpClientOptions.Create()
        .WithRouteTemplate("/v1/payments/:id")
        .WithMetadata(new Dictionary<string, object?> { ["provider"] = "payments" })))
{
    response.EnsureSuccessStatusCode();
}
```

`LogBrewHttpClientTelemetry.SendAsync(...)` preserves the app-owned `HttpClient`, `HttpRequestMessage`, response, cancellation token, and original exception. It keeps `LogBrewTrace.Current` active while the request runs, overwrites any existing `traceparent` with one normalized child span header, captures one `http.client` span, records status code or exception type only, and reports SDK capture failures through optional `OnError(...)` without replacing the HTTP result. It does not patch `HttpClient` globally, install a handler, capture request/response bodies, serialize arbitrary headers, include full URLs, hostnames, query strings, baggage, tracestate, or open support tickets. The packaged `examples/HttpClientOutboundTelemetry.cs` file proves installed-package outbound `HttpClient` span and logger correlation.

If your app already builds clients through a message-handler pipeline or `IHttpClientFactory`, use `LogBrewHttpClientHandler` instead of wrapping each send. The handler uses the same options and privacy rules as `SendAsync(...)`, but fits normal .NET `DelegatingHandler` composition:

```csharp
var handler = new LogBrewHttpClientHandler(
    client,
    LogBrewHttpClientOptions.Create()
        .WithRequestFilter(request => request.Method == HttpMethod.Post)
        .WithRouteTemplateSelector(request =>
            request.RequestUri != null && request.RequestUri.AbsolutePath.StartsWith("/v1/payments/", StringComparison.Ordinal)
                ? "/v1/payments/:id"
                : "/outbound"))
{
    InnerHandler = new HttpClientHandler()
};

using var httpClient = new HttpClient(handler);
```

For explicitly selected named or typed factory clients, install `LogBrew.HttpClient` and add correlation on that client's builder:

```csharp
using LogBrew.HttpClient;

services
    .AddHttpClient("catalog")
    .AddLogBrewCorrelation(client);
```

`AddLogBrewCorrelation(...)` is idempotent per builder name, the first registration wins, and it does not install a factory-wide filter or diagnostics listener. It creates a W3C child only when `LogBrewTrace.Current` is active, returns the caller's request header and trace state before completion, and keeps responses, streaming content, exceptions, cancellation, and middleware order app-owned. Place it after retry middleware when each execution should have its own child. Fixed span metadata is limited to method, normalized non-IP host, status, duration, source, sampled state, real cancellation, and exception type; it excludes paths, query strings, fragments, ports, client names, arbitrary headers or metadata, bodies, authentication material, baggage, tracestate, and exception text. SDK delivery requests bypass the handler to prevent self-correlation.

For the legacy manual `LogBrewHttpClientTelemetry` and `LogBrewHttpClientHandler` APIs above, use `WithRequestFilter(...)` to skip noisy internal calls without modifying the request or injecting propagation headers. Use `WithRouteTemplateSelector(...)` when one typed client sends multiple route families and you want stable low-cardinality span names. These options do not apply to `AddLogBrewCorrelation(...)`. Selector output is validated like `WithRouteTemplate(...)`; keep it query-free and route-shaped.

For ASP.NET Core, keep the middleware app-owned and use `LogBrewServerRequestTelemetry` to wrap the request pipeline. This captures one request span, an optional `http.server.duration` metric, and an optional exception issue while preserving the original response or exception:

```csharp
using System.Collections.Generic;
using LogBrew;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-aspnetcore", "1.0.0");
var app = WebApplication.CreateBuilder(args).Build();

app.UseRouting();
app.Use(async (context, next) =>
{
    var endpoint = context.GetEndpoint() as RouteEndpoint;
    var routeTemplate = endpoint?.RoutePattern.RawText is { Length: > 0 } rawRoute
        ? "/" + rawRoute.TrimStart('/')
        : context.Request.Path.Value ?? "/";

    await LogBrewServerRequestTelemetry.CaptureAsync(
        client,
        context.Request.Method,
        routeTemplate,
        context.Request.Headers.TryGetValue("traceparent", out var traceparent) ? traceparent.ToString() : null,
        async request =>
        {
            await next(context);
            return context.Response.StatusCode;
        },
        LogBrewServerRequestOptions.Create()
            .WithEventIdPrefix("aspnetcore_request")
            .WithMetadata(new Dictionary<string, object?>
            {
                ["framework"] = "aspnetcore",
                ["component"] = "checkout-api"
            }));
});
```

The helper does not patch ASP.NET Core globally, read request or response bodies, capture arbitrary headers, serialize `traceparent`, include query strings, open support tickets, infer usage/quota, or flush automatically. The app still owns middleware order, response handling, and shutdown/flush. The packaged `examples/AspNetCoreRequestTelemetry.cs` file shows a local Kestrel app with route-template extraction and copyable middleware wiring.

If you want package-owned ASP.NET Core middleware instead of copying the wrapper into your app, install the optional integration package:

```bash
dotnet add package LogBrew.AspNetCore
```

For normal hosted applications, set `LOGBREW_SERVER_API_KEY` and use the host-owned lifecycle:

```csharp
using LogBrew;

var builder = WebApplication.CreateBuilder(args);
builder.AddLogBrew();

var app = builder.Build();
app.UseRouting();
app.UseLogBrew();
```

`builder.AddLogBrew()` creates one automatic-delivery client, adds privacy-bounded application logging, and registers one start/stop lifecycle. `app.UseLogBrew()` captures route-template request spans, duration metrics, and unhandled request issues with mechanism `aspnetcore.middleware`, handled `false`, and bounded structured frames. It rethrows the original exception and omits its raw message, raw stack text, locals, source snippets, and absolute paths. Missing `LOGBREW_SERVER_API_KEY` disables the integration safely; `LOGBREW_ENABLED=false` is the explicit override. Host shutdown drains and closes delivery, while `LogBrewAspNetCoreRuntime.Health()` reports privacy-safe state without keys, endpoints, event contents, or exception messages. The package README includes CLI-first project creation, owner-only key handling, hosted `doctor`/`traces` readback, and project archival without requiring a dashboard.

Existing app-owned client integrations remain compatible. `LogBrew.AspNetCore` still provides `app.UseLogBrewRequestTelemetry(client, options => ...)`, uses the same privacy-bounded request span/metric/issue path as the explicit helper, keeps `LogBrewTrace.Current` active for downstream `ILogger` calls, and avoids body/header/query/raw propagation capture. It also provides `builder.Services.AddLogBrewDependencyActivitySourceTelemetry(client, options => ...)`, which registers a host-lifetime-managed `LogBrewActivitySourceListener` for common dependency `ActivitySource` names such as `System.Net.Http`, Entity Framework Core, SqlClient, and StackExchange.Redis. The app-builder fallback `app.UseLogBrewDependencyActivitySourceTelemetry(client, options => ...)` is available when service registration is not convenient. These dependency bridges are off until called, dispose when the ASP.NET Core host stops, and do not add OpenTelemetry exporters/processors, subscribe to arbitrary `DiagnosticSource` events, or patch HTTP/database clients. The packaged `examples/AspNetCoreMiddlewareTelemetry.cs` file in that integration package shows automatic lifecycle, request/log correlation, local preview, and dependency ActivitySource telemetry.

## Dependency Spans

Use `LogBrewOperationTracing` around app-owned database, cache, or queue calls when you want dependency timing without a profiler, Entity Framework interceptor, Redis/Kafka client dependency, or global patching:

```csharp
using System.Collections.Generic;
using LogBrew;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "1.0.0");
var orderId = LogBrewOperationTracing.DatabaseOperation(
    client,
    "orders.select",
    () => "order_123",
    LogBrewOperationTracing.DatabaseOperationOptions.Create()
        .WithSystem("sqlserver")
        .WithOperationKind("select")
        .WithDatabaseName("checkout")
        .WithStatementTemplate("SELECT * FROM orders WHERE id = ?")
        .WithRowCount(1)
        .WithMetadata(new Dictionary<string, object?> { ["routeTemplate"] = "/orders/:id" }));
```

For app-owned queues, keep the broker SDK in your code and let LogBrew write or read only W3C `traceparent` values:

```csharp
var messageHeaders = new Dictionary<string, string>();

LogBrewOperationTracing.QueueOperation(
    client,
    "invoice.publish",
    () =>
    {
        // Set messageHeaders["traceparent"] on your Kafka/RabbitMQ/SQS message here.
        return true;
    },
    LogBrewOperationTracing.QueueOperationOptions.Create()
        .WithSystem("kafka")
        .WithOperationKind("publish")
        .WithQueueName("invoices")
        .WithTraceparentHeaderSetter((name, value) => messageHeaders[name] = value));

LogBrewOperationTracing.QueueOperation(
    client,
    "invoice.process",
    () => true,
    LogBrewOperationTracing.QueueOperationOptions.Create()
        .WithSystem("rabbitmq")
        .WithOperationKind("process")
        .WithQueueName("invoice-work")
        .WithIncomingTraceparent(messageHeaders.TryGetValue("traceparent", out var traceparent) ? traceparent : null)
        .WithLinkedMessageTraceparent("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"));
```

`WithTraceparentHeaderSetter(...)` is called once after LogBrew creates the queue span and before your callback runs, so the outgoing message can carry the same child span context that LogBrew records. `WithIncomingTraceparent(...)` continues one valid incoming message context; malformed values are reported through `OnError(...)` and fall back to the active trace or a new root without interrupting the queue operation. `WithLinkedMessageTraceparent(...)` adds bounded span links for consumed or batched messages without storing raw propagation headers.

For app-owned ADO.NET commands, use `LogBrewDbCommandTelemetry` around the provider command execution instead of writing a callback wrapper for every query:

```csharp
using System.Data.Common;
using LogBrew;

DbCommand command = CreateCommandFromYourProvider();
var rows = LogBrewDbCommandTelemetry.ExecuteNonQuery(
    client,
    command,
    LogBrewDbCommandOptions.Create()
        .WithSystem("sqlserver")
        .WithOperationName("orders.update")
        .WithDatabaseName("checkout")
        .WithMetadata(new Dictionary<string, object?> { ["routeTemplate"] = "/orders/:id" }));
```

`LogBrewDbCommandTelemetry` supports sync and async `ExecuteNonQuery`, `ExecuteScalar`, and `ExecuteReader` calls. It preserves the app-owned `DbCommand`, result, reader, cancellation token, and original provider exception; keeps `LogBrewTrace.Current` active while the command runs; records row count only from `ExecuteNonQuery`; and reports SDK capture failures through optional `OnError(...)` callbacks without replacing the command result. It does not install a profiler, Entity Framework interceptor, provider-specific package, connection wrapper, SQL parser, database-side trace propagation, query comments, baggage, tracestate, or support-ticket creation. It also does not capture `CommandText`, parameters, connection strings, data source, raw result rows, exception messages, or stacks. The packaged `examples/DbCommandTelemetry.cs` file proves installed-package ADO.NET command spans and redaction with a dependency-free fake command.

For EF Core apps that want command spans without wrapping every `DbCommand`, install the optional integration package:

```bash
dotnet add package LogBrew.EntityFrameworkCore
```

```csharp
using LogBrew;
using LogBrew.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "1.0.0");

optionsBuilder
    .UseSqlServer(connectionString)
    .AddLogBrewCommandTelemetry(
        client,
        options => options
            .WithSystem("sqlserver")
            .WithDatabaseName("checkout")
            .WithOperationNamePrefix("orders")
            .WithCommandFilter(snapshot => snapshot.CommandSource != "migrations")
            .WithMetadataProvider(snapshot => new Dictionary<string, object?>
            {
                ["efCommandSource"] = snapshot.CommandSource,
                ["efExecuteMethod"] = snapshot.ExecuteMethod,
                ["efIsAsync"] = snapshot.IsAsync
            }));
```

`LogBrew.EntityFrameworkCore` adds `LogBrewEntityFrameworkCoreCommandInterceptor` through `AddLogBrewCommandTelemetry(...)`. It records one sanitized `entity_framework_core.command` span per EF Core command, correlates with the active LogBrew trace, captures EF command source, execute method, command type, duration, non-query row count, and type-only provider failures or cancellations, and reports SDK capture failures through optional `OnError(...)`. It does not capture SQL text, query parameters, connection strings, data source, hostnames, raw `traceparent`, payloads, result rows, exception messages, exception stacks, baggage, tracestate, database-side query comments, or support tickets. Use `WithCommandFilter(...)` for noisy commands and `WithMetadataProvider(...)` for primitive low-cardinality context. The packaged `examples/EntityFrameworkCoreCommandTelemetry.cs` file proves package install and example compilation without adding EF dependencies to the base `LogBrew` package.

For StackExchange.Redis apps that want Redis command spans without profiler hooks or key capture, install the optional integration package:

```bash
dotnet add package LogBrew.StackExchangeRedis
```

```csharp
using LogBrew;
using LogBrew.StackExchangeRedis;
using StackExchange.Redis;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "1.0.0");
IDatabase redis = multiplexer.GetDatabase();

var value = redis.TraceLogBrewCommand(
    client,
    "GET",
    db => db.StringGet("cart:123"),
    LogBrewStackExchangeRedisCommandOptions.Create()
        .WithCacheName("checkout-cache")
        .WithMetadata(new Dictionary<string, object?> { ["routeTemplate"] = "/cart/:id" }));
```

`LogBrew.StackExchangeRedis` adds `TraceLogBrewCommand(...)` and `TraceLogBrewCommandAsync(...)` around app-owned Redis calls. The helper creates one sanitized `stackexchange_redis.command:<COMMAND>` child span, keeps `LogBrewTrace.Current` active while the Redis call runs, preserves the original result or exception, infers coarse hit/count/size metadata where safe, and reports SDK capture failures through optional `OnError(...)`. It does not capture Redis keys, values, command arguments, raw command text, connection strings, endpoints, server names, arbitrary headers, payloads, exception messages, stacks, baggage, tracestate, profiler sessions, global patches, or support tickets. The packaged `examples/StackExchangeRedisCommandTelemetry.cs` file proves installed-package Redis command spans and redaction without requiring a live Redis server.

Sync and async helpers are available for database, cache, and queue operations. They create one child span under `LogBrewTrace.Current` when a trace is active, keep that child trace active while the callback runs, preserve the callback result or original exception, and report SDK capture failures through optional `OnError(...)` callbacks without interrupting app work. Queue helpers can inject one normalized `traceparent`, continue one valid incoming `traceparent`, and add bounded linked message contexts. Failed dependency operations also attach one bounded span event named `exception` with type-only metadata (`exceptionType` and `exceptionEscaped`) so issues can be filtered without sending exception messages or stack traces.

You can add your own primitive-only span event summaries to any span with `SpanEventSummary`:

```csharp
client.Span(
    "evt_span_checkout_dependency",
    "2026-06-02T10:00:06Z",
    SpanAttributes.Create("database:orders.select", "4bf92f3577b34da6a3ce929d0e0e4736", "b7ad6b7169203333", "ok")
        .WithParentSpanId("00f067aa0ba902b7")
        .WithEvent(SpanEventSummary.Create("retry").WithMetadata(new Dictionary<string, object?>
        {
            ["attempt"] = 2,
            ["retryable"] = true
        })));
```

Span event summaries are capped at eight entries per span and accept only string, number, boolean, or null metadata. Metadata is primitive-only, and the dependency helpers drop unsafe dependency details such as raw statements, connection details, cache identifiers, message contents, broker details, request metadata, and unsafe values. For EF Core command spans, use the optional `LogBrew.EntityFrameworkCore` package. For Redis command spans, use the optional `LogBrew.StackExchangeRedis` package. Other Kafka-style automatic integrations should come from explicit future integration packages rather than hidden behavior in this core package.

Use `SpanLinkSummary` for explicit async/batch links on any span:

```csharp
client.Span(
    "evt_span_invoice_batch",
    "2026-06-02T10:00:06Z",
    SpanAttributes.Create("queue:invoice.process", "4bf92f3577b34da6a3ce929d0e0e4736", "b7ad6b7169203334", "ok")
        .WithLink(SpanLinkSummary.FromTraceparent("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01")
            .WithMetadata(new Dictionary<string, object?> { ["relation"] = "message" })));
```

Span link summaries are capped at eight entries per span, store only trace ID/span ID/sampled plus primitive metadata, and never copy raw `traceparent`, baggage, tracestate, payloads, headers, message bodies, broker URLs, or queue credentials. The packaged `examples/DependencySpansTelemetry.cs` file shows database, cache, and queue spans running from a small console app, with trace correlation, queue propagation, linked message summaries, type-only dependency exception events, and dependency metadata redaction.

## Support Ticket Diagnostics Drafts

Use `SupportTicketDraft` when a developer or support agent needs a local JSON payload for the planned LogBrew support-ticket API. The helper validates the public source/category contract, uses the planned backend create payload fields, and redacts token-like diagnostics before returning the draft.

```csharp
using System;
using System.Collections.Generic;
using LogBrew;

var draft = SupportTicketDraft.Create(
    SupportTicketDraftInput.Create(
            "sdk",
            "ingest_failure",
            "Telemetry flush failed",
            "Flush returned usage_limit_exceeded")
        .WithProjectId("proj_123")
        .WithEnvironment("production")
        .WithRuntime(".NET 10")
        .WithFramework("ASP.NET Core")
        .WithSdkPackage("LogBrew")
        .WithSdkVersion("0.1.0")
        .WithRelease("checkout@1.2.3")
        .WithTraceId("4BF92F3577B34DA6A3CE929D0E0E4736")
        .WithEventId("evt_checkout_flush")
        .WithDiagnostics(new Dictionary<string, object?>
        {
            ["attemptCount"] = 2,
            ["apiKey"] = "lbw_ingest_placeholder",
            ["endpoint"] = "https://api.example/ingest?debug=true#frag",
            ["error"] = new InvalidOperationException("raw message is omitted")
        }));

Console.WriteLine(draft.ToJson());
```

This helper does not send data, open support tickets, call `POST /api/support/tickets`, use account/session API credentials, or infer backend usage/quota state. Support routes are backend-owned and should only be called by an explicit user or agent action after backend reports deployed support-ticket routes. Diagnostics are bounded to JSON-like values; auth values, cookies, tokens, local paths, URL origins, exception messages, exception stacks, hidden payloads, and unsupported objects are redacted or omitted.

## HTTP Delivery

Use `HttpTransport` when you want the SDK to POST queued batches to LogBrew:

```csharp
using LogBrew;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "my-dotnet-app", "1.0.0");
client.Log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes.Create("worker started", "info"));

using var transport = new HttpTransport(new HttpTransportOptions
{
    Endpoint = HttpTransport.DefaultEndpoint,
    Headers = new Dictionary<string, string> { ["x-logbrew-source"] = "dotnet-worker" },
    Timeout = TimeSpan.FromSeconds(10)
});

TransportResponse response = client.Shutdown(transport);
Console.Error.WriteLine(response.StatusCode);
```

`HttpTransport` sends JSON with the SDK key in the `authorization` header, supports a custom endpoint, headers, timeout, and app-owned `HttpClient`, maps HTTP statuses through the client's retry rules, and converts request/time-out failures into retryable transport errors.

## Queue Pressure and Shutdown

The client keeps an in-memory queue capped at 1,000 events by default. When the queue is full, new events are dropped before they enter the queue, already-buffered release/environment/trace context is preserved, and `DroppedEvents()` reports the local drop count. This is a local backpressure signal only; do not use it to infer hosted usage, quota, or account history.

```csharp
using LogBrew;

var dropped = 0;
var client = LogBrewClient.Create(
    "LOGBREW_API_KEY",
    "checkout-dotnet-service",
    "1.0.0",
    maxQueueSize: 500,
    onEventDropped: drop =>
    {
        if (drop.Reason == "queue_overflow")
        {
            dropped = drop.DroppedEvents;
        }
    });

client.Log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes.Create("worker started", "info"));
Console.Error.WriteLine(client.DroppedEvents());
```

Drop callbacks are advisory and callback failures do not interrupt application logging. `Flush(transport)` keeps queued events after auth failures, retry-budget exhaustion, or non-2xx delivery and clears them only after a 2xx response. `Shutdown(transport)` flushes with the same rules, marks the client closed, and rejects later writes with `shutdown_error`.

## Microsoft.Extensions.Logging

Add LogBrew as a normal .NET logging provider when your app already uses `ILogger`:

```csharp
using LogBrew;
using Microsoft.Extensions.Logging;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "my-dotnet-app", "1.0.0");
var transport = RecordingTransport.AlwaysAccept();

using ILoggerFactory factory = LoggerFactory.Create(builder =>
{
    builder.SetMinimumLevel(LogLevel.Information);
    builder.AddLogBrew(client, new LogBrewLoggerOptions
    {
        Metadata = new Dictionary<string, object?> { ["service"] = "checkout" },
        Transport = transport
    });
});

ILogger logger = factory.CreateLogger("CheckoutWorker");
using (logger.BeginScope(new Dictionary<string, object?> { ["requestId"] = "req_123" }))
{
    logger.LogWarning("Checkout slow for {Region}", "global");
}

client.Flush(transport);
```

`AddLogBrew()` is opt-in and does not replace app-owned logging providers. It captures the logger category, .NET log level, event id/name, structured message values, primitive scope values, and exception type/message. Full exception stack text is omitted unless `IncludeExceptionStackTrace` is enabled. By default provider logs are queued on the client; set both `Transport` and `FlushOnLog = true` only when immediate delivery is the desired behavior.

LogBrew serializes severities as `info`, `warning`, `error`, or `critical`. `Trace` and `Debug` records are captured as `info`, `Warning` as `warning`, `Error` as `error`, and `Critical` as `critical`; the original .NET log level remains in metadata.

## Examples

From `dotnet/logbrew-dotnet`:

The `examples` directory contains copyable snippets for creating a client, previewing queued JSON, sending through `HttpTransport`, and attaching the `ILogger` provider in your own .NET service.

## Behavior

- `PreviewJson()` returns the queued batch as pretty JSON.
- `IssueAttributes.FromException(...)` creates typed mechanism/handled state and bounded basename-only frames without automatically copying exception messages or raw stack text.
- The in-memory queue is capped at 1,000 events by default; tune it with `maxQueueSize`, observe local `queue_overflow` loss with `DroppedEvents()` or `onEventDropped`, and keep usage/quota/history backend-owned.
- `Flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `HttpTransport` sends queued batches through `System.Net.Http` with configurable endpoint, headers, timeout, and app-owned `HttpClient` support.
- `ProductTimeline` queues app-owned product and network milestone events without visual replay, HTTP client patching, payload capture, or header capture.
- `LogBrewHttpClientTelemetry` and `LogBrewHttpClientHandler` wrap app-owned outbound `HttpClient` sends with one child span and one normalized `traceparent`, without global client patching or payload/header capture.
- `LogBrewOperationTracing` creates app-owned database, cache, and queue spans without adding driver dependencies, profilers, interceptors, or automatic client patching.
- `LogBrewDbCommandTelemetry` creates app-owned ADO.NET `DbCommand` spans for sync/async non-query, scalar, and reader calls without capturing raw SQL, parameters, connection strings, result rows, provider exception messages, or stacks.
- `LogBrew.EntityFrameworkCore` is an optional package for EF Core command spans through app-owned `AddLogBrewCommandTelemetry(...)`, without adding EF Core dependencies to the base `LogBrew` package.
- `LogBrew.StackExchangeRedis` is an optional package for sync/async StackExchange.Redis command spans through app-owned `TraceLogBrewCommand(...)` calls, without capturing Redis keys, values, arguments, connection endpoints, exception messages, or stacks.
- `LogBrew.OpenTelemetry` is an optional package for app-owned OpenTelemetry `TracerProviderBuilder.AddLogBrew(...)` span processing, without adding OpenTelemetry dependencies to the base `LogBrew` package.
- `SupportTicketDraft` builds local-only support-ticket create payload drafts and redacts diagnostics without calling backend support routes.
- `Shutdown(transport)` flushes queued events and rejects later writes.
- `AddLogBrew(client, options)` connects existing `ILogger` calls to LogBrew without global logging side effects.
- `RecordingTransport.AlwaysAccept()` is useful when you want to inspect queued JSON before network delivery.
- `SdkException` exposes stable `Code` and `DetailMessage` values for user-facing failure handling.
