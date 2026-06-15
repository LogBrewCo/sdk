# Rust Tracing Bridge Comparison - 2026-06-15

## Scope

Follow-up to the Rust HTTP server request pass. Tested the next Rust service gap: apps that already use the `tracing` ecosystem want existing app log events to reach hosted telemetry without switching to a heavy exporter stack, globally patching HTTP clients, or capturing arbitrary structured fields.

## Current Competitor Signals

- Sentry docs.rs for `sentry-tracing` 0.48.2: <https://docs.rs/sentry-tracing/latest/sentry_tracing/>. Sentry supports `tracing` events as issues, breadcrumbs, logs, and spans; it also supports filters and custom event mapping, but can capture broad `tracing` fields by default depending on mapping.
- OpenTelemetry docs.rs for `tracing-opentelemetry` 0.33.0: <https://docs.rs/tracing-opentelemetry/latest/tracing_opentelemetry/>. OpenTelemetry remains the standards path for connecting `tracing` spans to exporters, but the hosted-service path requires provider/exporter setup and multiple crates.
- Datadog Rust compatibility docs: <https://docs.datadoghq.com/tracing/trace_collection/compatibility/rust/>. Datadog Rust remains preview-stage and points users toward OpenTelemetry-compatible Rust libraries.
- Tokio `tracing` source/docs: <https://github.com/tokio-rs/tracing>. The core Rust ecosystem expectation is subscriber/layer composition, not replacing app-owned subscribers.

## LogBrew Improvement From This Pass

- Added optional `tracing` feature with `LogBrewTracingLayer`.
- The layer converts `tracing` events into LogBrew log events, preserves app-owned subscribers, accepts an app-owned timestamp function, ignores queue failures, and keeps `tracing`/`tracing-subscriber` out of default `cargo add logbrew`.
- The default bridge captures no arbitrary event fields. Apps must opt in with `with_allowed_fields(...)`; route-template field values are sanitized to strip query/hash text.
- Added packaged `examples/tracing_bridge.rs`, unit coverage, and an installed-artifact smoke test that installs `logbrew --features tracing` into a generated app with app-owned `tracing` and `tracing-subscriber`.

## Where LogBrew Is Better Today

- Lighter first-useful Rust logging bridge than Sentry/OpenTelemetry/Datadog for apps that only need canonical LogBrew logs from `tracing` events.
- Privacy defaults are stricter: no arbitrary field capture unless allowlisted, no request/response payload capture, no header capture, no raw URL capture, and no global HTTP patching.
- Works as a normal `tracing_subscriber::Layer`, so apps keep their existing subscriber stack and can compose LogBrew with stdout or other layers.

## Where LogBrew Is Still Worse

- The bridge currently converts events to logs only; it does not convert `tracing` spans into LogBrew span events.
- No built-in error object extraction, breadcrumb model, or issue grouping equivalent to Sentry's mature Rust integration.
- No Actix/Rocket examples yet.
- Source-map/native symbolication and backend-owned setup/usage/quota contracts remain broader product gaps.

## Updated Proof

- `cargo test --manifest-path rust/logbrew/Cargo.toml --all-features` now covers 27 Rust tests including Tower and tracing feature tests.
- `bash scripts/real_user_rust_tracing_smoke.sh` packages the crate, installs it into a generated `tracing-app` with `logbrew --features tracing`, adds app-owned `tracing@0.1` and `tracing-subscriber@0.3`, runs the packaged example, and validates release, environment, log conversion, allowed primitive metadata, sanitized route templates, and absence of unsafe field leakage.
- Current package proof after the tracing bridge: `cargo package --allow-dirty --no-verify` packaged 24 files, 179.1 KiB uncompressed, 36.6 KiB compressed.
