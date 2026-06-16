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
- No OpenTelemetry active context interop yet; LogBrew continues W3C headers but does not read an existing OTel span from context.
- No Gin, Chi, Echo, Fiber, gRPC, database, queue, or outbound HTTP integrations yet.
- No baggage support, rich span events, or exception stack capture controls in the Go trace helper yet.

## Updated Proof

- `go test ./...` in `go/logbrew`.
- `bash scripts/check_go_static.sh`.
- `bash scripts/real_user_go_smoke.sh`.
- `python3 scripts/check_go_http_trace_payload.py` through the installed-artifact smoke.
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_generated_artifacts.py`.

The installed-artifact Go smoke now packages and runs `examples/http_trace_correlation`, verifies release/environment/log/issue/span/metric output, proves one request span ID is reused across app log, issue, request span, and request duration metric metadata, verifies wrapped `slog` output receives trace IDs, and checks that query strings, fragments, request payload values, and non-primitive slog fields are not copied into LogBrew telemetry.
