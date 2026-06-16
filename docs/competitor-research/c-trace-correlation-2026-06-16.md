# C Trace Correlation Research - 2026-06-16

## Gap

LogBrew C already had explicit span attributes, product timeline helpers, metric helpers, recording transport, and optional libcurl delivery. It did not have an active trace context that could connect C logs, issues, actions, metrics, spans, and outgoing W3C propagation from one request or native operation. That made the C SDK weaker than Sentry Native, OpenTelemetry C++, and Datadog C++ for the debugging path where users expect a trace to connect multiple telemetry signals.

## Public Source Read

- Sentry Native, [`getsentry/sentry-native`](https://github.com/getsentry/sentry-native) at commit `10a29ab2e594944d1dfabb4fd261e7f314dbd8d7`.
- Read `include/sentry.h`: `sentry_set_trace`, `sentry_set_trace_n`, `sentry_regenerate_trace`, `sentry_set_span`, and `sentry_span_iter_headers`.
- Read `src/sentry_core.c`: `sentry_set_trace_n`, `sentry_regenerate_trace`, and `sentry_set_span`.
- Read `src/sentry_tracing.c`: `sentry__span_iter_headers`, `sentry_span_iter_headers`, and `sentry_transaction_iter_headers`.
- OpenTelemetry C++, [`open-telemetry/opentelemetry-cpp`](https://github.com/open-telemetry/opentelemetry-cpp) at commit `de26178fe5275a632a749792b4a72b625422d2ff`.
- Read `api/include/opentelemetry/trace/propagation/http_trace_context.h`: `Inject`, `Extract`, `ExtractContextFromTraceHeaders`, `InjectImpl`, `TraceIdFromHex`, `SpanIdFromHex`, and `TraceFlagsFromHex`.
- Read `api/include/opentelemetry/trace/span_context.h`: `SpanContext`, `IsValid`, `IsRemote`, and `IsSampled`.
- Read `sdk/src/logs/logger.cc`: `ExtractSpanContextFromContext`, `ExtractSpanContext`, and `StampSpanContextFromVariant`.
- Datadog C++, [`DataDog/dd-trace-cpp`](https://github.com/DataDog/dd-trace-cpp) at commit `0a1dc56b418262cee758c33fa6f488e9e44ab6ed`.
- Read `src/datadog/tracer.cpp`: `extract_span` and `extract_or_create_span`.
- Read `src/datadog/trace_segment.cpp`: `TraceSegment::inject`.
- Read `src/datadog/w3c_propagation.cpp`: `extract_traceparent`, `extract_w3c`, and `encode_traceparent`.

## Patterns Observed

- Sentry Native keeps scope/span state and lets downstream SDKs set trace identity so captures across layers can correlate. It can iterate outgoing trace headers from the active span or transaction.
- OpenTelemetry C++ models `SpanContext` as the propagation unit, validates W3C `traceparent`, rejects invalid IDs, and stamps trace/span IDs into logs when a valid context is present.
- Datadog C++ separates strict extraction from fallback creation, supports multiple propagation formats, and injects `traceparent` from the active span while keeping baggage/tracestate as a richer optional layer.

## LogBrew Change

- Added dependency-free `LogBrewTraceContext`, `LogBrewTraceScope`, and trace helpers in `c/logbrew-c/src/logbrew_trace.c`.
- `logbrew_trace_context_from_traceparent(...)` strictly validates W3C shape, normalizes IDs to lowercase, rejects forbidden/all-zero IDs, preserves sampled flags, and creates a fresh local span ID for the C process.
- `logbrew_trace_continue_or_create_context(...)` gives request boundaries a non-fatal fallback for missing or malformed propagation while strict parsing remains available.
- `logbrew_trace_scope_enter(...)` / `logbrew_trace_scope_exit(...)` expose an active compiler-TLS scope for C99 builds on common compilers without adding dependencies.
- `logbrew_client_issue(...)`, `logbrew_client_log(...)`, and `logbrew_client_action(...)` now automatically include active trace metadata without changing their public attribute structs.
- `logbrew_trace_metadata(...)`, `logbrew_trace_product_timeline_context(...)`, `logbrew_trace_span_attributes(...)`, and `logbrew_trace_create_headers(...)` keep metric, timeline, span, and outgoing propagation correlation explicit at the call site.
- `logbrew_client_metric(...)` now serializes metadata under `attributes.metadata`, aligning C with the shared event contract and allowing trace metadata without unsupported top-level metric fields.
- Added packaged `examples/trace_correlation.c` plus `scripts/check_c_trace_correlation_payload.py` to prove one W3C request trace links a C issue, log, action, span, `http.server.duration` metric, product action, network milestone, and outgoing `traceparent`.

## Tradeoffs

- C stays much lighter than Sentry Native, OTel C++, and Datadog C++ by avoiding global HTTP patching, baggage/tracestate, automatic thread/process instrumentation, broad span lifecycle objects, payload capture, header capture, and raw propagation serialization.
- Active context uses compiler TLS where available under the repo's strict C99 flags. This is pragmatic for Apple clang/GCC-style compilers, but it is not a complete portable threading abstraction for every C99 compiler.
- C still lacks rich native lifecycle spans, outbound HTTP child-span helpers, OpenTelemetry context ingestion, baggage/tracestate, rich span events/exceptions, and automatic crash/symbolication integration.

## Verification

- `bash scripts/check_c_package.sh` passed with Apple clang `21.0.0`.
- `bash scripts/real_user_c_smoke.sh` passed with Apple clang `21.0.0`.
- `scripts/check_c_trace_correlation_payload.py` validates trace/span IDs, active issue/log/action metadata, metric metadata, timeline trace IDs, outgoing `traceparent`, query/fragment stripping, and no raw incoming propagation leakage.
