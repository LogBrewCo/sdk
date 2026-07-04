# Python OpenTelemetry Exception Trace Summary - 2026-07-04

## Scope

This pass targets a real debugging gap: users need failed OpenTelemetry traces to be searchable by exception presence and type, without LogBrew collecting exception messages, stacks, payloads, headers, full URLs, baggage, or tracestate by default.

## Public Source Read

- Sentry Python `getsentry/sentry-python@1bd120f41780bfd5fd4d4b7c65aae395e425adab`.
- Files read: `sentry_sdk/integrations/opentelemetry/span_processor.py` (`SentrySpanProcessor`, `on_end`, `_update_span_with_otel_data`, `_update_span_with_otel_status`, `_get_trace_data`, `link_trace_context_to_error_event`).
- Pattern: Sentry is stronger at linking OTel span context to error events and mapping OTel span data into its tracing model. Tradeoff: broader runtime ownership and broader span data copying.

- OpenTelemetry Python `open-telemetry/opentelemetry-python@322c602c87f38933986a757db918591ade441bd3`.
- Files read: `opentelemetry-sdk/src/opentelemetry/sdk/trace/__init__.py` (`ReadableSpan`, `Span.add_event`, `Span.record_exception`, `Span.__exit__`) and `opentelemetry-api/src/opentelemetry/trace/span.py` (`add_event`, `record_exception`).
- Pattern: OTel models exceptions as span events with `exception.type`, optional message/stack, and escaped state; processors and exporters consume those events from ended spans.

- Datadog Python `DataDog/dd-trace-py@c12bb9dfb723bb96a662b7b90f36c805c4af43fb`.
- Files read: `ddtrace/internal/opentelemetry/span.py` (`record_exception`, `__exit__`, `set_status`) and `ddtrace/_trace/span.py` (`record_exception`, `set_exc_info`, span event validation).
- Pattern: Datadog records exception events and error metadata for rich trace debugging. Tradeoff: richer default error detail than LogBrew should copy into lightweight SDK payloads.

- PostHog Python `PostHog/posthog-python@6f75afe77ff059e4f3b0b6b7b30912612a7b5ff1`.
- Files read: `posthog/ai/otel/processor.py` (`PostHogSpanProcessor`, `on_end`, `force_flush`, `shutdown`) and `posthog/ai/otel/exporter.py` (`PostHogTraceExporter.export`, `force_flush`, `shutdown`).
- Pattern: PostHog provides a focused OTel processor/exporter path, especially for AI spans, while general observability depth remains narrower than Sentry and Datadog.

## LogBrew Update

- Python OTel detail spans now summarize OTel `exception` events as `otel.exception_event_count`, optional `otel.exception_escaped_count`, and bounded `otel.exception_types`.
- Python OTel trace summaries now aggregate those fields as `otel.trace.exception_event_count`, optional `otel.trace.exception_escaped_count`, and bounded `otel.trace.exception_types`.
- Escaped exception events mark spans with unset OTel status as `error`; explicit OTel OK remains `ok`.
- Exception messages, stack traces, payloads, headers, full URLs, baggage, tracestate, and raw propagation values remain omitted by default.

## Verification

- RED: focused Python OTel tests failed because detail and summary exception metadata did not exist and escaped exception events on unset status stayed `ok`.
- GREEN: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python.logbrew_py.tests.test_opentelemetry_processor -v`.
- GREEN: `bash scripts/real_user_python_opentelemetry_smoke.sh` with built wheel, installed `opentelemetry-sdk`, processor/exporter paths, and local payload assertions.
- GREEN: `bash scripts/real_user_python_opentelemetry_high_load_smoke.sh` confirmed the same converter behavior under installed-package queue pressure, retry, flush, and shutdown.

## Remaining Gap

Sentry and Datadog still lead on hosted trace-to-error navigation, grouping, semantic-convention breadth, stack/source context when users opt in, and automatic framework/outbound coverage. LogBrew's stronger position in this path is lighter installed-package behavior and safer default exception summaries.
