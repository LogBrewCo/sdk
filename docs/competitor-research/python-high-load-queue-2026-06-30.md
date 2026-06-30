# Python High-Load Queue Pressure - 2026-06-30

## Competitor Source Read

- Sentry Python `getsentry/sentry-python@291739faa48285f2634b5c0935e8f45bf365164e`: read `sentry_sdk/worker.py` `BackgroundWorker.__init__`, `submit`, and `flush`; `sentry_sdk/transport.py` `BaseHttpTransport._create_worker`, `capture_envelope`, `_handle_response`, and lost-event accounting; `sentry_sdk/consts.py` `DEFAULT_QUEUE_SIZE` and `transport_queue_size`.
- Datadog Python `DataDog/dd-trace-py@732ba08e2dde4be1d8f3984a9baa80395e374ab2`: read `ddtrace/internal/writer/writer.py` `HTTPWriter.__init__`, `_write_with_client`, `flush_queue`, `_flush_single_payload`, and `on_shutdown`; read `ddtrace/internal/writer/writer_client.py` encoder buffer setup.
- OpenTelemetry Python `open-telemetry/opentelemetry-python@50912be81bbc715ee040c9d8eb2f70b3d662ae26`: read `opentelemetry-sdk/src/opentelemetry/sdk/_shared_internal/__init__.py` batch processor `__init__`, `emit`, `worker`, `_export`, `shutdown`, and `force_flush`.
- PostHog Python `PostHog/posthog-python@e20e22937b6ffebd073931d5e359b68efd6718e5`: read `posthog/client.py` `Client.__init__`, `_enqueue`, `flush`, `join`, and `shutdown`; read `posthog/consumer.py` `Consumer.next`, `request`, and `_send`.

## Pattern

Mature Python SDKs do not leave high-volume telemetry as an unbounded list. Sentry uses a bounded background worker queue, rejects submissions when full, and records queue-overflow loss. Datadog bounds trace buffers by encoded size and records buffer/http drop metrics. OpenTelemetry uses a bounded deque in batch processors and records item drops when the queue is full. PostHog uses a bounded `Queue`, returns no event id when it is full, and provides flush/shutdown paths.

The tradeoff is mostly complexity. Competitors usually own background workers, batching, fork handling, and exporter lifecycle. That gives better automatic delivery behavior, but it also adds global runtime state and more hidden concurrency. LogBrew's Python SDK is still intentionally lighter: no background worker, no exporter ownership, no global patching.

## LogBrew Update

`LogBrewClient.create(...)` now accepts `max_queue_size` with a default of `10_000`. When the queue is full, LogBrew drops the new event, preserves the existing queued context, and increments `dropped_events()`. `pending_events()` still returns current queue depth. This keeps memory bounded during transport outages and makes queue pressure visible without deriving usage, quota, or billing locally.

Drop-new behavior was chosen over dropping the oldest event because LogBrew examples usually queue release, environment, span, or action context before high-volume logs. Preserving already-buffered context gives better debugging payloads when users eventually flush.

## Verification

- RED: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_sdk.py -k bounded_queue` failed because `LogBrewClient.create(...)` did not accept `max_queue_size`.
- RED: `python3 -m unittest tests.test_check_public_sdks.CheckPublicSdksJsonContractTests.test_public_verifier_runs_python_celery_smoke` failed because the public verifier did not run a Python high-load installed-artifact smoke.
- GREEN: focused bounded-queue unit tests now prove capacity validation, drop-new behavior, context preservation, and dropped-event counts.
- GREEN: `bash scripts/real_user_python_high_load_smoke.sh` builds the wheel, installs/uninstalls/reinstalls it in a temporary venv, emits 1,500 standard-logging records with release/environment/action/span context, proves 1,000 flushed events plus 504 local drops, retries a local fake intake from HTTP 503 to 202, verifies shutdown, and checks the flushed body does not contain the fake ingest key, authorization string, unsafe payload marker, or query text.

## Remaining Gap

LogBrew is safer and simpler for explicit app-owned Python logging with local installed-artifact proof. It is still weaker than Sentry, Datadog, and OpenTelemetry for background worker delivery, timed batch export, fork-aware queue reset, queue-size metrics exporters, adaptive rate-limit handling, and full automatic framework instrumentation.
