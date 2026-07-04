# .NET OpenTelemetry Exception Summaries - 2026-07-04

## User Gap

.NET services that already own an OpenTelemetry `TracerProvider` can record exceptions as Activity events. Before this pass, LogBrew copied the safe `exception.type` event field, but an escaped exception event on an otherwise unset-status Activity still looked like an `ok` span and had no top-level count/type metadata. That made failure traces harder to find without copying exception messages or stacks.

## Source Reading

- Sentry .NET `3d6f266e80c956a2fee2e8aaeeaad31dc438110d`
- `src/Sentry.OpenTelemetry/SentrySpanProcessor.cs`: `OnStart(...)`, `OnEnd(...)`, `GetSpanStatus(...)`, and `GenerateSentryErrorsFromOtelSpan(...)`.
- `src/Sentry.OpenTelemetry.Exporter/ActivityExtensions.cs`: Activity trace/span ID mapping.
- Pattern: Sentry maps OTel Activities into Sentry spans/transactions and turns OTel exception events into Sentry events when `exception.type` is present. This is strong for trace-to-error navigation, but it copies richer exception fields than LogBrew should by default.

- OpenTelemetry .NET `8592991371f0227e0522d145546cc67757bea9e1`
- `src/OpenTelemetry.Api/Trace/ActivityExtensions.cs`: `SetStatus(...)`, `GetStatus(...)`, and obsolete `RecordException(...)` bridge to `Activity.AddException(...)`.
- `src/OpenTelemetry/Trace/Processor/ExceptionProcessor.cs`: infers error status from unmanaged exception pointers for OTel SDK internals.
- Pattern: OTel keeps exception data as standard Activity events and status. Exporters/processors decide how much to preserve.

- Datadog .NET `bb5a5079a8a1950970fa82282ba3a2ccc06c943d`
- `tracer/src/Datadog.Trace/Activity/Handlers/ActivityHandlerCommon.cs`: Activity-to-span lifecycle and reconciliation.
- `tracer/src/Datadog.Trace/Activity/OtlpHelpers.cs`: `AgentConvertSpan(...)`, `ExtractActivityEvents(...)`, `AgentStatus2ErrorActivity6(...)`, and `ExtractExceptionAttributes(...)`.
- Pattern: Datadog copies Activity events and maps OTel error status plus exception event attributes into span error tags. Useful for discoverability, but broader and less privacy-minimal than LogBrew defaults.

- PostHog .NET `1d74b329490b5b71a016115859fff71ba3f16b7d`
- `README.md`, `src/`, and `samples/` grep found no comparable OpenTelemetry Activity span processor/exporter path.
- Pattern: PostHog .NET is not a direct comparator for this OTel trace slice.

## LogBrew Change

- `LogBrewActivitySpanTelemetry` now summarizes Activity events named `exception` into span metadata:
  `otel.exception_event_count`, optional `otel.exception_escaped_count`, and bounded comma-separated `otel.exception_types`.
- Escaped OTel exception events now mark a span as `error` when OTel status is unset. Explicit OTel `OK` remains `ok`; explicit OTel `ERROR` remains `error`.
- Event summaries now include type-only `exceptionType` and boolean `exceptionEscaped` when present.
- LogBrew still omits exception messages, stack traces, payloads, headers, full URLs, baggage, tracestate, arbitrary resource attributes, and raw propagation data by default.

## Verification

- RED: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release` failed on missing `"status": "error"` for an escaped exception Activity event.
- GREEN: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release` passed with 74 tests.
- GREEN: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.OpenTelemetry.Tests/LogBrew.OpenTelemetry.Tests.csproj --configuration Release` passed with 5 tests.
- GREEN installed-artifact/package proof: `bash scripts/check_dotnet_package.sh` built, tested, packed, and verified the .NET packages, including the installed OpenTelemetry example payload with safe exception summary metadata and redaction.

## Remaining Gaps

- Sentry and Datadog still lead on hosted trace-to-error navigation, grouping, richer automatic instrumentation, and exception UI.
- LogBrew still does not own OTel providers, samplers, resource detectors, baggage/tracestate, automatic instrumentation, OTLP forwarding, or global listeners. That keeps the .NET integration explicit and privacy-bounded, but full automatic OTel parity remains a future gap.
