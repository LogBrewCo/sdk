# Java High-Load Backpressure - 2026-06-29

## Goal

Improve Java production behavior under heavy logging load. A real user should not discover that the SDK can grow an unbounded in-memory queue, block app logging, or hide dropped telemetry until production pressure.

## Sources Read

- Sentry Java SDK: `https://github.com/getsentry/sentry-java.git` at `d8b6ce11cabd05be9a3f03a1d20fe247956d091d`.
- Sentry files/functions: `sentry/src/main/java/io/sentry/SentryOptions.java` (`maxQueueSize`, `setMaxQueueSize`, `setOnDiscard`), `sentry/src/main/java/io/sentry/transport/QueuedThreadPoolExecutor.java` (`isSchedulingAllowed`, `submit`, `afterExecute`), and `sentry/src/main/java/io/sentry/transport/AsyncHttpTransport.java` (`captureEnvelope`, queue-overflow discard recording, `flush`).
- OpenTelemetry Java: `https://github.com/open-telemetry/opentelemetry-java.git` at `9b57914fc5fdfc5213cc2b4c980112cc987d3276`.
- OpenTelemetry files/functions: `sdk/trace/src/main/java/io/opentelemetry/sdk/trace/export/BatchSpanProcessor.java` (`Worker.addSpan`, queue offer/drop accounting, `flush`) and `sdk/trace/src/main/java/io/opentelemetry/sdk/trace/export/BatchSpanProcessorBuilder.java` (`DEFAULT_MAX_QUEUE_SIZE`, `setMaxQueueSize`).
- Datadog Java tracer: `https://github.com/DataDog/dd-trace-java.git` at `ffb48aeb95a05df3d20c27afe3a7b1c5d0ba59c4`.
- Datadog files/functions: `dd-trace-core/src/main/java/datadog/trace/common/writer/DDAgentWriter.java` (`BUFFER_SIZE`, `traceBufferSize`) and `dd-trace-core/src/main/java/datadog/trace/common/writer/TraceProcessingWorker.java` (`publish`, primary/secondary queues, remaining capacity).

## Competitor Pattern

- Sentry keeps an async transport queue with configurable capacity. When scheduling is not allowed, the envelope is not queued and the client records queue-overflow loss data.
- OpenTelemetry batch processing uses a bounded queue, drops when `offer` fails, and records dropped-span counters instead of letting app code block indefinitely.
- Datadog publishes traces into bounded worker queues and treats a full buffer as backpressure rather than unbounded app-thread growth.

## LogBrew Implementation

- `LogBrewClient` now defaults to a bounded in-memory queue of 1,000 events.
- Apps can call `LogBrewClient.create(apiKey, sdkName, sdkVersion, maxRetries, maxQueueSize, drop -> ...)` to tune the cap and observe redacted advisory drop summaries.
- When the queue is full, LogBrew drops the newest event before it enters the queue, increments `droppedEvents()`, and reports `EventDrop(eventId, eventType, "queue_overflow")` to the optional callback.
- Drop callbacks are advisory. Callback exceptions are swallowed so app logging is not interrupted.
- Successful flush behavior is unchanged: queued events are cleared only after a 2xx transport response, and retryable 5xx/network failures preserve the queue until retry or failure.

## Tradeoffs

- Better than the previous LogBrew Java client because memory is bounded by default and high-volume loss is visible to app code.
- Simpler and safer than agent-owned async transports because the SDK does not create background worker threads, own exporters, or hide delivery lifecycle from the app.
- Worse than Sentry, Datadog, and OpenTelemetry for advanced loss accounting, background draining, batching intervals, export metrics, and automatic integration with their broader tracing pipelines.

## Verification

- Red test first: `bash scripts/check_java_package.sh` failed on missing `LogBrewClient.EventDrop`, missing `droppedEvents()`, and missing queue-size/drop-callback `create(...)` overload.
- Green package gate: `bash scripts/check_java_package.sh` passed with 32 Java client tests plus trace, servlet, span event, OpenTelemetry, operation tracing, support-ticket draft, Maven metadata, javadocs, source jar, binary jar, and packaged example checks.
- Installed-artifact high-load smoke: `bash scripts/real_user_java_high_load_smoke.sh` packs the local SDK jar, compiles a temporary Java app, queues 1,500 logs, proves 1,000 flushed / 500 dropped, verifies drop callback isolation, sends to a local `127.0.0.1` fake intake that returns 503 then 202, verifies two delivery attempts, and proves shutdown rejects later writes.
- Additional focused gates passed: `bash scripts/check_java_static.sh`, `bash scripts/real_user_java_smoke.sh`, `bash scripts/real_user_spring_boot_smoke.sh`, temporary Maven Central bundle build, ShellCheck warning-level checks, and public SDK verifier unit tests.

## Remaining Gaps

- Add richer exported drop diagnostics only if a public ingest or diagnostics contract exists; do not open support tickets or call hosted routes silently.
- Java still needs automatic Spring/Servlet/JDBC/cache/messaging spans, async servlet handling, baggage/tracestate decisions, and richer trace context before it beats Sentry/Datadog on the full rich-trace experience.
