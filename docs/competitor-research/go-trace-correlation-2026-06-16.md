# Go Trace Correlation Comparison - 2026-06-16

## Scope

Follow-up to the all-SDK tracing priority. The Go SDK already had dependency-free W3C `traceparent` parsing and explicit span helpers, but it lacked the Sentry-competitive request-local correlation path: one request trace that links handler logs, captured issues, request spans, and request-duration metrics in normal `net/http` applications.

## Source Reviewed

- Sentry Go `getsentry/sentry-go` at commit `c299195fc44e4c637d24a6ba1f2b38e0ccedb816`.
- Read `http/sentryhttp.go`: `New`, `Handle`, `HandleFunc`, `handle`, and `recoverWithSentry`.
- Read `scope.go`: `resolveTrace`.
- Read `crosstest/http_link_test.go`: `sendSignals`, `requireRequestSignalsLinked`, and `TestHTTPFamilyIntegrationsLinkManualErrorsLogsMetricsAndPanicsToOTel`.
- OpenTelemetry Go contrib `open-telemetry/opentelemetry-go-contrib` at commit `abd6958a5b955e3a2bd8c11f968b221c7cace421`.
- Read `instrumentation/net/http/otelhttp/handler.go`: `NewHandler`, `NewMiddleware`, and `serveHTTP`.
- Read `instrumentation/net/http/otelhttp/labeler.go`: `Labeler`, `ContextWithLabeler`, and `LabelerFromContext`.
- Read `instrumentation/net/http/otelhttp/handler_example_test.go`.
- Datadog Go `DataDog/dd-trace-go` at commit `9ac2a9993837a76bb5fc4151aa2a4a09c7057128`.
- Read `contrib/net/http/v2/trace.go`: `TraceAndServe`.
- Read `instrumentation/httptrace/httptrace.go`: `StartRequestSpan`, `FinishRequestSpan`, and `URLFromRequest`.
- Read `instrumentation/httptrace/response_writer.go`.
- Read `contrib/log/slog/slog.go`: `NewJSONHandler`, `WrapHandler`, `Handle`, `WithAttrs`, and `WithGroup`.
- Read `contrib/log/slog/example_test.go`.

## Competitor Patterns

- Sentry's `sentryhttp` wrapper clones or creates per-request scope, continues incoming trace headers, starts a request transaction, records route/status data, attaches the span to `request.Context()`, and recovers panics into captured events linked to that request trace.
- OpenTelemetry's `otelhttp` extracts propagators from headers, starts a server span, writes the active span into `request.Context()`, wraps the response writer, updates names from route patterns, records status and metrics, and exposes request-local labels through context.
- Datadog's HTTP instrumentation extracts propagation headers, starts and finishes request spans, records status and HTTP metadata, and its `slog` wrapper adds trace/span IDs to app-owned structured logs when the log call receives a trace-bearing context.

## LogBrew Improvement From This Pass

- Added `TraceContext`, `NewTraceContext`, `ContextWithLogBrewTrace`, `LogBrewTraceFromContext`, `TraceMetadataFromContext`, `LogAttributesWithTrace`, `IssueAttributesWithTrace`, and `SpanAttributesFromTraceContext` to make request-local correlation first-class in Go.
- Added `NewHTTPHandler` / `NewHTTPHandlerFunc` for app-owned `net/http` handlers. The wrapper reads only W3C `traceparent`, falls back non-fatally on malformed propagation, stores the active trace in `context.Context`, emits one request span, and optionally emits `http.server.duration` with the same trace metadata.
- Added `NewSlogHandler` for app-owned `log/slog` handlers. It preserves the wrapped handler, queues a LogBrew log with canonical severity and primitive metadata, and adds `traceId`, `spanId`, and `parentSpanId` to the wrapped app log when a LogBrew trace is active.
- Made the Go `Client` mutex-protected so request handlers and slog handlers can safely queue events from concurrent requests.
- Added `examples/http_trace_correlation`, proving release, environment, slog, issue, request span, and request-duration metric correlation from one W3C trace.

## Where LogBrew Is Better Today

- Lighter and more explicit than Sentry/Datadog for teams that want request trace-log-error-metric correlation without automatic global HTTP patching, logger monkey-patching, body capture, header capture, raw URL capture, or a full OpenTelemetry dependency.
- The HTTP helper uses path-only route templates and the slog helper copies only primitive metadata into LogBrew events by default.
- The same APIs work without framework dependencies, so framework wrappers can layer on top while keeping the base package small.

## Where LogBrew Is Still Worse

- No automatic panic recovery helper yet; Sentry's Go HTTP integration captures panics and links them to the active request transaction.
- OpenTelemetry active-context interop was still missing in this pass; see the 2026-07-03 follow-up below for the optional bridge that closes that specific gap.
- No Gin, Chi, Echo, Fiber, gRPC, database, queue, or outbound HTTP integrations yet.
- No baggage support, rich span events, or exception stack capture controls in the Go trace helper yet.

## Updated Proof

- `go test ./...` in `go/logbrew`.
- `bash scripts/check_go_static.sh`.
- `bash scripts/real_user_go_smoke.sh`.
- `python3 scripts/check_go_http_trace_payload.py` through the installed-artifact smoke.
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_generated_artifacts.py`.

The installed-artifact Go smoke now packages and runs `examples/http_trace_correlation`, verifies release/environment/log/issue/span/metric output, proves one request span ID is reused across app log, issue, request span, and request duration metric metadata, verifies wrapped `slog` output receives trace IDs, and checks that query strings, fragments, request payload values, and non-primitive slog fields are not copied into LogBrew telemetry.

## OpenTelemetry Bridge Follow-Up - 2026-07-03

### Source Reviewed

- Sentry Go `getsentry/sentry-go` at commit `b818debe0bfa3171bd4256b60b52a0566eb7978a`.
- Read `otel/otlp/span_exporter.go`: `NewTraceExporter`, `sentryOTLPExporter.ExportSpans`, and `Shutdown`.
- Read `otel/linking_integration.go`: `NewOtelIntegration` and `SetupOnce`.
- Read `otel/internal/common/event_processor.go`: `ResolveTraceContext`.
- OpenTelemetry Go `open-telemetry/opentelemetry-go` at commit `852dabed9f85cd10d41d1c00ffcf4c8b41e1b934`.
- Read `sdk/trace/span_processor.go`: `SpanProcessor`.
- Read `sdk/trace/simple_span_processor.go`: `NewSimpleSpanProcessor` and synchronous export behavior.
- Read `sdk/trace/batch_span_processor.go`: bounded queue, drop, shutdown, and force-flush behavior.
- Read `sdk/trace/span.go`: `ReadOnlySpan`.
- Read `sdk/trace/span_exporter.go`: `SpanExporter`.
- Datadog Go `DataDog/dd-trace-go` at commit `6b801cd948a96857bcd3f3f8049416c32b354f53`.
- Read `ddtrace/opentelemetry/span.go`: OTel span adapter backed by Datadog spans.
- Read `ddtrace/opentelemetry/tracer_provider.go`: `NewTracerProvider`, `Tracer`, `Shutdown`, and `ForceFlush`.
- Read `ddtrace/opentelemetry/tracer.go`: `Start`, OTel parent/context handling, attributes, events, links, and baggage mapping.
- PostHog Go `PostHog/posthog-go` at commit `6affc1549498bbd8f8ee3fe5beaaab6da5d13ca1`.
- Searched trace-related source and found error stack trace helpers, but no general OTel span processor/exporter bridge.

### Competitor Pattern

- Sentry offers an OTel exporter path and a linking integration that resolves active OTel trace context for Sentry events.
- Datadog implements a fuller OTel tracer provider/span adapter, including attributes, links, events, status, sampling, and baggage/tracestate mapping.
- OTel Go expects exporters to honor context cancellation and leaves retry behavior to the exporter; `SimpleSpanProcessor` exports synchronously and `BatchSpanProcessor` owns bounded batching/drop behavior.

### LogBrew Improvement From This Pass

- Added optional Go module `github.com/LogBrewCo/sdk/go/logbrew/otel`; the base `github.com/LogBrewCo/sdk/go/logbrew` module remains dependency-free and still has no OTel module graph.
- Added `TraceContextFromContext` and `TraceContextFromSpanContext` to copy only valid active OTel trace ID/span ID/sampled flags into a LogBrew child trace context.
- Added `NewSpanExporter`, implementing `sdktrace.SpanExporter` by queueing ended OTel spans into an app-owned LogBrew client with safe method/route/status, DB, messaging, RPC, exception-type, span-kind, instrumentation-scope, and span-link summaries.
- Selected `go.opentelemetry.io/otel@v1.41.0`/`sdk@v1.41.0` because `v1.42+` requires Go 1.25; this preserves the current Go 1.24 SDK baseline.
- Added installed-artifact proof through `scripts/real_user_go_opentelemetry_smoke.sh`: local fake Go proxy for LogBrew parent and OTel modules, install/remove/reinstall, real OTel dependencies, context copy, span export, flush/shutdown, docs lookup, and unsafe metadata filtering.

### Where LogBrew Is Better Today

- More explicit and safer for teams that already own an OTel provider: LogBrew does not install globals, create exporters/processors, own retry, capture payloads/headers/full URLs/SQL statements/exception messages/stacks, or force OTel dependencies into the base Go module.
- The installed smoke proves root Go consumers still get only the base LogBrew module, while OTel users opt into a separate module.

### Where LogBrew Is Still Worse

- Sentry and Datadog still have richer automatic framework coverage and deeper OTel pipeline ownership.
- Datadog's OTel adapter carries richer span events, attributes, links, baggage, and tracestate; LogBrew intentionally exports a smaller privacy-bounded subset.
- Go still lacks Gin/Chi/Echo/Fiber/gRPC automatic middleware, automatic panic recovery helpers, and first-party automatic driver integrations for common DB/cache/queue clients.
