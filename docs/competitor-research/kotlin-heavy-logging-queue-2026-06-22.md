# Kotlin Heavy Logging Queue - Competitor Research - 2026-06-22

## Goal

Make Kotlin/JVM logging safer under real app concurrency. Android and server apps can log from request, callback, dispatcher, coroutine, and background-worker threads, so the core SDK queue must not lose events before flush.

## Sources Read

- Sentry Java SDK: `getsentry/sentry-java@57d359a2dee07eb48c5b2f6fad04d540af7fe407`.
- Sentry files/functions: `sentry/src/main/java/io/sentry/transport/QueuedThreadPoolExecutor.java` (`submit`, `afterExecute`, `waitTillIdle`, `isSchedulingAllowed`) and `sentry/src/main/java/io/sentry/transport/AsyncHttpTransport.java` (`send`, `flush`, queue-overflow handling).
- Datadog Android SDK: `DataDog/dd-sdk-android@0d7a2594c31f3a860fa69edc02e72b9afacbcd9f`.
- Datadog files/functions: `dd-sdk-android-core/src/main/kotlin/com/datadog/android/core/internal/thread/BackPressuredBlockingQueue.kt` (`offer`, `put`, `addWithBackPressure`) and `ObservableLinkedBlockingQueue.kt` (`LinkedBlockingQueue` extension and queue dump helpers).
- OpenTelemetry Java SDK: `open-telemetry/opentelemetry-java@824334c552cd800d6b89512f20225b2025fd5d16`.
- OpenTelemetry file/functions: `sdk/trace/src/main/java/io/opentelemetry/sdk/trace/export/BatchSpanProcessor.java` (`Worker.addSpan`, queue accounting, `forceFlush`, `shutdown`, `exportCurrentBatch`).

## Competitor Pattern

- Sentry sends envelopes through a bounded executor queue, tracks unfinished work, records queue-overflow loss, and flushes by waiting for idle work.
- Datadog Android uses concurrent blocking queues and explicit backpressure strategies instead of unsynchronized mutable lists.
- OpenTelemetry Java uses a queue with atomic size/drop accounting and a worker signal path so producer threads do not mutate exporter batches unsafely.

## LogBrew Implementation

- Added a high-load Kotlin test with 16 JVM threads and 16,000 real `LogBrewClient.log(...)` calls.
- The red run proved the previous unsynchronized `MutableList` queue lost events under load: `16000` expected, `12311` queued.
- Added one `stateLock` in `LogBrewClient` to serialize queue reads/writes, `closed` checks, preview serialization, flush, and shutdown.
- Kept the fix intentionally smaller than competitor worker/exporter stacks: no background thread, no hidden backpressure policy, no disk cache, no automatic dropping, and no new runtime dependency.

## Tradeoffs

- Better for LogBrew's current explicit SDK shape: app code can log concurrently without losing queued events, while the default package stays dependency-light and easy to reason about.
- Worse than Sentry, Datadog, and OpenTelemetry for very large production pipelines that need bounded queues, async workers, persisted envelopes, queue metrics, drop reporting, and exporter backpressure controls.
- Next safe Kotlin reliability step is a local fake-intake high-volume flush/retry/shutdown smoke from an installed artifact, then optional bounded queue/backpressure only if real user evidence shows unbounded memory risk.

## Verification

- Red: `bash scripts/check_kotlin_package.sh` failed in `concurrent_logging_preserves_queue_and_flushes`, with `16000` expected queued events but `12311` found.
- Green: `bash scripts/check_kotlin_package.sh` passed with 30 Kotlin core tests, 5 OkHttp tests, source/binary jar checks, README checks, and Maven metadata checks.
- Installed proof: `bash scripts/real_user_kotlin_smoke.sh` passed from temporary Gradle/package-manager consumers.
