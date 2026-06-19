# Rust HTTP Client Span Comparison - 2026-06-19

## Sources Read

- Sentry Rust `getsentry/sentry-rust@7f22e359adac0214d1a75dfd887842fb902c9417`
  - `sentry-core/src/performance.rs`: `Transaction::start_child`, `Transaction::start_child_with_details`, `Span::set_request`, `Span::iter_headers`, `Span::set_status`, `Span::finish_with_timestamp`
  - `sentry-opentelemetry/src/propagator.rs`: `SentryPropagator::inject_context`, `extract_with_context`, propagated `sentry-trace` header behavior
  - `sentry-opentelemetry/src/processor.rs`: `SentrySpanProcessor::on_start`, `on_end`, OTel span-to-Sentry transaction/span mapping
- OpenTelemetry Rust Contrib `open-telemetry/opentelemetry-rust-contrib@883881d019ba8e5a433b327f3695b613c44303d0`
  - `opentelemetry-instrumentation-actix-web/src/client.rs`: `ClientExt::trace_request`, `InstrumentedClientRequest::trace_request`, `record_response`, `record_err`, `ActixClientCarrier::set`
  - `opentelemetry-instrumentation-actix-web/examples/client.rs`: explicit `client.get(...).trace_request().send().await` flow
  - `opentelemetry-instrumentation-tower/src/lib.rs`: `RouteExtractor`, `PathExtractor`, `HTTPLayerBuilder`, `HTTPService::call`, `ResponseFuture`, `finalize_request`
- Datadog Rust `DataDog/dd-trace-rs@0d1d982f0464318f5c1a21c2db1c84b58ff2c95c`
  - `datadog-opentelemetry/src/text_map_propagator.rs`: `DatadogPropagator::inject_context`, W3C/Datadog propagation conversion, baggage/tracestate handling
  - `datadog-opentelemetry/examples/propagator/src/server.rs`: `send_request`, Hyper request builder, `global::get_text_map_propagator(...inject_context...)`

## Patterns And Tradeoffs

- Sentry Rust exposes strong generic primitives: child spans, request metadata attachment, distributed trace headers, and OTel processor/propagator integration. It can carry richer request details, but `Span::set_request` can include URL, query string, cookies, headers, and data when callers provide them.
- OpenTelemetry Actix client instrumentation wraps the client request object, starts a client span, injects propagation, records response status or error, and returns the original client result. Tower instrumentation applies the same ownership pattern to services, names spans from low-cardinality routes when available, records status/duration/body-size metrics, and finalizes spans after responses. It can also record `url.full` and user-agent by default in inspected paths, which is useful but broader than LogBrew's public privacy default.
- Datadog Rust currently centers on OTel-compatible propagation and exporter/processor mapping. It can inject W3C, Datadog, baggage, and tracestate headers from active OTel context, but that path is heavier and depends on an OTel runtime setup.

## LogBrew Design Decision

LogBrew added dependency-free `HttpClientSpan` instead of a global `reqwest`, Hyper, Tower, or `ureq` client patch. Apps pass an app-owned route template, method, child span ID, status/duration, and optional primitive metadata. The helper returns:

- one normal `SpanEvent` that can be queued with `LogBrewClient::span(...)`;
- one exact W3C `traceparent` header value for the app-owned outbound request;
- trace/span/parent IDs so tests and examples can prove correlation.

For Rust apps that already use `ureq`, the existing `http` feature now also exposes `HttpClientSpan::capture_ureq_call(...)`. It validates propagation before the call, passes exactly one `traceparent` value to the app-owned request closure, measures duration, records response status or `ureq` error type, queues one span, and returns the original `ureq` response/error.

For Rust apps that already use `reqwest`, the separate `reqwest` feature now exposes `HttpClientSpan::capture_reqwest_send(...)`. It validates propagation before the send, injects exactly one `traceparent` on the app-owned `RequestBuilder`, measures duration, records response status or request error type, queues one span, and returns the original `reqwest::Response` or typed `ReqwestCaptureError::Request(reqwest::Error)`. Setup validation failures stay separate as `ReqwestCaptureError::Setup(SdkError)` instead of being disguised as transport failures.

Privacy and adoption boundaries are intentionally tighter than Sentry/OpenTelemetry/Datadog defaults: no client dependency, no global patching, no request or response body capture, no arbitrary header/cookie capture, no full URL/query/hash capture, no raw propagation metadata, no baggage, no tracestate, no support-ticket calls, and no backend usage/quota derivation. Unsafe metadata keys are dropped through the same shared filter used by DB/cache/queue dependency spans.

## Where LogBrew Is Better

- Easier first adoption for Rust services that want one outbound span and one W3C header without installing an OTel provider/exporter or accepting global client instrumentation.
- Easier typed `ureq` and `reqwest` adoption than manual spans: the helpers preserve the app's agent/request ownership and original HTTP result while automatically timing, injecting propagation, and queuing the span.
- Safer default metadata than the inspected Sentry/OpenTelemetry paths: route templates are query/hash-free and caller metadata keeps only primitive, safe fields.
- Installed-artifact proof is explicit: a packaged crate smoke validates the README, exported API, manual emitted span, `ureq` capture path, `reqwest` capture path, outgoing `traceparent`, and absence of unsafe metadata leakage.

## Where LogBrew Is Still Worse

- Sentry/OpenTelemetry/Datadog still have a higher ceiling for automatic client instrumentation, OTel processors/exporters, baggage/tracestate, rich span events/exceptions, links, and metrics.
- LogBrew does not yet provide typed Hyper or Tower client wrappers; non-`ureq`/non-`reqwest` apps still call the manual helper and set the returned header themselves.
- Rust still needs fuller OTel processor/exporter interop and optional framework/client integration packages if broad automatic coverage becomes worth the dependency/version cost.

## Verification

- TDD red: `cargo test --manifest-path rust/logbrew/Cargo.toml --test http_client` failed on missing `logbrew::HttpClientSpan`.
- Focused green: `cargo test --manifest-path rust/logbrew/Cargo.toml --test http_client` passed, proving sanitized route names, W3C parent/child correlation, status/duration metadata, outgoing `traceparent`, invalid method/status/duration errors, and unsafe metadata dropping.
- TDD red for the `ureq` path: `cargo test --manifest-path rust/logbrew/Cargo.toml --features http --test http_client http_client_span_captures_ureq_call_result_and_preserves_error` failed on missing `capture_ureq_call`.
- Focused `ureq` green: the same command passed, proving original success/error preservation, downstream `traceparent`, status capture for `ureq::Error::StatusCode`, span status, duration metadata, and query/hash dropping.
- TDD red for the `reqwest` path: `cargo test --manifest-path rust/logbrew/Cargo.toml --features reqwest --test http_client http_client_span_captures_reqwest_send_result_and_preserves_error` failed on missing `capture_reqwest_send`.
- Focused `reqwest` green: the same command passed, proving app-owned `RequestBuilder` send, downstream `traceparent`, response status capture, typed request/setup error boundary, span status, duration metadata, and query/hash dropping.
- Installed package proof: `bash scripts/real_user_rust_http_client_smoke.sh` packaged `logbrew` and installed it into a generated Cargo app with `logbrew`'s `http` and `reqwest` features plus direct `ureq@3.3` and `reqwest@0.12`; package proof validates README/API coverage, manual emitted `rust_http_client` span metadata, `ureq` capture metadata, `reqwest` capture metadata, downstream `traceparent`, and no unsafe metadata leakage.
