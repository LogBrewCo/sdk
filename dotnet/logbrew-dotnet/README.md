# LogBrew .NET SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public .NET SDK for building, validating, previewing, and flushing LogBrew event batches, with `System.Net.Http` delivery and opt-in `Microsoft.Extensions.Logging` provider support.

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
- `Flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `HttpTransport` sends queued batches through `System.Net.Http` with configurable endpoint, headers, timeout, and app-owned `HttpClient` support.
- `Shutdown(transport)` flushes queued events and rejects later writes.
- `AddLogBrew(client, options)` connects existing `ILogger` calls to LogBrew without global logging side effects.
- `RecordingTransport.AlwaysAccept()` is useful when you want to inspect queued JSON before network delivery.
- `SdkException` exposes stable `Code` and `DetailMessage` values for user-facing failure handling.
