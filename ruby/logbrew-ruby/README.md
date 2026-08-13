# LogBrew Ruby SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Ruby SDK for building, validating, previewing, and flushing LogBrew event batches, with automatic Rails request, database, cache, view, and error capture; standard-library `Net::HTTP` delivery; opt-in standard-library `Logger` support; and manual Rack helpers.

The core package has no runtime gem dependencies. Its automatic integration
activates only inside an application that has already loaded Rails.

## Install

```bash
gem install logbrew-sdk
```

## Rails Quick Start

Add the gem normally. Its package-name require shim loads the Rails integration
when Rails is present, so `require: "logbrew"` and a custom initializer are not
needed:

```ruby
# Gemfile
gem "logbrew-sdk", "~> 0.1.6"
```

```bash
bundle install
export LOGBREW_SERVER_API_KEY="your project-scoped server ingest key"
bin/rails server
```

That is the complete Rails application change. The Railtie installs one
request middleware, subscribes to handled Rails errors, creates a fresh client
inside each server process, delivers in the background, and performs one
bounded shutdown drain. Without `LOGBREW_SERVER_API_KEY`, the integration stays
disabled and the application behaves normally. Set `LOGBREW_ENABLED=false` to
disable it explicitly. If the Gemfile uses `require: false`, load
`logbrew/rails` yourself after Rails.

The automatic integration records route-template request spans and up to eight
slowest request-local Active Record, Rails cache, and Action View child spans.
The request span reports exact observed and captured operation counts plus
truncation. Operation evidence contains only the operation type, duration,
cache-hit state, relative `app/views` template path, and exception type when
present. It never contains SQL, cache keys or values, or absolute paths.

Escaped request failures include exception identity,
`rails.middleware` with `handled: false`, and up to 32 newest-first sanitized
frames. Handled Rails reports use `rails.error_reporter` with `handled: true`.
It does not record concrete request paths, query strings, request or response
bodies, arbitrary headers, authorization values, cookies, user IDs, exception
messages, raw backtrace text, source snippets, locals, arguments, or absolute
paths. Exception messages and raw backtrace text are separate opt-ins:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `LOGBREW_ENABLED` | inferred | Optional explicit `true` or `false` override |
| `LOGBREW_SERVER_API_KEY` | unset | Project-scoped server ingest key; enables the integration |
| `LOGBREW_SERVICE_NAME` | Rails application name | Bounded service metadata |
| `LOGBREW_ENVIRONMENT` | `Rails.env` | Bounded environment metadata |
| `LOGBREW_RELEASE` | unset | Optional release identifier |
| `LOGBREW_ENDPOINT` | `https://api.logbrew.co/v1/events` | HTTPS intake URL; loopback HTTP is accepted for local development |
| `LOGBREW_REQUEST_TIMEOUT_MS` | `10000` | Per-request delivery timeout from 1 to 600000 ms |
| `LOGBREW_FLUSH_INTERVAL_MS` | `5000` | Automatic delivery interval from 10 to 3600000 ms |
| `LOGBREW_FLUSH_THRESHOLD` | `100` | Queue size from 1 to 1000 that requests an earlier flush |
| `LOGBREW_CAPTURE_EXCEPTION_MESSAGES` | `false` | Opt in to exception message capture |
| `LOGBREW_INCLUDE_EXCEPTION_BACKTRACE` | `false` | Opt in to raw exception backtrace text; sanitized structured frames are always captured |

`LOGBREW_API_KEY` and `LOGBREW_INGEST_KEY` are not Rails aliases. If either is
set without the canonical server key, startup reports the exact
`LOGBREW_SERVER_API_KEY` correction without printing any key value.

### Create a Project and Confirm Hosted Rails Delivery

LogBrew CLI 0.1.32 or newer can create a project and one-time key without a
dashboard handoff. The destination key file must not already exist:

```bash
logbrew status --json
install -d -m 700 "$HOME/.logbrew"

project_result="$(
  logbrew projects create rails-service \
    --runtime ruby \
    --environment development \
    --ingest-key-file "$HOME/.logbrew/rails-service.ingest" \
    --json
)"
export LOGBREW_PROJECT_ID="$(jq -er '.project.id' <<<"$project_result")"
unset project_result
export LOGBREW_SERVER_API_KEY="$(< "$HOME/.logbrew/rails-service.ingest")"
export LOGBREW_SERVICE_NAME="rails-service"
```

Start Rails and request one application route. Then inspect the same project
through the approved CLI session:

```bash
logbrew doctor --project "$LOGBREW_PROJECT_ID" --json
logbrew traces --project "$LOGBREW_PROJECT_ID" \
  --service rails-service \
  --since 1h \
  --json
```

When the temporary project is no longer needed, archive it and remove the
revoked one-time key:

```bash
unset LOGBREW_SERVER_API_KEY
unset LOGBREW_SERVICE_NAME
logbrew projects archive "$LOGBREW_PROJECT_ID" --yes --json
rm -f "$HOME/.logbrew/rails-service.ingest"
unset LOGBREW_PROJECT_ID
```

## Usage

```ruby
require "logbrew"

client = LogBrew::Client.create(
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
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

## Shared Telemetry Context

Use one versioned context when a human or coding agent must correlate releases,
issues, logs, spans, metrics, and product actions without reverse-engineering a
flat metadata map:

```ruby
resource = LogBrew::TelemetryResource.create
  .with_service(name: "checkout-api", version: "1.4.0")
  .with_deployment(environment: "production", release: "checkout@1.4.0")
  .with_framework(name: "rails", version: "8.1.3")
  .with_application(name: "checkout", version: "1.4.0", build: "140")
  .build
client_context = LogBrew::TelemetryContext.create
  .with_resource(resource)
  .with_tag("region", "eu")
  .build

client = LogBrew::Client.create(
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
  sdk_name: "checkout-api",
  sdk_version: "1.4.0",
  context: client_context
)

request_context = LogBrew::TelemetryContext.create
  .with_session(id: "session_checkout_123")
  .with_subject(id: "subject_checkout_123", kind: "user")
  .with_tags("journey" => "checkout", "surface" => "payment")
  .build

LogBrew::Telemetry.with_context(request_context) do
  client.log(
    "evt_checkout_started",
    Time.now.utc.iso8601,
    message: "checkout started",
    level: "info"
  )
end
```

Client context is merged into all seven signal types. Resource sections and
tags merge field by field; event context replaces trace, session, or subject
sections and wins on conflicting resource fields or tags. Pass a built
`TelemetryContext` as an event's `context:` value for an explicit override.
`LogBrew::Telemetry.with_context` provides a fiber/thread-local request or job
scope and returns to the exact prior scope even when application work raises.
When `LogBrew::Trace.current` is active, its W3C trace and span IDs are added to
the typed context on every signal. Explicit event context remains the final
override.

The client adds only Ruby engine/version, operating-system family/release, and
architecture beneath explicit context by default. Set
`capture_runtime_context: false` to disable those defaults without removing
explicit context. The automatic Rails adapter also promotes its already
validated service, environment, release, and Rails version configuration into
the corresponding resource sections. Automatic context never reads host names,
process IDs, commands or arguments, environment variables, local account names,
working directories, files, network addresses, cloud metadata, memory, or CPU
values.

Context is detached and validated before queue admission. Strings, IDs, trace
identifiers, resource sections, and tags follow the shared event schema; tags
are sorted and capped at 32. Session and subject IDs are application-owned,
opaque correlation values. Never put names, email addresses, authentication
material, network addresses, or other direct personal data in them. Use
`TelemetryContext.from_hash(...)` or `TelemetryResource.from_hash(...)` only
when adapting an already schema-shaped object; the builders are clearer for
new code.

## Serialized Worker Lifecycle

Use `LogBrew::WorkerLifecycle` when a prefork or long-running worker processes
one work item at a time and needs an explicit telemetry boundary:

```ruby
client = LogBrew::Client.create(
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
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

For a service request, combine release, environment, log, product action,
network milestone, metric, and span events around one typed request context and
one shared W3C trace:

```ruby
incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
trace = LogBrew::Traceparent.parse(incoming)
child_span_id = "b7ad6b7169203331"
route_template = "/checkout/:cart_id"
session_id = "sess_checkout_123"
request_context = LogBrew::TelemetryContext.create
  .with_session(id: session_id)
  .with_subject(id: "subject_checkout_123", kind: "user")
  .with_tag("journey", "checkout")
  .build
active_trace = LogBrew::Trace.create(
  trace_id: trace.trace_id,
  span_id: child_span_id,
  parent_span_id: trace.parent_span_id,
  trace_flags: trace.trace_flags
)

LogBrew::Telemetry.with_context(request_context) do
  LogBrew::Trace.with_context(active_trace) do
    client.log(
      "evt_log_checkout_started",
      "2026-06-02T10:00:02Z",
      message: "checkout request started",
      level: "info",
      logger: "checkout",
      metadata: { routeTemplate: route_template }
    )
    client.action(
      "evt_action_checkout_submit",
      "2026-06-02T10:00:03Z",
      LogBrew::ProductTimeline.product_action(
        name: "checkout.submit",
        route_template: route_template,
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
      metadata: { method: "POST", routeTemplate: route_template, statusCode: 202 }
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
          metadata: { sampled: trace.sampled, routeTemplate: route_template }
        )
      )
    )
  end
end

outgoing_headers = LogBrew::Traceparent.create_headers(
  trace_id: trace.trace_id,
  span_id: child_span_id,
  trace_flags: trace.trace_flags
)
```

The packaged `examples/first_useful_telemetry.rb` file shows the full flow,
including client resource/deployment context, release, environment, opaque
subject/session correlation, and a network milestone. Route templates stay
query-free, metadata is primitive-only, and the SDK does not capture request
bodies or arbitrary transport metadata.

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

## Typed Issue Diagnostics

Use `LogBrew::IssueDiagnostics` when an application wants issue evidence that a
human or coding agent can understand without parsing a flattened metadata map:

```ruby
breadcrumbs = [
  LogBrew::IssueDiagnostics.breadcrumb(
    timestamp: "2026-08-02T10:14:58.125Z",
    category: "checkout.navigation",
    type: "navigation",
    message: "User reached payment review",
    data: { step: "payment" }
  ),
  LogBrew::IssueDiagnostics.breadcrumb(
    timestamp: "2026-08-02T10:14:59Z",
    category: "checkout.request",
    level: "warn",
    data: { method: "POST", statusCode: 503 }
  )
]

begin
  checkout.call
rescue RuntimeError => error
  client.issue(
    "evt_checkout_failure",
    Time.now.utc.iso8601,
    LogBrew::IssueDiagnostics.from_exception(
      error,
      message: "Checkout could not be completed.",
      mechanism_type: "ruby.exception",
      handled: true,
      context: request_context,
      metadata: { routeTemplate: "/checkout/:cart_id" },
      breadcrumbs: breadcrumbs
    )
  )
end
```

The typed payload exposes exception type, mechanism and handled state, a
bounded parent-first Ruby `cause` chain, up to 32 newest-first stack frames,
and up to 64 oldest-to-newest breadcrumbs. Automatic node messages are marked
redacted, per-node stack availability is explicit, and cycles, unsafe cause
access, or the eight-node cap mark truncation. Generated
frames contain only basename, positive coordinates, and bounded function
identity. Explicit frames can also carry module, `inApp`, and debug ID. A
breadcrumb accepts a stable category/type, normalized level, bounded message,
and at most eight flat finite primitive data values. Set
`breadcrumbs_truncated: true` when the supplied list omits earlier history.

`from_exception` deliberately omits exception text unless `message:` is
provided. Pass `context:` to correlate the issue with the same typed resource,
trace, session, opaque subject, and tags as its surrounding signals. Automatic
and manual structured frame projection never captures raw backtrace strings,
source code, locals, arguments, or absolute paths. The raw Rails/Rack backtrace
option is separate and remains off by default. Run
`make -C examples run-issue-diagnostics` for a complete inspectable payload.
Rails, Rack, and Sidekiq issue capture reuse this same graph. See the shared
[exception-chain contract](../../docs/exception-chain-evidence.md).

## Metrics

Use `metric` for explicit, application-owned measurements. LogBrew validates the metric name, kind, value, unit, temporality, and optional metadata before queueing the event:

```ruby
client.metric(
  "evt_metric_queue_depth",
  "2026-06-02T10:00:06Z",
  name: "queue.depth",
  description: "Number of items waiting in the checkout queue.",
  kind: "gauge",
  value: 42,
  unit: "{items}",
  temporality: "instant",
  metadata: { service: "worker", queue: "checkout" }
)
```

Supported metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms require `delta` or `cumulative` temporality and non-negative values; gauges require `instant` temporality and may be negative. An optional `description` gives people and investigation tools the stable meaning of the measurement. Keep it generic, single-line, between 1 and 1,024 Unicode scalar values, and free of identifiers, personal data, or changing values. It is not a query dimension. Keep metadata low-cardinality and primitive. This SDK does not automatically collect Ruby runtime, Rack, Rails, or database metrics yet.

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
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
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
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
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
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
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
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
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
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
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

The `examples` directory contains copyable snippets for creating a client,
building typed issue diagnostics, sending through `HttpTransport`, using the
standard logger wrapper, attaching Rack middleware, and subscribing to Rails
errors in your own Ruby app.

## Standard Logger

`LogBrew::Logger` subclasses Ruby's standard `::Logger`, so existing Ruby logging calls can queue LogBrew log events without adding a runtime dependency.

```ruby
require "logbrew"

client = LogBrew::Client.create(
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
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

Rails applications should use the automatic Rails quick start above. Use
`LogBrew::RackMiddleware` directly only for Sinatra, plain Rack, or a Rails app
that intentionally owns custom middleware wiring.

```ruby
require "logbrew"

client = LogBrew::Client.create(
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
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

The manual middleware records successful responses as span events, records
unhandled app exceptions as typed issue plus error-span events, and re-raises
the exact app exception so Rack keeps normal response handling. Escaped issues
use `rack.middleware`, `handled: false`, and bounded structured frames. Its
compatibility defaults retain path, request-ID, and exception-message capture.
Set `include_exception_message: false` for type-only issues. Raw backtrace text
is omitted unless `include_exception_backtrace: true` is set; sanitized
structured frames remain available either way. Events queue by default; pass
`transport:` plus `flush_on_response: true` when each response should flush.

## Rails Error Subscriber

The automatic Rails integration already subscribes to handled Rails errors.
Use `LogBrew::RailsErrorSubscriber` directly only when an application owns a
custom Rails error-reporting lifecycle.

```ruby
require "logbrew"

client = LogBrew::Client.create(
  api_key: ENV.fetch("LOGBREW_SERVER_API_KEY"),
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

The manual subscriber implements
`report(error, handled:, severity:, context:, source:, **options)`. Exception
reports include typed identity, `rails.error_reporter`, the supplied handled
state, and bounded structured frames. Its compatibility default includes
primitive context values and exception messages; set
`include_exception_message: false` for type-only issues. Raw backtrace text is
omitted unless `include_exception_backtrace: true` is set. If you also use the
manual Rack middleware, keep this subscriber focused on handled reports so
unhandled request exceptions are not captured twice.

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
- `LogBrew::IssueDiagnostics` builds typed exception identity, mechanism/handled state, basename-only structured frames, and bounded ordered breadcrumbs without raw exception internals.
- `LogBrew::HttpTransport` sends queued batches through Ruby's standard `Net::HTTP` with configurable endpoint, headers, timeout, and app-owned HTTP client support.
- `LogBrew::RackMiddleware` captures Rack request spans and unhandled app exceptions without requiring Rails or Rack at runtime.
- `LogBrew::RailsErrorSubscriber` captures handled/manual Rails error reports without requiring Rails at runtime.
- `LogBrew::Rails` automatically installs privacy-bounded Rails request spans, handled-error issues, per-process delivery, health access, and idempotent shutdown when the canonical server key is configured.
- `shutdown(transport)` flushes queued events and rejects later writes.
- `LogBrew::RecordingTransport.always_accept` is useful when you want to inspect queued JSON before network delivery.
- `LogBrew::SdkError` exposes stable `code` and `message` values for user-facing failure handling.
