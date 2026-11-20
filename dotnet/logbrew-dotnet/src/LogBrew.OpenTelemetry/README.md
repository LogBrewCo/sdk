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
    activity?.SetTag("service.name", "checkout-api");
    activity?.SetTag("service.version", "1.0.0");
    activity?.SetTag("deployment.environment.name", "production");
    activity?.SetTag("telemetry.sdk.name", "opentelemetry");
    activity?.SetTag("http.request.method", "GET");
    activity?.SetTag("http.route", "/checkout/{id}");
    activity?.SetTag("http.response.status_code", 200);
}

using var exporterSource = new ActivitySource("Checkout.Exporter", "1.0.0");
using var exporter = new LogBrewOpenTelemetrySpanExporter(client, options => options
    .WithEventIdPrefix("checkout_otel_exporter")
    .WithServiceName("checkout-worker")
    .WithServiceVersion("1.0.0")
    .WithDeploymentEnvironment("staging"));
using var exportProcessor = new SimpleActivityExportProcessor(exporter);
using var exporterProvider = Sdk.CreateTracerProviderBuilder()
    .AddSource("Checkout.Exporter")
    .AddProcessor(exportProcessor)
    .Build();

using (var activity = exporterSource.StartActivity("POST /jobs/{id}", ActivityKind.Producer))
{
    activity?.SetTag("messaging.system", "memory");
    activity?.SetTag("messaging.operation", "publish");
}

Console.WriteLine(client.PreviewJson());
```

The integration adds `LogBrewOpenTelemetrySpanProcessor`, `TracerProviderBuilder.AddLogBrew(...)`, and `LogBrewOpenTelemetrySpanExporter` for apps that prefer standard OpenTelemetry export processors such as `SimpleActivityExportProcessor` or `BatchActivityExportProcessor`. It captures ended, recorded W3C Activities through the same privacy-bounded `LogBrewActivitySpanTelemetry` path as the core SDK: trace/span IDs, parent span ID, sampled flag, duration, Activity name/kind/source, capped Activity event summaries, capped Activity link summaries, type-only OpenTelemetry exception event counts and types, escaped-exception error inference, explicit service context, safe `service.name`/`service.version`/`deployment.environment.name`/`telemetry.sdk.name` resource-convention tags, and a small allowlist of primitive semantic tags such as HTTP method/route/status, DB system/operation, messaging system/operation, RPC system, and exception type. It reads the database, RPC, and messaging system names from the current keys (`db.system.name`, `rpc.system.name`, `messaging.system.name`) and from the older keys (`db.system`, `rpc.system`, `messaging.system`). Each captured span also carries matching `TelemetryContext` trace identity plus typed service and deployment resource fields, so related LogBrew issues, logs, actions, and metrics can join the same trace without parsing flat metadata.

It does not create an OpenTelemetry provider, sampler, resource detector, instrumentation package, baggage/tracestate reader, global Activity listener, HTTP/database patch, arbitrary resource copier, payload/header/full-URL/query capture, exception message capture, support ticket, OTLP forwarding path, or background upload path. Apps keep ownership of their OpenTelemetry pipeline and LogBrew only receives sanitized ended spans after the app opts in.

## Request Outcomes

`AddLogBrew(...)` also sends the outcome of each ended server or consumer Activity:

- One duration histogram in milliseconds: `http.server.duration`, `rpc.server.duration` when the Activity has an `rpc.system.name` or `rpc.system` tag, or `messaging.process.duration` for a consumer. Its metadata holds the Activity kind, `status`, and the same safe HTTP, database, messaging, and RPC fields as the span.
- One issue when the Activity failed (error status, a 5xx status code, or an escaped exception) and has an `exception` event, as `Activity.AddException(...)` records. The issue has the title `<Activity name> failed`, the exception type, and stack frames read from `exception.stacktrace`. Frames keep the method, type, file name without its directory, and line. The exception message is not sent.
- Breadcrumbs: each ended child Activity and each `ILogger` record written inside an Activity through the LogBrew logger provider. An issue includes the breadcrumbs of its Activity and of its parent Activities in the same process, at most 64.

The issue, metric, and span share the trace and span IDs of the Activity. `ILogger` records written inside an Activity also carry its trace and span IDs when no LogBrew trace is active. Client, producer, and internal Activities send only spans and breadcrumbs, so a failed dependency call does not send a second issue. `LogBrewOpenTelemetrySpanExporter` sends only spans. Use `LogBrewActivitySpanTelemetry.RecordBreadcrumb(Activity.Current, IssueBreadcrumb.Create(timestamp, "checkout"))` to add your own breadcrumbs.

The packaged `examples/OpenTelemetrySpanProcessorTelemetry.cs` file shows copyable processor and exporter Activity-to-LogBrew span correlation setup with service context.
