# Python OpenTelemetry Span Processor - 2026-07-01

## Scope

Improve Python rich-trace interop for apps that already use OpenTelemetry. Before this pass, LogBrew could copy the current OTel span context into a LogBrew child trace, but it could not consume ended OTel `ReadableSpan` data through a `SpanProcessor`-compatible path. That left LogBrew weaker than Sentry, Datadog, OpenTelemetry, and PostHog for teams that expect existing OTel spans to produce useful trace timelines.

## Public Source Read

- Sentry Python `getsentry/sentry-python@4b98ef1d1d72e8bdc1a11006776e1a89b1325eed`.
- Files read: `sentry_sdk/integrations/opentelemetry/integration.py` (`_setup_sentry_tracing`), `sentry_sdk/integrations/opentelemetry/span_processor.py` (`SentrySpanProcessor`, `on_start`, `on_end`, `_get_trace_data`, `_update_span_with_otel_data`, `_update_transaction_with_otel_data`), `sentry_sdk/integrations/opentelemetry/propagator.py`, and `sentry_sdk/integrations/otlp.py` (`setup_otlp_traces_exporter`).
- Pattern: Sentry registers a real span processor on the app's OTel provider, maps OTel spans into Sentry transactions/spans, keeps an open-span map, copies broad attributes/resources, and can wire OTLP export. Tradeoff: strong interop, but deeper runtime/vendor ownership and broader privacy surface.

- OpenTelemetry Python `open-telemetry/opentelemetry-python@9ffd585e2f5eb296e2c9e834887b382af0c18727`.
- Files read: `opentelemetry-sdk/src/opentelemetry/sdk/trace/__init__.py` (`SpanProcessor`, `_on_ending`, `ReadableSpan`) and `opentelemetry-sdk/src/opentelemetry/sdk/trace/export/__init__.py` (`SimpleSpanProcessor`, `BatchSpanProcessor`, `on_end`, `force_flush`, `shutdown`).
- Pattern: processors are synchronous hooks with `on_start`, `_on_ending`, `on_end`, `force_flush`, and `shutdown`; sampled-span processors skip unsampled spans before export.

- Datadog Python `DataDog/dd-trace-py@ad931e9b9a8087d963a639b8c1eaff0b749b81cc`.
- Files read: `ddtrace/internal/opentelemetry/trace.py` (`TracerProvider`, `Tracer.start_span`, `_otel_to_dd_span_context`) and `ddtrace/internal/opentelemetry/span.py` (`Span`, `get_span_context`, `add_event`, `record_exception`, `set_status`).
- Pattern: Datadog exposes an OTel-compatible tracer/provider shim around Datadog spans, maps active OTel contexts into Datadog contexts, supports links/events/exceptions, and carries tracestate. Tradeoff: much richer, but it owns more tracing runtime behavior than LogBrew should in the core package.

- PostHog Python `PostHog/posthog-python@bce671277cfe161587c9230efb5f9dd60c9dc47a`.
- Files read: `posthog/ai/otel/processor.py` (`PostHogSpanProcessor`), `posthog/ai/otel/exporter.py` (`PostHogTraceExporter`), and `posthog/ai/otel/spans.py` (`is_ai_span`).
- Pattern: PostHog filters AI-related OTel spans and forwards them through an OTLP exporter; it is narrower than Sentry/Datadog for general observability but stronger for one AI trace export workflow.

## LogBrew Implementation

- Added `span_attributes_from_open_telemetry_readable_span(...)` to convert OTel `ReadableSpan`-like objects into privacy-bounded LogBrew span attributes.
- Added `LogBrewOpenTelemetrySpanProcessor` plus `create_logbrew_open_telemetry_span_processor(...)` for app-owned `TracerProvider.add_span_processor(...)`.
- Default installs still add no OpenTelemetry dependency; the helper duck-types OTel objects and no-ops when spans are invalid or unsampled.
- Captured detail spans include safe service/environment/route/method/status/span-kind/scope/dropped-count metadata and up to eight type-only event summaries.
- Optional `include_trace_summary=True` emits one synthetic `opentelemetry.trace:<root-name>` summary on `force_flush()` or `shutdown()`.
- The processor avoids OTel provider/exporter ownership, broad attributes/resources, raw propagation metadata, baggage, tracestate, links, full URLs, headers, query strings, payloads, cookies, DB statements, exception messages, and stacks.

## Verification

- Red/green unit path: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_opentelemetry_processor.py` covers readable-span conversion, sampled-span defaults, sensitive allowlist rejection, processor queueing, trace summaries, and shutdown no-op behavior.
- Installed-artifact proof: `bash scripts/real_user_python_opentelemetry_smoke.sh` builds the wheel, installs it in a temp app, installs current `opentelemetry-sdk`, registers the LogBrew processor with a real `TracerProvider`, emits root/dependency spans, force-flushes, verifies detail plus summary spans, and checks blocked OTel values do not leak.

## Honest Gap After This Pass

LogBrew is now better for lightweight, dependency-optional, privacy-bounded OTel span ingestion that works from an installed wheel and does not take over the user's OTel runtime. Sentry, Datadog, and native OpenTelemetry remain stronger for full exporter/provider ownership, automatic instrumentation breadth, links, baggage/tracestate, richer semantic conventions, streaming/batching internals, and cross-signal OTel runtime integration. PostHog remains stronger for its focused AI-span OTLP export path. The next Python trace work should target the highest-demand automatic framework/outbound/DB/cache/queue gaps with the same installed-artifact and fake-intake proof.
