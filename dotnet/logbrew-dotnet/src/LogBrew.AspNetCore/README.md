# LogBrew ASP.NET Core SDK

Host-managed LogBrew delivery, application logging, and privacy-bounded request telemetry for ASP.NET Core.

## Install

```bash
dotnet add package LogBrew.AspNetCore
```

## Quick Start

Set the project-scoped server ingest key outside source control, then add LogBrew to the builder and request pipeline:

```bash
export LOGBREW_SERVER_API_KEY="your project-scoped server ingest key"
export LOGBREW_SERVICE_NAME="checkout-api"
export LOGBREW_RELEASE="1.2.3"
```

```csharp
using LogBrew;

var builder = WebApplication.CreateBuilder(args);
builder.AddLogBrew();

var app = builder.Build();
app.UseRouting();
app.UseLogBrew();

app.MapGet("/orders/{orderId}", () => Results.Ok());
app.Run();
```

`builder.AddLogBrew()` creates one automatic-delivery client, adds the standard `ILogger` provider for warning-and-higher records, and registers one host lifecycle. `app.UseLogBrew()` adds one request middleware and must appear after `UseRouting()` so it can use bounded route templates instead of raw paths. Host start records environment and optional release markers; host stop performs one bounded drain and closes delivery. Repeated registration is idempotent and the first configuration wins.

Without `LOGBREW_SERVER_API_KEY`, the integration stays disabled and both calls are safe no-ops. Set `LOGBREW_ENABLED=false` to disable it explicitly. `LOGBREW_API_KEY` and `LOGBREW_INGEST_KEY` are not aliases: when either legacy name is present without the canonical server key, startup names the exact `LOGBREW_SERVER_API_KEY` correction without printing the key value.

## Configuration

| Environment variable | `appsettings` key | Default | Purpose |
| --- | --- | --- | --- |
| `LOGBREW_ENABLED` | `LogBrew:Enabled` | inferred | Optional explicit `true` or `false` override |
| `LOGBREW_SERVER_API_KEY` | `LogBrew:ServerApiKey` | unset | Project-scoped server ingest key; enables the integration |
| `LOGBREW_SERVICE_NAME` | `LogBrew:ServiceName` | ASP.NET application name | Bounded service metadata |
| `LOGBREW_ENVIRONMENT` | `LogBrew:Environment` | host environment | Bounded deployment environment |
| `LOGBREW_RELEASE` | `LogBrew:Release` | unset | Optional release identifier |
| `LOGBREW_ENDPOINT` | `LogBrew:Endpoint` | `https://api.logbrew.co/v1/events` | HTTPS intake URL without user-info/query/fragment data; loopback HTTP is accepted for local development |
| `LOGBREW_REQUEST_TIMEOUT_MS` | `LogBrew:RequestTimeoutMs` | `10000` | HTTP delivery timeout from 1 ms through 10 minutes |
| `LOGBREW_FLUSH_INTERVAL_MS` | `LogBrew:FlushIntervalMs` | `5000` | Automatic flush interval |
| `LOGBREW_FLUSH_THRESHOLD` | `LogBrew:FlushThreshold` | `100` | Queue size that wakes delivery |

Programmatic options take precedence:

```csharp
builder.AddLogBrew(options => options
    .WithServiceName("checkout-api")
    .WithEnvironment("production")
    .WithRelease("1.2.3")
    .WithDependencyTelemetry(true)
    .ConfigureLogging(logging => logging.MinimumLevel = LogLevel.Warning)
    .ConfigureRequestTelemetry(request => request
        .WithRequestFilter(context => context.Request.Path != "/health")
        .WithRouteTemplateSelector(context => context.GetEndpoint()?.DisplayName)));
```

Dependency telemetry is opt-in. When enabled, the host owns a `LogBrewActivitySourceListener` for `System.Net.Http`, Entity Framework Core, SqlClient, and StackExchange.Redis sources. Use `ConfigureDependencyTelemetry(...)` to narrow or extend those named sources. `WithTransport(...)` accepts an app-owned transport; network endpoints must use HTTPS, except loopback HTTP for local development.

## Create a Project and Confirm Hosted Delivery

LogBrew CLI 0.1.32 or newer can create a project and one-time key without a dashboard. Keep the generated key file owner-only:

```bash
logbrew status --json
install -d -m 700 "$HOME/.logbrew"

project_result="$(
  logbrew projects create aspnet-service \
    --runtime dotnet \
    --environment development \
    --ingest-key-file "$HOME/.logbrew/aspnet-service.ingest" \
    --json
)"
export LOGBREW_PROJECT_ID="$(jq -er '.project.id' <<<"$project_result")"
unset project_result
export LOGBREW_SERVER_API_KEY="$(< "$HOME/.logbrew/aspnet-service.ingest")"
export LOGBREW_SERVICE_NAME="aspnet-service"
export LOGBREW_ENVIRONMENT="development"
```

Start the application and request one application route. Then inspect the same project through the authenticated CLI session:

```bash
logbrew doctor --project "$LOGBREW_PROJECT_ID" --json
logbrew traces --project "$LOGBREW_PROJECT_ID" \
  --service aspnet-service \
  --environment development \
  --since 1h \
  --json
```

When the temporary project is no longer needed, archive it and remove the one-time key:

```bash
unset LOGBREW_SERVER_API_KEY LOGBREW_SERVICE_NAME LOGBREW_ENVIRONMENT
logbrew projects archive "$LOGBREW_PROJECT_ID" --yes --json
rm -f "$HOME/.logbrew/aspnet-service.ingest"
unset LOGBREW_PROJECT_ID
```

## Health and Privacy Boundary

`LogBrewAspNetCoreRuntime` exposes the enabled state, privacy-safe delivery health, the last shutdown status code, and a stable lifecycle error code without returning keys, endpoints, event contents, exception messages, or filesystem paths:

```csharp
var runtime = app.Services.GetRequiredService<LogBrewAspNetCoreRuntime>();
LogBrewAspNetCoreHealthSnapshot health = runtime.Health();
```

The request middleware captures one route-template span, one optional `http.server.duration` metric, and one optional exception issue. Escaping exceptions carry typed .NET exception identity, mechanism `aspnetcore.middleware`, handled `false`, and at most 32 newest-first structured frames before the exact original exception is rethrown. Automatic issue capture omits exception messages, raw stack text, locals, source snippets, and absolute paths. It keeps `LogBrewTrace.Current` active while downstream handlers run so application-owned logs and telemetry can join the trace. It does not read request or response bodies, capture arbitrary headers, serialize raw `traceparent`, include query strings, or include raw route values; requests without a selected endpoint use the stable `/unmatched` route. The automatic logging provider excludes ASP.NET ambient scopes—which can contain raw paths and connection identifiers—while retaining explicit structured log fields and LogBrew trace correlation. Set `WithCaptureExceptionIssue(false)` only when another owner already captures the same failure.

## Existing Manual APIs

Existing integrations remain compatible. Apps that already own the client, transport, and shutdown sequence can continue to use `app.UseLogBrewRequestTelemetry(client, ...)`, `builder.Services.AddLogBrewDependencyActivitySourceTelemetry(client, ...)`, and `app.UseLogBrewDependencyActivitySourceTelemetry(client, ...)`. `WithRequestFilter(...)` and `WithRouteTemplateSelector(...)` remain available on manual and automatic request telemetry.

The packaged `examples/AspNetCoreMiddlewareTelemetry.cs` file provides a complete local Kestrel example with LogBrew `ILogger` correlation, route-template request spans, dependency `ActivitySource` spans, and local preview output.
