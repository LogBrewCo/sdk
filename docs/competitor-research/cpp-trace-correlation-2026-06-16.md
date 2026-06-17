# C++ Trace Correlation Research

## Gap

LogBrew C++ already had explicit span attributes, metric helpers, product timeline helpers, recording transport, and optional libcurl delivery. It did not expose an active trace context that could connect C++ logs, issues, actions, metrics, spans, product timelines, and outgoing W3C propagation from one native operation. That made the C++ SDK weaker than Sentry Native, OpenTelemetry C++, and Datadog C++ for the debugging path where users expect one trace to connect multiple signals.

## Competitor Source Read

- Sentry Native, [`getsentry/sentry-native`](https://github.com/getsentry/sentry-native) at commit `10a29ab2e594944d1dfabb4fd261e7f314dbd8d7`.
- Read `include/sentry.h`: `sentry_set_trace`, `sentry_set_trace_n`, `sentry_regenerate_trace`, `sentry_options_set_propagate_traceparent`, `sentry_span_iter_headers`, and `sentry_transaction_iter_headers`.
- Read `src/sentry_core.c`: `sentry_set_trace_n` and `sentry_regenerate_trace`.
- Read `src/sentry_tracing.c`: trace/span validation and propagation parsing.
- OpenTelemetry C++, [`open-telemetry/opentelemetry-cpp`](https://github.com/open-telemetry/opentelemetry-cpp) at commit `de26178fe5275a632a749792b4a72b625422d2ff`.
- Read `api/include/opentelemetry/trace/propagation/http_trace_context.h`: `Inject`, `Extract`, `ExtractContextFromTraceHeaders`, `InjectImpl`, `TraceIdFromHex`, `SpanIdFromHex`, and `TraceFlagsFromHex`.
- Read `sdk/src/logs/logger.cc`: `ExtractSpanContextFromContext`, `ExtractSpanContext`, and `StampSpanContextFromVariant`.
- Datadog C++, [`DataDog/dd-trace-cpp`](https://github.com/DataDog/dd-trace-cpp) at commit `0a1dc56b418262cee758c33fa6f488e9e44ab6ed`.
- Read `src/datadog/tracer.cpp`: `extract_span` and `extract_or_create_span`.
- Read `src/datadog/w3c_propagation.cpp`: `extract_traceparent`, `extract_w3c`, and `encode_traceparent`.
- Read `src/datadog/trace_segment.cpp`: `TraceSegment::inject`.

## Patterns To Reuse Safely

- Sentry Native exposes explicit trace propagation APIs and creates local span IDs for events connected to an upstream trace.
- OpenTelemetry C++ treats `SpanContext` as the validated propagation unit, rejects invalid W3C trace IDs/span IDs, injects `traceparent`, and stamps trace/span IDs onto log records when a valid context exists.
- Datadog C++ separates strict extraction from fallback creation, creates a new local span when continuing extracted context, injects W3C `traceparent`, and supports richer baggage/tracestate separately.

## LogBrew Implementation

- Added dependency-free `TraceContext` and RAII `TraceScope` to `cpp/logbrew-cpp`.
- `trace_context_from_traceparent(...)` validates W3C shape, normalizes IDs to lowercase, rejects forbidden/all-zero IDs, preserves sampled state, and creates a fresh local span ID.
- `continue_or_create_trace_context(...)` falls back to a local root trace when propagation is missing or malformed.
- `LogBrewClient` now adds active trace metadata to issue, log, action, and metric events while preserving app-owned event calls.
- Added `trace_metadata(...)`, `trace_span_attributes(...)`, `trace_product_timeline_context(...)`, and `traceparent_headers(...)` helpers for explicit metrics, spans, product timelines, and outbound app-owned clients.
- Added packaged `examples/trace_correlation.cpp` plus `scripts/check_cpp_trace_correlation_payload.py` to prove one W3C trace links a C++ issue, log, action, span, `http.server.duration` metric, product action, network milestone, and outgoing `traceparent`.

## Tradeoffs

- LogBrew stays lighter than Sentry Native, OpenTelemetry C++, and Datadog C++ by avoiding global HTTP patching, baggage/tracestate, automatic thread/process instrumentation, broad span lifecycle objects, payload capture, header capture, and raw propagation serialization.
- C++ now has a better first-useful trace/log/error correlation path for source-only native apps that want explicit control and small build surface.
- Remaining gaps versus mature competitors: no OpenTelemetry context bridge, baggage/tracestate, lifecycle spans, outbound HTTP child-span instrumentation, DB/cache/queue spans, rich span events/exceptions, or native crash symbolication integration.

## Verification

- `bash scripts/check_cpp_package.sh`: compiles C++17 core/tests/examples, validates canonical payloads, validates packaged trace correlation payload, and checks package metadata.
- `bash scripts/real_user_cpp_smoke.sh`: installs from the source archive into a temporary native app, proves remove/reinstall, validates optional HTTP retry delivery, and runs installed `run-trace-correlation`.
- `scripts/check_cpp_trace_correlation_payload.py`: validates trace/span IDs, active issue/log/action metadata, metric metadata, timeline trace IDs, outgoing `traceparent`, route query/fragment stripping, and no raw incoming propagation leakage.

## 2026-06-17 OpenTelemetry SpanContext Follow-Up

### Additional Source Read

- OpenTelemetry C++, [`open-telemetry/opentelemetry-cpp`](https://github.com/open-telemetry/opentelemetry-cpp/tree/de26178fe5275a632a749792b4a72b625422d2ff) at commit `de26178fe5275a632a749792b4a72b625422d2ff`.
- Read `api/include/opentelemetry/trace/span_context.h`: `SpanContext::IsValid`, `trace_id`, `span_id`, `trace_flags`, `IsSampled`, and `IsRemote`.
- Read `api/include/opentelemetry/trace/trace_id.h`: `TraceId::ToLowerBase16`, `IsValid`, and `CopyBytesTo`.
- Read `api/include/opentelemetry/trace/span_id.h`: `SpanId::ToLowerBase16`, `IsValid`, and `CopyBytesTo`.
- Read `api/include/opentelemetry/trace/trace_flags.h`: `TraceFlags::IsSampled`, `ToLowerBase16`, and `flags`.
- Read `api/include/opentelemetry/trace/propagation/http_trace_context.h`: `HttpTraceContext::Inject`, `Extract`, `InjectImpl`, and `ExtractContextFromTraceHeaders`.
- Sentry Native, [`getsentry/sentry-native`](https://github.com/getsentry/sentry-native/tree/10a29ab2e594944d1dfabb4fd261e7f314dbd8d7) at commit `10a29ab2e594944d1dfabb4fd261e7f314dbd8d7`.
- Read `src/sentry_tracing.c`: outgoing `sentry-trace`, baggage construction, and optional W3C `traceparent` emission.
- Read `src/sentry_core.c`: `sentry_set_trace` and `sentry_set_trace_n`.
- Read `include/sentry.h`: `sentry_options_set_propagate_traceparent`.
- Datadog C++, [`DataDog/dd-trace-cpp`](https://github.com/DataDog/dd-trace-cpp/tree/0a1dc56b418262cee758c33fa6f488e9e44ab6ed) at commit `0a1dc56b418262cee758c33fa6f488e9e44ab6ed`.
- Read `src/datadog/tracer.cpp`: `Tracer::extract_span`.
- Read `src/datadog/trace_segment.cpp`: `TraceSegment::inject` W3C branch.
- Read `test/test_span.cpp`: `injecting W3C traceparent header`.

### LogBrew Follow-Up

- Added dependency-free `OpenTelemetrySpanContext`, `open_telemetry_span_context(...)`, `open_telemetry_span_context_from_sampled(...)`, `trace_context_from_opentelemetry_span_context(...)`, and `trace_span_attributes_from_opentelemetry_span_context(...)`.
- Apps can copy only stable OTel W3C trace ID, span ID, and trace flags from an app-owned OpenTelemetry C++ `SpanContext` into a fresh LogBrew child context/span.
- The helper normalizes uppercase IDs, rejects malformed/all-zero IDs and invalid flags, derives sampled state from trace flags, creates a fresh LogBrew local span ID, and keeps the OTel span ID as the parent.
- Packaged `examples/trace_correlation.cpp` now proves the OTel parent copy path while preserving the same privacy-bounded payload contract: no tracestate, baggage, raw propagation metadata, global HTTP patching, payloads, headers, full URLs, query strings, or fragments.

### Remaining Gap

LogBrew C++ still does not ingest a live OpenTelemetry `Context`, install OpenTelemetry, add exporters/processors, preserve tracestate/baggage, emit links/events/exceptions, or automatically instrument HTTP/lifecycle/DB/cache/queue work. Those remain deliberate follow-up areas after this minimal bridge.

## 2026-06-17 Live OpenTelemetry Span Follow-Up

### Additional Source Read

- OpenTelemetry C++, [`open-telemetry/opentelemetry-cpp`](https://github.com/open-telemetry/opentelemetry-cpp/tree/d6035a817b363db74f02a401cfbe396831b60109) at commit `d6035a817b363db74f02a401cfbe396831b60109`.
- Read `api/include/opentelemetry/trace/span_context.h`: `SpanContext::IsValid`, `trace_id`, `span_id`, `trace_flags`, and `IsSampled`.
- Read `api/include/opentelemetry/trace/span.h`: `Span::GetContext`.
- Read `api/include/opentelemetry/trace/context.h`: `GetSpan(context)` for explicit `Context` extraction.
- Read `api/include/opentelemetry/trace/tracer.h`: `Tracer::GetCurrentSpan`.
- Read `api/include/opentelemetry/trace/trace_id.h`, `span_id.h`, and `trace_flags.h`: `ToLowerBase16` and validity helpers.
- Sentry Native, [`getsentry/sentry-native`](https://github.com/getsentry/sentry-native/tree/fd19f353875b7043613b7c08f565aebbf8490e16) at commit `fd19f353875b7043613b7c08f565aebbf8490e16`.
- Read `src/sentry_core.c`: `sentry_set_trace`, `sentry_set_trace_n`, and `sentry_regenerate_trace`.
- Read `src/sentry_tracing.c`: `sentry__span_iter_headers`, outgoing `sentry-trace`, baggage construction, optional W3C `traceparent`, `sentry_span_iter_headers`, and `sentry_transaction_iter_headers`.
- Read `include/sentry.h`: public trace propagation declarations and `sentry_options_set_propagate_traceparent`.
- Datadog C++, [`DataDog/dd-trace-cpp`](https://github.com/DataDog/dd-trace-cpp/tree/0a1dc56b418262cee758c33fa6f488e9e44ab6ed) at commit `0a1dc56b418262cee758c33fa6f488e9e44ab6ed`.
- Read `src/datadog/tracer.cpp`: `Tracer::extract_span` merge/error behavior.
- Read `src/datadog/trace_segment.cpp`: `TraceSegment::inject` W3C `traceparent` and `tracestate` injection.
- Read `src/datadog/w3c_propagation.cpp`: `extract_traceparent` validation and sampling extraction.

### LogBrew Follow-Up

- Added header-only template adapters that compile only when an app passes OTel-like objects: `try_open_telemetry_span_context_from_span_context(...)`, `open_telemetry_span_context_from_span_context(...)`, `try_open_telemetry_span_context_from_span(...)`, `open_telemetry_span_context_from_span(...)`, `try_open_telemetry_span_context_from_span_pointer(...)`, and `open_telemetry_span_context_from_span_pointer(...)`.
- Apps that already include OpenTelemetry C++ can call `try_open_telemetry_span_context_from_span_pointer(opentelemetry::trace::Tracer::GetCurrentSpan())` or pass `opentelemetry::trace::GetSpan(context)` for an explicit OTel `Context`; default LogBrew source builds still include no OTel headers or libraries.
- The `try_` helpers return `std::nullopt` for invalid or absent spans, while the throwing helpers keep the existing C++ `SdkException("validation_error", ...)` behavior.
- The adapters copy only valid trace ID, span ID, and trace flags through OTel's stable `ToLowerBase16` surface, then reuse LogBrew's existing validation and fresh-child-span creation.

### Tradeoffs

- This keeps LogBrew lighter than Sentry Native and Datadog C++ because it does not manage global trace scope, install exporters/processors, emit baggage/tracestate, own HTTP injection styles, or capture span attributes/events/links.
- The live active-span path is now more useful for C++ apps that already run OpenTelemetry, while preserving source-only builds for native apps that do not.
- Remaining C++ gaps are explicit OTel `Context` convenience overloads that name OTel types, full OTel span processor/exporter interop, baggage/tracestate, rich events/exceptions/links, automatic outbound/DB/cache/queue spans, URL/request phase timings, lifecycle spans, and native symbolication parity.
