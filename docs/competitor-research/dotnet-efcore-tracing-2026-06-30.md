# .NET EF Core Command Tracing Comparison - 2026-06-30

## Source Evidence

- Sentry .NET `getsentry/sentry-dotnet@951d98f789ec6794a1bbd82149d900f06fde0cfa`: read `src/Sentry.DiagnosticSource/Internal/DiagnosticSource/SentryEFCoreListener.cs`, `EFCommandDiagnosticSourceHelper.cs`, `EFDiagnosticSourceHelper.cs`, and `src/Sentry.EntityFramework/SentryCommandInterceptor.cs`. Pattern: EF Core diagnostic events are correlated by `CommandId`; Sentry starts/finishes `db.query` spans from EF command events and attaches database metadata. Older EF6 support uses a command interceptor and logs command text as a breadcrumb.
- Datadog .NET `DataDog/dd-trace-dotnet@f0fbab0b733ead08b8c37f7ee550ede7a7f9cd60`: read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/AdoNet/DbScopeFactory.cs` and `CommandExecuteReaderIntegration.cs`. Pattern: profiler-based ADO.NET instrumentation starts active SQL spans around provider execute calls, classifies providers, avoids nested duplicate command spans, and can inject database-monitoring context into queries.
- OpenTelemetry .NET Contrib `open-telemetry/opentelemetry-dotnet-contrib@7e8040413042ee663a9ef4dd04ab52d1a17ed77b`: read `src/OpenTelemetry.Instrumentation.EntityFrameworkCore/Implementation/EntityFrameworkDiagnosticListener.cs`, `EntityFrameworkInstrumentationOptions.cs`, `TracerProviderBuilderExtensions.cs`, and `EntityFrameworkInstrumentation.cs`. Pattern: EF Core `DiagnosticSource` subscription creates Activity spans, maps providers to DB semantic conventions, supports filters/enrichment, and can optionally attach bind values.
- PostHog .NET `PostHog/posthog-dotnet@8fad3ff84cda2c741f397e1152e58a7b96c98124`: searched `src` for `EntityFramework`, `DbCommand`, `SaveChanges`, `DiagnosticListener`, and `SqlClient`; no comparable EF Core command tracing path was found.

## What LogBrew Added

- Added optional `LogBrew.EntityFrameworkCore` NuGet package with `LogBrewEntityFrameworkCoreCommandInterceptor` and `AddLogBrewCommandTelemetry(...)`.
- Apps opt in through their own `DbContextOptionsBuilder`; the base `LogBrew` package does not gain EF Core dependencies.
- The interceptor creates one sanitized `entity_framework_core.command:<operation>` span per EF Core command, correlates with the active LogBrew trace, records EF command source, execute method, command type, duration, non-query row count, DB system/name, sampled flag, and type-only provider failures or cancellations.
- `WithCommandFilter(...)` lets apps skip noisy command sources. `WithMetadataProvider(...)` allows primitive low-cardinality context from a safe command snapshot.

## Privacy And Tradeoffs

- LogBrew does not capture raw database statements, bind values, connection details, data source, network names, raw trace context headers, result rows, payloads, exception messages, exception call stacks, baggage, tracestate, database-side comments, or support tickets.
- Compared with Sentry/OTel/Datadog, this is lighter and safer for first production use, but still weaker for automatic zero-code coverage, full DB semantic conventions, query sanitization, database-side trace propagation, rich span events/links, baggage/tracestate, and profiler-backed provider coverage.

## Verification

- Red TDD: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.EntityFrameworkCore.Tests/LogBrew.EntityFrameworkCore.Tests.csproj --configuration Release` first failed because `LogBrew.EntityFrameworkCore` did not exist.
- Package dependency check: an attempted real SQLite-backed EF test failed on NuGet vulnerability `SQLitePCLRaw.lib.e_sqlite3 2.1.11`; the source tests were changed to synthetic EF Core command event data so vulnerability checks stay strict.
- Green focused proof: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.EntityFrameworkCore.Tests/LogBrew.EntityFrameworkCore.Tests.csproj --configuration Release` passed with 4 tests.
- Green package proof: `bash scripts/check_dotnet_package.sh` passed with 65 core tests, 4 ASP.NET Core tests, 4 EF Core tests, package metadata/readme/example inspection, and source example execution.
- Green installed proof: `bash scripts/real_user_dotnet_smoke.sh` passed with packed local NuGet installs, installed EF Core package example proof, package lifecycle add/remove/re-add, and existing local HTTP/retry/flush/shutdown coverage.
