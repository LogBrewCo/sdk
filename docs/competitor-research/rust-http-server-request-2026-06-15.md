# Rust HTTP Server Request Telemetry Comparison - 2026-06-15

## Scope

Follow-up to the Rust first-useful pass. Tested the next practical service gap from a real user perspective: an Axum/Tower/Actix-style app wants request spans and request-duration metrics with W3C propagation, but does not want a heavy automatic instrumentation stack, global HTTP patching, payload capture, or header capture.

## Current Competitor Signals

- Sentry docs: [Rust Axum](https://docs.sentry.io/platforms/rust/guides/axum/) and public source `getsentry/sentry-rust@e33b7ff20eb5bf948eacf89d7eecdcc59b31d4f3`, especially `sentry-tower/src/lib.rs`. Sentry has real Tower/Axum middleware and warns about layer ordering, memory-leak risk, and transaction naming when raw request URIs contain unique IDs.
- Sentry docs: [Rust Actix Web](https://docs.sentry.io/platforms/rust/guides/actix-web/) and [`sentry-actix`](https://docs.rs/sentry-actix/latest/sentry_actix/) expose framework middleware and a per-request hub model. This is easier to wire than a manual helper, but it is still Sentry-owned middleware with broader SDK behavior than LogBrew's explicit request helper.
- OpenTelemetry docs: [Rust getting started](https://opentelemetry.io/docs/languages/rust/getting-started/) and public source `open-telemetry/opentelemetry-rust@88821497a893ff6dd4dd916621a2224394ebb0a4`, especially `opentelemetry-sdk/src/propagation/trace_context.rs`. OpenTelemetry remains the standards baseline for W3C propagation, but the hosted-service path requires provider/exporter setup and multiple crates.
- Actix ecosystem docs: [`tracing-actix-web`](https://docs.rs/tracing-actix-web/latest/tracing_actix_web/) provides `TracingLogger` request spans and optional OpenTelemetry hooks, while [`opentelemetry-instrumentation-actix-web`](https://docs.rs/opentelemetry-instrumentation-actix-web/latest/opentelemetry_instrumentation_actix_web/) provides request tracing and request metrics middleware. These set the expectation that Actix users should see route-aware request spans/metrics without raw URI leakage.
- Datadog docs: [Rust library](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/rust/). Datadog Rust is useful for tracing direction, but it is still a heavier tracer-oriented path than LogBrew's current explicit SDK.

## LogBrew Improvement From This Pass

- Added dependency-free `HttpRequestTelemetry` for Rust HTTP server middleware in Axum, Tower, Actix, Rocket, or custom servers.
- The helper builds a request `SpanEvent`, optional `http.server.duration` histogram metric, effective trace/span IDs, parent span ID when a valid incoming W3C `traceparent` is continued, and an outgoing `traceparent` value for downstream app-owned clients.
- Route templates are sanitized to remove query strings and hash fragments, HTTP methods are normalized, status code class is captured, `5xx` maps to span `error`, and malformed incoming propagation falls back non-fatally to the explicit app trace ID.
- Packaged example and installed-app smoke proof validate span/metric output, outgoing propagation, route-template privacy, and absence of payload/header/query leakage.
- Follow-up Axum proof adds a packaged `examples/axum_request_middleware.rs` mini-app plus generated `axum-app` install smoke. It now uses the optional `tower` feature and `TowerRequestTelemetryLayer` with Axum's matched route template, reads only W3C `traceparent`, returns an outgoing `traceparent`, and keeps Axum/Tokio/Tower out of LogBrew's default dependency path.
- Follow-up Actix proof adds a packaged `examples/actix_request_middleware.rs` mini-app plus generated `actix-app` install smoke. It uses app-owned Actix middleware, reads only W3C `traceparent`, uses Actix's matched route template, emits a request span plus `http.server.duration`, returns outgoing `traceparent`, and keeps `actix-web` out of LogBrew's dependency path.

## Where LogBrew Is Better Today

- No new runtime dependencies and no default Tower/Axum dependency tax.
- No global middleware side effects by default; apps choose where to call the helper and keep response ownership.
- Safer route semantics than URI-based transaction naming: public examples use stable route templates and explicitly reject query/hash leakage.
- A runnable Axum mini-app now shows one-line Tower `route_layer` integration from an installed package without forcing every Rust user to accept Axum/Tokio/Tower dependencies.
- A runnable Actix mini-app now shows the same safe request telemetry pattern from an installed package without forcing every Rust user to accept Actix dependencies.
- Lower-friction first useful path for teams that only need hosted logs/actions/network milestones/metrics/spans before adopting full OpenTelemetry or Sentry-style automatic instrumentation.

## Where LogBrew Is Still Worse

- The Tower layer is feature-gated in the core crate, not a separate Axum integration crate with framework-specific defaults.
- Rust now has an optional `tracing` event/span bridge, but span conversion remains basic compared with Sentry and OpenTelemetry because it does not consume an existing OTel context or model rich span events/exceptions.
- No Rocket example yet.
- Source-map/native symbolication and backend-owned setup/usage/quota contracts remain broader product gaps.

## Next Focus

Next, add a Rocket example or richer externally supplied trace context only if they stay privacy-bounded and dependency-light. Keep integrations optional; do not patch global clients, capture arbitrary headers, capture request/response bodies, or infer route names from raw URLs.

## Updated Proof

- `bash scripts/real_user_rust_axum_smoke.sh` packages the crate, installs it into a generated `axum-app` with `logbrew --features tower`, adds `axum@0.8`, `tokio@1`, and `tower@0.5`, copies the packaged Axum example, runs it, and validates span/metric payload shape plus privacy constraints.
- `bash scripts/real_user_rust_actix_smoke.sh` packages the crate, installs it into a generated `actix-app` with default `logbrew`, adds `actix-web@4`, copies the packaged Actix example, runs it, and validates span/metric payload shape plus privacy constraints.
- Current package proof after the Actix example: `cargo package --allow-dirty --no-verify --manifest-path rust/logbrew/Cargo.toml` packaged 25 files, 226.8 KiB uncompressed, 47.5 KiB compressed.
