# Rust Dependency Spans Competitor Research - 2026-06-19

## Sources Read

- Sentry Rust `getsentry/sentry-rust@7f22e359adac0214d1a75dfd887842fb902c9417`
  - `sentry-tracing/src/layer/mod.rs`: `SentryLayer`, `default_event_filter`, `default_span_filter`, `record_fields`, `on_new_span`, `on_enter`, `on_close`, `on_record`
  - `sentry-tracing/src/converters.rs`: `FieldVisitor`, `extract_event_data_with_context`, `breadcrumb_from_event`, `extract_and_remove_tags`, `record_error`
- OpenTelemetry Rust Contrib `open-telemetry/opentelemetry-rust-contrib@883881d019ba8e5a433b327f3695b613c44303d0`
  - `opentelemetry-instrumentation-tower/src/lib.rs`: `RouteExtractor`, `NoRouteExtractor`, `PathExtractor`, `HTTPLayerBuilder`, `HTTPService::call`, `ResponseFuture`, `RequestAttributeExtractor`, `ResponseAttributeExtractor`
- Datadog Rust `DataDog/dd-trace-rs@0d1d982f0464318f5c1a21c2db1c84b58ff2c95c`
  - `datadog-opentelemetry/src/mappings/sdk_span.rs`: `SdkSpan`, `from_sdk_span_data`, attributes, events, links, status, instrumentation scope
  - `instrumentation/datadog-aws-lambda/src/lib.rs`: `TracedService::new`, `with_config`, `Service::call`, synchronous writer defaults, handler context attach/finish flow

## Patterns And Tradeoffs

- Sentry Rust's `tracing` layer is mature for automatic span/log/event conversion: it creates nested spans, records fields, maps tags, and can attach current span context to events. This is more automatic than LogBrew but depends on subscriber-layer ownership and broader field handling.
- OpenTelemetry Rust Contrib's Tower instrumentation emphasizes low-cardinality route extraction, explicit request/response attribute extractors, span naming from route templates, and framework-owned middleware lifecycle. This reinforces keeping dependency and outbound work app-owned unless a framework package owns the patching.
- Datadog Rust currently leans into OpenTelemetry span data/exporter mapping plus specific Lambda instrumentation. It has richer span data surfaces, lifecycle ownership, and synchronous serverless flush choices, but it is heavier than a dependency-free first-adoption helper.

## LogBrew Design Decision

LogBrew added a dependency-free explicit builder instead of an OTEL processor, subscriber layer, database driver wrapper, or queue/cache client patch:

- `DependencyOperationSpan::database(...)`
- `DependencyOperationSpan::cache(...)`
- `DependencyOperationSpan::queue(...)`

The helper builds normal `SpanEvent`s from either `TraceparentContext` or `OpenTelemetrySpanContext`. It preserves W3C trace correlation, parent span IDs, status, duration, low-cardinality dependency metadata, primitive caller metadata, and exception type while using the existing `LogBrewClient::span(...)` validation, transport, flush, retry, and shutdown behavior.

Privacy and adoption boundaries are intentionally tighter than automatic competitors by default: no Rust driver/client imports, no global subscriber or OTEL processor requirement, no SQL/query/statement text, cache keys/values, raw queue bodies, headers, cookies, URLs, host/user/auth fields, exception messages, stacks, baggage, or tracestate capture. Unsafe metadata keys and non-primitive metadata values are dropped before span creation.

## Remaining Gaps

- Sentry/OpenTelemetry remain better for full OTEL processor/exporter interoperability, nested span lifecycle ownership, rich span events/exceptions, span links, baggage/tracestate, and automatic subscriber/driver/client integrations.
- LogBrew is now stronger for dependency-light first adoption: developers can create one DB/cache/queue span under an existing request or OTEL context without adding OTEL runtime setup or accepting broad automatic metadata capture.
- Next Rust work should target optional framework-owned helpers only when they have installed-artifact proof: `tracing`/`tracing-opentelemetry` active span extraction improvements, outbound HTTP spans, and explicit DB/cache/queue wrappers for popular clients if demand justifies dependency/version coverage.

## Verification

- Focused Rust proof: `cargo test --manifest-path rust/logbrew/Cargo.toml --test operation_tracing` passed, proving DB/cache/queue span names, W3C and OpenTelemetry parent context ingestion, duration/status metadata, exception type, primitive metadata preservation, and unsafe metadata dropping.
- Example proof: `rust/logbrew/examples/real_user_smoke.rs` now exercises the dependency span helper without changing the stable smoke output shape.
- Installed package proof: `bash scripts/real_user_rust_smoke.sh` packages the crate, confirms `src/operation_tracing.rs` and README/rustdoc coverage, installs/removes/reinstalls the packaged crate in generated Cargo apps, and runs a `smoke-dependency` binary that validates dependency span correlation plus unsafe metadata omission.
