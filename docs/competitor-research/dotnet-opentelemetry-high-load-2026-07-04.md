# .NET OpenTelemetry High-Load Installed Proof - 2026-07-04

## User Gap

.NET services that already use OpenTelemetry should be able to add LogBrew
without discovering queue/backpressure, retry, redaction, or shutdown behavior
only after production load. Before this verifier, LogBrew had unit-level
OpenTelemetry queue pressure coverage and a normal packed OpenTelemetry example,
but no installed-package high-load proof for the `LogBrew.OpenTelemetry`
integration path.

## Source Evidence Reused

- Sentry .NET `getsentry/sentry-dotnet@951d98f789ec6794a1bbd82149d900f06fde0cfa`:
  `src/Sentry/Internal/BackgroundWorker.cs`, `src/Sentry/SentryOptions.cs`,
  and `src/Sentry/Internal/ClientReportRecorder.cs`.
- OpenTelemetry .NET `open-telemetry/opentelemetry-dotnet@2d50a2b69a93c69435e920245d9663111ff3c542`:
  `src/OpenTelemetry/BatchExportProcessor.cs`,
  `src/OpenTelemetry/BatchExportProcessorOptions.cs`, and
  `src/OpenTelemetry/Internal/CircularBuffer.cs`.
- Datadog .NET tracer `DataDog/dd-trace-dotnet@a2346ba4fa5455164534a8427e510acd877f00a9`:
  `tracer/src/Datadog.Trace/Agent/AgentWriter.cs`,
  `tracer/src/Datadog.Trace/Agent/SpanBuffer.cs`, and
  `tracer/src/Datadog.Trace/Configuration/TracerSettings.cs`.
- Sentry .NET OpenTelemetry `3d6f266e80c956a2fee2e8aaeeaad31dc438110d`:
  `src/Sentry.OpenTelemetry/SentrySpanProcessor.cs` and
  `src/Sentry.OpenTelemetry.Exporter/ActivityExtensions.cs`.
- Datadog .NET OpenTelemetry bridge `bb5a5079a8a1950970fa82282ba3a2ccc06c943d`:
  `tracer/src/Datadog.Trace/Activity/Handlers/ActivityHandlerCommon.cs` and
  `tracer/src/Datadog.Trace/Activity/OtlpHelpers.cs`.

## Pattern

Competitors make high-load telemetry delivery explicit with bounded queues,
worker/exporter lifecycle behavior, dropped-event accounting, and flush or
shutdown semantics. LogBrew intentionally remains lighter for .NET: the app
still owns the OpenTelemetry provider/exporter lifecycle, while LogBrew proves
bounded local buffering, visible drops, retry, flush, and shutdown behavior from
the installed package.

## LogBrew Update

- Added `scripts/real_user_dotnet_opentelemetry_high_load_smoke.sh`.
- The smoke packs local `LogBrew` and `LogBrew.OpenTelemetry` NuGets, installs
  them into a temporary `net10.0` console app, removes and reinstalls the OTel
  package to prove package-manager behavior, and emits 1,500 OTel Activities
  through `TracerProviderBuilder.AddLogBrew(...)`.
- It proves the default 1,000-event LogBrew queue, 500 visible span drops,
  advisory drop callback metadata, local fake-intake 503-to-202 retry, flush
  clearing, and installed exporter failure after client shutdown.
- It verifies safe release/service/environment/OTel exception metadata while
  omitting ingest identifiers, auth markers, full URLs, query strings,
  fragments, payload/message strings, service instance IDs, exception messages,
  and stacks.

## Verification

- RED: `bash scripts/real_user_dotnet_opentelemetry_high_load_smoke.sh` failed
  because the installed-artifact OTel high-load smoke did not exist.
- GREEN: `bash scripts/real_user_dotnet_opentelemetry_high_load_smoke.sh`
  passed and printed `.NET OpenTelemetry high-load installed-artifact smoke passed`.

## Remaining Gaps

Sentry, Datadog, and OpenTelemetry still lead on background workers, timed
batching, exported client-report/drop metrics, adaptive rate-limit handling,
hosted trace-to-error navigation, baggage/tracestate, and automatic framework
instrumentation. LogBrew remains stricter by default by avoiding hidden provider
ownership, payload/header/full-URL capture, exception messages, and stack
capture in this integration.
