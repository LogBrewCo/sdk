# LogBrew.OpenTelemetry

`LogBrew.OpenTelemetry` is an optional .NET integration for apps that already own an OpenTelemetry `TracerProvider`.

```bash
dotnet add package LogBrew
dotnet add package LogBrew.OpenTelemetry
```

```csharp
using LogBrew;
using LogBrew.OpenTelemetry;
using OpenTelemetry;
using OpenTelemetry.Trace;
using System.Diagnostics;

var client = LogBrewClient.Create(
    Environment.GetEnvironmentVariable("LOGBREW_API_KEY") ?? "LOGBREW_API_KEY",
    "checkout-api",
    "1.0.0");

using var source = new ActivitySource("Checkout.Api", "1.0.0");
using var provider = Sdk.CreateTracerProviderBuilder()
    .AddSource("Checkout.Api")
    .AddLogBrew(client, options => options
        .WithServiceName("checkout-api")
        .WithServiceVersion("1.0.0")
        .WithDeploymentEnvironment("production"))
    .Build();

using (var activity = source.StartActivity("GET /checkout/{id}", ActivityKind.Server))
{
    activity?.SetTag("http.request.method", "GET");
    activity?.SetTag("http.route", "/checkout/{id}");
    activity?.SetTag("http.response.status_code", 200);
}

Console.WriteLine(client.PreviewJson());
```

The integration adds `LogBrewOpenTelemetrySpanProcessor` and `TracerProviderBuilder.AddLogBrew(...)`. It captures ended, recorded W3C Activities through the same privacy-bounded `LogBrewActivitySpanTelemetry` path as the core SDK: trace/span IDs, parent span ID, sampled flag, duration, Activity name/kind/source, capped Activity event summaries, capped Activity link summaries, explicit service context, and a small allowlist of primitive semantic tags such as HTTP method/route/status, DB system/operation, messaging system/operation, and exception type.

It does not create an OpenTelemetry provider, exporter, sampler, resource detector, instrumentation package, baggage/tracestate reader, global Activity listener, HTTP/database patch, payload/header/full-URL/query capture, exception message/stack capture, support ticket, or background upload path. Apps keep ownership of their OpenTelemetry pipeline and LogBrew only receives sanitized ended spans after the app opts in.

The packaged `examples/OpenTelemetrySpanProcessorTelemetry.cs` file shows a copyable OpenTelemetry Activity-to-LogBrew span correlation setup with service context.
