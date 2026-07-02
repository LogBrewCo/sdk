# LogBrew ASP.NET Core SDK

Optional ASP.NET Core integration for the public LogBrew .NET SDK.

## Install

```bash
dotnet add package LogBrew.AspNetCore
```

`LogBrew.AspNetCore` depends on `LogBrew` and adds opt-in ASP.NET Core extensions:

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
app.UseLogBrewDependencyActivitySourceTelemetry(
    client,
    options => options.WithEventIdPrefix("aspnetcore_dependency"));
```

The middleware captures one request span, one optional `http.server.duration` metric, and one optional exception issue. It keeps `LogBrewTrace.Current` active while downstream handlers run, so LogBrew `ILogger` records and app-owned telemetry can join the same trace.

`UseLogBrewDependencyActivitySourceTelemetry(...)` starts a host-lifetime-managed `LogBrewActivitySourceListener` for common dependency sources: `System.Net.Http`, Entity Framework Core, SqlClient, and StackExchange.Redis. It is off until called, disposes when the ASP.NET Core host stops, and does not add OpenTelemetry exporters/processors or patch ASP.NET Core/HTTP/database clients.

The request middleware does not read request or response bodies, capture arbitrary headers, serialize raw `traceparent`, include query strings, open support tickets, infer usage/quota, or flush automatically. The dependency ActivitySource bridge follows the same public-safety boundary for dependency spans. Use `WithRequestFilter(...)`, `WithRouteTemplateSelector(...)`, and dependency ActivitySource filters to keep telemetry low-cardinality and app-owned.

The packaged `examples/AspNetCoreMiddlewareTelemetry.cs` file shows a complete local Kestrel app with LogBrew `ILogger` correlation, request route-template spans, host-lifetime-managed dependency ActivitySource spans, and local preview output.
