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

## Serialized Worker Lifecycle

Use `LogBrew::WorkerLifecycle` when a prefork or long-running worker processes
one work item at a time and needs an explicit telemetry boundary:

```ruby
client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "checkout-worker",
  sdk_version: "1.0.0"
)
transport = LogBrew::HttpTransport.new
lifecycle = LogBrew::WorkerLifecycle.create(
  client: client,
  transport: transport,
  on_delivery_failure: ->(failure) {
    warn "LogBrew delivery #{failure.code}; #{failure.pending_events} events retained"
  }
)

result = lifecycle.run do
  client.log(
    "evt_job_started",
    Time.now.utc.iso8601,
    message: "job started",
    level: "info",
    logger: "checkout-worker"
  )
  perform_one_job
end

lifecycle.shutdown
```

Create the client, transport, and lifecycle inside each child process after
forking. An inherited lifecycle rejects both work and shutdown before touching
its copied queue or transport, and ownership is checked again after application
work so a process change cannot flush copied parent state. `run` attempts one
bounded flush whether the application returns or raises, but always preserves
the exact application result or original exception. Delivery diagnostics expose
only a stable stage/code and aggregate queued/dropped counts; they never include
event content, request bodies, authorization values, exception messages,
process IDs, paths, or transport state.

This helper is intentionally explicit and installs no background thread,
timer, signal hook, global fork patch, destructor, or `at_exit` flush. It is for
serialized worker loops, not concurrent Sidekiq-style job execution. Keep using
direct `client.flush`/`client.shutdown`, or a framework-specific integration,
when that lifecycle fits the application better.

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

The helper accepts W3C-shaped values, rejects forbidden or all-zero IDs, normalizes uppercase hex to lowercase, exposes the sampled flag, and creates LogBrew child span attributes with a new caller-provided span ID. It does not patch Ruby HTTP clients globally.

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

## Outbound HTTP Tracing

Wrap an app-owned `Net::HTTP` connection explicitly when outbound work should become a child of the active LogBrew trace:

```ruby
uri = URI("https://service.example/health")
http = LogBrew::HttpClientTracing.wrap_net_http(
  Net::HTTP.new(uri.host, uri.port),
  client: client,
  on_capture_error: ->(error) { warn(error.class.name) }
)

response = http.request(Net::HTTP::Get.new(uri.request_uri))
```

Faraday remains optional. Apps that already use Faraday can load the integration and place its middleware inside retry middleware so every actual retry receives a distinct child span:

```ruby
require "faraday"
require "logbrew/faraday_tracing"

connection = Faraday.new("https://service.example") do |builder|
  builder.use LogBrew::FaradayTracingMiddleware, client: client
  builder.adapter :net_http
end
```

Both adapters are literal pass-throughs when `LogBrew::Trace.current` is absent. With an active parent, they propagate one W3C `traceparent`, return the caller-visible header and trace scope to their prior values, and capture one completion span per actual execution. Duplicate wrappers, nested LogBrew HTTP middleware, and SDK delivery are suppressed without process-wide hooks. Net::HTTP start blocks, response streaming, Faraday middleware ordering, responses, and exceptions retain their normal behavior; telemetry capture failures are advisory.

Outbound HTTP spans allow only method, normalized host, status code, duration, adapter source, sampled state, and exception type. They never record scheme, port, path, query, fragment, full URL, request or response headers, bodies or sizes, exception messages or stacks, authentication material, cookies, baggage, tracestate, resolved addresses, or arbitrary request options.

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

## Bounded Delivery

The client bounds queued telemetry and each transport request independently. Queue defaults are 1,000 events and 4 MiB of compact event JSON. Request defaults are 100 events and 256 KiB. When a queue limit is reached, LogBrew rejects the new event so earlier release, environment, and trace context stays available for the next flush. An event that cannot fit one request is rejected before it enters the queue.

```ruby
dropped = 0
client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "my-ruby-app",
  sdk_version: "1.0.0",
  max_queue_size: 1_000,
  max_queue_bytes: 4 * 1024 * 1024,
  max_batch_size: 100,
  max_batch_bytes: 256 * 1024,
  on_event_dropped: lambda do |notice|
    dropped = notice.dropped_events
    warn "LogBrew queue pressure: #{notice.reason} (#{dropped} dropped)"
  end
)
```

`pending_events`, `pending_event_bytes`, and `dropped_events` expose local pressure without a network call. Events are serialized once at capture, so later mutation of caller-owned strings or metadata cannot change queued content, byte accounting, or retry bodies. `LogBrew::DroppedEvent` contains only the rejected event ID/type, the stable reason `queue_overflow`, `event_too_large`, or opt-in `persistence_failure`, cumulative loss, and retained count/bytes; it never includes event attributes or payload content. Callback errors are isolated from application capture.

Transport bodies use compact JSON and stay under both request limits. `response.attempts` aggregates every request attempt and `response.batches` reports accepted request batches. Each successful request removes only its accepted queue prefix. If a later batch fails, its events and every later event remain queued in order. The failed body is frozen across later `flush` or `shutdown` calls, so events captured after failure cannot change retry bytes. A flush drains only the events present when it started; events captured during transport I/O remain queued.

Existing custom transports keep the same `send(api_key, body)` interface, but they must allow one `flush` to call `send` more than once. Treat each call as an independent compact request and use `response.batches` when application code needs the accepted request count; do not assume one transport call per flush.

`shutdown` rejects new capture while its final flush is running, closes only after every start-snapshot batch is accepted, and reopens capture if delivery fails. Clients created with `Client.create` own no background worker or timer; applications keep explicit control over when network delivery happens.

## Automatic Delivery

Applications that own their transport can opt into one lazy delivery worker. Manual clients remain the default.

```ruby
transport = LogBrew::HttpTransport.new(timeout: 10)
client = LogBrew::Client.create_automatic(
  api_key: ENV.fetch("LOGBREW_API_KEY"),
  sdk_name: "checkout-worker",
  sdk_version: "1.0.0",
  transport: transport,
  flush_interval: 5,
  flush_threshold: 100,
  retry_base_delay: 0.25,
  retry_max_delay: 30,
  persistent_queue_path: ENV["LOGBREW_PERSISTENT_QUEUE_PATH"]
)

client.log("evt_job_started", Time.now.utc.iso8601, message: "job started", level: "info")
warn JSON.generate(client.delivery_health.to_h)
client.shutdown
```

The worker starts only after accepted queue work exists, then wakes when the queue reaches `flush_threshold` or `flush_interval` expires. Restart-hydrated persistent work wakes it immediately. Automatic and manual sends share the existing serialized flush, immutable failed prefix, accepted-prefix acknowledgement, batch bounds, and persistence format; no second queue or transport path is created.

Retryable network, `408`, and `5xx` failures retain the exact failed body and use capped equal-jitter backoff. Authentication (`401`/`403`), quota (`429`), validation (`400`/`422`), and other non-retryable responses pause automatic sends without dropping queued work. `recover_automatic_delivery` performs one explicit synchronous flush through the owned transport and resumes scheduling only after success. Calling `flush(transport)` directly provides the same explicit recovery boundary. `stop_automatic_delivery` joins the worker without draining or discarding work; a later manual flush remains available.

`delivery_health` returns an immutable, JSON-serializable `LogBrew::DeliveryHealth` snapshot. Its fixed fields are lifecycle state, queued event/byte counts, dropped count, in-flight state, bounded outcome/failure/flush counters, pause reason, and current retry delay. It never contains event data, event IDs, API keys, endpoints, headers, response bodies, filesystem paths, process or thread IDs, exception messages, or server text.

Automatic ownership is process-local. An inherited automatic client rejects capture, flush, purge, stop, and shutdown after `fork`; each child must create a fresh client, transport, and persistent queue owner. No signal handler, global fork hook, `at_exit`, or finalizer is installed. `shutdown` stops and joins the worker before its final drain, and a failed drain reopens the client with retryable failures scheduled or terminal failures paused. Application transport timeouts still bound how promptly an in-flight send can stop.

## Sidekiq Tracing

Sidekiq integration is explicit and optional. Sidekiq is not a dependency of the base gem. Create the LogBrew client and instrumentation in the process that owns the middleware, then register the client and server sides you use:

```ruby
require "logbrew"
require "logbrew/sidekiq"
require "sidekiq"

transport = LogBrew::HttpTransport.new(timeout: 10)
client = LogBrew::Client.create_automatic(
  api_key: ENV.fetch("LOGBREW_API_KEY"),
  sdk_name: "checkout-worker",
  sdk_version: "1.0.0",
  transport: transport
)
sidekiq_tracing = LogBrew::Sidekiq::Instrumentation.create(
  client: client,
  max_retries: 25
)

Sidekiq.configure_client { |config| sidekiq_tracing.register_client(config) }
Sidekiq.configure_server do |config|
  sidekiq_tracing.register_client(config)
  sidekiq_tracing.register_server(config)
  config.on(:quiet) { sidekiq_tracing.quiet }
  config.on(:shutdown) { sidekiq_tracing.shutdown }
end
```

Registration is app-owned, idempotent, and reversible with `unregister_client` and `unregister_server`; the first instrumentation registered for each middleware class owns that entry. `disable` and `enable` provide reversible capture control. `quiet` stops new Sidekiq instrumentation while already queued LogBrew events remain under the existing delivery owner. `shutdown` is idempotent and delegates draining to the existing client; automatic clients use their owned transport, while manual clients must pass `transport:` when the instrumentation is created.

The client middleware adds one bounded `logbrew` carrier containing only a version, W3C `traceparent`, and enqueue time. Valid retries keep that carrier without creating another enqueue span. The server middleware continues a valid carrier or starts a fresh trace when it is absent or malformed, returns the caller trace state after every result, and records bounded queue-wait and execution timing. Set `max_retries` to the same default retry limit used by your Sidekiq configuration; per-job integer or disabled retry settings are honored. Retryable failures keep only error spans, while the terminal escaped failure adds one deduplicated fixed-title issue and preserves the original exception.

Sidekiq spans contain only fixed source, sampled state, bounded retry count, bounded queue-wait duration, execution duration, status, and real cancellation. The integration does not capture job arguments, payload fields, job identifiers, worker names, queue values, connection data, exception messages or stacks, baggage, or tracestate. Capture failures are advisory and never replace job execution or retry behavior. Create fresh clients and instrumentation after `fork`; inherited instances fail closed without changing jobs.

## Persistent Worker Delivery

Server workers that need restart recovery can opt into an app-owned persistent queue. Create the client after forking and give every worker its own normalized absolute directory:

```ruby
queue_path = ENV.fetch("LOGBREW_PERSISTENT_QUEUE_PATH")

client = LogBrew::Client.create(
  api_key: ENV.fetch("LOGBREW_API_KEY"),
  sdk_name: "checkout-worker",
  sdk_version: "1.0.0",
  persistent_queue_path: queue_path,
  on_event_dropped: lambda do |notice|
    warn "LogBrew delivery pressure: #{notice.reason} (#{notice.dropped_events} dropped)"
  end
)

client.log("evt_job_started", Time.now.utc.iso8601, message: "job started", level: "info")
client.shutdown(LogBrew::HttpTransport.new)
```

Persistence is disabled by default and adds no background thread, timer, or `at_exit` hook. Admission writes and syncs each validated event with an atomic same-directory rename. If that rename completes but directory sync cannot be confirmed, capture raises the content-free `persistence_commit_error`; the event remains pending and cannot be sent or purged until a later sync succeeds, and it is never reported as dropped. Restart reads the oldest records first, preserves the normal 1,000-event/4 MiB bounds, and keeps the same 100-event/256 KiB transport splitting. A server-accepted prefix is recorded before local compaction, so interrupted compaction does not replay it. A crash before that marker may replay a stable event ID; delivery is intentionally at-least-once, not exactly-once.

The queue directory must be dedicated, owner-only, and used by one process. Symlinks, unexpected files, corrupt records, concurrent owners, and inherited pre-fork clients fail closed. Build each child client after fork with a unique path. Successful `shutdown` releases ownership; failed delivery remains restartable. Use `client.purge_pending_events` only when the application explicitly chooses to discard pending telemetry.

Event files contain the same validated event JSON your application submitted, including message and metadata values. Protect the directory and do not put API keys or other sensitive values in telemetry. The SDK never adds the API key, endpoint, request headers, process ID, SDK request envelope, or queue path to stored records. Persistence failures before an event rename reject the new event with the content-free `persistence_failure` drop reason; they do not fall back to an in-memory-only event.

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
- `persistent_queue_path:` enables explicit owner-only, single-process restart recovery; `purge_pending_events` explicitly discards its pending prefix.
- `Client.create_automatic(...)` opts an owned transport into one lazy interval/threshold worker; `delivery_health`, `recover_automatic_delivery`, and `stop_automatic_delivery` expose fixed process-local lifecycle control.
- `LogBrew::Sidekiq::Instrumentation` explicitly installs optional client/server middleware with bounded W3C propagation, fixed telemetry, and app-owned quiet/shutdown hooks.
- `flush(transport)` splits its queue snapshot into compact 100-event/256 KiB requests, freezes failed retry bytes, acknowledges only accepted prefixes, and leaves transport-time capture queued.
- Queues default to 1,000 events and 4 MiB of compact serialized event data; `pending_event_bytes`, `dropped_events`, and `on_event_dropped` expose pressure locally. `TransportResponse#attempts` and `#batches` expose request work.
- `metric(...)` queues explicit, application-owned metric events with name, kind, value, unit, temporality, and low-cardinality metadata validation.
- `LogBrew::ProductTimeline` builds explicit, application-owned product action and network milestone timeline events with primitive metadata and query/hash-free routes.
- `LogBrew::SupportTicketDraft.create` builds explicit, local-only support-ticket create payload drafts with redacted diagnostics and no backend route calls.
- `LogBrew::HttpTransport` sends queued batches through Ruby's standard `Net::HTTP` with configurable endpoint, headers, timeout, and app-owned HTTP client support.
- `LogBrew::RackMiddleware` captures Rack request spans and unhandled app exceptions without requiring Rails or Rack at runtime.
- `LogBrew::RailsErrorSubscriber` captures handled/manual Rails error reports without requiring Rails at runtime.
- `shutdown(transport)` flushes queued events and rejects later writes.
- `LogBrew::RecordingTransport.always_accept` is useful when you want to inspect queued JSON before network delivery.
- `LogBrew::SdkError` exposes stable `code` and `message` values for user-facing failure handling.
