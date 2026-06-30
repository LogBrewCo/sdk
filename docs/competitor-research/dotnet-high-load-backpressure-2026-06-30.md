# .NET High-Load Backpressure - 2026-06-30

## Goal

Improve .NET production behavior under heavy logging load. From a real user point of view, a logging SDK should not grow an unbounded in-memory queue, hide local telemetry loss, or block normal `ILogger` usage during a transport outage.

## Competitor Source Read

- Sentry .NET `getsentry/sentry-dotnet@951d98f789ec6794a1bbd82149d900f06fde0cfa`: read `src/Sentry/Internal/BackgroundWorker.cs` (`EnqueueEnvelope`, `FlushAsync`, `DoFlushAsync`, `Dispose`), `src/Sentry/SentryOptions.cs` (`MaxQueueItems`, `ShutdownTimeout`, `FlushTimeout`), and `src/Sentry/Internal/ClientReportRecorder.cs` lost-event accounting.
- OpenTelemetry .NET `open-telemetry/opentelemetry-dotnet@2d50a2b69a93c69435e920245d9663111ff3c542`: read `src/OpenTelemetry/BatchExportProcessor.cs` (`DefaultMaxQueueSize`, `TryExport`, `OnForceFlush`, `OnShutdown`, dropped count), `src/OpenTelemetry/BatchExportProcessorOptions.cs`, and `src/OpenTelemetry/Internal/CircularBuffer.cs` (`TryAdd` full-buffer behavior).
- Datadog .NET tracer `DataDog/dd-trace-dotnet@a2346ba4fa5455164534a8427e510acd877f00a9`: read `tracer/src/Datadog.Trace/Agent/AgentWriter.cs` (`WriteTrace`, `FlushAndCloseAsync`, dropped trace/span counters), `tracer/src/Datadog.Trace/Agent/SpanBuffer.cs` (`TryWrite`, `Full`, `Overflow`), and `tracer/src/Datadog.Trace/Configuration/TracerSettings.cs` trace buffer sizing.

## Pattern

Mature .NET telemetry SDKs bound queues or buffers and make flush/shutdown behavior explicit. Sentry uses a background worker with `MaxQueueItems` and client-report loss accounting. OpenTelemetry uses bounded batch-export queues and records dropped items when the circular buffer is full. Datadog bounds trace buffers and tracks dropped traces/spans when writer buffers overflow.

The tradeoff is complexity. Competitors own worker threads, batch intervals, exporters, and more lifecycle state. LogBrew stays lighter in the core .NET package: no background worker, no exporter ownership, and no hidden delivery thread.

## LogBrew Update

- `LogBrewClient.Create(...)` now accepts `maxQueueSize` with a default of 1,000.
- When the queue is full, LogBrew drops the new event, preserves already-buffered release/environment/trace context, increments `DroppedEvents()`, and calls optional `onEventDropped` with `DroppedEvent(eventId, eventType, "queue_overflow", droppedEvents)`.
- Drop callbacks are advisory and callback exceptions do not interrupt application logging.
- Flush behavior remains predictable: queued events clear only after a 2xx transport response; auth failures, non-2xx failures, and retry-budget exhaustion preserve the queue. `Shutdown(transport)` uses the same flush rules and rejects later writes.

## Verification

- RED package test: `dotnet run --project dotnet/logbrew-dotnet/tests/LogBrew.Tests/LogBrew.Tests.csproj --configuration Release` failed before implementation because `DroppedEvent`, `maxQueueSize`, `onEventDropped`, and `DroppedEvents()` did not exist.
- GREEN package test: the same command passed with 66 .NET client tests, including bounded-queue behavior, callback failure isolation, default heavy-load queue pressure, and flush/shutdown behavior.
- RED public verifier test: `python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_dotnet_high_load_smoke` failed before the public verifier listed a .NET high-load installed-artifact smoke.
- GREEN installed-artifact smoke: `bash scripts/real_user_dotnet_high_load_smoke.sh` packs the local NuGet package, installs/removes/reinstalls it in a temporary `net10.0` console app, queues release, environment, span, action, and 1,500 `ILogger` logs, proves 1,000 queued events plus 504 local drops, verifies drop callback isolation, sends to a local `127.0.0.1` fake intake that returns 503 then 202, verifies retry/flush/shutdown behavior, and checks the payload omits the fake ingest key, authorization marker, unsafe metadata marker, query text, and fragments.

## Remaining Gap

LogBrew .NET is now safer for explicit app-owned high-volume logging with local installed-package proof. It is still weaker than Sentry, Datadog, and OpenTelemetry for background draining, timed batch export, exported client-report/drop metrics, adaptive rate-limit handling, richer low-noise grouping, full OpenTelemetry exporter/processor interop, baggage/tracestate, and broader automatic framework instrumentation.
