# logbrew

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

The `examples` directory contains copyable snippets for creating a client, previewing queued JSON, sending through `HTTPTransport`, and using W3C trace propagation in your own Go service.
