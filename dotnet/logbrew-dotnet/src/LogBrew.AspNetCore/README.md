# LogBrew ASP.NET Core SDK

Optional ASP.NET Core integration for the public LogBrew .NET SDK.

## Install

```bash
dotnet add package LogBrew.AspNetCore
```

`LogBrew.AspNetCore` depends on `LogBrew` and adds one opt-in middleware extension:

```csharp
using LogBrew;
using Microsoft.AspNetCore.Builder;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-api", "1.0.0");
var app = WebApplication.CreateBuilder(args).Build();

app.UseRouting();
app.UseLogBrewRequestTelemetry(
    client,
    options => options
        .WithEventIdPrefix("aspnetcore_request")
        .WithMetadata(new Dictionary<string, object?>
        {
            ["framework"] = "aspnetcore",
            ["component"] = "checkout-api"
        }));
```

The middleware captures one request span, one optional `http.server.duration` metric, and one optional exception issue. It keeps `LogBrewTrace.Current` active while downstream handlers run, so LogBrew `ILogger` records and app-owned telemetry can join the same trace.

It does not read request or response bodies, capture arbitrary headers, serialize raw `traceparent`, include query strings, open support tickets, infer usage/quota, or flush automatically. Use `WithRequestFilter(...)` and `WithRouteTemplateSelector(...)` to keep telemetry low-cardinality and app-owned.

The packaged `examples/AspNetCoreMiddlewareTelemetry.cs` file shows a complete local Kestrel app with LogBrew `ILogger` correlation, request route-template spans, and local preview output.
