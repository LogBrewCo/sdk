# LogBrew Entity Framework Core

Opt-in Entity Framework Core command tracing for LogBrew .NET apps.

```bash
dotnet add package LogBrew.EntityFrameworkCore
```

```csharp
using LogBrew;
using LogBrew.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-service", "1.0.0");

optionsBuilder
    .UseSqlServer(connectionString)
    .AddLogBrewCommandTelemetry(
        client,
        options => options
            .WithSystem("sqlserver")
            .WithDatabaseName("checkout")
            .WithOperationNamePrefix("orders"));
```

`AddLogBrewCommandTelemetry(...)` installs `LogBrewEntityFrameworkCoreCommandInterceptor`. The interceptor captures one sanitized span per EF Core command and keeps the active LogBrew trace correlated while the command executes. It records command method, EF command source, command type, duration, row count for non-query commands, provider failure or cancellation type, release/environment correlation from the parent client payload, and primitive caller metadata.

It does not capture raw database statements, bind values, connection details, network names, raw trace headers, payloads, baggage, tracestate, or exception call stacks. Use `WithCommandFilter(...)` for noisy commands and `WithMetadataProvider(...)` for low-cardinality primitive context.

The package includes `examples/EntityFrameworkCoreCommandTelemetry.cs` as a copyable setup snippet.
