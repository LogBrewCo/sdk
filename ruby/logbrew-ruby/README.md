# LogBrew Ruby SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-espresso-bg-512.png" alt="LogBrew logo" width="96" height="96">
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
- `LogBrew::HttpTransport` sends queued batches through Ruby's standard `Net::HTTP` with configurable endpoint, headers, timeout, and app-owned HTTP client support.
- `LogBrew::RackMiddleware` captures Rack request spans and unhandled app exceptions without requiring Rails or Rack at runtime.
- `LogBrew::RailsErrorSubscriber` captures handled/manual Rails error reports without requiring Rails at runtime.
- `shutdown(transport)` flushes queued events and rejects later writes.
- `LogBrew::RecordingTransport.always_accept` is useful when you want to inspect queued JSON before network delivery.
- `LogBrew::SdkError` exposes stable `code` and `message` values for user-facing failure handling.
