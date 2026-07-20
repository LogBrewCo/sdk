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

## High-Load Behavior

`NewClient` keeps the in-memory event queue bounded to 1,000 events by default. Set `Config.MaxQueueSize` when your service needs a larger or smaller local buffer. When the queue is full, LogBrew drops new events instead of blocking app logging or discarding already-buffered release/environment/request context. Use `DroppedEvents()` for a local counter and `OnEventDropped` for an advisory callback:

```go
client, err := logbrew.NewClient(logbrew.Config{
  APIKey:       "LOGBREW_API_KEY",
  SDKName:      "go-worker",
  SDKVersion:   "0.1.0",
  MaxRetries:   1,
  MaxQueueSize: 1000,
  OnEventDropped: func(drop logbrew.EventDrop) {
    fmt.Printf("dropped %s %s after %d total drops\n", drop.EventType, drop.EventID, drop.DroppedEvents)
  },
})
must(err)
```

`EventDrop` contains only `eventId`, `eventType`, `reason`, and the cumulative dropped count; it never includes event attributes, payloads, API keys, headers, or transport details. The advisory callback is panic-safe and cannot interrupt capture. `Flush` and `Shutdown` still preserve accepted events across retryable transport failures, and `DroppedEvents()` is not reset by a successful flush.

## Automatic Delivery

Keep the existing manual behavior by using `NewClient`. To let a client own delivery, use `NewAutomaticClient` with one app-scoped transport:

```go
transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{})
must(err)

client, err := logbrew.NewAutomaticClient(logbrew.Config{
  APIKey:     "LOGBREW_API_KEY",
  SDKName:    "checkout-api",
  SDKVersion: "0.1.0",
}, logbrew.AutomaticDeliveryConfig{
  Transport: transport,
})
must(err)
defer func() {
  _, _ = client.Shutdown(nil)
}()
```

Automatic delivery starts lazily after the first accepted event. It flushes every two seconds or at 100 queued events by default, whichever happens first, while reusing the same bounded queue and serialized flush path. Override `FlushInterval` and `FlushThreshold` when needed. Retryable failures preserve one immutable failed prefix. Without a server directive, automatic delivery uses the existing immediate retry budget before capped equal-jitter scheduling from 100 milliseconds to five seconds. Later captures remain queued separately. For `408` and `5xx` responses, the standard HTTP transport honors one unambiguous RFC `Retry-After` delta-seconds or IMF-fixdate value without bypassing the client backoff floor, and clamps it to `RetryMaxDelay`. Malformed, duplicate, unsupported, or past values use the jittered client fallback instead of an immediate retry. Authentication (`401`/`403`), quota (`402`/`429`), and other non-retryable responses pause automatic delivery until the application fixes the cause and calls `ResumeDelivery`.

`DeliveryHealth()` returns only fixed lifecycle state, queue/drop counts, in-flight/coalesced state, bounded backoff source/outcome/delay fields, and counters. Backoff diagnostics distinguish the selected client or server delay and invalid server directives, but never retain the header value or clock input. The snapshot never contains event content or identifiers, API keys, endpoints, headers, paths, hosts, response text, or arbitrary metadata. `Shutdown(nil)` stops scheduling and drains through the owned transport. If that final send fails, queued work remains available for a later explicit `Shutdown(nil)` retry, while new captures stay rejected. The client installs no signal, process, or exit hooks; the application remains responsible for calling shutdown and for configuring an HTTP timeout appropriate to its runtime.

### Encrypted restart persistence

`NewPersistentAutomaticClient` is an opt-in extension of the same automatic client. It durably encrypts the existing queue before capture returns, recovers events oldest first after restart, and stores the exact failed request prefix so a retry after restart uses byte-identical request data. Ordinary `NewClient` and `NewAutomaticClient` behavior remains memory-only.

```go
// Load the same 32-byte key from your application's secure configuration on every
// restart. Do not generate a new key for an existing directory.
persistenceKey := loadApplicationPersistenceKey()

client, err := logbrew.NewPersistentAutomaticClient(logbrew.Config{
  APIKey:       "LOGBREW_API_KEY",
  SDKName:      "checkout-api",
  SDKVersion:   "0.1.0",
  MaxQueueSize: 1000,
}, logbrew.AutomaticDeliveryConfig{
  Transport: transport,
}, logbrew.PersistentDeliveryConfig{
  Directory:      "/var/lib/checkout-api/logbrew",
  EncryptionKey:  persistenceKey,
  MaxStoredBytes: 4 * 1024 * 1024,
})
must(err)
```

Persistence uses standard-library AES-256-GCM with a fresh nonce for every rewrite. The 32-byte key stays caller-owned and is never persisted or logged. Event count remains bounded by `Config.MaxQueueSize`; serialized event bytes default to 4 MiB and can be configured up to 16 MiB. Queue state, failed request bytes, event IDs, and the SDK identity inside a frozen request are authenticated, encrypted, and bound to the dedicated store's ownership marker. Outside that ciphertext, only fixed filenames, the content-free ownership marker, and a content-free transaction digest remain visible. API keys, transport authentication values, endpoints, headers, PIDs, hosts, and configured paths are not stored.

The configured directory is canonicalized to a dedicated leaf and must support verifiable owner-only POSIX modes, regular-file identity, single-link checks, advisory exclusive locking, file sync, and directory sync. Unsupported filesystems fail with `persistence_unsupported`; there is no plaintext or weak-permission fallback. Symlinked store leaves, unexpected files, unsafe links, unauthenticated corruption, the wrong key, concurrent ownership, inherited post-fork ownership, and file replacement while a process owns the store fail closed before delivery. A clean `Shutdown(nil)` releases ownership. The client adds no process hooks, shutdown hooks, or extra delivery queue.

Event content remains application-controlled sensitive data even when encrypted. Keep the directory private, protect and rotate the key using an app-owned migration, and use a different dedicated directory per logical client. `PurgePersistentDelivery` is an explicit destructive recovery operation: it acquires exclusive ownership, rejects unknown paths, removes only recognized persistence files, resets the content-free ownership marker, and synchronizes the directory. It accepts any valid 32-byte key value because purge must remain possible after the old key is lost.

An accepted prefix is removed from restart recovery only after its replacement queue snapshot and parent directory are durable. A crash after the remote service accepts a request but before that local acknowledgement completes can still resend the encrypted prefix after restart; transports and event processing should therefore remain idempotent. No local design can atomically commit a remote response and a filesystem update.

The app and its local filesystem owner remain inside the trust boundary. Without an external monotonic authority, the SDK cannot distinguish restoration of an entire older but internally valid persistence directory from a normal restart. Protect or back up the directory as one unit, and purge it if owner-driven rollback is suspected.

## First Useful Telemetry

For a production Go service, the first useful LogBrew payload is usually a release marker, environment marker, one service log, one product action, one network milestone, one request duration metric, and one W3C-linked request span. That gives developers and AI assistants enough context to answer "what changed?", "where did this happen?", "what did the user do?", "which API call mattered?", and "which trace links the signals?" without installing a large instrumentation stack.

```bash
go run ./examples/first_useful_telemetry
```

The example uses a fake API key, emits a local `PreviewJSON` payload, and then flushes to `AlwaysAcceptTransport`. It keeps the SDK dependency-free, app-owned, and explicit: no global `net/http` patching, no request or response payload capture, no arbitrary header capture, and no query or hash text in route metadata. Use `NewHTTPTransport` only when you are ready to send to the hosted LogBrew intake.

## Support Ticket Drafts

Use `CreateSupportTicketDraft` when a developer or support agent explicitly asks for a local JSON payload for the planned LogBrew support-ticket routes. The helper validates the public source/category contract, normalizes W3C trace IDs, redacts diagnostics, and returns a `SupportTicketDraft`. It does not send data, open a ticket, call backend support-ticket routes, use account/session API credentials, or infer backend ownership.

```go
draft, err := logbrew.CreateSupportTicketDraft(logbrew.SupportTicketDraftInput{
  Source:      "sdk",
  Category:    "ingest_failure",
  Title:       "Telemetry flush failed",
  Description: "Flush returned usage_limit_exceeded",
  ProjectID:   "proj_123",
  Environment: "production",
  Runtime:     "go1.25",
  Framework:   "net/http",
  SDKPackage:  "github.com/LogBrewCo/sdk/go/logbrew",
  SDKVersion:  "0.1.0",
  Release:     "checkout@1.2.3",
  TraceID:     "4bf92f3577b34da6a3ce929d0e0e4736",
  EventID:     "evt_checkout_flush",
  Diagnostics: map[string]any{
    "attemptCount": 2,
    "endpoint":    "https://api.example/ingest?debug=true",
    "localPath":   "<local-app-path>",
  },
})
if err != nil {
  panic(err)
}
_ = draft
```

Diagnostics are bounded to JSON-like values. Auth-like keys, cookies, tokens, URL origins, local paths, unsupported objects, and raw error messages are redacted or omitted before the draft is returned. Network ticket creation should remain a separate explicit user or agent action only after backend reports deployed support-ticket storage and routes.

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

## OpenTelemetry Bridge

If your Go app already installs OpenTelemetry, add the optional bridge module instead of changing the base SDK install:

```bash
go get github.com/LogBrewCo/sdk/go/logbrew/otel
```

```go
import (
  logbrewotel "github.com/LogBrewCo/sdk/go/logbrew/otel"
  sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

exporter, err := logbrewotel.NewSpanExporter(client, logbrewotel.SpanExporterConfig{
  EventIDPrefix: "checkout_otel",
  Metadata:      map[string]any{"service": "checkout-api"},
})
if err != nil {
  panic(err)
}
provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exporter)))
_ = provider
```

`TraceContextFromContext` and `TraceContextFromSpanContext` copy only valid OTel trace ID, span ID, and sampled flags into LogBrew child trace context. `NewSpanExporter` queues ended OTel spans as LogBrew span events with safe method/route/status, database, messaging, RPC, exception-type, span-kind, instrumentation-scope, and span-link summaries. It does not install global providers, own exporters/processors, retry, flush, capture full URLs, headers, payloads, SQL statements, exception messages, stacks, baggage, tracestate, or raw propagation values. Keep using `client.Flush` or `client.Shutdown` with your app-owned transport.

`NewHTTPHandler` wraps an app-owned `net/http` handler, accepts exactly one valid W3C `traceparent`, creates one request span, optionally emits `http.server.duration`, and passes the active `TraceContext` to downstream code through `context.Context`. It uses the matched `http.ServeMux` pattern or an explicit `RouteTemplate`; when neither is available it records `/` instead of the raw request path. The outermost LogBrew wrapper owns nested instrumentation so the same request is emitted once. If the handler panics, LogBrew records one failed request span and one generic correlated issue with type-only panic metadata, then re-panics with the original value. Ordinary 5xx responses remain span-only unless `NewHTTPHandlerWithOptions` receives `WithHTTPServerErrorIssues()`. `NewSlogHandler` wraps an app-owned `slog.Handler`, queues a LogBrew log, and adds `traceId` / `spanId` fields to the wrapped app log when the context contains a LogBrew trace:

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

handler, err := logbrew.NewHTTPHandlerWithOptions(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
  logger.InfoContext(r.Context(), "checkout handler reached", slog.String("cartTier", "standard"))
  w.WriteHeader(http.StatusNoContent)
}), logbrew.HTTPHandlerConfig{
  Client:               client,
  RouteTemplate:        "/checkout/:cart_id",
  CaptureRequestMetric: true,
}, logbrew.WithHTTPServerErrorIssues())
if err != nil {
  panic(err)
}
http.Handle("/checkout/", handler)
```

The HTTP and slog helpers are dependency-free and explicit. The HTTP wrapper preserves cancellation/deadlines, `http.Flusher`, `http.Hijacker`, `http.Pusher`, `io.ReaderFrom`, and `http.ResponseController` unwrapping when the app writer supports them. It does not patch globals, add workers, buffer bodies, capture request or response bodies, capture arbitrary headers, capture panic messages or stacks, or use raw URLs, query strings, fragments, cookies, authentication values, IPs, user identity, hosts, or local paths. Custom or unknown HTTP methods are recorded as `OTHER`. Run `go run ./examples/http_trace_correlation` for a copyable local example where release, environment, slog, issue, request span, and request-duration metric events share the same W3C trace.

## Outbound `net/http` Client Spans

Use `NewHTTPClientTransport` when you want one outbound client span around app-owned `http.Client` calls:

```go
transport, err := logbrew.NewHTTPClientTransport(logbrew.HTTPClientTransportConfig{
  Client:        client,
  Base:          http.DefaultTransport,
  EventIDPrefix: "checkout_http",
  // Optional: finish successful spans when the response body reaches EOF or Close.
  // Always close response bodies in your app code.
  FinishSpanOnResponseBodyClose: true,
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

The transport is an explicit app-owned wrapper; it never changes `http.DefaultTransport` or unrelated clients. A valid active LogBrew parent creates one child for each actual `RoundTrip`, and the request clone receives the matching W3C `traceparent`. With no valid parent, the original request goes directly to the selected transport without tracing work. Caller request headers and context remain unchanged, responses and errors keep their original identity, and capture failures are advisory. Direct duplicate registration returns the first wrapper; nested wrappers coalesce through the request context, and LogBrew delivery requests are excluded.

Place retry or redirect middleware outside this wrapper when each actual attempt should have its own child span. The fixed span metadata contains only method, normalized non-IP host when safe, status, duration, source, sampled state, real cancellation, and a bounded error class. It never stores scheme, port, path, query, fragment, full URL, headers, bodies or sizes, authentication material, cookies, baggage, tracestate, IP addresses, arbitrary metadata, error messages, stacks, or transport internals. `RouteTemplate`, `Metadata`, and `CapturePhaseTimings` remain in the config for source compatibility but are ignored and not retained. `FinishSpanOnResponseBodyClose` can defer capture while preserving body reads, writes, EOF, close, and errors. Run `go run ./examples/http_client_trace` for a local propagation and span-capture example.

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

Each helper creates a child `TraceContext`, activates it for the callback, records one span, returns the original result, and re-raises the original error. If the callback panics, LogBrew records one failed span with type-only panic metadata, then re-panics with the original value. Metadata is primitive-only and intentionally drops SQL text, parameters, connection details, cache keys/values, commands, message bodies, broker URLs, headers, cookies, raw `traceparent` values, baggage, tracestate, panic messages, stacks, and auth-like fields. These helpers do not import or patch `database/sql`, Redis, Kafka, AMQP, or queue clients; future automatic coverage should live in explicit integration packages with separate dependency and privacy validation.

For app-owned queue clients, use `TraceparentSetter` to write exactly one outgoing W3C `traceparent`, `IncomingTraceparent` to continue one valid message trace while processing, and `LinkedTraceparents` or `SpanLinkSummary` values to summarize batch/fan-in relationships. Use `SpanLinkSummaryFromTraceparent` for message-carrier traceparents or `NewSpanLinkSummary` for explicit W3C trace/span IDs:

```go
headers := map[string]string{}
_, err = logbrew.QueueOperationWithLogBrewSpan(r.Context(), client, "publish checkout", func(ctx context.Context) (string, error) {
  // Send your Kafka/SQS/Pub/Sub/AMQP message here with headers["traceparent"].
  return "published", nil
}, logbrew.QueueOperationConfig{
  System:        "kafka",
  OperationKind: "publish",
  QueueName:     "checkout-events",
  TaskName:      "checkout.completed",
  TraceparentSetter: func(traceparent string) error {
    headers["traceparent"] = traceparent
    return nil
  },
})
if err != nil {
  panic(err)
}

messageCount := 2
_, err = logbrew.QueueOperationWithLogBrewSpan(context.Background(), client, "process checkout batch", func(ctx context.Context) (int, error) {
  // Logs emitted with ctx correlate to the message-processing child span.
  return 2, nil
}, logbrew.QueueOperationConfig{
  System:              "kafka",
  OperationKind:       "process",
  QueueName:           "checkout-events",
  MessageCount:        &messageCount,
  IncomingTraceparent: headers["traceparent"],
  LinkedTraceparents:  []string{headers["traceparent"]},
  LinkMetadata:        map[string]any{"relation": "batch_item"},
})
```

Malformed incoming or linked propagation is reported through `OnError` as a redacted diagnostic and skipped without interrupting app work. Span links are capped at eight and store only normalized trace ID, span ID, sampled flag, and primitive safe metadata.

For common `database/sql` calls, use `SQLQueryContextWithLogBrewSpan` and `SQLExecContextWithLogBrewSpan` with an app-owned `*sql.DB`, `*sql.Tx`, `*sql.Conn`, or prepared `*sql.Stmt`:

```go
rows, err := logbrew.SQLQueryContextWithLogBrewSpan(
  r.Context(),
  client,
  db,
  "lookup checkout order",
  "SELECT * FROM orders WHERE account_ref = ?",
  logbrew.DatabaseOperationConfig{
    System:       "postgresql",
    DatabaseName: "orders",
    Metadata:     map[string]any{"service": "checkout"},
  },
  accountRef,
)
_ = rows
_ = err
```

The SQL helpers keep the same explicit boundary as the generic database helper. LogBrew passes query text and args only to query-text runners such as `*sql.DB`, `*sql.Tx`, and `*sql.Conn`; prepared statement runners such as `*sql.Stmt` receive args only. The exported runner interfaces are `SQLQueryContextRunner`, `SQLExecContextRunner`, `SQLStatementQueryContextRunner`, and `SQLStatementExecContextRunner`. In both cases LogBrew activates a child trace for logs inside that call, records safe operation metadata, and captures `RowsAffected()` for successful exec results when the driver exposes it. It does not wrap or register drivers, does not alter app connection inputs, and does not capture query text, parameters, connection details, user names, result rows, exception messages, stacks, baggage, or tracestate. If you want a sanitized statement template in telemetry, pass your own placeholder-only `StatementTemplate`; LogBrew will not derive one from query text.

For transaction-level hierarchy, use `SQLTransactionWithLogBrewSpan` with an app-owned `*sql.DB` or `*sql.Conn`, then pass the callback context to SQL query/exec helpers so those child spans sit under the transaction span:

```go
result, err := logbrew.SQLTransactionWithLogBrewSpan(
  r.Context(),
  client,
  db,
  "checkout transaction",
  nil,
  func(txCtx context.Context, tx *sql.Tx) (string, error) {
    _, err := logbrew.SQLExecContextWithLogBrewSpan(
      txCtx,
      client,
      tx,
      "insert checkout order",
      "INSERT INTO orders(account_ref) VALUES (?)",
      logbrew.DatabaseOperationConfig{System: "postgresql", DatabaseName: "orders"},
      accountRef,
    )
    if err != nil {
      return "", err
    }
    return "committed", nil
  },
  logbrew.DatabaseOperationConfig{System: "postgresql", DatabaseName: "orders"},
)
_ = result
_ = err
```

The transaction helper begins through the app-owned `SQLBeginTxRunner`, commits when the callback succeeds, rolls back when the callback returns an error, rolls back before re-panicking when the callback panics, records a safe `dbTransactionOutcome`, and preserves the original callback, commit error, or panic. Rollback failures are reported through `OnError` with a redacted SDK diagnostic. It does not wrap drivers, register global SQL drivers, patch pools, capture SQL text, parameters, DSNs, connection details, result rows, exception messages, stacks, baggage, or tracestate.

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
