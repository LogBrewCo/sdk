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

## 2026-07-02 Span Link Follow-Up

### Public Source Read

- Sentry Python `getsentry/sentry-python@1bd120f41780bfd5fd4d4b7c65aae395e425adab`.
- Re-read `sentry_sdk/integrations/opentelemetry/span_processor.py` (`link_trace_context_to_error_event`, `SentrySpanProcessor.on_start`, `on_end`, `_get_trace_data`, `_update_span_with_otel_data`). Pattern: the Python OTel bridge maps OTel spans into Sentry spans and links current OTel span context into error events, but this path does not visibly preserve OTel `ReadableSpan.links` as exported span-link arrays.

- OpenTelemetry Python `open-telemetry/opentelemetry-python@9ffd585e2f5eb296e2c9e834887b382af0c18727`.
- Re-read `opentelemetry-sdk/src/opentelemetry/sdk/trace/__init__.py` (`ReadableSpan.links`, `ReadableSpan.dropped_links`, `_format_links`, `Span._new_links`, `Span.add_link`, `Tracer.start_span`) and `opentelemetry-api/src/opentelemetry/trace/__init__.py` (`Link`, `dropped_attributes`). Pattern: span links are first-class `SpanContext` plus attributes, bounded by SDK limits, and are preferably supplied at span creation so samplers/exporters see them.

- Datadog Python `DataDog/dd-trace-py@ad931e9b9a8087d963a639b8c1eaff0b749b81cc`.
- Re-read `ddtrace/internal/opentelemetry/trace.py` (`Tracer.start_span`, `start_as_current_span` link handling), `ddtrace/_trace/_span_link.py` (`SpanLink`, `SpanLinkKind`), and `ddtrace/internal/encoding.py` (`span_links` serialization). Pattern: Datadog maps OTel `Link` objects into Datadog span links with trace ID, span ID, tracestate, flags, and attributes, then serializes them in trace payloads. Tradeoff: rich and portable, but it carries more propagation and attribute surface than LogBrew should copy by default.

- PostHog Python `PostHog/posthog-python@df9f2115859f27b33a1d7380bcd5b467374759d3`.
- Re-read `posthog/ai/otel/processor.py` (`PostHogSpanProcessor`), `posthog/ai/otel/exporter.py` (`PostHogTraceExporter`), and `posthog/ai/otel/spans.py` (`is_ai_span`). Pattern: PostHog delegates matching AI spans to an internal OTLP batch/export path and does not add a general lightweight link-summary bridge.

### LogBrew Update

- Added Python `SpanLinkSummary` support to the shared span validator so direct `client.span(...)` payloads can carry up to eight privacy-bounded `links`.
- Added `include_span_links=True` and `link_attribute_keys=[...]` to Python OTel readable-span conversion and `LogBrewOpenTelemetrySpanProcessor`.
- OTel links copy only valid linked trace ID, linked span ID, sampled flag, and explicitly allowlisted primitive link metadata; message IDs, full URLs, headers, payloads, cookies, DB statements, exception messages, stacks, baggage, tracestate, and raw propagation metadata stay out.

### Verification

- RED/green focused unit proof: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_opentelemetry_processor.py` now covers OTel link summary conversion, sensitive link-key rejection, processor queue preservation, and trace summary behavior.
- Core public span proof: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python/logbrew_py/tests/test_span_links.py` verifies direct span links serialize with primitive metadata and reject invalid span IDs.
- Installed-artifact proof updated: `bash scripts/real_user_python_opentelemetry_smoke.sh` creates a real OpenTelemetry `Link`, registers the LogBrew processor on a real `TracerProvider`, verifies one dependency link survives, and checks message IDs do not leak.

### Honest Gap After Link Follow-Up

LogBrew is now stronger than Sentry Python's current OTel processor path for a lightweight privacy-bounded link-summary use case, because it can preserve span links without owning the provider/exporter or copying broad attributes. Datadog and native OpenTelemetry remain stronger for full span-link fidelity, tracestate, link attributes, exporter lifecycle, automatic instrumentation, and batching. LogBrew intentionally stays narrower until a backend-supported, privacy-bounded richer trace model exists.

## 2026-07-02 Span Exporter Follow-Up

### Public Source Read

- Sentry Python `getsentry/sentry-python@1bd120f41780bfd5fd4d4b7c65aae395e425adab`.
- Re-read `sentry_sdk/integrations/otlp.py` (`setup_otlp_traces_exporter`, `SentryOTLPPropagator`, `OTLPIntegration.setup_once_with_options`). Pattern: Sentry can automatically configure an OTLP exporter plus batch processor from DSN or collector settings, and can install Sentry propagation. Tradeoff: convenient and powerful, but broader runtime/provider ownership than LogBrew's core Python SDK should take by default.

- OpenTelemetry Python `open-telemetry/opentelemetry-python@9ffd585e2f5eb296e2c9e834887b382af0c18727`.
- Re-read `opentelemetry-sdk/src/opentelemetry/sdk/trace/export/__init__.py` (`SpanExportResult`, `SpanExporter.export`, `shutdown`, `force_flush`, `SimpleSpanProcessor`, `BatchSpanProcessor`). Pattern: frameworks often accept a `SpanExporter`; exporters return `SUCCESS` or `FAILURE`, while OTel processors own batching and sampled-span filtering.

- PostHog Python `PostHog/posthog-python@df9f2115859f27b33a1d7380bcd5b467374759d3`.
- Re-read `posthog/ai/otel/exporter.py` (`PostHogTraceExporter.export`, `shutdown`, `force_flush`) and `posthog/ai/otel/processor.py` (`PostHogSpanProcessor`). Pattern: PostHog exposes both processor and exporter forms; the exporter exists specifically for setups that only accept a `SpanExporter`, then delegates to OTLP for matching AI spans.

- Datadog Python `DataDog/dd-trace-py@ad931e9b9a8087d963a639b8c1eaff0b749b81cc`.
- Re-read `ddtrace/opentelemetry/__init__.py` (OpenTelemetry support docs, OTel logs/trace enablement, trace mapping) and `ddtrace/internal/opentelemetry/trace.py` (`TracerProvider`, `Tracer.start_span`, link handling). Pattern: Datadog offers broad OTel-compatible provider/tracer interop and maps OTel spans into Datadog spans. Tradeoff: rich and mature, but it requires deeper tracing runtime ownership and Datadog-specific export behavior.

### LogBrew Update

- Added `LogBrewOpenTelemetrySpanExporter` plus `create_logbrew_open_telemetry_span_exporter(...)`.
- Apps or frameworks that require a `SpanExporter` can register it with app-owned `SimpleSpanProcessor` or `BatchSpanProcessor`; default LogBrew installs still add no OpenTelemetry dependency.
- The exporter returns OTel `SpanExportResult.SUCCESS`/`FAILURE` when `opentelemetry-sdk` is installed, otherwise it returns a same-name fallback enum so local tests and dependency-free imports stay stable.
- Exported spans reuse the existing privacy-bounded readable-span conversion, span-event summaries, link summaries, and trace-summary flush behavior. It still avoids provider ownership, OTLP forwarding, baggage, tracestate, raw propagation metadata, broad attributes, full URLs, headers, payloads, DB statements, exception messages, and stacks.

### Verification

- RED/green focused unit proof: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python.logbrew_py.tests.test_opentelemetry_processor.OpenTelemetryProcessorTests.test_open_telemetry_span_exporter_queues_details_and_trace_summary python.logbrew_py.tests.test_opentelemetry_processor.OpenTelemetryProcessorTests.test_open_telemetry_span_exporter_returns_failure_after_shutdown`.
- Full unit proof: `PYTHONPATH=python/logbrew_py/src python3 -m unittest python.logbrew_py.tests.test_opentelemetry_processor -v`.
- Installed-artifact proof updated: `bash scripts/real_user_python_opentelemetry_smoke.sh` builds the wheel, installs current `opentelemetry-sdk`, registers the LogBrew exporter with a real `SimpleSpanProcessor`, verifies exporter result shape, detail spans, trace summary, one link summary, and blocked-value redaction.

### Honest Gap After Exporter Follow-Up

LogBrew is now closer to PostHog's ergonomic processor/exporter split while staying broader than PostHog's AI-only filter and safer by default than broad OTLP forwarding. Sentry and Datadog remain stronger for full automatic OTLP/provider/exporter integration, broader semantic convention handling, and mature collector/backend pipelines. The next Python trace work should prioritize user-visible time-to-answer gaps: richer automatic framework/outbound spans, backend-supported trace querying/symbolication where applicable, and heavier OTel integration only where it can stay opt-in and privacy-bounded.
