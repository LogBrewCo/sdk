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

- Span conversion is intentionally basic: it accepts explicit W3C `traceparent` fields on root spans, but it still does not read an existing OpenTelemetry context from `tracing-opentelemetry`, export span events through OTel collectors, or model span events/exceptions as richly as `tracing-opentelemetry` and Sentry.
- No built-in error object extraction, breadcrumb model, or issue grouping equivalent to Sentry's mature Rust integration.
- No Rocket example yet.
- Source-map/native symbolication and backend-owned setup/usage/quota contracts remain broader product gaps.

## Updated Proof

- `cargo test --manifest-path rust/logbrew/Cargo.toml --all-features` now covers 29 Rust tests including Tower and tracing feature tests.
- `bash scripts/real_user_rust_tracing_smoke.sh` packages the crate, installs it into a generated `tracing-app` with `logbrew --features tracing`, adds app-owned `tracing@0.1` and `tracing-subscriber@0.3`, runs the packaged example, and validates release, environment, log conversion, span conversion, upstream W3C trace continuation, parent/child links, sampled propagation, log trace correlation, allowed primitive metadata, sanitized route templates, and absence of unsafe field leakage.
- Current package proof after the tracing bridge update: `cargo package --allow-dirty --no-verify` packaged 25 files, 232.0 KiB uncompressed, 48.1 KiB compressed.
