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
