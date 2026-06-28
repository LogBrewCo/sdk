# .NET Dependency Spans - Competitor Research - 2026-06-19

## Sources Read

- Sentry .NET `getsentry/sentry-dotnet@2f2842f20f9581468a0ab4e971bfd507557161b3`
  - `src/Sentry.EntityFramework/SentryQueryPerformanceListener.cs`: `ReaderExecuting`, `ReaderExecuted`, `NonQueryExecuting`, `NonQueryExecuted`, `ScalarExecuting`, `ScalarExecuted`, `CreateSpan`, and `Finish`.
  - `src/Sentry.EntityFramework/SentryCommandInterceptor.cs`: `NonQueryExecuting`, `ReaderExecuting`, `ScalarExecuting`, and `Log`.
  - `src/Sentry.EntityFramework/DbInterceptionIntegration.cs`: `Register` and `Unregister`.
- Datadog .NET tracer `DataDog/dd-trace-dotnet@b92777ccdbd8bc7f7ad0a7cb59d5d53f638e93e1`
  - `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/AdoNet/SqlClient/SqlClientDefinitions.cs`: SqlClient integration definitions.
  - `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Redis/StackExchange/RedisExecuteSyncIntegration.cs`, `RedisExecuteAsyncIntegration.cs`, and `StackExchangeRedisHelper.cs`: StackExchange.Redis command interception.
  - `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Kafka/KafkaHelper.cs`, `KafkaProduceAsyncIntegration.cs`, and `KafkaConsumerConsumeIntegration.cs`: Kafka producer/consumer span support.
  - `tracer/test/Datadog.Trace.Tests/ExtensionMethods/SpanExtensionsTests.cs`: DB connection-string tag extraction and cache limits.
- OpenTelemetry .NET Contrib `open-telemetry/opentelemetry-dotnet-contrib@b04a8ba4d4dadee7723fb0dac5c818de69ba3c50`
  - `src/OpenTelemetry.Instrumentation.SqlClient/Implementation/SqlClientDiagnosticListener.cs` and `SqlEventSourceListener.netfx.cs`: SQL diagnostic/event-source command observation.
  - `src/OpenTelemetry.Instrumentation.SqlClient/SqlClientTraceInstrumentationOptions.cs`: filter, enrich, exception recording, and trace-context propagation options.
  - `src/OpenTelemetry.Instrumentation.StackExchangeRedis/Implementation/RedisProfilerEntryToActivityConverter.cs`: `ProfilerCommandToActivity`, command metadata, timing, and optional verbose statement handling.
  - `test/OpenTelemetry.Instrumentation.StackExchangeRedis.Tests/StackExchangeRedisCallsInstrumentationTests.cs`: exported Redis activity expectations, filtering, enrich hooks, and disposal flush behavior.

## Pattern Observed

- Sentry EF integration uses Entity Framework interception to create child spans from the current hub span and finish them after command completion or exception. It provides automatic EF coverage but depends on EF interception and can include command text as span description or breadcrumbs.
- Datadog uses profiler/auto-instrumentation definitions across SqlClient, Redis, Kafka, and other clients. It has broad automatic coverage, connection metadata parsing, data-streams/Kafka metadata, and mature integration toggles, but the core behavior depends on profiler hooks, version-specific integrations, and wider metadata surfaces.
- OpenTelemetry .NET uses `Activity`/`ActivitySource` plus client-specific instrumentation such as SqlClient event sources and StackExchange.Redis profiling. It has strong semantic conventions, enrich/filter hooks, and richer timing, but it requires extra instrumentation packages and can expose command/query text when verbose options are enabled.

## LogBrew Change

- Added dependency-free `LogBrewOperationTracing.DatabaseOperation(...)`, `DatabaseOperationAsync(...)`, `CacheOperation(...)`, `CacheOperationAsync(...)`, `QueueOperation(...)`, and `QueueOperationAsync(...)` to the .NET core package.
- The helpers run an app-owned callback under a child `LogBrewTraceContext`, preserve the callback result or original exception, queue one span, and report SDK capture failures through optional `OnError(...)` callbacks without replacing app behavior.
- Metadata is primitive-only and drops unsafe dependency details such as raw statements, connection details, cache identifiers, message contents, broker details, request metadata, and unsafe values.
- This intentionally avoids profilers, EF interceptors, SqlClient/Redis/Kafka dependencies, global patching, payload/header capture, baggage, and tracestate in the core package.

## Verification

- `bash scripts/check_dotnet_package.sh` passes with 33 source tests and packaged README/example checks.
- `bash scripts/real_user_dotnet_smoke.sh` passes from an installed local NuGet package, proving DB/cache/queue span APIs, trace correlation, metadata redaction, retry/failure/flush/shutdown behavior, and package install/remove/reinstall lifecycle.

## Honest Gap

LogBrew is now lighter, safer by default, and easier to verify from installed artifacts than broad automatic instrumentation in the core package. Sentry, Datadog, and OpenTelemetry remain stronger for automatic EF/SqlClient/Redis/Kafka coverage, richer semantic conventions, span events/exceptions/links, baggage/tracestate, and client-specific timing. The next .NET step should be opt-in integration packages or helpers for the highest-demand concrete clients, not hidden patching in core.

## 2026-06-28 Span Event Follow-Up

### Source Context Reused

- Sentry .NET and Datadog .NET sources above showed mature exception/span enrichment in their automatic dependency paths.
- OpenTelemetry .NET's Activity model exposes event-style span annotations through `ActivityEvent`, and OTel instrumentation commonly records exception facts as span events.

### LogBrew Change

- Added public `SpanEventSummary` support to .NET `SpanAttributes`, capped at eight event summaries per span with non-empty names, optional ISO-8601 timestamps, and primitive-only metadata.
- `LogBrewOperationTracing` now attaches one `exception` event summary to failed database/cache/queue spans with only `exceptionType` and `exceptionEscaped`.
- The dependency-span installed example now includes a caught failing database operation; the verifier proves the exception event exists while the exception message, query text, connection details, cache keys, and message payload text stay out of the emitted JSON.
- Bumped the core NuGet package metadata to `LogBrew` `0.1.3` for the next scoped .NET release; `LogBrew.AspNetCore` remains unchanged.

### Verification

- TDD red: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release` failed on the missing exception span event.
- TDD red installed proof: `bash scripts/check_dotnet_package.sh` failed with `summary event count mismatch` after the verifier expected the new failing dependency span.
- Green proof: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release` passed with 60 tests.
- Green installed proof: `bash scripts/check_dotnet_package.sh` passed with 60 core tests, 4 ASP.NET Core tests, NuGet pack proof, README/example checks, and dependency-span payload validation.

### Still Not Copied

LogBrew still does not add EF/SqlClient/Redis/Kafka dependencies, profiler hooks, automatic instrumentation, OTel processors/exporters, baggage, tracestate, span links, full exception messages, stack traces, raw SQL, connection strings, broker details, message payloads, request/response bodies, headers, or support-ticket behavior in the core .NET package.
