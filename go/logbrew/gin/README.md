# logbrew/gin

Gin request telemetry for the public LogBrew Go SDK.

This optional module stays thin over the core SDK. It adds Gin middleware and
request-context ergonomics while the application keeps ownership of client
configuration, delivery, retry, flush, shutdown, and Gin recovery.

## Install

The module requires Go 1.24.0 or newer:

```bash
go get github.com/LogBrewCo/sdk/go/logbrew/gin@latest
```

## Request Middleware

Create the app-owned LogBrew client and transport first, then install the
middleware after Gin's recovery middleware:

```go
package main

import (
  "os"

  "github.com/LogBrewCo/sdk/go/logbrew"
  logbrewgin "github.com/LogBrewCo/sdk/go/logbrew/gin"
  "github.com/gin-gonic/gin"
)

func main() {
  transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{})
  must(err)
  client, err := logbrew.NewAutomaticClient(logbrew.Config{
    APIKey:     os.Getenv("LOGBREW_SERVER_API_KEY"),
    SDKName:    "checkout-api",
    SDKVersion: "1.0.0",
  }, logbrew.AutomaticDeliveryConfig{
    Transport: transport,
  })
  must(err)
  defer func() {
    _, _ = client.Shutdown(nil)
  }()

  middleware, err := logbrewgin.NewMiddleware(logbrewgin.Config{
    Client:                   client,
    CaptureRequestMetrics:   true,
    CaptureServerErrorIssues: true,
    Metadata: map[string]any{
      "service":     "checkout-api",
      "environment": "production",
    },
  })
  must(err)

  router := gin.New()
  router.Use(gin.Recovery(), middleware)
  router.GET("/checkout/:cart_id", func(c *gin.Context) {
    must(client.Log("evt_checkout_received", "2026-08-01T10:00:00Z",
      logbrew.LogAttributesWithTrace(c.Request.Context(), logbrew.LogAttributes{
        Message: "checkout request received",
        Level:   "info",
        Logger:  "checkout-api",
      }),
    ))
    c.Status(204)
  })
  must(router.Run(":8080"))
}

func must(err error) {
  if err != nil {
    panic(err)
  }
}
```

`gin.Default()` already installs Gin recovery before application-added
middleware, so use `router.Use(middleware)` with that constructor. With
`gin.New()`, install `gin.Recovery()` before the LogBrew middleware as shown.
LogBrew records the failed span and a generic type-only exception with the
`gin.recovery` mechanism, unhandled state, and bounded structured call frames.
It then re-panics so Gin's existing recovery keeps ownership of the response
and logging behavior.

The middleware always captures one request span. Duration metrics and generic
issues for ordinary 5xx responses are opt-in. Panics observed by the middleware
always produce a generic issue. `Filter` can exclude health checks or other
app-selected requests:

```go
middleware, err := logbrewgin.NewMiddleware(logbrewgin.Config{
  Client: client,
  Filter: func(c *gin.Context) bool {
    return c.FullPath() != "/health"
  },
})
```

Inside a downstream handler, use either `logbrewgin.TraceFromContext(c)` or
`logbrew.LogBrewTraceFromContext(c.Request.Context())`. App-owned logs and
issues join the request trace directly through `client.LogContext(...)` and
`client.IssueContext(...)`. The core `*AttributesWithTrace` helpers remain for
integrations that prepare attributes before capture.

## Delivery and Hosted Readback

The middleware only queues events. It never creates a transport, sends on the
request path, flushes, starts its own worker, or installs process hooks. Use
`NewAutomaticClient` as above or call `Flush` / `Shutdown` through the core SDK.

Follow the core [Go hosted-delivery guide](../README.md#create-a-project-and-confirm-hosted-delivery)
to create a project and server ingest key without a dashboard handoff, then
confirm the request telemetry through authenticated CLI readback.

## Privacy Boundary

Automatic Gin telemetry keeps the framework name, normalized standard method,
matched route template, status code/class, duration, W3C trace IDs, sampled
flag, bounded Gin error count, and type-only panic metadata. Unmatched routes
use the fixed `<unmatched>` label instead of the concrete request path.

It does not capture request or response bodies, concrete URLs, query strings,
fragments, hosts, client IPs, user identity, cookies, authorization values,
arbitrary headers, raw `traceparent`, baggage, tracestate, error messages,
panic values, raw stack text, source lines, locals, or absolute frame paths.
Generated frames contain only basename, coordinates, and bounded code identity.
Custom metadata accepts primitive low-cardinality values and drops keys that
suggest authentication material, payloads, URLs, headers, queries, or raw
propagation.
