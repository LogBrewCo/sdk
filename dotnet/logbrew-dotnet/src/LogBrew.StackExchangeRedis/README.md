# LogBrew StackExchange.Redis

Opt-in StackExchange.Redis command tracing for LogBrew .NET apps.

```bash
dotnet add package LogBrew.StackExchangeRedis
```

```csharp
using LogBrew;
using LogBrew.StackExchangeRedis;
using StackExchange.Redis;

var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-service", "1.0.0");
IDatabase redis = multiplexer.GetDatabase();

var value = redis.TraceLogBrewCommand(
    client,
    "GET",
    db => db.StringGet("cart:123"),
    LogBrewStackExchangeRedisCommandOptions.Create()
        .WithCacheName("checkout-cache")
        .WithMetadata(new Dictionary<string, object?> { ["routeTemplate"] = "/cart/:id" }));
```

`TraceLogBrewCommand(...)` and `TraceLogBrewCommandAsync(...)` capture one sanitized `stackexchange_redis.command:<COMMAND>` span around the app-owned Redis call. They keep the active `LogBrewTrace.Current` child trace available while the command runs, preserve the original result or exception, infer safe coarse result metadata for Redis values, and report SDK capture failures through optional `OnError(...)`.

The helper records the normalized Redis command name, operation kind, optional cache name, database index when available, duration, sampled state, coarse hit/count/size metadata, and type-only failures. It does not capture Redis keys, values, command arguments, raw command text, connection strings, endpoints, server names, arbitrary headers, payloads, exception messages, stacks, baggage, tracestate, profiler sessions, or support tickets.

The package includes `examples/StackExchangeRedisCommandTelemetry.cs` as a copyable example that compiles from the installed NuGet package without requiring a live Redis server.
