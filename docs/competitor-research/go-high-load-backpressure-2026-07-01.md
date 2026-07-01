# Go High-Load Backpressure Research - 2026-07-01

## Scope

Reduce the Go SDK production-safety gap for services that emit many logs, spans, and metrics during bursts. A real developer should be able to predict what happens when local telemetry is produced faster than it can be flushed, verify retry and shutdown behavior from an installed module, and avoid unbounded memory growth.

## Competitor Source Evidence

- Sentry Go: `getsentry/sentry-go@ea6e493b6bd7bd5810b996c8245211982818114e`.
  - Read `batch_processor.go` `newBatchProcessor`, `Send`, `Flush`, `Shutdown`, and `run`.
  - Read `transport.go` `NewHTTPTransport`, `HTTPTransport.Configure`, `SendEventWithContext`, `flushInternal`, and `worker`.
  - Pattern: bounded channels, non-blocking send/drop on full transport buffer, client report recorder for queue overflow, explicit flush and close paths, background worker.
- Datadog Go tracer: `DataDog/dd-trace-go@061ffc340dae85a53729895d0f9b22d906940ca9`.
  - Read `ddtrace/tracer/writer.go` `agentTraceWriter.add`, `flush`, `stop`, and `logTraceWriter.add`.
  - Read `ddtrace/tracer/payload.go` `payloadStats`, `payload`, and `safePayload`.
  - Pattern: size-triggered payload flush, bounded concurrent sends, retry loop, stats counters for queued/flushed/dropped traces, payload reset/clear for memory release.
- OpenTelemetry Go: `open-telemetry/opentelemetry-go@77954066ebef2c7bcbc28e05ea93ecfb57fad86a`.
  - Read `sdk/trace/batch_span_processor.go` `BatchSpanProcessorOptions`, `NewBatchSpanProcessor`, `OnEnd`, `ForceFlush`, `Shutdown`, `enqueueDrop`, and `enqueueBlockOnQueueFull`.
  - Read `sdk/trace/evictedqueue.go` `evictedQueue.add`.
  - Pattern: configurable max queue size, default drop-on-full with optional blocking mode, explicit dropped counter, force-flush/shutdown drains, span-event/link eviction limits.
- PostHog Go: `PostHog/posthog-go@2b6e1878570f91ba7a155720923bbf3b98cc9216`.
  - Read `posthog.go` `NewWithConfig`, `EnqueueWithContext`, `sendBatch`, `CloseWithContext`, `awaitDrain`, `send`, and `loop`.
  - Read `message.go` `prepareForSend` and batch size constants.
  - Pattern: bounded message and batch channels, queue sized from `MaxEnqueuedRequests`, submit timeout for smoothing bursts, graceful close drain, callback failures for dropped batches, per-message byte limits.

## LogBrew Design

LogBrew Go now uses a dependency-free bounded in-memory queue in the core client:

- `Config.MaxQueueSize` defaults to 1,000 events and rejects negative values.
- New events are dropped on overflow, preserving already-buffered release/environment/request context.
- `DroppedEvents()` returns a cumulative local drop counter that does not reset on flush.
- `OnEventDropped` emits a panic-safe advisory `EventDrop` with only `eventId`, `eventType`, `reason=queue_overflow`, and cumulative `droppedEvents`.
- `Flush` and `Shutdown` retain existing retry and accepted-event behavior.

This follows the competitor production-safety pattern while staying lighter than background worker/exporter designs. It avoids goroutine ownership, blocking app logging, payload/header capture, transport internals, API keys, event attributes, exception stacks, automatic ticket creation, and unbounded local memory growth.

## Honest Comparison

- Better than the previous LogBrew Go SDK and easier to reason about than hidden background queues: backpressure is explicit, dependency-free, locally inspectable, and verified from an installed module with a fake intake.
- Better than default Sentry/PostHog behavior for teams that want synchronous local queue visibility without a background worker or endpoint-specific client.
- Worse than Sentry, Datadog, OpenTelemetry, and PostHog for teams that want asynchronous batching workers, automatic periodic export, built-in self-metrics, blocking queue modes, byte-size batching, retry-after scheduling, or exporter/provider interop.

## Verification

- RED: `go test ./...` failed because `EventDrop`, `Config.MaxQueueSize`, `Config.OnEventDropped`, and `Client.DroppedEvents()` did not exist.
- GREEN: `cd go/logbrew && go test ./...` passes with bounded queue/drop/advisory regression coverage.
- Installed-artifact proof: `bash scripts/real_user_go_high_load_smoke.sh` builds a local Go module proxy, installs/removes/reinstalls `github.com/LogBrewCo/sdk/go/logbrew@v0.1.0`, emits 1,500 logs plus release/environment/action/request span into a 1,000-event queue, proves 504 new-event drops, panic-safe drop advisories, local fake-intake 503-to-202 retry, flush clearing accepted events, shutdown behavior, and no API key/raw unsafe metadata/dropped event leakage in the flushed body.

## Remaining Gaps

- Async background batching for Go services that prefer non-blocking transport ownership.
- Byte-size batch limits and event-size rejection before serialization.
- Built-in queue/drop/flush metrics exporters.
- Context-aware flush deadlines and retry-after handling.
- OpenTelemetry exporter/processor interop.
