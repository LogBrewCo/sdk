# Python OpenTelemetry Context Bridge - 2026-07-01

## Scope

Close a high-impact Python rich-trace gap: teams that already use OpenTelemetry should be able to correlate LogBrew logs/actions/spans with the active OTel trace without replacing their tracer provider, exporter, or instrumentation stack.

## Public Source Read

- Sentry Python `getsentry/sentry-python@171aa1646187b79e2a85ce1177a65e509333a8aa`: read `sentry_sdk/integrations/opentelemetry/integration.py` `_setup_sentry_tracing()` and `sentry_sdk/integrations/opentelemetry/span_processor.py` `SentrySpanProcessor.on_start(...)`, `on_end(...)`, `_get_trace_data(...)`, `link_trace_context_to_error_event(...)`. Pattern: Sentry installs an OTel tracer provider/span processor, maps OTel spans into Sentry transactions/spans, formats integer IDs, links active OTel context to error events, and copies attributes/resource metadata.
- OpenTelemetry Python `open-telemetry/opentelemetry-python@9ffd585e2f5eb296e2c9e834887b382af0c18727`: read `opentelemetry-api/src/opentelemetry/trace/span.py` `TraceFlags`, `SpanContext`, `NonRecordingSpan`, `format_trace_id(...)`, `format_span_id(...)`, and `opentelemetry-api/src/opentelemetry/trace/propagation/__init__.py` `get_current_span(...)`/`set_span_in_context(...)`. Pattern: `SpanContext` stores integer trace/span IDs, rejects zero/out-of-range IDs through `is_valid`, and exposes sampled state through `TraceFlags.sampled` or bit `0x01`.
- Datadog Python `DataDog/dd-trace-py@f3ed29130a66ed38ed83d61b130c37932f234b40`: read `ddtrace/internal/opentelemetry/span.py` `Span.get_span_context(...)`, `_get_trace_flags(...)`, `add_event(...)`, `record_exception(...)`, and `_datadog_operation_name`. Pattern: Datadog provides a full OTel-compatible shim around Datadog spans, resolves sampling before context propagation, maps status/events/exceptions/semantic attributes, and supports richer operation naming.
- PostHog Python `PostHog/posthog-python@672e71aa3195941368c936442bd547a5b96d35bd`: read `posthog/ai/otel/spans.py` `is_ai_span(...)`. Pattern: PostHog's Python OTel source is focused on AI span filtering rather than a general-purpose current trace bridge.

## Takeaways

- Sentry and Datadog are stronger for teams that want OTel to become the primary tracing runtime or exporter path.
- Full processor/exporter interop would be heavier than LogBrew's current Python SDK and would expand the privacy surface through attributes, resource metadata, events, links, baggage, and tracestate.
- The useful lightweight step is copy-only correlation: read the current OTel parent span context when the app already installed OTel, validate IDs, create a LogBrew child context, and let existing LogBrew helpers correlate logs/actions/spans under that child.

## LogBrew Implementation

- Added `logbrew_trace_context_from_open_telemetry_span_context(...)`, `logbrew_trace_context_from_open_telemetry_span(...)`, and `logbrew_trace_context_from_current_open_telemetry_span(...)` to `logbrew_sdk`.
- The helpers duck-type OTel objects so default LogBrew installs add no OTel dependency and return `None` when OTel is absent or invalid.
- The bridge copies only valid trace ID, parent span ID, and sampled flag into a fresh `LogBrewTraceContext` child span.
- It intentionally does not install OpenTelemetry, own tracer providers/exporters/processors, read attributes/events/links, ingest baggage/tracestate, serialize raw propagation metadata, patch clients, or capture payloads, headers, cookies, full URLs, query strings, or fragments.

## Verification

- `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_sdk.py`
- `bash scripts/real_user_python_opentelemetry_smoke.sh`

## Honest Gap After This Pass

LogBrew is now better for a small dependency-optional OTel correlation helper with explicit privacy bounds. Sentry and Datadog remain stronger for full OTel processor/exporter interop, automatic span lifecycle ownership, rich OTel attributes/resources/events/links, baggage/tracestate, and broad framework auto-instrumentation. The next Python trace priority is still deeper framework/outbound/DB/cache/queue coverage only where it keeps first-event setup, privacy defaults, and fake-intake installed-artifact proof simple.
