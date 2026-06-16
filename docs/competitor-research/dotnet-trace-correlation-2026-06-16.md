# .NET Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority. The .NET SDK already had explicit W3C `Traceparent` helpers, first-useful telemetry, `HttpTransport`, and an opt-in `Microsoft.Extensions.Logging` provider. It lacked the Sentry-competitive request-local correlation path where one request trace links .NET logs, captured issues, request spans, and request-duration metrics.

## Source Reviewed

- Sentry .NET `getsentry/sentry-dotnet` at commit `2f2842f20f9581468a0ab4e971bfd507557161b3`.
- Read `src/Sentry.AspNetCore/SentryTracingMiddleware.cs`: `TryStartTransaction` and `InvokeAsync`.
- Read `src/Sentry.Extensions.Logging/SentryStructuredLogger.cs`: `Log`.
- Read `src/Sentry.OpenTelemetry.Exporter/OtelPropagationContext.cs`: `Current`, `Snapshot`, `TraceId`, `SpanId`, and `ParentSpanId`.
- Read `src/Sentry.OpenTelemetry.Exporter/SentryPropagator.cs`: `Extract` and `Inject`.
- OpenTelemetry .NET `open-telemetry/opentelemetry-dotnet` at commit `41d2bb5a5f29aa8ad8f6566041434dccfb6b3252`.
- Read `src/OpenTelemetry/Logs/LogRecord.cs`: constructor activity capture and `TraceId` / `SpanId` properties.
- Read `src/OpenTelemetry/Logs/ILogger/OpenTelemetryLogger.cs`: `Log` and `LogRecordData.SetActivityContext(...)` use.
- Datadog .NET tracer `DataDog/dd-trace-dotnet` at commit `f308e58bebac1cf0f977fae6ddbe68e2f3ff399a`.
- Read `tracer/src/Datadog.Trace/AsyncLocalScopeManager.cs`: `Activate` and `Close`.
- Read `tracer/src/Datadog.Trace/CorrelationIdentifier.cs`: trace/log correlation keys.
- Read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Logging/LogContext.cs`: `TryGetValues`, `TryGetTraceId`, and `TryGetSpanId`.
- Read `tracer/src/Datadog.Trace/ClrProfiler/AutoInstrumentation/Logging/ILogger/LogsInjection/DatadogLoggingScope.cs`: trace/span log-scope injection.

## Competitor Patterns

- Sentry opens a request transaction/scope in ASP.NET middleware, keeps that scope available while user handlers run, and finishes it after route/status information is known.
- Sentry and OpenTelemetry both use the platform's active execution context (`Activity.Current` in OTel, Sentry hub/scope in Sentry) so logs and errors inherit trace/span identity automatically.
- Datadog uses `AsyncLocal` active scope plus log injection keys so structured logs can pivot to the active span without developers manually passing IDs on every log call.
- All three provide richer automatic instrumentation than LogBrew has today, but that comes with heavier dependencies, agent/middleware wiring, or broader capture surfaces.

## LogBrew Improvement From This Pass

- Added `LogBrewTraceContext` for immutable W3C-shaped trace/span identity, local root generation, incoming `traceparent` continuation, outbound `traceparent`, sampled flags, and primitive correlation metadata.
- Added `LogBrewTrace` with `AsyncLocal` active context, previous-context restoration, `Current`, and primitive `MetadataWithCurrentTrace(...)` helpers.
- Added `LogBrewHttpRequestTelemetry` to emit one request span plus optional `http.server.duration` metric using the same trace/span IDs as logs and issues. Malformed incoming propagation falls back non-fatally to a local root trace for request helpers, while strict `Traceparent.Parse(...)` remains available for explicit validation.
- Updated `LogBrewLoggerProvider` so `ILogger` records automatically include active `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled` metadata.
- Made `LogBrewClient` queue access lock-protected so request handlers and logger providers can safely enqueue from concurrent async work.
- Added packaged `examples/HttpTraceCorrelation.cs` plus installed-artifact validation for async log, issue, request span, and request-duration metric correlation from one W3C trace.

## Where LogBrew Is Better Today

- Lighter and more explicit for teams that want request trace-log-error-metric correlation without a .NET profiler/agent, ASP.NET package dependency, OpenTelemetry setup, global HTTP patching, payload capture, header capture, or raw propagation serialization.
- The request helper records route templates after stripping query strings/fragments and keeps metadata primitive-only.
- `AsyncLocal` active trace support works with standard async execution and remains under app-owned scopes rather than hidden global middleware.

## Where LogBrew Is Still Worse

- No ASP.NET Core middleware/filter package yet; users call `LogBrewHttpRequestTelemetry` from app-owned middleware or handlers.
- No `Activity.Current` / OpenTelemetry context bridge yet, so apps already using OTel must explicitly pass W3C `traceparent` or a LogBrew trace context.
- No outbound `HttpClient`, database, messaging, cache, or rich child-span auto-instrumentation.
- No baggage, tracestate, span events, or exception event modeling beyond primitive metadata.

## Updated Evidence

- `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release`: 29 tests including 6 trace-correlation tests.
- `bash scripts/check_dotnet_package.sh`: builds, packs, checks NuGet metadata and README payload, runs examples, and validates `HttpTraceCorrelation` output.
- `bash scripts/real_user_dotnet_smoke.sh`: installs the built `LogBrew` NuGet package into temporary apps, proves install/remove/reinstall, logger integration, HTTP retry, and packaged `HttpTraceCorrelation` output from the installed artifact.

The trace example verifies one trace/span pair across an async `ILogger` record, captured issue, request span, and `http.server.duration` metric; verifies outbound W3C `traceparent`; checks malformed incoming propagation does not fail request setup; and checks query strings, fragments, non-primitive metadata, and raw propagation headers are not serialized into LogBrew telemetry.
