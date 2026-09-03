# LogBrew for Hangfire

`LogBrew.Hangfire` adds one opt-in Hangfire server filter. Every performed job
gets a named `job.execute` root span, logs written through LogBrew's
`Microsoft.Extensions.Logging` provider inherit that trace, and an escaped job
exception creates a typed unhandled issue on the same root.

```bash
dotnet add package LogBrew.Hangfire
```

```csharp
using Hangfire;
using LogBrew;
using LogBrew.Hangfire;

var client = LogBrewClient.CreateAutomatic(
    Environment.GetEnvironmentVariable("LOGBREW_SERVER_API_KEY")!,
    "checkout-worker",
    "1.0.0",
    new HttpTransport());

GlobalConfiguration.Configuration.UseLogBrewHangfire(client);
```

See `examples/HangfireJobTelemetry.cs` for the complete registration.

Register the filter once before starting Hangfire workers. Use the same client
with `AddLogBrew(...)` when job code logs through `ILogger`; those records then
carry the job root's exact trace and span IDs. App-owned child instrumentation
also inherits the active job trace.

The adapter records only the bounded job type and method, duration, outcome,
framework/source/operation classification, and exception type. It never reads
serialized arguments, job IDs, storage connections, or headers. It omits
exception messages and raw stack text. Capture failures are isolated from the
job and can be observed locally through the optional third
`UseLogBrewHangfire(...)` callback.
