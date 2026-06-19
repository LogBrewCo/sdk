# logbrew

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Go SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```bash
go get github.com/LogBrewCo/sdk/go/logbrew
```

## Example

```go
package main

import (
  "encoding/json"
  "fmt"
  "os"

  "github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
  client, err := logbrew.NewClient(logbrew.Config{
    APIKey:     "LOGBREW_API_KEY",
    SDKName:    "logbrew-go",
    SDKVersion: "0.1.0",
  })
  if err != nil {
    panic(err)
  }

  must(client.Release("evt_release_001", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
    Version: "1.2.3",
    Commit:  "abc123def456",
    Notes:   "Public release marker",
  }))
  must(client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", logbrew.EnvironmentAttributes{
    Name:   "production",
    Region: "global",
  }))
  must(client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", logbrew.IssueAttributes{
    Title:   "Checkout timeout",
    Level:   "error",
    Message: "Request timed out after retry budget",
  }))
  must(client.Log("evt_log_001", "2026-06-02T10:00:03Z", logbrew.LogAttributes{
    Message: "worker started",
    Level:   "info",
    Logger:  "job-runner",
  }))
  duration := 12.5
  must(client.Span("evt_span_001", "2026-06-02T10:00:04Z", logbrew.SpanAttributes{
    Name:       "GET /health",
    TraceID:    "trace_001",
    SpanID:     "span_001",
    Status:     "ok",
    DurationMs: &duration,
  }))
  must(client.Action("evt_action_001", "2026-06-02T10:00:05Z", logbrew.ActionAttributes{
    Name:   "deploy",
    Status: "success",
  }))

  payload, err := client.PreviewJSON()
  must(err)
  fmt.Println(payload)

  response, err := client.Shutdown(logbrew.AlwaysAcceptTransport())
  must(err)
  _ = json.NewEncoder(os.Stderr).Encode(map[string]any{
    "ok": true,
    "status": response.StatusCode,
    "attempts": response.Attempts,
    "events": 6,
  })
}

func must(err error) {
  if err != nil {
    panic(err)
  }
}
```

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples. Call `Flush` or `Shutdown` to send queued events through a transport, and use `PreviewJSON` when you want a stable local JSON preview before sending anything.

## First Useful Telemetry

For a production Go service, the first useful LogBrew payload is usually a release marker, environment marker, one service log, one product action, one network milestone, one request duration metric, and one W3C-linked request span. That gives developers and AI assistants enough context to answer "what changed?", "where did this happen?", "what did the user do?", "which API call mattered?", and "which trace links the signals?" without installing a large instrumentation stack.

```bash
go run ./examples/first_useful_telemetry
```

The example uses a fake API key, emits a local `PreviewJSON` payload, and then flushes to `AlwaysAcceptTransport`. It keeps the SDK dependency-free, app-owned, and explicit: no global `net/http` patching, no request or response payload capture, no arbitrary header capture, and no query or hash text in route metadata. Use `NewHTTPTransport` only when you are ready to send to the hosted LogBrew intake.

## Metrics

Use `Metric` for explicit, application-owned measurements. LogBrew validates the metric name, kind, value, unit, temporality, and optional metadata before queueing the event:

```go
must(client.Metric("evt_metric_queue_depth", "2026-06-02T10:00:06Z", logbrew.MetricAttributes{
  Name:        "queue.depth",
  Kind:        "gauge",
  Value:       42,
  Unit:        "{items}",
  Temporality: "instant",
  Metadata:    map[string]any{"service": "worker"},
}))
```

Supported metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms require `delta` or `cumulative` temporality and non-negative values; gauges require `instant` temporality and may be negative. Keep metadata low-cardinality and primitive. This SDK does not automatically collect runtime or framework metrics yet.

## Trace Context

Use the dependency-free W3C helpers when a Go service needs to continue incoming distributed trace context without taking an OpenTelemetry dependency:

```go
traceparent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
context, err := logbrew.ParseTraceparent(traceparent)
if err != nil {
  panic(err)
}

duration := 8.5
attributes, err := logbrew.SpanAttributesFromTraceparent(logbrew.TraceparentSpanInput{
  Traceparent: traceparent,
  Name:        "GET /health",
  SpanID:      "b7ad6b7169203331",
  Status:      "ok",
  DurationMs:  &duration,
  Metadata: map[string]any{
    "framework": "net/http",
    "sampled":   context.Sampled,
  },
})
if err != nil {
  panic(err)
}

must(client.Span("evt_request_span", "2026-06-02T10:00:04Z", attributes))
outgoing, err := logbrew.CreateTraceparent(context.TraceID, attributes.SpanID, context.TraceFlags)
if err != nil {
  panic(err)
}
fmt.Println(outgoing)
```

`ParseTraceparent` validates W3C shape, rejects forbidden version `ff`, rejects all-zero trace/span IDs, normalizes IDs to lowercase, and exposes the sampled flag. `SpanAttributesFromTraceparent` returns LogBrew span attributes with `TraceID` from the incoming trace and `ParentSpanID` from the incoming parent span, while copying only primitive metadata values. `CreateTraceparent` emits a normalized outgoing `traceparent` from explicit IDs and defaults empty flags to sampled `01`.

For request-local correlation, use `NewTraceContext` and attach it with `ContextWithLogBrewTrace`. `LogBrewTraceFromContext` returns the active request trace, and `LogAttributesWithTrace` / `IssueAttributesWithTrace` merge primitive trace metadata into app-owned logs and issues:

```go
trace, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
  Traceparent: r.Header.Get("traceparent"),
})
if err != nil {
  // Treat malformed incoming propagation as non-fatal in request handlers.
  trace, err = logbrew.NewTraceContext(logbrew.TraceContextInput{})
}
if err != nil {
  panic(err)
}
r = r.WithContext(logbrew.ContextWithLogBrewTrace(r.Context(), trace))

must(client.Log("evt_handler_log", "2026-06-02T10:00:03Z", logbrew.LogAttributesWithTrace(r.Context(), logbrew.LogAttributes{
  Message: "checkout handler reached",
  Level:   "info",
  Logger:  "checkout-service",
})))
```

`NewHTTPHandler` wraps an app-owned `net/http` handler, reads only W3C `traceparent`, creates one request span, optionally emits `http.server.duration`, and passes the active `TraceContext` to downstream code through `context.Context`. `NewSlogHandler` wraps an app-owned `slog.Handler`, queues a LogBrew log, and adds `traceId` / `spanId` fields to the wrapped app log when the context contains a LogBrew trace:

```go
slogHandler, err := logbrew.NewSlogHandler(logbrew.SlogHandlerConfig{
  Client:  client,
  Wrapped: slog.NewJSONHandler(os.Stdout, nil),
  Logger:  "checkout-service",
})
if err != nil {
  panic(err)
}
logger := slog.New(slogHandler)

handler, err := logbrew.NewHTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
  logger.InfoContext(r.Context(), "checkout handler reached", slog.String("cartTier", "standard"))
  w.WriteHeader(http.StatusNoContent)
}), logbrew.HTTPHandlerConfig{
  Client:               client,
  RouteTemplate:        "/checkout/:cart_id",
  CaptureRequestMetric: true,
})
if err != nil {
  panic(err)
}
http.Handle("/checkout/", handler)
```

The HTTP and slog helpers are dependency-free and explicit. They do not patch global HTTP clients, do not capture request or response bodies, do not capture arbitrary headers, and strip query/hash text from route metadata. Run `go run ./examples/http_trace_correlation` for a copyable local example where release, environment, slog, issue, request span, and request-duration metric events share the same W3C trace.

## Outbound `net/http` Client Spans

Use `NewHTTPClientTransport` when you want one outbound client span around app-owned `http.Client` calls:

```go
transport, err := logbrew.NewHTTPClientTransport(logbrew.HTTPClientTransportConfig{
  Client:        client,
  Base:          http.DefaultTransport,
  RouteTemplate: "/payments/:payment_id",
  EventIDPrefix: "checkout_http",
  Metadata:      map[string]any{"service": "checkout-api"},
})
if err != nil {
  panic(err)
}

httpClient := &http.Client{Transport: transport}
request, err := http.NewRequestWithContext(
  r.Context(),
  http.MethodGet,
  "https://api.example.com/payments/123?coupon=summer",
  nil,
)
if err != nil {
  panic(err)
}
response, err := httpClient.Do(request)
```

The transport clones the request before writing exactly one W3C `traceparent`, scopes the downstream call under a child `TraceContext`, queues one span with method, query-free route, status, duration, sampled flag, and primitive metadata, then returns the original response or error. HTTP 4xx/5xx responses and transport errors are marked as failed dependency spans. Malformed active trace state falls back to a local trace and reports through `OnError`; telemetry capture failures also report through `OnError` and do not replace the app-owned HTTP result. It does not patch global clients, does not capture request or response payloads, does not store headers, cookies, full URLs, query strings, fragments, baggage, tracestate, or raw propagation values. Run `go run ./examples/http_client_trace` for a local example of downstream propagation and span capture.

## Dependency Spans

Use `DatabaseOperationWithLogBrewSpan`, `CacheOperationWithLogBrewSpan`, and `QueueOperationWithLogBrewSpan` around app-owned database, cache, or queue calls when you want request-to-dependency timing without driver monkeypatching:

```go
result, err := logbrew.DatabaseOperationWithLogBrewSpan(r.Context(), client, "select checkout", func(ctx context.Context) (string, error) {
  // Use ctx for your database call so logs inside the callback can share the child trace.
  return "order_123", nil
}, logbrew.DatabaseOperationConfig{
  System:            "postgresql",
  OperationKind:     "query",
  DatabaseName:      "orders",
  StatementTemplate: "SELECT * FROM orders WHERE id = ?",
  Metadata:          map[string]any{"service": "checkout"},
})
```

Each helper creates a child `TraceContext`, activates it for the callback, records one span, returns the original result, and re-raises the original error. Metadata is primitive-only and intentionally drops SQL text, parameters, connection details, cache keys/values, commands, message bodies, broker URLs, headers, cookies, and auth-like fields. These helpers do not import or patch `database/sql`, Redis, Kafka, AMQP, or queue clients; future automatic coverage should live in explicit integration packages with separate dependency and privacy validation.

## Agent-Readable Timelines

Use `CreateProductActionAttributes` and `CreateNetworkMilestoneAttributes` when your Go service already knows important product steps or API milestones. The helpers create normal `action` event attributes with primitive metadata that AI assistants can analyze across sessions without visual replay, global HTTP patching, payload capture, or header capture.

```go
context, err := logbrew.ParseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
if err != nil {
  panic(err)
}

action, err := logbrew.CreateProductActionAttributes(logbrew.ProductActionInput{
  Name:          "checkout.started",
  SessionID:     "sess_checkout_123",
  TraceID:       context.TraceID,
  RouteTemplate: "/checkout/:step?email=user@example.com#pay",
  Screen:        "Checkout",
  Funnel:        "checkout",
  Step:          "started",
})
if err != nil {
  panic(err)
}
must(client.Action("evt_checkout_started", "2026-06-02T10:00:00Z", action))

statusCode := 202
durationMs := 64.5
network, err := logbrew.CreateNetworkMilestoneAttributes(logbrew.NetworkMilestoneInput{
  RouteTemplate: "https://api.example.com/v1/payments/:id?debug=true#trace",
  Method:        "post",
  StatusCode:    &statusCode,
  DurationMs:    &durationMs,
  SessionID:     "sess_checkout_123",
  TraceID:       context.TraceID,
  Metadata:      map[string]any{"region": "global"},
})
if err != nil {
  panic(err)
}
must(client.Action("evt_payment_api", "2026-06-02T10:00:01Z", network))
```

Route templates are stripped to path-only values before queueing, nested metadata is dropped, HTTP methods are normalized, and 4xx/5xx status codes default network milestone status to `failure`. The `examples/agent_timeline` package contains a focused preview of product and network milestones correlated by `sessionId` and W3C `traceId`; `examples/first_useful_telemetry` shows the same timeline signals alongside release, environment, log, metric, and span events; `examples/http_trace_correlation` shows request-local trace, slog, issue, request span, and duration metric correlation in a local `net/http` app.

## HTTP Delivery

Use `NewHTTPTransport` for real outbound delivery from server-side Go apps:

```go
transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
  Endpoint: logbrew.DefaultHTTPEndpoint,
  Headers: map[string]string{"x-logbrew-source": "go-worker"},
})
if err != nil {
  panic(err)
}

response, err := client.Flush(transport)
if err != nil {
  panic(err)
}
fmt.Println(response.StatusCode)
```

`HTTPTransport` uses Go's standard `net/http` client, posts JSON, passes the SDK key through the `authorization` header, supports custom endpoint/header/client/timeout settings, drains and closes response bodies, and maps client delivery failures into retryable `NetworkError(...)` values so `Client.Flush` can preserve queued events and retry. Inject a custom `*http.Client` when a service already owns proxy, TLS, or timeout settings.

The `examples` directory contains copyable snippets for creating a client, previewing queued JSON, sending through `HTTPTransport`, producing a first-useful telemetry payload, correlating `net/http` + `slog` signals, and using W3C trace propagation in your own Go service.
