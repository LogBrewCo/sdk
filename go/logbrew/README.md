# logbrew

Public Go SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```bash
go get github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew
go mod tidy
go mod download -json github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew
cd examples && make
cd examples && make run-readme-example
cd examples && make run
cd examples && make run-real-user-smoke
go run ./examples/readme_example
go run ./examples/real_user_smoke
go build -o smoke-app-bin .
go version -m smoke-app-bin
go list -m github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew NewClient
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew Config
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew Event
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew ReleaseAttributes
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew EnvironmentAttributes
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew IssueAttributes
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew LogAttributes
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew SpanAttributes
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew TraceparentContext
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew TraceparentSpanInput
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew ParseTraceparent
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew CreateTraceparent
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew SpanAttributesFromTraceparent
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew ActionAttributes
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew SdkError
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew Transport
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew TransportResponse
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew TransportError
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew NetworkError
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew DefaultHTTPEndpoint
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew HTTPTransportConfig
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew HTTPTransport
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew NewHTTPTransport
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew RecordingTransport
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew RecordingTransport.LastBody
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew AlwaysAcceptTransport
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew AsTransportError
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew Client.PendingEvents
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew Client.PreviewJSON
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew Client.Flush
go doc github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew Client.Shutdown
```

## Example

```go
package main

import (
  "encoding/json"
  "fmt"
  "os"

  "github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew"
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

Use a clearly fake placeholder like `LOGBREW_API_KEY` in local examples and tests. Call `Flush` or `Shutdown` to send queued events through a transport, and use `PreviewJSON` when you want a stable local JSON preview without sending anything.

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

`HTTPTransport` uses Go's standard `net/http` client, posts JSON, passes the SDK key through the `authorization` header, supports custom endpoint/header/client/timeout settings, drains and closes response bodies, and maps client delivery failures into retryable `NetworkError(...)` values so `Client.Flush` can preserve queued events and retry. Inject a custom `*http.Client` when a service already owns proxy, TLS, timeout, or test transport settings.

Installed `go doc` output should also expose the field-level meaning of `Config`, `Event`, `TransportResponse`, and `RecordingTransport.SentBodies`, not just the top-level type names.
A fresh temp module should also be able to resolve the SDK from a standard module-proxy artifact at `v0.1.0`, not only through a local workspace `replace`.
That proxy artifact should also keep the expected `.info`, `.mod`, and `.zip` metadata, plus the shipped `examples/Makefile`, `examples/readme_example/main.go`, `examples/real_user_smoke/main.go`, and `examples/real_user_smoke/Makefile` files, and a temp app should be able to start through `go mod init`, add the SDK through `go get`, and then let `go mod tidy` leave the expected direct `go.mod` requirement plus `go.sum` hash entries for the module and its `go.mod`. A separate temp lifecycle module should also prove that `go get github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew@none` removes that dependency from `go.mod` and `go list -m all` before `go get ...@v0.1.0` adds it back. The proxy artifact plus installed module cache should still carry the `go get` command, the fake `LOGBREW_API_KEY` placeholder, `PreviewJSON` guidance, W3C trace context helper guidance, and the shared `examples/Makefile` helper commands a real consumer may inspect after download. The shipped examples should also run directly from the extracted module artifact before the temp app flow starts, both through raw `go run ./examples/readme_example` and `go run ./examples/real_user_smoke`, and the downloaded `examples/Makefile` should give users one discoverable helper surface for both flows, with plain `make` printing copy-pasteable `make run-readme-example`, `make run`, and `make run-real-user-smoke` commands before the README example runs through `make run-readme-example` and the stronger real-user path runs through `make run` or `make run-real-user-smoke`. The nested `examples/real_user_smoke/Makefile` should still keep the shorter smoke-only helper path too. After `go mod tidy`, `go mod verify` should also confirm the downloaded module cache is intact, and both `go list -m all` plus `go list -m -json all` should still show the temp app root plus the installed `github.com/LogBrewCo/LogBrewCo-sdk/go/logbrew v0.1.0` module. Later `go list -deps -json ./...` should also keep the expected `smoke-app` package entry plus the installed `logbrew` dependency package metadata before `go build`, `go test`, `go vet`, `go list`, `go doc`, and `go run` checks succeed under `-mod=readonly` so the generated module state is actually enforced, including through a temp `Makefile` that wraps the key readonly build, test, vet, smoke-app, README-example, and W3C trace helper commands a consumer may keep around locally.
