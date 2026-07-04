# LogBrew Ruby SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Ruby SDK for building, validating, previewing, and flushing LogBrew event batches, with standard-library `Net::HTTP` delivery, opt-in standard-library `Logger` support, Rack-compatible middleware, and a Rails error subscriber for Rails apps.

The package uses only Ruby standard-library features at runtime.

## Install

```bash
gem install logbrew-sdk
```

## Usage

```ruby
require "logbrew"

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "my-ruby-app",
  sdk_version: "1.0.0"
)

client.release(
  "evt_release_001",
  "2026-06-02T10:00:00Z",
  version: "1.2.3",
  commit: "abc123def456"
)
client.action(
  "evt_action_001",
  "2026-06-02T10:00:05Z",
  name: "deploy",
  status: "success"
)

puts client.preview_json
response = client.shutdown(LogBrew::RecordingTransport.always_accept)
warn response.status_code
```

## First Useful Service Telemetry

For a service request, combine release, environment, log, product action, network milestone, metric, and span events around one shared W3C trace:

```ruby
incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
trace = LogBrew::Traceparent.parse(incoming)
child_span_id = "b7ad6b7169203331"
route_template = "/checkout/:cart_id"
session_id = "sess_checkout_123"

client.log(
  "evt_log_checkout_started",
  "2026-06-02T10:00:02Z",
  message: "checkout request started",
  level: "info",
  logger: "checkout",
  metadata: { traceId: trace.trace_id, sessionId: session_id, routeTemplate: route_template }
)
client.action(
  "evt_action_checkout_submit",
  "2026-06-02T10:00:03Z",
  LogBrew::ProductTimeline.product_action(
    name: "checkout.submit",
    route_template: "/checkout/:cart_id",
    session_id: session_id,
    trace_id: trace.trace_id,
    screen: "Checkout",
    funnel: "checkout",
    step: "submit"
  )
)
client.metric(
  "evt_metric_http_server_duration",
  "2026-06-02T10:00:05Z",
  name: "http.server.duration",
  kind: "histogram",
  value: 183.4,
  unit: "ms",
  temporality: "delta",
  metadata: { method: "POST", routeTemplate: route_template, statusCode: 202, traceId: trace.trace_id }
)
client.span(
  "evt_span_checkout_request",
  "2026-06-02T10:00:06Z",
  LogBrew::Traceparent.span_attributes_from_traceparent(
    trace,
    LogBrew::TraceparentSpanInput.new(
      name: "POST /checkout/:cart_id",
      span_id: child_span_id,
      duration_ms: 183.4,
      metadata: { sampled: trace.sampled, routeTemplate: route_template, sessionId: session_id }
    )
  )
)

outgoing_headers = LogBrew::Traceparent.create_headers(
  trace_id: trace.trace_id,
  span_id: child_span_id,
  trace_flags: trace.trace_flags
)
```

The packaged `examples/first_useful_telemetry.rb` file shows the full flow, including release, environment, and network milestone events. Route templates stay query-free, metadata is primitive-only, and the SDK does not capture request bodies or arbitrary transport metadata.

## W3C Trace Context

Use `LogBrew::Traceparent` when your app already has an incoming or outgoing W3C `traceparent` value:

```ruby
trace = LogBrew::Traceparent.parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
headers = LogBrew::Traceparent.create_headers(
  trace_id: trace.trace_id,
  span_id: "b7ad6b7169203331",
  trace_flags: trace.trace_flags
)
```

The helper accepts W3C-shaped values, rejects forbidden or all-zero IDs, normalizes uppercase hex to lowercase, exposes the sampled flag, and creates LogBrew child span attributes with a new caller-provided span ID. It does not patch Ruby HTTP clients.

## HTTP Request Trace Correlation

Use `LogBrew::RackMiddleware` and `LogBrew::Trace.current` when request logs, handled errors, product actions, metrics, and the request span should share one W3C trace:

```ruby
app = lambda do |_env|
  trace = LogBrew::Trace.current
  logger.info("checkout started")
  client.metric(
    "evt_checkout_duration",
    "2026-06-02T10:00:05Z",
    name: "http.server.duration",
    kind: "histogram",
    value: 183.4,
    unit: "ms",
    temporality: "delta",
    metadata: { routeTemplate: "/checkout/:cart_id", statusCode: 202 }
  )
  outgoing_headers = LogBrew::Trace.create_headers(trace)
  [202, {}, ["ok"]]
end

rack = LogBrew::RackMiddleware.new(app, client: client)
```

The middleware reads only W3C `traceparent`, creates a request-local span ID, exposes `LogBrew::Trace.current` while your app runs, and uses that same span ID on the emitted request span. `LogBrew::Logger`, direct `client.log`, `client.issue`, `client.action`, `client.metric`, and `LogBrew::RailsErrorSubscriber` add active `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled` metadata when a request trace is active. Malformed propagation falls back to a local root trace without raising into the app. Raw propagation values, request bodies, arbitrary headers, cookies, and query strings are not captured.

## Dependency Operation Spans

Use `LogBrew::OperationTracing` when your app owns the database, cache, or queue call and wants one correlated dependency span without monkeypatching ActiveRecord, Redis, Sidekiq, or other Ruby libraries:

```ruby
result = LogBrew::OperationTracing.database_operation(
  client,
  "users.lookup",
  system: "postgresql",
  operation: "select",
  target: "users",
  metadata: { service: "api", rowCount: 1 }
) do
  User.find_by(email: email)
end
```

`database_operation`, `cache_operation`, and `queue_operation` run your block under a child `LogBrew::Trace` context, preserve the block result or original exception, and emit exactly one span with primitive metadata. Capture failures can be observed with `on_error:` without replacing app behavior. The helpers intentionally drop SQL statements, query params, connection strings, cache keys/values, message bodies, job IDs, headers, cookies, URLs, auth-like fields, and other sensitive-looking metadata. Failed dependency spans include only the exception type in metadata plus one bounded `exception` span event with `exceptionType` and `exceptionEscaped: true`; exception messages and stacks stay out by default.

## Metrics

Use `metric` for explicit, application-owned measurements. LogBrew validates the metric name, kind, value, unit, temporality, and optional metadata before queueing the event:

```ruby
client.metric(
  "evt_metric_queue_depth",
  "2026-06-02T10:00:06Z",
  name: "queue.depth",
  kind: "gauge",
  value: 42,
  unit: "{items}",
  temporality: "instant",
  metadata: { service: "worker", queue: "checkout" }
)
```

Supported metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms require `delta` or `cumulative` temporality and non-negative values; gauges require `instant` temporality and may be negative. Keep metadata low-cardinality and primitive. This SDK does not automatically collect Ruby runtime, Rack, Rails, or database metrics yet.

## Product And Network Timelines

Use `LogBrew::ProductTimeline` when your app already knows the product step or API milestone that matters and you want an agent-readable timeline without recording a visual session replay:

```ruby
client.action(
  "evt_checkout_submit",
  "2026-06-02T10:00:07Z",
  LogBrew::ProductTimeline.product_action(
    name: "checkout.submit",
    route_template: "/checkout/:cart_id",
    session_id: "session_123",
    trace_id: "trace_123",
    screen: "Checkout",
    funnel: "purchase",
    step: "submit",
    metadata: { plan: "pro" }
  )
)

client.action(
  "evt_checkout_api",
  "2026-06-02T10:00:08Z",
  LogBrew::ProductTimeline.network_milestone(
    route_template: "/api/checkout/:cart_id",
    method: "POST",
    status_code: 503,
    duration_ms: 42.5,
    session_id: "session_123",
    trace_id: "trace_123",
    metadata: { region: "iad" }
  )
)
```

The helpers return normal `action` attributes, so they work with the existing queue, preview, flush, and retry behavior. They accept only primitive metadata, copy it defensively, strip query strings and hashes from route templates, reduce full HTTP URLs to paths, normalize HTTP methods, and infer failed network milestones from `4xx`/`5xx` status codes. They do not patch `Net::HTTP`, capture request or response payloads, capture arbitrary headers, auto-capture clicks, or claim visual replay.

## Support Ticket Draft Diagnostics

Use `LogBrew::SupportTicketDraft.create` when a developer or support agent explicitly asks for a local JSON payload for the planned LogBrew support-ticket routes. The helper validates the public source/category contract, normalizes W3C trace IDs, redacts diagnostics, and returns a plain Ruby hash:

```ruby
draft = LogBrew::SupportTicketDraft.create(
  source: "sdk",
  category: "ingest_failure",
  title: "Telemetry flush failed",
  description: "Flush returned usage_limit_exceeded",
  sdk_package: "logbrew-sdk",
  sdk_version: "0.1.0",
  trace_id: "4BF92F3577B34DA6A3CE929D0E0E4736",
  diagnostics: {
    endpoint: "https://api.example/ingest?debug=true",
    apiKey: "lbw_ingest_redacted",
    error: RuntimeError.new("hidden token")
  }
)

puts JSON.generate(draft)
```

This helper is local-only. It does not send data, open a ticket, call backend support-ticket routes, use account/session API credentials, or infer backend ownership. Diagnostics are bounded to JSON-like values; token-like keys and strings are redacted, HTTP URLs keep only the path, local filesystem paths are replaced, exceptions keep only the class name, and unsupported Ruby objects are omitted.

## HTTP Delivery

Use `LogBrew::HttpTransport` when you want the SDK to POST queued batches to LogBrew:

```ruby
require "logbrew"

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "my-ruby-app",
  sdk_version: "1.0.0"
)
client.log("evt_log_001", "2026-06-02T10:00:03Z", message: "worker started", level: "info")

transport = LogBrew::HttpTransport.new(
  endpoint: LogBrew::HttpTransport::DEFAULT_ENDPOINT,
  headers: { "x-logbrew-source" => "ruby-worker" },
  timeout: 10
)

response = client.shutdown(transport)
warn response.status_code
```

`HttpTransport` sends JSON with the SDK key in the `authorization` header, supports a custom endpoint, headers, timeout, and app-owned HTTP client object, maps HTTP statuses through the client's retry rules, and converts request/time-out failures into retryable transport errors.

## Example Source

The `examples` directory contains copyable snippets for creating a client, sending through `HttpTransport`, using the standard logger wrapper, attaching Rack middleware, and subscribing to Rails errors in your own Ruby app.

## Standard Logger

`LogBrew::Logger` subclasses Ruby's standard `::Logger`, so existing Ruby logging calls can queue LogBrew log events without adding a runtime dependency.

```ruby
require "logbrew"

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "my-ruby-app",
  sdk_version: "1.0.0"
)

logger = LogBrew::Logger.new(
  client: client,
  logger_name: "checkout",
  progname: "checkout",
  metadata: { service: "web" }
)

logger.warn("checkout slow")
logger.error(RuntimeError.new("payment failed"))

client.flush(LogBrew::RecordingTransport.always_accept)
```

The adapter respects Ruby logger levels and lazy block messages, maps `DEBUG`/`INFO` to LogBrew `info`, `WARN` to `warning`, `ERROR` to `error`, and `FATAL` to `critical`, captures `progname`, primitive base metadata, and exception type/message, and omits exception backtrace text unless `include_exception_backtrace: true` is set. Logs queue by default; pass `transport:` plus `flush_on_log: true` or call `flush_logbrew` for immediate delivery.

## Rack And Rails Middleware

Use `LogBrew::RackMiddleware` when a Rails, Sinatra, or Rack app should capture request spans and unhandled app exceptions without adding a framework dependency to the SDK.

```ruby
require "logbrew"

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "my-rails-app",
  sdk_version: "1.0.0"
)

# Rails: config/application.rb
config.middleware.use(
  LogBrew::RackMiddleware,
  client: client,
  transport: LogBrew::HttpTransport.new,
  flush_on_response: true,
  metadata: { service: "web" }
)
```

For plain Rack apps, wrap the app directly:

```ruby
app = LogBrew::RackMiddleware.new(
  ->(_env) { [200, { "content-type" => "text/plain" }, ["ok"]] },
  client: client
)
```

The middleware records successful responses as span events, records unhandled app exceptions as issue plus error-span events, and re-raises app exceptions so Rails or Rack keeps normal response handling. It captures method, path without query text, status code, request id when present, primitive base metadata, exception type/message, and duration. Exception backtrace text is omitted unless `include_exception_backtrace: true` is set. Events queue by default; pass `transport:` plus `flush_on_response: true` when each response should flush.

## Rails Error Subscriber

Use `LogBrew::RailsErrorSubscriber` when handled or manually reported Rails errors should queue LogBrew issue events through Rails' own error reporter.

```ruby
require "logbrew"

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "my-rails-app",
  sdk_version: "1.0.0"
)

# Rails: config/initializers/logbrew.rb
Rails.error.subscribe(
  LogBrew::RailsErrorSubscriber.new(
    client: client,
    transport: LogBrew::HttpTransport.new,
    flush_on_report: true,
    metadata: { service: "web" }
  )
)
```

The subscriber implements `report(error, handled:, severity:, context:, source:, **options)`, captures handled state, severity, Rails source, primitive context values, primitive base metadata, and exception type/message, and omits exception backtrace text unless `include_exception_backtrace: true` is set. It queues by default; pass `transport:` plus `flush_on_report: true` when each report should flush. If you also use `LogBrew::RackMiddleware`, keep the subscriber focused on handled/manual reports so unhandled request exceptions are not captured twice.

## Behavior

- `preview_json` returns the queued batch as pretty JSON.
- `flush(transport)` sends queued events, retries retryable failures, and clears the queue only after a 2xx response.
- `metric(...)` queues explicit, application-owned metric events with name, kind, value, unit, temporality, and low-cardinality metadata validation.
- `LogBrew::ProductTimeline` builds explicit, application-owned product action and network milestone timeline events with primitive metadata and query/hash-free routes.
- `LogBrew::SupportTicketDraft.create` builds explicit, local-only support-ticket create payload drafts with redacted diagnostics and no backend route calls.
- `LogBrew::HttpTransport` sends queued batches through Ruby's standard `Net::HTTP` with configurable endpoint, headers, timeout, and app-owned HTTP client support.
- `LogBrew::RackMiddleware` captures Rack request spans and unhandled app exceptions without requiring Rails or Rack at runtime.
- `LogBrew::RailsErrorSubscriber` captures handled/manual Rails error reports without requiring Rails at runtime.
- `shutdown(transport)` flushes queued events and rejects later writes.
- `LogBrew::RecordingTransport.always_accept` is useful when you want to inspect queued JSON before network delivery.
- `LogBrew::SdkError` exposes stable `code` and `message` values for user-facing failure handling.
