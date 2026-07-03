# logbrew/otel

Optional OpenTelemetry bridge for the LogBrew Go SDK.

Use this module only when your app already has OpenTelemetry Go installed and you want ended OTel spans or active OTel contexts to correlate with LogBrew events.

## Install

```bash
go get github.com/LogBrewCo/sdk/go/logbrew/otel
```

The base module stays separate:

```bash
go get github.com/LogBrewCo/sdk/go/logbrew
```

## Span Exporter

```go
package main

import (
  "context"

  "github.com/LogBrewCo/sdk/go/logbrew"
  logbrewotel "github.com/LogBrewCo/sdk/go/logbrew/otel"
  sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func main() {
  client, err := logbrew.NewClient(logbrew.Config{
    APIKey:     "LOGBREW_API_KEY",
    SDKName:    "checkout-api",
    SDKVersion: "0.1.0",
  })
  if err != nil {
    panic(err)
  }

  exporter, err := logbrewotel.NewSpanExporter(client, logbrewotel.SpanExporterConfig{
    EventIDPrefix: "checkout_otel",
    Metadata:      map[string]any{"service": "checkout-api"},
  })
  if err != nil {
    panic(err)
  }

  provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exporter)))
  defer provider.Shutdown(context.Background())
}
```

`NewSpanExporter` queues ended OTel spans into the app-owned LogBrew client. It does not create global providers, own delivery transports, retry, or flush. Keep using `client.Flush` or `client.Shutdown` with an app-owned LogBrew transport.

## Context Copy

```go
trace, ok, err := logbrewotel.TraceContextFromContext(ctx, "b7ad6b7169203331")
if err != nil {
  panic(err)
}
if ok {
  ctx = logbrew.ContextWithLogBrewTrace(ctx, trace)
}
```

The bridge copies only valid OTel trace ID, span ID, and sampled flags into LogBrew child trace context. Invalid or absent OTel context returns `ok=false` without interrupting app work.

## Privacy Boundary

The exporter keeps method, route, status, database system/operation, messaging system/operation, RPC service/method, exception type, span kind, instrumentation scope, and span-link summaries. It drops full URLs, query strings, headers, cookies, payloads, SQL statements, exception messages, stacks, baggage, tracestate, and raw propagation values.
