# Rust HTTP Server Request Telemetry Comparison - 2026-06-15

## Scope

Follow-up to the Rust first-useful pass. Tested the next practical service gap from a real user perspective: an Axum/Tower-style app wants request spans and request-duration metrics with W3C propagation, but does not want a heavy automatic instrumentation stack, global HTTP patching, payload capture, or header capture.

## Current Competitor Signals

- Sentry docs: [Rust Axum](https://docs.sentry.io/platforms/rust/guides/axum/) and public source `getsentry/sentry-rust@e33b7ff20eb5bf948eacf89d7eecdcc59b31d4f3`, especially `sentry-tower/src/lib.rs`. Sentry has real Tower/Axum middleware and warns about layer ordering, memory-leak risk, and transaction naming when raw request URIs contain unique IDs.
- OpenTelemetry docs: [Rust getting started](https://opentelemetry.io/docs/languages/rust/getting-started/) and public source `open-telemetry/opentelemetry-rust@88821497a893ff6dd4dd916621a2224394ebb0a4`, especially `opentelemetry-sdk/src/propagation/trace_context.rs`. OpenTelemetry remains the standards baseline for W3C propagation, but the hosted-service path requires provider/exporter setup and multiple crates.
- Datadog docs: [Rust library](https://docs.datadoghq.com/tracing/trace_collection/dd_libraries/rust/). Datadog Rust is useful for tracing direction, but it is still a heavier tracer-oriented path than LogBrew's current explicit SDK.

## LogBrew Improvement From This Pass

- Added dependency-free `HttpRequestTelemetry` for Rust HTTP server middleware in Axum, Tower, Actix, Rocket, or custom servers.
- The helper builds a request `SpanEvent`, optional `http.server.duration` histogram metric, effective trace/span IDs, parent span ID when a valid incoming W3C `traceparent` is continued, and an outgoing `traceparent` value for downstream app-owned clients.
- Route templates are sanitized to remove query strings and hash fragments, HTTP methods are normalized, status code class is captured, `5xx` maps to span `error`, and malformed incoming propagation falls back non-fatally to the explicit app trace ID.
- Packaged example and installed-app smoke proof validate span/metric output, outgoing propagation, route-template privacy, and absence of payload/header/query leakage.
- Follow-up Axum proof adds a packaged `examples/axum_request_middleware.rs` mini-app plus generated `axum-app` install smoke. It uses Axum's matched route template through app-owned middleware, reads only W3C `traceparent`, returns an outgoing `traceparent`, and keeps Axum/Tokio/Tower out of LogBrew's default dependency path.

## Where LogBrew Is Better Today

- No new runtime dependencies and no default Tower/Axum dependency tax.
- No global middleware side effects by default; apps choose where to call the helper and keep response ownership.
- Safer route semantics than URI-based transaction naming: public examples use stable route templates and explicitly reject query/hash leakage.
- A runnable Axum mini-app now shows the exact middleware glue from an installed package without forcing every Rust user to accept Axum/Tokio/Tower dependencies.
- Lower-friction first useful path for teams that only need hosted logs/actions/network milestones/metrics/spans before adopting full OpenTelemetry or Sentry-style automatic instrumentation.

## Where LogBrew Is Still Worse

- No drop-in Tower `Layer` or Axum middleware crate yet, so teams that expect one-line middleware still need to copy the app-owned glue.
- No Rust `tracing` subscriber/layer bridge yet, so existing `tracing` spans and logs are not automatically converted.
- No Actix/Rocket examples yet.
- Source-map/native symbolication and backend-owned setup/usage/quota contracts remain broader product gaps.

## Next Focus

Evaluate a minimal Rust `tracing` bridge or optional Tower `Layer` only if it stays dependency-light and does not hide route-template ownership. Keep integrations optional; do not patch global clients, capture arbitrary headers, capture request/response bodies, or infer route names from raw URLs.
