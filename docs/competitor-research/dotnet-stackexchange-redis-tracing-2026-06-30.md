# .NET StackExchange.Redis Tracing - Competitor Research - 2026-06-30

## Sources Read

- Sentry .NET `getsentry/sentry-dotnet@951d98f789ec6794a1bbd82149d900f06fde0cfa`
  - Repository search for `redis` and `stackexchange` found no first-party StackExchange.Redis integration path at this commit.
- Datadog .NET tracer `DataDog/dd-trace-dotnet@f0fbab0b733ead08b8c37f7ee550ede7a7f9cd60`
  - `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Redis/StackExchange/StackExchangeRedisHelper.cs`
  - `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Redis/StackExchange/RedisExecuteAsyncIntegration.cs`
  - `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Redis/StackExchange/RedisExecuteSyncIntegration.cs`
  - `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Redis/RedisHelper.cs`
  - `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Redis/RedisTags.cs`
- OpenTelemetry .NET Contrib `open-telemetry/opentelemetry-dotnet-contrib@7e8040413042ee663a9ef4dd04ab52d1a17ed77b`
  - `src/OpenTelemetry.Instrumentation.StackExchangeRedis/StackExchangeRedisInstrumentation.cs`
  - `src/OpenTelemetry.Instrumentation.StackExchangeRedis/StackExchangeRedisConnectionInstrumentation.cs`
  - `src/OpenTelemetry.Instrumentation.StackExchangeRedis/StackExchangeRedisInstrumentationOptions.cs`
  - `src/OpenTelemetry.Instrumentation.StackExchangeRedis/Implementation/RedisProfilerEntryToActivityConverter.cs`
  - `src/OpenTelemetry.Instrumentation.StackExchangeRedis/TracerProviderBuilderExtensions.cs`
- PostHog .NET `PostHog/posthog-dotnet@8fad3ff84cda2c741f397e1152e58a7b96c98124`
  - Repository search for `redis` and `stackexchange` found no first-party Redis integration path at this commit.

## Pattern Observed

- Datadog wins on automatic coverage by using profiler/calltarget instrumentation for StackExchange.Redis execute paths. It captures command/resource and connection-style tags, avoids nested Redis spans, and works without application code at call sites, but this is heavier, version-coupled, and has a broader metadata surface.
- OpenTelemetry .NET Contrib wins for apps already using OTel by registering StackExchange.Redis profiling sessions and converting profiled entries to Activities with semantic tags, filtering, enrich hooks, and background session lifecycle handling. This is rich and portable, but it requires an extra OTel package and can expose expanded Redis operation details when verbose options are enabled.
- Sentry and PostHog did not show a current first-party StackExchange.Redis integration in the public .NET repos reviewed, so Redis-specific trace quality is a Datadog/OpenTelemetry advantage rather than a universal competitor baseline.

## LogBrew Change

- Added optional NuGet package `LogBrew.StackExchangeRedis` instead of adding Redis dependencies to the base `LogBrew` package.
- Added `TraceLogBrewCommand(...)` and `TraceLogBrewCommandAsync(...)` extension methods for app-owned `IDatabase` and `IDatabaseAsync` calls.
- Each helper creates one child span under `LogBrewTrace.Current`, keeps that child trace active while the Redis call runs, preserves the original result or exception, records a normalized command name, operation kind, database index, duration, sampled state, optional cache name, safe primitive caller metadata, and coarse hit/count/size result metadata.
- Failed Redis calls keep the original exception behavior and add type-only span diagnostics with `errorType`, `exceptionType`, and `exceptionEscaped`.
- The helper intentionally avoids profiler sessions, global patching, connection ownership, Redis keys, values, command arguments, raw command text, endpoints, connection strings, arbitrary headers, payloads, exception messages, stacks, baggage, tracestate, and support-ticket behavior.

## Verification

- TDD red: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.StackExchangeRedis.Tests/LogBrew.StackExchangeRedis.Tests.csproj --configuration Release` first failed on the missing `LogBrew.StackExchangeRedis` namespace.
- Green focused proof: the same test command now passes with `{"tests":4}`.
- Installed/source package proof: `bash scripts/check_dotnet_package.sh` passes with core, ASP.NET Core, EF Core, and Redis tests; NuGet content inspection; README checks; source example build/run; and Redis payload redaction validation.
- Installed-artifact proof: `bash scripts/real_user_dotnet_smoke.sh` passes from local NuGet packages, including `LogBrew.StackExchangeRedis` package install, packaged Redis example execution, payload validation, and install/remove/reinstall lifecycle.
- Package health: `dotnet list dotnet/logbrew-dotnet/src/LogBrew.StackExchangeRedis/LogBrew.StackExchangeRedis.csproj package --vulnerable --include-transitive` reports no vulnerable packages, and `dotnet list ... package --outdated` reports no updates for current NuGet sources.

## Honest Status

LogBrew is now better than Sentry .NET and PostHog .NET for explicit Redis span coverage because their reviewed public repos did not expose a first-party StackExchange.Redis path. LogBrew is safer and lighter than Datadog/OpenTelemetry for applications that prefer app-owned call sites, privacy-bounded metadata, and installed-artifact proof without global patching. Datadog and OpenTelemetry remain stronger for automatic Redis coverage, richer semantic conventions, profiler timing, OTel Activity integration, filtering/enrich hooks, and broader dependency auto-instrumentation. The next .NET trace priorities should be optional high-demand integrations only when they preserve uninstallability, user-owned setup, high-load behavior, and key/value redaction.
