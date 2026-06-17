# Rust Tracing Bridge Comparison - 2026-06-15

## Scope

Follow-up to the Rust HTTP server request pass. Tested the next Rust service gap: apps that already use the `tracing` ecosystem want existing app log events and spans to reach hosted telemetry without switching to a heavy exporter stack, globally patching HTTP clients, or capturing arbitrary structured fields.

## Current Competitor Signals

- Sentry Rust tracing docs: <https://docs.sentry.io/platforms/rust/guides/tracing/> and `sentry-tracing` 0.48.2: <https://docs.rs/sentry-tracing/latest/sentry_tracing/>. Sentry supports `tracing` events as issues, breadcrumbs, logs, and spans; it also supports filters and custom event mapping, but can capture broad `tracing` fields by default depending on mapping.
- Sentry OpenTelemetry/developer docs: <https://develop.sentry.dev/sdk/telemetry/traces/opentelemetry/> and <https://docs.sentry.io/platforms/rust/tracing/instrumentation/automatic-instrumentation/>. Sentry's mature Rust tracing path can connect OpenTelemetry/distributed tracing contexts, which remains a higher ceiling than LogBrew's current lightweight bridge.
- OpenTelemetry docs.rs for `tracing-opentelemetry` 0.33.0: <https://docs.rs/tracing-opentelemetry/latest/tracing_opentelemetry/> and `OpenTelemetrySpanExt`: <https://docs.rs/tracing-opentelemetry/latest/tracing_opentelemetry/trait.OpenTelemetrySpanExt.html>. OpenTelemetry remains the standards path for connecting `tracing` spans to existing distributed context and exporters, but the hosted-service path requires provider/exporter setup and multiple crates.
- OpenTelemetry context propagation docs: <https://opentelemetry.io/docs/concepts/context-propagation/>. The current ecosystem expectation is that traces, spans, and correlated logs preserve incoming context across service boundaries instead of starting unrelated local traces.
- Datadog Rust compatibility docs: <https://docs.datadoghq.com/tracing/trace_collection/compatibility/rust/>. Datadog Rust remains preview-stage and points users toward OpenTelemetry-compatible Rust libraries.
- Tokio `tracing` source/docs: <https://github.com/tokio-rs/tracing>. The core Rust ecosystem expectation is subscriber/layer composition, not replacing app-owned subscribers.

## LogBrew Improvement From This Pass

- Added optional `tracing` feature with `LogBrewTracingLayer`.
- The layer converts `tracing` events into LogBrew log events, preserves app-owned subscribers, accepts an app-owned timestamp function, ignores queue failures, and keeps `tracing`/`tracing-subscriber` out of default `cargo add logbrew`.
- Closed spans are converted only when apps opt in with `with_span_events()`. The layer generates W3C-shaped trace/span IDs, derives parent/child links from active `tracing` spans, adds trace correlation to logs emitted inside a span, records duration on close, and marks the current span as `error` when an error-level event is emitted inside it.
- Root spans can now continue an explicit incoming W3C `traceparent` or `trace_parent` field without requiring OpenTelemetry as a default dependency. The layer uses the upstream trace ID and parent span ID, generates fresh local child span IDs, inherits the sampled flag into span/log metadata, ignores malformed propagation non-fatally, and does not serialize the raw propagation header as metadata.
- The default bridge captures no arbitrary event or span fields. Apps must opt in with `with_allowed_fields(...)`; route-template field values are sanitized to strip query/hash text, and debug-formatted non-primitives are ignored.
- Added packaged `examples/tracing_bridge.rs`, unit coverage, and an installed-artifact smoke test that installs `logbrew --features tracing` into a generated app with app-owned `tracing` and `tracing-subscriber`.

## Where LogBrew Is Better Today

- Lighter first-useful Rust tracing bridge than Sentry/OpenTelemetry/Datadog for apps that need canonical LogBrew logs and basic spans from `tracing` without a full OpenTelemetry provider/exporter stack.
- Privacy defaults are stricter: no arbitrary field capture unless allowlisted, no request/response payload capture, no header capture, no raw URL capture, and no global HTTP patching.
- Works as a normal `tracing_subscriber::Layer`, so apps keep their existing subscriber stack and can compose LogBrew with stdout or other layers.

## Where LogBrew Is Still Worse

- Span conversion is intentionally basic: it accepts explicit W3C `traceparent` fields on root spans and dependency-free OpenTelemetry-style span context fields, but it still does not install an OpenTelemetry processor/exporter, read live `tracing-opentelemetry` span extensions automatically, or model span events/exceptions as richly as `tracing-opentelemetry` and Sentry.
- No built-in error object extraction, breadcrumb model, or issue grouping equivalent to Sentry's mature Rust integration.
- No Rocket example yet.
- Source-map/native symbolication and backend-owned setup/usage/quota contracts remain broader product gaps.

## Updated Proof

- `cargo test --manifest-path rust/logbrew/Cargo.toml --all-features` now covers 29 Rust tests including Tower and tracing feature tests.
- `bash scripts/real_user_rust_tracing_smoke.sh` packages the crate, installs it into a generated `tracing-app` with `logbrew --features tracing`, adds app-owned `tracing@0.1` and `tracing-subscriber@0.3`, runs the packaged example, and validates release, environment, log conversion, span conversion, upstream W3C trace continuation, parent/child links, sampled propagation, log trace correlation, allowed primitive metadata, sanitized route templates, and absence of unsafe field leakage.
- Current package proof after the tracing bridge update: `cargo package --allow-dirty --no-verify` packaged 25 files, 232.0 KiB uncompressed, 48.1 KiB compressed.

## 2026-06-17 OpenTelemetry SpanContext Follow-Up

### Source Reading

- OpenTelemetry Rust `open-telemetry/opentelemetry-rust@88821497a893ff6dd4dd916621a2224394ebb0a4`: read `opentelemetry/src/trace/span_context.rs` (`SpanContext`, `SpanContext::new`, `trace_id`, `span_id`, `trace_flags`, `is_valid`, `is_sampled`) and `opentelemetry/src/trace/context.rs` (`SpanRef::span_context`, `TraceContextExt`). Pattern: immutable span context carries trace ID, span ID, trace flags, remote bit, and tracestate; validity rejects invalid IDs; sampled is derived from flags.
- Tokio `tokio-rs/tracing-opentelemetry@1d5422f1f37932fd65e434da618b305d4c94ee9c`: read `src/span_ext.rs` (`OpenTelemetrySpanExt::set_parent`, `context`, `add_link`, `set_attribute`, `set_status`, `add_event`). Pattern: a `tracing::Span` can receive/expose an OpenTelemetry `Context`, but parent setting has lifecycle constraints and requires the OTel layer to be present.
- Sentry Rust `getsentry/sentry-rust@e33b7ff20eb5bf948eacf89d7eecdcc59b31d4f3`: read `sentry-opentelemetry/src/converters.rs` (`convert_trace_id`, `convert_span_id`, `convert_span_status`), `sentry-opentelemetry/src/propagator.rs` (`SentryPropagator::inject_context`, `extract_with_context`), and `sentry-opentelemetry/src/processor.rs` (`SentrySpanProcessor::new`, `on_start`, `on_end`). Pattern: Sentry can run as an OTel span processor and convert real OTel spans into Sentry traces, including active-span event correlation.
- Datadog Rust tracer `DataDog/dd-trace-rs@0d1d982f0464318f5c1a21c2db1c84b58ff2c95c`: read `datadog-opentelemetry/src/mappings/sdk_span.rs` (`SdkSpan`), `datadog-opentelemetry/src/propagation/context.rs` (`SpanContext`, `InjectSpanContext`, `SpanLink`), and `datadog-opentelemetry/src/propagation/tracecontext.rs` (`Traceparent`, W3C `TRACEPARENT_KEY`, tracestate parsing). Pattern: Datadog maps OTel span data into vendor spans and carries propagation metadata, but the implementation is intentionally heavier and vendor-specific.

### LogBrew Update

- Added dependency-free `OpenTelemetrySpanContext` to the Rust core API. Apps that already own an OpenTelemetry span context can copy trace ID, span ID, and trace flags into LogBrew without enabling a new feature, adding an exporter, or coupling LogBrew to `opentelemetry` crate version churn.
- Added `Traceparent::create_headers_from_opentelemetry_context(...)`, `span_attributes_from_opentelemetry_context(...)`, and `context_from_opentelemetry_context(...)`. The OTel span ID becomes the parent span ID for the new LogBrew child span, while the child span ID remains app-owned and W3C-validated.
- Kept the same privacy boundary: no tracestate or baggage ingestion, no automatic `tracing-opentelemetry` extension reads, no processors/exporters, no global HTTP patching, no payload/header/raw URL capture, and no raw propagation value in metadata.

### Tradeoffs

- Better than before for teams with an existing OpenTelemetry context who just need LogBrew trace/log/span correlation and one-header downstream propagation.
- Still behind Sentry and full OpenTelemetry for automatic span processing, rich span events/exceptions, links, tracestate/baggage, and collector/exporter workflows.

## 2026-06-17 Rocket Request Follow-Up

### Source Reading

- Rocket `rwf2/Rocket@v0.5.1`: read `core/lib/src/fairing/ad_hoc.rs` (`AdHoc::on_request`, `AdHoc::on_response`), `core/lib/src/request/request.rs` (`Request::headers`, `Request::route`, `Request::local_cache`), and `core/lib/src/route/route.rs` (`Route::uri`). Pattern: fairings are app-owned lifecycle hooks; route templates are available after routing, so request telemetry should build in `on_response` rather than `on_request`.
- Sentry Rust `getsentry/sentry-rust@0.48.2`: read `sentry-actix/src/lib.rs` request transaction middleware and `sentry-tower/src/lib.rs` tower layer. Pattern: Sentry can start transactions from incoming headers, configure scope processors, map status, and finish transactions in framework middleware, but the official repo does not ship a Rocket integration and the request path is heavier than LogBrew needs for first-useful telemetry.

### LogBrew Update

- Added packaged `examples/rocket_request_fairing.rs` plus `scripts/real_user_rust_rocket_smoke.sh`. The smoke packages `logbrew`, installs it into a generated Rocket app, runs the packaged example, and validates a request span plus `http.server.duration` metric.
- The Rocket example records start time in `AdHoc::on_request`, builds telemetry in `AdHoc::on_response` with `Request::route().uri`, continues a valid incoming W3C `traceparent`, emits one outgoing `traceparent`, and keeps the LogBrew client in app-managed state.
- Privacy boundary matches the other Rust server examples: no framework dependency in default `logbrew`, no global HTTP patching, no payload/header capture beyond the single W3C propagation header, and no raw URI/query/hash capture.

### Proof

- `cargo run --quiet --example rocket_request_fairing` plus `scripts/check_rust_rocket_payload.py` validates the local example output.
- `bash scripts/real_user_rust_rocket_smoke.sh` validates the installed crate path with Rocket `0.5.1`; current package proof reported 26 files, 265.3 KiB uncompressed, 55.0 KiB compressed.

### Remaining Rust Gaps

- Still behind Sentry/OpenTelemetry for automatic `tracing-opentelemetry` extraction/processor interop, rich span events/exceptions, span links, tracestate/baggage, and automatic framework/outbound/DB/cache/queue spans.

## 2026-06-17 Span Event Summary Follow-Up

### Source Reading

- Sentry Rust `getsentry/sentry-rust@e33b7ff20eb5bf948eacf89d7eecdcc59b31d4f3`: re-read `sentry-tracing/src/layer/mod.rs` (`default_event_filter`, `on_event`, `record_fields`) and `sentry-tracing/src/converters.rs` (`extract_event_data`, `FieldVisitor::record_error`, `event_from_event`). Pattern: Sentry can turn tracing events into breadcrumbs, logs, and exception events, and can include broad event/span fields when configured.
- Tokio `tracing-opentelemetry@1d5422f1f37932fd65e434da618b305d4c94ee9c`: re-read `src/layer.rs` (`SpanEventVisitor`, `with_error_events_to_exceptions`, `on_event`) and `src/span_ext.rs` (`add_event`, `add_event_with_timestamp`, `set_status`). Pattern: the OTel layer materializes in-span events, maps error fields to exception semantic-convention attributes, and updates span status.
- Datadog Rust `DataDog/dd-trace-rs@0d1d982f0464318f5c1a21c2db1c84b58ff2c95c`: re-read `datadog-opentelemetry/src/mappings/sdk_span.rs` (`SdkSpan`, `events`, `dropped_event_count`, `links`). Pattern: Datadog consumes OTel span data with explicit span events and links, but through the heavier OTel exporter path.

### LogBrew Update

- Added privacy-bounded tracing span event summaries when apps opt into `LogBrewTracingLayer::with_span_events()`.
- Closed LogBrew span metadata now includes `tracingSpanEventCount` for in-span events and, when an error-level event occurs on that span, `tracingSpanErrorEventCount`, `tracingLastErrorLevel`, and `tracingLastErrorTarget`.
- The bridge still records the event itself as a LogBrew log event, marks only the current span as `error`, and intentionally does not copy error messages, exception stacks, payloads, arbitrary headers, full URLs, baggage, tracestate, or non-allowlisted event fields into span metadata.

### Tradeoffs

- This narrows the Sentry/OpenTelemetry diagnostics gap by making closed spans explain whether important events occurred inside them.
- LogBrew remains lighter but less expressive than full Sentry/OTel/Datadog span event ingestion: no exception object model, no event arrays, no links, no stack capture, and no automatic processor/exporter interop.

## 2026-06-17 `tracing-opentelemetry` Active Context Copy Follow-Up

### Source Reading

- Re-read Tokio `tracing-opentelemetry@1d5422f1f37932fd65e434da618b305d4c94ee9c` `src/span_ext.rs` (`OpenTelemetrySpanExt::set_parent`, `context`) and `src/layer.rs` (`WithContext`, `parent_context`, `on_new_span`, `on_event`, `on_close`). Pattern: the OTel layer stores private span extension state; the public API is `tracing::Span::context()`, while processor/exporter paths retain full span events, links, and lifecycle data.
- Re-read OpenTelemetry Rust `open-telemetry/opentelemetry-rust@88821497a893ff6dd4dd916621a2224394ebb0a4` `opentelemetry/src/trace/context.rs` (`TraceContextExt`, `SpanRef::span_context`), `opentelemetry/src/trace/span_context.rs` (`SpanContext::is_valid`, `is_sampled`), and `opentelemetry/src/trace_context.rs` (`TraceFlags::to_u8`, `TraceId`, `SpanId`). Pattern: valid OTel contexts expose exactly the W3C IDs and flags LogBrew needs without reading tracestate or baggage.
- Re-read Sentry Rust `sentry-opentelemetry/src/processor.rs` (`SentrySpanProcessor::new`, `on_start`, `on_end`). Pattern: Sentry's higher ceiling comes from a real OTel span processor that owns conversion at start/end and correlates Sentry events against active OTel spans.
- Re-read Datadog Rust `datadog-opentelemetry/src/mappings/sdk_span.rs` (`SdkSpan`). Pattern: Datadog consumes complete OTel span data, including attributes, events, and links, through a heavier exporter-mapping path.

### LogBrew Update

- Added optional `tracing-opentelemetry` feature. It keeps default `logbrew` and `logbrew --features tracing` installs unchanged, while apps that already depend on OpenTelemetry can opt into `opentelemetry_span_context_from_current_tracing_span()` or `opentelemetry_span_context_from_tracing_span(...)`.
- The helper calls the public `tracing_opentelemetry::OpenTelemetrySpanExt::context()` API, rejects invalid/no-layer contexts by returning `None`, and copies only trace ID, span ID, trace flags, and sampled state into LogBrew's existing `OpenTelemetrySpanContext`.
- Added packaged `examples/tracing_opentelemetry_bridge.rs` plus installed smoke coverage. The example uses an app-owned OTel parent and no-op tracer, creates one LogBrew child span with `Traceparent::span_attributes_from_opentelemetry_context(...)`, and proves the outgoing trace header can be created without emitting raw `traceparent`.

### Tradeoffs

- This is a smaller, safer interop step than Sentry or full OpenTelemetry processors: useful for apps that already have an active OTel `tracing` span and want LogBrew child spans or downstream headers.
- LogBrew still does not automatically consume full OTel span processor data, span links, event arrays, exceptions, tracestate, baggage, or exporter lifecycle. That remains a real gap for teams wanting full OTel replacement behavior.
