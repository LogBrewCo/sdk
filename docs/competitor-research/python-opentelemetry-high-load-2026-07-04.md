# Python OpenTelemetry High-Load Proof - 2026-07-04

## Scope

This pass checks whether LogBrew's Python OpenTelemetry exporter behaves like a real installed SDK under high span volume, transport failure, retry, bounded queue pressure, redaction, flush, and shutdown. The user-facing goal is not raw feature count; it is predictable first-debug behavior when an app produces more spans than the local queue can hold while intake is temporarily unavailable.

## Public Source Read

- Sentry Python `getsentry/sentry-python@1bd120f41780bfd5fd4d4b7c65aae395e425adab`.
- Files read: `sentry_sdk/_batcher.py` (`Batcher`, `add`, `_flush_loop`, `flush`, `MAX_BEFORE_FLUSH`, `MAX_BEFORE_DROP`), `sentry_sdk/transport.py` (`HttpTransportCore`, `record_lost_event`, `_update_rate_limits`, `_handle_response`, `_fetch_pending_client_report`), and `sentry_sdk/traces.py` (`Span.end`, `_end`).
- Pattern: Sentry is stronger for background batching, rate-limit handling, client reports, and lost-event accounting. Tradeoff: more hidden runtime ownership and broader delivery machinery.

- OpenTelemetry Python `open-telemetry/opentelemetry-python@322c602c87f38933986a757db918591ade441bd3`.
- Files read: `opentelemetry-sdk/src/opentelemetry/sdk/trace/export/__init__.py` (`SpanExporter`, `SimpleSpanProcessor.on_end`, `BatchSpanProcessor`, `on_end`, `shutdown`, `force_flush`) and `opentelemetry-sdk/src/opentelemetry/sdk/_shared_internal/__init__.py` (`BatchProcessor`, `emit`, `worker`, `force_flush`, `shutdown`).
- Pattern: OpenTelemetry's batch processor owns a bounded queue and worker lifecycle, drops when full, and exposes force-flush/shutdown semantics that framework users expect.

- Datadog Python `DataDog/dd-trace-py@c12bb9dfb723bb96a662b7b90f36c805c4af43fb`.
- Files read: `ddtrace/internal/writer/writer.py` (`HTTPWriter`, `_set_drop_rate`, `_write_with_client`, `flush_queue`, `_flush_single_payload`).
- Pattern: Datadog is stronger for buffered trace writes, drop-rate metrics, backoff, retries, and writer lifecycle. Tradeoff: heavier vendor writer behavior and more background state.

- PostHog Python `PostHog/posthog-python@6f75afe77ff059e4f3b0b6b7b30912612a7b5ff1`.
- Files read: `posthog/ai/otel/processor.py` (`PostHogSpanProcessor`), `posthog/ai/otel/exporter.py` (`PostHogTraceExporter.export`, `force_flush`, `shutdown`), and `posthog/consumer.py` (`Consumer.next`, `request`, retry/drop flow).
- Pattern: PostHog has a focused OTel processor/exporter path for AI spans and a background consumer with flush/retry behavior, but it is narrower for general observability.

## LogBrew Update

- Added `scripts/real_user_python_opentelemetry_high_load_smoke.sh`.
- The smoke builds the Python wheel, installs it in a temporary app, installs current `opentelemetry-sdk`, registers `create_logbrew_open_telemetry_span_exporter(...)` behind a real `BatchSpanProcessor`, emits 1,500 OTel spans under one W3C trace, and keeps the LogBrew queue capped at 1,000 events.
- It proves 500 local drops are visible through `dropped_events()`, then flushes 1,000 queued spans to a local `127.0.0.1` fake intake that returns HTTP 503 then 202.
- It verifies retry count, flush completion, auth/header behavior, shutdown/export failure after close, release/environment/service metadata, trace/span correlation, and redaction of ingest keys, unsafe identifiers, DB statements, full URLs, query markers, exception messages, and stacks.

## Tradeoffs

LogBrew is now stronger for a lightweight, reproducible installed-artifact proof of privacy-bounded OTel high-volume behavior. It gives users a clear answer for queue pressure, retry, flush, and shutdown without taking over their OpenTelemetry provider, worker, or exporter pipeline.

Sentry, Datadog, and OpenTelemetry remain stronger for background workers, rate-limit/client-report accounting, adaptive batching, drop metrics export, full semantic-convention coverage, and hosted trace debugging. LogBrew should keep narrowing those gaps with opt-in, source-backed helpers and local fake-intake proof before adding heavier runtime ownership.

## Verification

- RED: `python3 -m unittest tests.test_python_high_load_smoke.PythonHighLoadSmokeTests.test_opentelemetry_high_load_smoke_exercises_installed_artifact_flow` failed because the high-load OTel installed-artifact smoke did not exist.
- GREEN: the same focused test now asserts the smoke owns its build venv, installs current OTel, uses `BatchSpanProcessor`, exercises 1,500 spans, enforces a 1,000-event queue, proves drops, uses localhost fake intake, checks retry attempts, and verifies shutdown behavior.
- GREEN: `bash scripts/real_user_python_opentelemetry_high_load_smoke.sh` builds and installs the wheel in a temporary app, runs the real OTel high-load flow, and prints `Python OpenTelemetry high-load installed-artifact smoke passed`.

## Remaining Gap

The next highest-impact Python trace work should target richer automatic framework/outbound spans and stronger hosted trace navigation. Heavy background exporter ownership should remain opt-in and must keep sensitive values, payloads, raw URLs, baggage, tracestate, and stack data out of default SDK payloads.
