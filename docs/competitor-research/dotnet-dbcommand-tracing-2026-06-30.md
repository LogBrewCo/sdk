# .NET ADO.NET DbCommand Tracing

## Goal

Close a high-impact .NET rich-trace gap from a real developer point of view: Sentry, Datadog, and OpenTelemetry can produce database command spans from framework or auto-instrumentation paths, while LogBrew only had generic database callback spans. The LogBrew improvement should make app-owned ADO.NET command calls easier to correlate with request traces from the installed package without adding provider dependencies, profilers, EF interceptors, raw SQL capture, query comments, database-side trace propagation, baggage, or tracestate.

## Competitor Source Read

- Sentry .NET `getsentry/sentry-dotnet@951d98f789ec6794a1bbd82149d900f06fde0cfa`
- Read `src/Sentry.EntityFramework/SentryQueryPerformanceListener.cs`: `ReaderExecuting`, `NonQueryExecuting`, `ScalarExecuting`, `CreateSpan`, and `Finish` start/finish child spans around EF command interception and attach success/error status.
- Read `src/Sentry.EntityFramework/SentryCommandInterceptor.cs`: `Log(...)` records `DbCommand.CommandText` as breadcrumbs.
- Read `src/Sentry.EntityFramework/DbInterceptionIntegration.cs`: registers/removes the EF interception listener only when performance monitoring is enabled.
- Datadog .NET `DataDog/dd-trace-dotnet@f0fbab0b733ead08b8c37f7ee550ede7a7f9cd60`
- Read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/AdoNet/DbScopeFactory.cs`: `CreateDbCommandScope(...)`, `TryGetIntegrationDetails(...)`, provider detection, SQL span tags, command text resource naming, duplicate suppression, and DBM propagation.
- Read `CommandExecuteNonQueryIntegration.cs`, `CommandExecuteReaderIntegration.cs`, and `AdoNetConstants.cs`: CallTarget wrappers for `ExecuteNonQuery`, `ExecuteScalar`, `ExecuteReader`, async variants, reader close/read hooks, and provider method inventory.
- OpenTelemetry .NET contrib `open-telemetry/opentelemetry-dotnet-contrib@7e8040413042ee663a9ef4dd04ab52d1a17ed77b`
- Read `src/OpenTelemetry.Instrumentation.SqlClient/Implementation/SqlClientDiagnosticListener.cs`: listens to SqlClient before/after/error diagnostic events, derives Activity names/tags from command and connection data, supports filter/enrich hooks, optional exception recording, and optional trace context propagation through SQL Server context info.
- Read `SqlClientTraceInstrumentationOptions.cs` and `Implementation/SqlTelemetryHelper.cs`: `EnrichWithSqlCommand`, `Filter`, `RecordException`, optional query-parameter capture warning, SQL Server semantic attributes, and duration metrics.
- PostHog .NET `PostHog/posthog-dotnet@8fad3ff84cda2c741f397e1152e58a7b96c98124`
- Read `src/PostHog.AspNetCore/Tracing/PostHogRequestContextMiddleware.cs` and `src/PostHog.AI/PostHogOpenAIHandler.cs`: request context and AI HTTP telemetry patterns. Source search did not show generic ADO.NET, Entity Framework, or SqlClient database span instrumentation.

## Design Pattern And Tradeoffs

Sentry is convenient inside EF because it owns the interceptor lifecycle, but it can include command text. Datadog is strongest for transparent ADO.NET coverage and provider detection, but it relies on profiler/CallTarget instrumentation, richer DBM propagation, and command text/resource capture. OpenTelemetry is standards-rich through DiagnosticSource/ActivitySource and options hooks, but SqlClient-focused and can capture query parameters when explicitly enabled. PostHog is not a direct database tracing competitor here.

LogBrew chose a lighter core-SDK boundary: explicit app-owned `DbCommand` helpers for sync/async `ExecuteNonQuery`, `ExecuteScalar`, and `ExecuteReader`. The helpers preserve the app-owned command/result/reader/cancellation value/original provider exception, keep `LogBrewTrace.Current` active while the command executes, emit one child `database.command:<operation>` span, record `rowCount` only from non-query results, and attach one type-only exception span event on failures.

Privacy defaults are stricter than the competitors above: no profiler, EF interceptor, provider dependency, SQL parser, query comments, database-side trace propagation, raw `CommandText`, parameters, connection strings, data source, result rows, exception messages, stacks, baggage, tracestate, or support-ticket creation.

## LogBrew Changes

- Added `LogBrewDbCommandTelemetry` and `LogBrewDbCommandOptions` to the .NET core package.
- Added unit coverage for sync non-query/scalar/reader, async non-query/scalar/reader, active trace correlation, row count, result preservation, original exception preservation, capture-failure isolation, and redaction.
- Added packaged `examples/DbCommandTelemetry.cs` plus `scripts/check_dotnet_db_command_payload.py`.
- Updated NuGet package metadata checks, source package checks, installed NuGet smoke, Makefile targets, and README guidance.

## Verification

- Red TDD: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release` failed because `LogBrewDbCommandTelemetry` and `LogBrewDbCommandOptions` did not exist.
- Focused green: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release` passed with 65 tests after implementation.

## Honest Status

LogBrew is now better for teams that want an explicit, dependency-free, privacy-bounded ADO.NET command helper with installed-package proof and no hidden runtime instrumentation. Sentry, Datadog, and OpenTelemetry remain stronger for transparent automatic EF/SqlClient/provider coverage, richer semantic conventions, DB metrics, filter/enrich ecosystems, DBM propagation, and profiler/DiagnosticSource-based discovery. The next .NET rich-trace gaps are optional EF/SqlClient integration packages, richer span event/link support, and provider-specific DB/cache/queue helpers that stay opt-in and privacy-bounded.
