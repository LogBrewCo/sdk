# LogBrew .NET SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public .NET SDK for building, validating, previewing, and flushing LogBrew event batches, with `System.Net.Http` delivery, W3C trace correlation, and opt-in `Microsoft.Extensions.Logging` provider support.

The library targets `netstandard2.0`, uses `System.Net.Http` for built-in HTTP delivery, and depends on `Microsoft.Extensions.Logging` for the standard .NET logging provider surface.

## Install

```bash
dotnet add package LogBrew
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

## Explicit Metrics

Use `MetricAttributes` when your application already knows the measurement it wants to report:

```csharp
using System.Collections.Generic;
using LogBrew;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "my-dotnet-app", "1.0.0");
client.Metric(
    "evt_metric_001",
    "2026-06-02T10:00:06Z",
    MetricAttributes.Create("queue.depth", "gauge", 42, "{items}", "instant")
        .WithMetadata(new Dictionary<string, object?> { ["queue"] = "default" }));
```

Metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms use `delta` or `cumulative` temporality and must be non-negative; gauges use `instant` temporality and may go up or down. Prefer stable, low-cardinality primitive metadata such as service, region, queue, or route pattern. This SDK does not automatically collect CLR, runtime, or framework metrics yet.

## Product and Network Timelines

Use `ProductTimeline` when your .NET service already knows important product steps or API milestones. The helpers create normal `action` events with primitive metadata that AI assistants can analyze across sessions without visual replay, HTTP client patching, request/response payload capture, or header capture.

```csharp
using System.Collections.Generic;
using LogBrew;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "my-dotnet-app", "1.0.0");

client.Action(
    "evt_action_checkout_submit",
    "2026-06-02T10:00:05Z",
    ProductTimeline.ProductAction("checkout.submit")
        .WithRouteTemplate("/checkout/:step")
        .WithSessionId("session_123")
        .WithTraceId("trace_abc")
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
        .WithSessionId("session_123")
        .WithTraceId("trace_abc")
        .ToActionAttributes());
```

`ProductTimeline` strips query strings and fragments from route templates, keeps metadata primitive-only, and leaves all product action and network milestone capture under app control.

## First Useful Service Telemetry

For first useful .NET service telemetry, combine release, environment, logs, product actions, network milestones, metrics, and a W3C-linked span in one small app-owned flow:

```csharp
using System.Collections.Generic;
using LogBrew;

const string incomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const string childSpanId = "b7ad6b7169203331";
var context = Traceparent.Parse(incomingTraceparent);
var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "1.0.0");

client.Log(
    "evt_log_checkout_started",
    "2026-06-02T10:00:02Z",
    LogAttributes.Create("checkout request started", "info")
        .WithLogger("checkout.http")
        .WithMetadata(new Dictionary<string, object?>
        {
            ["routeTemplate"] = "/checkout/:cart_id",
            ["sessionId"] = "sess_checkout_123",
            ["traceId"] = context.TraceId
        }));

client.Action(
    "evt_action_payment_api",
    "2026-06-02T10:00:04Z",
    ProductTimeline.NetworkMilestone("https://payments.example/payments/:payment_id?card=sample")
        .WithMethod("POST")
        .WithStatusCode(202)
        .WithDurationMs(183.4)
        .WithSessionId("sess_checkout_123")
        .WithTraceId(context.TraceId)
        .ToActionAttributes());

client.Metric(
    "evt_metric_http_server_duration",
    "2026-06-02T10:00:05Z",
    MetricAttributes.Create("http.server.duration", "histogram", 183.4, "ms", "delta")
        .WithMetadata(new Dictionary<string, object?>
        {
            ["method"] = "POST",
            ["routeTemplate"] = "/checkout/:cart_id",
            ["statusCode"] = 202,
            ["traceId"] = context.TraceId
        }));

client.Span(
    "evt_span_checkout_request",
    "2026-06-02T10:00:06Z",
    Traceparent.SpanAttributesFromTraceparent(
        incomingTraceparent,
        TraceparentSpanInput.Create("POST /checkout/:cart_id", childSpanId, "ok")
            .WithDurationMs(183.4)
            .WithMetadata(new Dictionary<string, object?>
            {
                ["routeTemplate"] = "/checkout/:cart_id",
                ["sampled"] = context.Sampled,
                ["sessionId"] = "sess_checkout_123"
            })));

var outgoingHeaders = Traceparent.CreateHeaders(context.TraceId, childSpanId, context.TraceFlags);
```

`Traceparent` validates W3C shape, rejects forbidden or all-zero IDs, normalizes IDs, exposes the sampled flag, creates outbound `traceparent` headers, and builds child span attributes with primitive metadata only. The packaged `examples/FirstUsefulTelemetry.cs` file shows the complete release, environment, log, product action, network milestone, metric, and span flow.

## Request Trace Correlation

Use `LogBrewHttpRequestTelemetry` when your service owns request handling and wants one W3C request span to connect request logs, handler errors, metrics, and outgoing propagation. The helper keeps capture explicit: it does not patch global HTTP clients, read payloads, or collect request headers.

```csharp
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

using ILoggerFactory factory = LoggerFactory.Create(builder =>
{
    builder.AddLogBrew(client, new LogBrewLoggerOptions { EventIdPrefix = "checkout_trace" });
});

using (request.Activate())
{
    LogBrewTraceContext? activeTrace = LogBrewTrace.Current;
    ILogger logger = factory.CreateLogger("CheckoutTrace");
    logger.LogWarning("checkout slow for {CartId}", "cart_123");

    client.Issue(
        "evt_issue_checkout_trace",
        "2026-06-02T10:00:04Z",
        IssueAttributes.Create("Checkout handler failed", "error")
            .WithMessage("payment provider failed")
            .WithMetadata(LogBrewTrace.MetadataWithCurrentTrace(new Dictionary<string, object?>
            {
                ["routeTemplate"] = request.RouteTemplate,
                ["exceptionType"] = "System.InvalidOperationException",
                ["exceptionMessage"] = "payment provider failed"
            })));
}

request.FinishSpanAndMetric(
    "evt_span_checkout_trace",
    "evt_metric_checkout_trace",
    "2026-06-02T10:00:06Z",
    503);

IReadOnlyDictionary<string, string> outgoingHeaders = request.OutgoingHeaders;
```

`LogBrewTraceContext` generates W3C-shaped non-zero trace/span IDs, continues valid incoming `traceparent` values, preserves sampled flags, and omits malformed propagation values non-fatally for request helpers. `LogBrewTrace.Activate()` uses .NET `AsyncLocal` so standard async work keeps the active trace context. The `ILogger` provider automatically adds `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled` metadata when a trace is active. `MetadataWithCurrentTrace()` is useful for app-owned errors or product events that should join the same request. The packaged `examples/HttpTraceCorrelation.cs` file shows copyable request trace, async logger, handler error, span, metric, and outgoing propagation usage.

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

`TryCreateChildFromCurrentActivity()`, `TryCreateChildFromActivity(...)`, and `TryCreateChildFromActivityContext(...)` copy only valid W3C Activity trace ID, span ID, and recorded flag into a fresh LogBrew child span. Use `LogBrewActivitySpanTelemetry.Capture(...)` when you also want the app-owned `Activity` itself represented as one LogBrew span, usually after your app or framework has finished that Activity. It copies W3C trace/span IDs, parent span ID, recorded flag, duration, Activity name/kind/source, capped Activity event summaries, capped Activity link summaries, and a small allowlist of safe primitive semantic tags such as HTTP method/route/status, DB system/operation, messaging system/operation, and exception type. These helpers return `false` for null, unstarted, non-W3C, or default/all-zero contexts and report capture failures through optional `OnError(...)`. They do not add an OpenTelemetry dependency, own exporters/processors, install Activity listeners, read tracestate or baggage, patch HTTP clients, capture payloads, serialize raw propagation headers, include full URLs/headers/query strings, include exception messages/stacks, or change `Activity.Current`. The packaged `examples/ActivityTraceCorrelation.cs` file shows installed-package Activity-to-LogBrew log/action/span/metric correlation.

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

`LogBrewActivitySourceListener` captures only stopped Activities from explicit `WithSourceName(...)` entries or source-backed presets such as `WithHttpClientSources()`, `WithAspNetCoreSources()`, `WithEntityFrameworkCoreSources()`, `WithSqlClientSources()`, `WithStackExchangeRedisSources()`, and `WithCommonDotNetSources()`. It delegates payload construction to `LogBrewActivitySpanTelemetry` and reports SDK capture errors through optional `OnError(...)`. Calling `Start(client)` without source names is fail-closed and captures no Activities. It does not create OpenTelemetry processors, exporters, tracestate, baggage, global HTTP instrumentation, payload/header capture, or full URL/query capture.

The packaged `examples/ActivitySourceListenerTelemetry.cs` file shows the same listener in a small console app, including safe route naming, explicit source filtering, and primitive-only metadata.

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

Use `WithRequestFilter(...)` to skip noisy internal calls without modifying the request or injecting propagation headers. Use `WithRouteTemplateSelector(...)` when one typed client sends multiple route families and you want stable low-cardinality span names. Selector output is validated like `WithRouteTemplate(...)`; keep it query-free and route-shaped.

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

`LogBrew.AspNetCore` adds `app.UseLogBrewRequestTelemetry(client, options => ...)`, uses the same privacy-bounded request span/metric/issue path as the explicit helper, keeps `LogBrewTrace.Current` active for downstream `ILogger` calls, and still avoids body/header/query/raw propagation capture. It also adds `app.UseLogBrewDependencyActivitySourceTelemetry(client, options => ...)`, which starts a host-lifetime-managed `LogBrewActivitySourceListener` for common dependency `ActivitySource` names such as `System.Net.Http`, Entity Framework Core, SqlClient, and StackExchange.Redis. That dependency bridge is off until called, disposes when the ASP.NET Core host stops, and does not add OpenTelemetry exporters/processors, subscribe to arbitrary `DiagnosticSource` events, or patch HTTP/database clients. The packaged `examples/AspNetCoreMiddlewareTelemetry.cs` file in that integration package shows the complete middleware plus dependency ActivitySource version.

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
- The in-memory queue is capped at 1,000 events by default; tune it with `maxQueueSize`, observe local `queue_overflow` loss with `DroppedEvents()` or `onEventDropped`, and keep usage/quota/history backend-owned.
- `Flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `HttpTransport` sends queued batches through `System.Net.Http` with configurable endpoint, headers, timeout, and app-owned `HttpClient` support.
- `ProductTimeline` queues app-owned product and network milestone events without visual replay, HTTP client patching, payload capture, or header capture.
- `LogBrewHttpClientTelemetry` and `LogBrewHttpClientHandler` wrap app-owned outbound `HttpClient` sends with one child span and one normalized `traceparent`, without global client patching or payload/header capture.
- `LogBrewOperationTracing` creates app-owned database, cache, and queue spans without adding driver dependencies, profilers, interceptors, or automatic client patching.
- `LogBrewDbCommandTelemetry` creates app-owned ADO.NET `DbCommand` spans for sync/async non-query, scalar, and reader calls without capturing raw SQL, parameters, connection strings, result rows, provider exception messages, or stacks.
- `LogBrew.EntityFrameworkCore` is an optional package for EF Core command spans through app-owned `AddLogBrewCommandTelemetry(...)`, without adding EF Core dependencies to the base `LogBrew` package.
- `LogBrew.StackExchangeRedis` is an optional package for sync/async StackExchange.Redis command spans through app-owned `TraceLogBrewCommand(...)` calls, without capturing Redis keys, values, arguments, connection endpoints, exception messages, or stacks.
- `SupportTicketDraft` builds local-only support-ticket create payload drafts and redacts diagnostics without calling backend support routes.
- `Shutdown(transport)` flushes queued events and rejects later writes.
- `AddLogBrew(client, options)` connects existing `ILogger` calls to LogBrew without global logging side effects.
- `RecordingTransport.AlwaysAccept()` is useful when you want to inspect queued JSON before network delivery.
- `SdkException` exposes stable `Code` and `DetailMessage` values for user-facing failure handling.
