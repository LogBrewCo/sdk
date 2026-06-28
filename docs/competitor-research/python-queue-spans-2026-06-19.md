# Python Queue Span Comparison - 2026-06-19

## Scope

Reduce LogBrew's Python server-side queue/task span gap without adding a hard Celery, RQ, Dramatiq, Redis, broker, Datadog, Sentry, or OpenTelemetry dependency to `logbrew-sdk`.

## Competitor Sources Read

- Sentry Python `getsentry/sentry-python@907dd48f1a118d75ddb2f2178e879bdc5fa71283`
- `sentry_sdk/integrations/rq.py`: `RqIntegration.setup_once`, `sentry_patched_perform_job`, `sentry_patched_enqueue_job`, `_make_event_processor`.
- `sentry_sdk/integrations/arq.py`: `patch_enqueue_job`, `_sentry_enqueue_job`, `patch_run_job`, `_sentry_run_job`.
- `sentry_sdk/integrations/dramatiq.py`: `before_enqueue`, `before_process_message`, `after_process_message`.
- OpenTelemetry Python Contrib `open-telemetry/opentelemetry-python-contrib@a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb`
- `instrumentation/opentelemetry-instrumentation-celery/src/opentelemetry/instrumentation/celery/__init__.py`: `CeleryInstrumentor._instrument`, `_trace_prerun`, `_trace_postrun`, `_trace_before_publish`, `_trace_after_publish`, `_trace_failure`, `_trace_retry`.
- `instrumentation/opentelemetry-instrumentation-celery/src/opentelemetry/instrumentation/celery/utils.py`: `set_attributes_from_context`, `attach_context`, `detach_context`, `retrieve_context`, `retrieve_task`, `retrieve_task_from_sender`.
- Datadog dd-trace-py `DataDog/dd-trace-py@90d3cc64f59ff10213396b37bf83c49a260afab8`
- `ddtrace/contrib/internal/celery/signals.py`: `trace_prerun`, `trace_postrun`, `trace_before_publish`, `_inject_distributed_headers`, `trace_after_publish`, `trace_failure`.
- `ddtrace/contrib/internal/rq/patch.py`: `traced_queue_enqueue_job`, `traced_queue_fetch_job`, `traced_perform_job`, `traced_job_perform`, `patch`.

## Pattern Observed

- Sentry and Datadog win on automatic adoption by patching queue frameworks and inserting propagation metadata into job/message storage.
- OpenTelemetry uses Celery signals to create producer/consumer spans and stores span context on task-local structures so later signals can finish or annotate spans.
- Mature queue integrations distinguish publish/process roles, store temporary span state across lifecycle callbacks, add queue/task/message identifiers, and propagate trace context through framework metadata.
- The tradeoff is weight and privacy surface: automatic integrations can capture job IDs, task IDs, args/kwargs or descriptions depending on settings, broker/host data, baggage/tracestate, and framework-internal metadata.

## Targeted Competitor Smoke

Command summary:

```bash
python3 -m venv /tmp/logbrew-python-queue-competitor-smoke-20260619/venv
pip install sentry-sdk rq fakeredis opentelemetry-sdk opentelemetry-instrumentation-celery celery ddtrace
python /tmp/logbrew-python-queue-competitor-smoke-20260619/smoke.py
```

Observed local output:

```json
{
  "datadog_rq_job_func": "math.sqrt",
  "datadog_rq_job_meta_keys": [],
  "datadog_rq_patched": true,
  "opentelemetry_celery_span_count": 1,
  "opentelemetry_celery_span_kinds": ["CONSUMER"],
  "opentelemetry_celery_span_names": ["run/queue_smoke.add"],
  "opentelemetry_celery_value": 5,
  "sentry_rq_has_trace_headers": true,
  "sentry_rq_meta_keys": ["_sentry_trace_headers"],
  "sentry_rq_trace_header_keys": ["baggage", "sentry-trace"]
}
```

Datadog attempted its default local-agent delivery to `localhost:8126`; no hosted competitor intake was used. This smoke proves local patch/import behavior and span/header creation, not hosted backend ingestion.

## LogBrew Design

LogBrew adds explicit `queue_operation_with_logbrew_span(...)` and `async_queue_operation_with_logbrew_span(...)`:

- Caller owns the queue/broker client and operation callable.
- LogBrew creates one child `LogBrewTraceContext` from the active or supplied trace and activates it while the callable runs.
- LogBrew queues one span with `source=queue`, `queueSystem`, `queueOperation`, optional `queueOperationKind`, `queueName`, `taskName`, `messageCount`, `attempt`, sampled state, duration, and exception type.
- The original operation result or exception is preserved.
- Telemetry capture failures report through `on_capture_error` without replacing the queue result.
- Message-like caller metadata keys are dropped before capture.

## What LogBrew Intentionally Avoids

- No Celery/RQ/Dramatiq monkeypatching in core.
- No broker metadata writes, hidden support tickets, backend setup calls, or usage/quota inference.
- No job args/kwargs, message bodies, headers, cookies, broker URLs, queue payloads, baggage, tracestate, stack traces, or exception messages.
- No hard queue framework dependency.

## Remaining Gap

Competitors still lead for automatic queue framework adoption. The next stronger LogBrew step should be optional framework-owned queue integration packages or source snippets, starting with Celery/RQ if user demand justifies the extra dependency and patching surface.

## RQ Convenience Follow-Up

Fresh source refresh on 2026-06-19:

- Sentry Python `getsentry/sentry-python@883e585baf564ff650e2292b70262aef852adec0`
- `sentry_sdk/integrations/rq.py`: `RqIntegration.setup_once`, `sentry_patched_perform_job`, `sentry_patched_enqueue_job`, `_make_event_processor`, `_capture_exception`.
- Datadog dd-trace-py `DataDog/dd-trace-py@187cfc3700200ec8f33d6f610280924ef17e1696`
- `ddtrace/contrib/internal/rq/patch.py`: `traced_queue_enqueue_job`, `traced_queue_fetch_job`, `traced_perform_job`, `traced_job_perform`, `patch`, `unpatch`.
- OpenTelemetry Python Contrib `open-telemetry/opentelemetry-python-contrib@a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb`
- `instrumentation/opentelemetry-instrumentation-celery/src/opentelemetry/instrumentation/celery/__init__.py`: `CeleryInstrumentor._instrument`, `_trace_before_publish`, `_trace_prerun`, `_trace_postrun`, `_trace_failure`, `_trace_retry`.

Pattern update:

- Sentry RQ patches `Queue.enqueue_job` and worker `perform_job`, stores `_sentry_trace_headers` in `job.meta`, and can enrich error events with RQ job data.
- Datadog RQ wraps `Queue.enqueue_job`, `Queue.fetch_job`, `Worker.perform_job`, and `Job.perform`, adds producer/consumer span tags such as queue name, job ID, and function name, and unpatches reversibly.
- OpenTelemetry Celery still validates the signal-based producer/consumer model with explicit context injection/extraction and task-local span lifecycle state.

LogBrew follow-up:

- Added dependency-free `rq_operation_with_logbrew_span(...)` in core for app-owned RQ enqueue/perform calls.
- The helper duck-types only string-like `job.func_name` and `job.origin`, derives `taskName`, `queueName`, `queueOperation`, and a single-message count, and delegates to the existing queue span capture path.
- It preserves the caller's operation result/error, activates a child LogBrew trace during the operation, and keeps capture failures isolated through `on_capture_error`.
- It does not import RQ, patch `Queue` or `Worker`, write `job.meta`, capture job IDs, args, kwargs, descriptions, headers, broker URLs, baggage, tracestate, exception messages, or stack traces.

Verifier evidence:

- Focused TDD red failed on missing `rq_operation_with_logbrew_span` export.
- `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_rq_client.py python/logbrew_py/tests/test_queue_client.py` passed.
- `PYTHONPATH=python/logbrew_py/src python3 scripts/python_queue_span_smoke.py` proved four queue events, RQ task/queue metadata, and no RQ args/kwargs/header leakage.
- `PYTHONPATH=python/logbrew_py/src python3 -m unittest discover -s python/logbrew_py/tests -p 'test_*.py'` ran 62 tests.
- `bash scripts/check_python_static.sh` passed Ruff and mypy over 42 source files.
- `bash scripts/real_user_python_smoke.sh` passed wheel, wheel reinstall, freeze/direct reinstall, sdist, and sdist reinstall installed-artifact checks with `_rq_client.py` included.

Remaining gap after this follow-up:

- LogBrew is now better for privacy-bounded explicit RQ adoption, but Sentry and Datadog remain ahead for teams that want hidden RQ patching and broker metadata propagation. That should stay out of core; the next step would be a separate opt-in `logbrew-rq` integration package only if the extra dependency and patching surface are justified.

## Celery Convenience Follow-Up

Fresh source refresh reused from the RQ follow-up:

- Sentry Python `getsentry/sentry-python@883e585baf564ff650e2292b70262aef852adec0`
- `sentry_sdk/integrations/celery/__init__.py`: `CeleryIntegration.setup_once`, `_patch_task_apply_async`, `_patch_celery_send_task`, `_patch_producer_publish`, `_update_celery_task_headers`, `_capture_exception`, `_make_event_processor`.
- Datadog dd-trace-py `DataDog/dd-trace-py@187cfc3700200ec8f33d6f610280924ef17e1696`
- `ddtrace/contrib/internal/celery/signals.py`: `trace_before_publish`, `trace_after_publish`, `trace_prerun`, `trace_postrun`, `_inject_distributed_headers`, `trace_failure`, `trace_retry`.
- OpenTelemetry Python Contrib `open-telemetry/opentelemetry-python-contrib@a5081cddcd6ca7f529abb2dbdebce6d2a4f062fb`
- `instrumentation/opentelemetry-instrumentation-celery/src/opentelemetry/instrumentation/celery/__init__.py`: `CeleryInstrumentor._instrument`, `_trace_before_publish`, `_trace_after_publish`, `_trace_prerun`, `_trace_postrun`, `_trace_failure`, `_trace_retry`.

Pattern update:

- Sentry Celery patches task publish/run paths, updates task headers with trace and baggage data, tracks enqueue timestamps, and can enrich exceptions with task IDs and args/kwargs subject to PII settings.
- Datadog Celery uses Celery signals, stores span state against task IDs, injects distributed headers into nested Celery header structures, and records broker host/port metadata.
- OpenTelemetry Celery uses signal hooks, task-local span lifecycle state, producer/consumer spans, and propagator injection/extraction.

LogBrew follow-up:

- Added dependency-free `celery_operation_with_logbrew_span(...)` in core for app-owned Celery `apply_async` or task-processing calls.
- The helper duck-types only string-like `task.name` and an optional `task.request.delivery_info.routing_key`, derives `taskName`, `queueName`, `queueOperation`, and a single-message count, and delegates to the existing queue span capture path.
- It preserves caller result/error, activates a child LogBrew trace during the operation, and keeps capture failures isolated through `on_capture_error`.
- It does not import Celery, register signals, patch `apply_async`, mutate headers, record broker URLs, capture task IDs, args, kwargs, request headers, baggage, tracestate, exception messages, or stack traces.

Verifier evidence:

- Focused TDD red failed on missing `celery_operation_with_logbrew_span` export.
- `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_celery_client.py python/logbrew_py/tests/test_rq_client.py python/logbrew_py/tests/test_queue_client.py` passed.
- `PYTHONPATH=python/logbrew_py/src python3 scripts/python_queue_span_smoke.py` proved five queue events, Celery task/queue metadata, RQ metadata, and no Celery/RQ payload/header/broker leakage.
- `PYTHONPATH=python/logbrew_py/src python3 -m unittest discover -s python/logbrew_py/tests -p 'test_*.py'` ran 64 tests.
- `bash scripts/check_python_static.sh` passed Ruff and mypy over 44 source files.
- `bash scripts/real_user_python_smoke.sh` passed wheel, wheel reinstall, freeze/direct reinstall, sdist, and sdist reinstall installed-artifact checks with `_celery_client.py` and `_rq_client.py` included.

Remaining gap after this follow-up:

- LogBrew is now better for privacy-bounded explicit Celery and RQ adoption, but Sentry, Datadog, and OpenTelemetry remain ahead for teams that want hidden signal/patch-based queue instrumentation and propagation through broker metadata. That should stay out of `logbrew-sdk`; a future opt-in `logbrew-celery` package would need separate dependency, patching, privacy, and uninstall proof.

## Span Event Summary Follow-Up

Fresh source refresh on 2026-06-29 is recorded in `docs/competitor-research/python-span-events-2026-06-29.md`.

- Added bounded `span_events` support to generic queue, RQ, and Celery helpers.
- Failed queue operations now add one automatic type-only `exception` span event with `exceptionType` and `exceptionEscaped=true`.
- Message-like span-event metadata keys are filtered before capture, so payloads, headers, args, kwargs, broker URLs, and exception messages remain absent.
- `PYTHONPATH=python/logbrew_py/src python3 scripts/python_queue_span_smoke.py` now proves queue/RQ/Celery span events plus exception event summaries.

Remaining gap after this follow-up:

- LogBrew now has safe queue event summaries, but still avoids full OpenTelemetry event arrays/links, baggage/tracestate, hidden queue lifecycle hooks, and broker metadata propagation.
