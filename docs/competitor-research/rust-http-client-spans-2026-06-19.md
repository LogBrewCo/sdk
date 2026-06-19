# Rust HTTP Client Span Comparison - 2026-06-19

## Sources Read

- Sentry Rust `getsentry/sentry-rust@7f22e359adac0214d1a75dfd887842fb902c9417`
  - `sentry-core/src/performance.rs`: `Transaction::start_child`, `Transaction::start_child_with_details`, `Span::set_request`, `Span::iter_headers`, `Span::set_status`, `Span::finish_with_timestamp`
  - `sentry-opentelemetry/src/propagator.rs`: `SentryPropagator::inject_context`, `extract_with_context`, propagated `sentry-trace` header behavior
  - `sentry-opentelemetry/src/processor.rs`: `SentrySpanProcessor::on_start`, `on_end`, OTel span-to-Sentry transaction/span mapping
- OpenTelemetry Rust Contrib `open-telemetry/opentelemetry-rust-contrib@883881d019ba8e5a433b327f3695b613c44303d0`
  - `opentelemetry-instrumentation-tower/src/lib.rs`: `RouteExtractor`, `PathExtractor`, `HTTPLayerBuilder`, `HTTPService::call`, `ResponseFuture`, `finalize_request`
- Datadog Rust `DataDog/dd-trace-rs@0d1d982f0464318f5c1a21c2db1c84b58ff2c95c`
  - `datadog-opentelemetry/src/text_map_propagator.rs`: `DatadogPropagator::inject_context`, W3C/Datadog propagation conversion, baggage/tracestate handling
  - `datadog-opentelemetry/examples/propagator/src/server.rs`: `send_request`, Hyper request builder, `global::get_text_map_propagator(...inject_context...)`

## Patterns And Tradeoffs

- Sentry Rust exposes strong generic primitives: child spans, request metadata attachment, distributed trace headers, and OTel processor/propagator integration. It can carry richer request details, but `Span::set_request` can include URL, query string, cookies, headers, and data when callers provide them.
- OpenTelemetry Tower instrumentation owns middleware lifecycle, names spans from low-cardinality routes when available, records status/duration/body-size metrics, and finalizes spans after responses. It also records `url.full` and user-agent by default in the inspected source, which is useful but broader than LogBrew's public privacy default.
- Datadog Rust currently centers on OTel-compatible propagation and exporter/processor mapping. It can inject W3C, Datadog, baggage, and tracestate headers from active OTel context, but that path is heavier and depends on an OTel runtime setup.

## LogBrew Design Decision

LogBrew added dependency-free `HttpClientSpan` instead of a global `reqwest`, `ureq`, Hyper, or Tower client patch. Apps pass an app-owned route template, method, child span ID, status/duration, and optional primitive metadata. The helper returns:

- one normal `SpanEvent` that can be queued with `LogBrewClient::span(...)`;
- one exact W3C `traceparent` header value for the app-owned outbound request;
- trace/span/parent IDs so tests and examples can prove correlation.

Privacy and adoption boundaries are intentionally tighter than Sentry/OpenTelemetry/Datadog defaults: no client dependency, no global patching, no request or response body capture, no arbitrary header/cookie capture, no full URL/query/hash capture, no raw propagation metadata, no baggage, no tracestate, no support-ticket calls, and no backend usage/quota derivation. Unsafe metadata keys are dropped through the same shared filter used by DB/cache/queue dependency spans.

## Where LogBrew Is Better

- Easier first adoption for Rust services that want one outbound span and one W3C header without installing an OTel provider/exporter or accepting global client instrumentation.
- Safer default metadata than the inspected Sentry/OpenTelemetry paths: route templates are query/hash-free and caller metadata keeps only primitive, safe fields.
- Installed-artifact proof is explicit: a packaged crate smoke validates the README, exported API, emitted span, outgoing `traceparent`, and absence of unsafe metadata leakage.

## Where LogBrew Is Still Worse

- Sentry/OpenTelemetry/Datadog still have a higher ceiling for automatic client instrumentation, OTel processors/exporters, baggage/tracestate, rich span events/exceptions, links, and metrics.
- LogBrew does not yet provide typed `reqwest`, Hyper, Tower client, or `ureq` wrappers; apps must call the helper and set the returned header themselves.
- Rust still needs fuller OTel processor/exporter interop and optional framework/client integration packages if broad automatic coverage becomes worth the dependency/version cost.

## Verification

- TDD red: `cargo test --manifest-path rust/logbrew/Cargo.toml --test http_client` failed on missing `logbrew::HttpClientSpan`.
- Focused green: `cargo test --manifest-path rust/logbrew/Cargo.toml --test http_client` passed, proving sanitized route names, W3C parent/child correlation, status/duration metadata, outgoing `traceparent`, invalid method/status/duration errors, and unsafe metadata dropping.
- Installed package proof: `bash scripts/real_user_rust_http_client_smoke.sh` packaged `logbrew` and installed it into a generated Cargo app; package proof reported 32 files / 305.1 KiB / 62.0 KiB and validated README/API coverage, emitted `rust_http_client` span metadata, downstream `traceparent`, and no query/header/body leakage.
