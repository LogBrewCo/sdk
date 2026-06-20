# frozen_string_literal: true

require "json"
require "socket"
require "stringio"
require_relative "../lib/logbrew"

def assert(condition, message)
  raise message unless condition
end

def expect_error(code, message_fragment)
  yield
rescue LogBrew::SdkError => error
  assert(error.code == code, "expected #{code}, got #{error.code}")
  assert(error.message.include?(message_fragment), "expected error containing #{message_fragment}")
  return error
end

def sample_client(max_retries: 2)
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby",
    sdk_version: "0.1.0",
    max_retries: max_retries
  )
end

def enqueue_all(client)
  client.release("evt_release_001", "2026-06-02T10:00:00Z", version: "1.2.3", commit: "abc123def456", notes: "Public release marker")
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", name: "production", region: "global")
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", title: "Checkout timeout", level: "error", message: "Request timed out after retry budget")
  client.log("evt_log_001", "2026-06-02T10:00:03Z", message: "worker started", level: "info", logger: "job-runner")
  client.span("evt_span_001", "2026-06-02T10:00:04Z", name: "GET /health", traceId: "trace_001", spanId: "span_001", status: "ok", durationMs: 12.5)
  client.action("evt_action_001", "2026-06-02T10:00:05Z", name: "deploy", status: "success")
end

class LocalHttpIntake
  attr_reader :endpoint, :last_method, :last_path, :last_authorization, :last_content_type, :last_source, :last_body,
              :bodies, :request_count

  def initialize(statuses = [202])
    @server = TCPServer.new("127.0.0.1", 0)
    @endpoint = "http://127.0.0.1:#{@server.addr[1]}/v1/events"
    @statuses = statuses.dup
    @bodies = []
    @request_count = 0
    @closed = false
    @thread = Thread.new { accept_loop }
  end

  def close
    @closed = true
    @server.close unless @server.closed?
    @thread.join(2)
  end

  private

  def accept_loop
    until @closed
      socket = @server.accept
      begin
        handle(socket)
      ensure
        socket.close unless socket.closed?
      end
    end
  rescue IOError, Errno::EBADF
    nil
  end

  def handle(socket)
    request_line = socket.gets.to_s.strip
    parts = request_line.split(" ")
    @last_method = parts[0].to_s
    @last_path = parts[1].to_s

    headers = {}
    while (line = socket.gets)
      stripped = line.chomp
      break if stripped.empty?

      name, value = stripped.split(":", 2)
      headers[name.downcase] = value.to_s.strip if name && value
    end

    body = socket.read(headers.fetch("content-length", "0").to_i).to_s
    @last_body = body
    @bodies << body
    @last_authorization = headers.fetch("authorization", "")
    @last_content_type = headers.fetch("content-type", "")
    @last_source = headers.fetch("x-logbrew-source", "")
    @request_count += 1

    status = @statuses.empty? ? 202 : @statuses.shift
    reason = status == 503 ? "Service Unavailable" : "Accepted"
    socket.write("HTTP/1.1 #{status} #{reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
  end
end

tests = 0

client = sample_client
enqueue_all(client)
payload = JSON.parse(client.preview_json)
assert(payload.fetch("events").map { |event| event.fetch("type") } == %w[release environment issue log span action], "unexpected event order")
tests += 1

client = sample_client
client.metric(
  "evt_metric_001",
  "2026-06-02T10:00:06Z",
  name: "queue.depth",
  kind: "gauge",
  value: -2.0,
  unit: "{items}",
  temporality: "instant",
  metadata: { service: "worker", queue: "checkout" }
)
metric_payload = client.preview_json
assert(metric_payload.include?('"type": "metric"'), "expected metric event type")
assert(metric_payload.include?('"kind": "gauge"'), "expected metric kind")
assert(metric_payload.include?('"value": -2.0'), "expected gauge value")
assert(metric_payload.include?('"unit": "{items}"'), "expected metric unit")
assert(metric_payload.include?('"temporality": "instant"'), "expected metric temporality")
assert(metric_payload.include?('"queue": "checkout"'), "expected metric metadata")
tests += 1

client = sample_client
product_metadata = { "plan" => "pro", "source" => "caller", "attempt" => 2 }
product_action = LogBrew::ProductTimeline.product_action(
  name: "checkout.submit",
  status: "running",
  route_template: "/checkout?cart=123#pay",
  session_id: "session_123",
  trace_id: "trace_123",
  screen: "Checkout",
  funnel: "purchase",
  step: "submit",
  metadata: product_metadata
)
product_metadata["plan"] = "enterprise"
client.action("evt_product_timeline", "2026-06-02T10:00:07Z", product_action)
product_event = JSON.parse(client.preview_json).fetch("events")[0]
product_attributes = product_event.fetch("attributes")
product_timeline_metadata = product_attributes.fetch("metadata")
assert(product_attributes.fetch("name") == "checkout.submit", "expected product action name")
assert(product_attributes.fetch("status") == "running", "expected product action status")
assert(product_timeline_metadata.fetch("source") == "product_timeline", "expected product timeline source")
assert(product_timeline_metadata.fetch("routeTemplate") == "/checkout", "expected product route without query or hash")
assert(product_timeline_metadata.fetch("sessionId") == "session_123", "expected product session")
assert(product_timeline_metadata.fetch("traceId") == "trace_123", "expected product trace")
assert(product_timeline_metadata.fetch("screen") == "Checkout", "expected product screen")
assert(product_timeline_metadata.fetch("funnel") == "purchase", "expected product funnel")
assert(product_timeline_metadata.fetch("step") == "submit", "expected product step")
assert(product_timeline_metadata.fetch("plan") == "pro", "expected product metadata copy")
assert(product_timeline_metadata.fetch("attempt") == 2, "expected product numeric metadata")
tests += 1

client = sample_client
network_action = LogBrew::ProductTimeline.network_milestone(
  route_template: "https://api.example.test/v1/checkout?cart=123#debug",
  method: "post",
  status_code: 503,
  duration_ms: 42.5,
  session_id: "session_123",
  trace_id: "trace_123",
  metadata: { region: "iad", cached: false }
)
client.action("evt_network_timeline", "2026-06-02T10:00:08Z", network_action)
network_attributes = JSON.parse(client.preview_json).fetch("events")[0].fetch("attributes")
network_metadata = network_attributes.fetch("metadata")
assert(network_attributes.fetch("name") == "network.post /v1/checkout", "expected default network milestone name")
assert(network_attributes.fetch("status") == "failure", "expected failed network milestone status")
assert(network_metadata.fetch("source") == "network_timeline", "expected network timeline source")
assert(network_metadata.fetch("routeTemplate") == "/v1/checkout", "expected network route path only")
assert(network_metadata.fetch("method") == "POST", "expected normalized method")
assert(network_metadata.fetch("statusCode") == 503, "expected status code metadata")
assert(network_metadata.fetch("durationMs") == 42.5, "expected duration metadata")
assert(network_metadata.fetch("sessionId") == "session_123", "expected network session")
assert(network_metadata.fetch("traceId") == "trace_123", "expected network trace")
assert(network_metadata.fetch("region") == "iad", "expected network metadata")
assert(network_metadata.fetch("cached") == false, "expected boolean metadata")
tests += 1

expect_error("validation_error", "product action name must be non-empty") do
  LogBrew::ProductTimeline.product_action(name: " ")
end
expect_error("validation_error", "action status must be one of") do
  LogBrew::ProductTimeline.product_action(name: "checkout.submit", status: "done")
end
expect_error("validation_error", "network milestone route_template must be non-empty") do
  LogBrew::ProductTimeline.network_milestone(route_template: " ")
end
expect_error("validation_error", "network milestone method must be a valid HTTP method") do
  LogBrew::ProductTimeline.network_milestone(route_template: "/checkout", method: "bad method")
end
expect_error("validation_error", "network milestone status_code must be between 100 and 599") do
  LogBrew::ProductTimeline.network_milestone(route_template: "/checkout", status_code: 99)
end
expect_error("validation_error", "network milestone duration_ms must be a finite number") do
  LogBrew::ProductTimeline.network_milestone(route_template: "/checkout", duration_ms: Float::INFINITY)
end
expect_error("validation_error", "network milestone duration_ms must be non-negative") do
  LogBrew::ProductTimeline.network_milestone(route_template: "/checkout", duration_ms: -1)
end
expect_error("validation_error", "network milestone name must be non-empty") do
  LogBrew::ProductTimeline.network_milestone(route_template: "/checkout", name: " ")
end
expect_error("validation_error", "metadata value for nested must be a string, number, boolean, or null") do
  LogBrew::ProductTimeline.product_action(name: "checkout.submit", metadata: { nested: [] })
end
expect_error("validation_error", "metadata key must be non-empty") do
  LogBrew::ProductTimeline.product_action(name: "checkout.submit", metadata: { "" => "bad" })
end
tests += 1

trace_context = LogBrew::Traceparent.parse("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")
assert(trace_context.trace_id == "4bf92f3577b34da6a3ce929d0e0e4736", "expected normalized trace id")
assert(trace_context.parent_span_id == "00f067aa0ba902b7", "expected normalized parent span id")
assert(trace_context.trace_flags == "01", "expected normalized trace flags")
assert(trace_context.sampled == true, "expected sampled flag")
outgoing_headers = LogBrew::Traceparent.create_headers(
  trace_id: trace_context.trace_id,
  span_id: "b7ad6b7169203331",
  trace_flags: trace_context.trace_flags
)
assert(
  outgoing_headers.fetch("traceparent") == "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01",
  "expected outgoing traceparent"
)
span_attributes = LogBrew::Traceparent.span_attributes_from_traceparent(
  trace_context,
  LogBrew::TraceparentSpanInput.new(
    name: "POST /checkout/:cart_id",
    span_id: "b7ad6b7169203331",
    duration_ms: 183.4,
    metadata: { routeTemplate: "/checkout/:cart_id", sampled: true }
  )
)
assert(span_attributes.fetch("traceId") == trace_context.trace_id, "expected traceparent span trace id")
assert(span_attributes.fetch("parentSpanId") == trace_context.parent_span_id, "expected traceparent parent span id")
assert(span_attributes.fetch("spanId") == "b7ad6b7169203331", "expected traceparent child span id")
assert(span_attributes.fetch("status") == "ok", "expected traceparent span status")
assert(span_attributes.fetch("durationMs") == 183.4, "expected traceparent span duration")
assert(span_attributes.fetch("metadata").fetch("routeTemplate") == "/checkout/:cart_id", "expected traceparent metadata")
tests += 1

expect_error("validation_error", "traceparent must have four fields") do
  LogBrew::Traceparent.parse("bad")
end
expect_error("validation_error", "traceparent version must be two hex characters and not ff") do
  LogBrew::Traceparent.parse("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
end
expect_error("validation_error", "traceparent trace id must be 32 non-zero hex characters") do
  LogBrew::Traceparent.parse("00-00000000000000000000000000000000-00f067aa0ba902b7-01")
end
expect_error("validation_error", "traceparent parent span id must be 16 non-zero hex characters") do
  LogBrew::Traceparent.parse("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")
end
expect_error("validation_error", "traceparent flags must be two hex characters") do
  LogBrew::Traceparent.parse("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0z")
end
expect_error("validation_error", "span spanId must be 16 non-zero hex characters") do
  LogBrew::Traceparent.span_attributes_from_traceparent(
    trace_context,
    LogBrew::TraceparentSpanInput.new(name: "POST /checkout", span_id: "0000000000000000")
  )
end
expect_error("validation_error", "metadata value for nested must be a string, number, boolean, or null") do
  LogBrew::Traceparent.span_attributes_from_traceparent(
    trace_context,
    LogBrew::TraceparentSpanInput.new(name: "POST /checkout", span_id: "b7ad6b7169203331", metadata: { nested: [] })
  )
end
tests += 1

client = sample_client
enqueue_all(client)
transport = LogBrew::RecordingTransport.always_accept
response = client.flush(transport)
assert(response.status_code == 202, "expected successful status")
assert(response.attempts == 1, "expected one attempt")
assert(client.pending_events.zero?, "expected queue to clear")
assert(transport.last_body.include?('"events"'), "expected body to include events")
tests += 1

client = sample_client
empty = client.flush(LogBrew::RecordingTransport.always_accept)
assert(empty.status_code == 204, "expected empty flush status")
assert(empty.attempts.zero?, "expected empty flush attempts")
tests += 1

expect_error("validation_error", "timestamp must include a timezone offset") do
  sample_client.log("evt_log_001", "2026-06-02T10:00:03", message: "worker started", level: "info")
end
tests += 1

expect_error("validation_error", "issue level must be one of") do
  sample_client.issue("evt_issue_001", "2026-06-02T10:00:02Z", title: "Checkout timeout", level: "verbose")
end
client = sample_client
client.issue("evt_issue_alias", "2026-06-02T10:00:02Z", title: "Checkout timeout", level: "fatal")
client.log("evt_log_debug", "2026-06-02T10:00:03Z", message: "verbose runtime detail", level: "debug")
client.log("evt_log_warn", "2026-06-02T10:00:04Z", message: "legacy warning alias", level: "warn")
levels = JSON.parse(client.preview_json).fetch("events").map { |event| event.fetch("attributes").fetch("level") }
assert(levels == %w[critical info warning], "expected severity aliases to normalize")
tests += 1

expect_error("validation_error", "span durationMs must be non-negative") do
  sample_client.span("evt_span_001", "2026-06-02T10:00:04Z", name: "GET /health", traceId: "trace_001", spanId: "span_001", status: "ok", durationMs: -1)
end
tests += 1

expect_error("validation_error", "metric value must be a finite number") do
  sample_client.metric("evt_metric_001", "2026-06-02T10:00:06Z", name: "queue.depth", kind: "gauge", value: Float::NAN, unit: "{items}", temporality: "instant")
end
tests += 1

expect_error("validation_error", "metric counter value must be non-negative") do
  sample_client.metric("evt_metric_001", "2026-06-02T10:00:06Z", name: "jobs.completed", kind: "counter", value: -1, unit: "1", temporality: "delta")
end
tests += 1

expect_error("validation_error", "metric temporality for gauge must be one of: instant") do
  sample_client.metric("evt_metric_001", "2026-06-02T10:00:06Z", name: "queue.depth", kind: "gauge", value: 2, unit: "{items}", temporality: "delta")
end
tests += 1

client = sample_client
enqueue_all(client)
expect_error("unauthenticated", "transport rejected the API key") do
  client.flush(LogBrew::RecordingTransport.new([401]))
end
assert(client.pending_events == 6, "expected unauthenticated failure to preserve queue")
tests += 1

client = sample_client
enqueue_all(client)
retry_transport = LogBrew::RecordingTransport.new([LogBrew::TransportError.network("temporary outage"), 202])
retry_response = client.flush(retry_transport)
assert(retry_response.attempts == 2, "expected retry before success")
assert(retry_transport.sent_bodies.length == 2, "expected two sent bodies")
tests += 1

client = sample_client(max_retries: 1)
enqueue_all(client)
retry_budget_transport = LogBrew::RecordingTransport.new([
  LogBrew::TransportError.network("temporary outage"),
  LogBrew::TransportError.network("still down")
])
expect_error("network_failure", "still down") do
  client.flush(retry_budget_transport)
end
assert(client.pending_events == 6, "expected retry-budget failure to preserve queue")
tests += 1

client = sample_client
enqueue_all(client)
expect_error("transport_error", "unexpected transport status 400") do
  client.flush(LogBrew::RecordingTransport.new([400]))
end
assert(client.pending_events == 6, "expected non-retryable status to preserve queue")
tests += 1

intake = LocalHttpIntake.new([202])
begin
  transport = LogBrew::HttpTransport.new(
    endpoint: intake.endpoint,
    headers: { "x-logbrew-source" => "ruby-test" },
    timeout: 2
  )
  response = transport.send("LOGBREW_API_KEY", '{"events":[{"id":"evt_ruby_http"}]}')
  assert(response.status_code == 202, "expected HTTP transport status")
  assert(response.attempts == 1, "expected HTTP transport attempt")
  assert(transport.endpoint.to_s == intake.endpoint, "expected HTTP transport endpoint")
  assert(transport.timeout == 2.0, "expected HTTP transport timeout")
  assert(transport.headers.length == 1, "expected HTTP transport headers")
  assert(intake.request_count == 1, "expected one HTTP request")
  assert(intake.last_method == "POST", "expected HTTP POST")
  assert(intake.last_path == "/v1/events", "expected HTTP path")
  assert(intake.last_body.include?("evt_ruby_http"), "expected HTTP request body")
  assert(intake.last_authorization == "Bearer LOGBREW_API_KEY", "expected HTTP authorization header")
  assert(intake.last_content_type.start_with?("application/json"), "expected HTTP content type")
  assert(intake.last_source == "ruby-test", "expected HTTP custom header")
ensure
  intake.close
end
tests += 1

intake = LocalHttpIntake.new([503, 202])
begin
  client = sample_client(max_retries: 1)
  client.log("evt_ruby_http_retry", "2026-06-02T10:00:03Z", message: "retry me", level: "info")
  response = client.flush(LogBrew::HttpTransport.new(endpoint: intake.endpoint, timeout: 2))
  assert(response.status_code == 202, "expected HTTP retry status")
  assert(response.attempts == 2, "expected HTTP retry attempts")
  assert(intake.request_count == 2, "expected two HTTP requests")
  assert(intake.bodies.length == 2, "expected two HTTP bodies")
  assert(intake.bodies[0] == intake.bodies[1], "expected retry body to stay unchanged")
  assert(client.pending_events.zero?, "expected HTTP retry to clear queue")
ensure
  intake.close
end
tests += 1

begin
  LogBrew::HttpTransport.new(endpoint: "http://127.0.0.1:1/v1/events", timeout: 1).send("LOGBREW_API_KEY", "{}")
rescue LogBrew::TransportError => error
  assert(error.code == "network_failure", "expected HTTP network code")
  assert(error.retryable, "expected HTTP network retryable")
  assert(error.message.include?("http transport failed"), "expected HTTP failure prefix")
else
  raise "expected HTTP transport exception"
end
tests += 1

expect_error("configuration_error", "endpoint must use http or https") do
  LogBrew::HttpTransport.new(endpoint: "/v1/events")
end
expect_error("configuration_error", "header name must be non-empty") do
  LogBrew::HttpTransport.new(headers: { " " => "bad" })
end
expect_error("configuration_error", "timeout must be positive") do
  LogBrew::HttpTransport.new(timeout: 0)
end
tests += 1

client = sample_client
enqueue_all(client)
shutdown_response = client.shutdown(LogBrew::RecordingTransport.always_accept)
assert(shutdown_response.status_code == 202, "expected shutdown flush")
expect_error("shutdown_error", "client is already shut down") do
  client.action("evt_action_002", "2026-06-02T10:00:06Z", name: "deploy", status: "success")
end
tests += 1

client = sample_client
logger_output = StringIO.new
logger = LogBrew::Logger.new(
  client: client,
  logdev: logger_output,
  logger_name: "checkout",
  event_id_prefix: "ruby_logger",
  metadata: { service: "web", ignored: [] },
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 6) },
  progname: "checkout-prog",
  formatter: proc { |severity, _time, progname, message| "#{severity}:#{progname}:#{message}\n" }
)
logger.debug("cart loaded")
logger.warn("checkout slow")
logger.add(::Logger::ERROR, RuntimeError.new("payment failed"), "payment")
logger.fatal("checkout down")
preview = JSON.parse(client.preview_json)
logger_events = preview.fetch("events")
assert(logger_events.length == 4, "expected logger events to be queued")
assert(logger_events.map { |event| event.fetch("id") } == %w[ruby_logger_1 ruby_logger_2 ruby_logger_3 ruby_logger_4], "expected logger event ids")
assert(logger_events.map { |event| event.fetch("timestamp") }.uniq == ["2026-06-02T10:00:06Z"], "expected logger timestamps")
assert(logger_events.map { |event| event.fetch("attributes").fetch("level") } == %w[info warning error critical], "expected logger level mapping")
assert(logger_events[1].fetch("attributes").fetch("message") == "checkout slow", "expected logger message")
assert(logger_events[1].fetch("attributes").fetch("logger") == "checkout", "expected configured logger name")
metadata = logger_events[2].fetch("attributes").fetch("metadata")
assert(metadata.fetch("service") == "web", "expected base metadata")
assert(!metadata.key?("ignored"), "expected non-primitive metadata to be skipped")
assert(metadata.fetch("rubySeverity") == "ERROR", "expected Ruby severity metadata")
assert(metadata.fetch("progname") == "payment", "expected per-call progname metadata")
assert(metadata.fetch("exceptionType") == "RuntimeError", "expected exception type metadata")
assert(metadata.fetch("exceptionMessage") == "payment failed", "expected exception message metadata")
assert(!metadata.key?("exceptionBacktrace"), "expected exception backtrace to be opt-in")
assert(logger_output.string.include?("WARN:checkout-prog:checkout slow"), "expected normal logger output")
tests += 1

client = sample_client
threshold_logger = LogBrew::Logger.new(client: client, level: ::Logger::INFO)
block_evaluated = false
threshold_logger.debug do
  block_evaluated = true
  "expensive debug"
end
assert(!block_evaluated, "expected debug block to stay lazy below threshold")
assert(client.pending_events.zero?, "expected skipped debug log to queue no event")
tests += 1

client = sample_client
transport = LogBrew::RecordingTransport.always_accept
flush_logger = LogBrew::Logger.new(
  client: client,
  event_id_prefix: "flush_logger",
  transport: transport,
  flush_on_log: true,
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 7) }
)
flush_logger.error("flush me")
assert(client.pending_events.zero?, "expected flush-on-log to clear queue")
assert(transport.sent_bodies.length == 1, "expected flush-on-log to send one body")
assert(transport.last_body.include?('"id": "flush_logger_1"'), "expected flushed logger event body")
tests += 1

client = sample_client
errors = []
safe_logger = LogBrew::Logger.new(
  client: client,
  timestamp_provider: -> { "not-a-timestamp" },
  on_error: ->(error) { errors << error }
)
safe_logger.info("bad timestamp should not break normal logging")
assert(errors.length == 1, "expected logger capture error callback")
assert(client.pending_events.zero?, "expected failed logger capture to keep queue empty")
tests += 1

client = sample_client
rack_app = lambda { |_env| [200, { "content-type" => "text/plain" }, ["ok"]] }
rack = LogBrew::RackMiddleware.new(
  rack_app,
  client: client,
  event_id_prefix: "rack_test",
  metadata: { service: "web", ignored: [] },
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 8) }
)
response = rack.call(
  "REQUEST_METHOD" => "POST",
  "PATH_INFO" => "/checkout",
  "QUERY_STRING" => "cart=123",
  "rack.url_scheme" => "https",
  "HTTP_X_REQUEST_ID" => "req_123",
  "logbrew.trace_id" => "4bf92f3577b34da6a3ce929d0e0e4736",
  "logbrew.span_id" => "b7ad6b7169203331",
  "logbrew.parent_span_id" => "00f067aa0ba902b7",
  "logbrew.trace_flags" => "01"
)
assert(response[0] == 200, "expected Rack response to pass through")
rack_events = JSON.parse(client.preview_json).fetch("events")
assert(rack_events.length == 1, "expected Rack middleware to queue one span")
rack_span = rack_events[0]
assert(rack_span.fetch("id") == "rack_test_span_1", "expected Rack span id")
assert(rack_span.fetch("timestamp") == "2026-06-02T10:00:08Z", "expected Rack timestamp")
span_attributes = rack_span.fetch("attributes")
assert(span_attributes.fetch("name") == "POST /checkout", "expected Rack span name")
assert(span_attributes.fetch("traceId") == "4bf92f3577b34da6a3ce929d0e0e4736", "expected Rack trace id")
assert(span_attributes.fetch("spanId") == "b7ad6b7169203331", "expected Rack span id")
assert(span_attributes.fetch("parentSpanId") == "00f067aa0ba902b7", "expected Rack parent span id")
assert(span_attributes.fetch("status") == "ok", "expected Rack span status")
assert(span_attributes.fetch("durationMs") >= 0, "expected Rack duration")
span_metadata = span_attributes.fetch("metadata")
assert(span_metadata.fetch("service") == "web", "expected Rack base metadata")
assert(!span_metadata.key?("ignored"), "expected Rack middleware to skip non-primitive metadata")
assert(span_metadata.fetch("source") == "rack", "expected Rack source")
assert(span_metadata.fetch("http.method") == "POST", "expected Rack method metadata")
assert(span_metadata.fetch("http.path") == "/checkout", "expected Rack path metadata")
assert(span_metadata.fetch("http.status_code") == 200, "expected Rack status metadata")
assert(span_metadata.fetch("traceId") == "4bf92f3577b34da6a3ce929d0e0e4736", "expected Rack trace metadata")
assert(span_metadata.fetch("spanId") == "b7ad6b7169203331", "expected Rack span metadata")
assert(span_metadata.fetch("parentSpanId") == "00f067aa0ba902b7", "expected Rack parent metadata")
assert(span_metadata.fetch("rack.url_scheme") == "https", "expected Rack scheme metadata")
assert(span_metadata.fetch("HTTP_X_REQUEST_ID") == "req_123", "expected Rack request id metadata")
assert(!span_metadata.fetch("http.path").include?("?"), "expected Rack middleware to omit query text")
tests += 1

client = sample_client
error_app = lambda { |_env| raise RuntimeError, "checkout failed" }
rack = LogBrew::RackMiddleware.new(
  error_app,
  client: client,
  event_id_prefix: "rack_error",
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 9) }
)
begin
  rack.call(
    "REQUEST_METHOD" => "GET",
    "PATH_INFO" => "/boom",
    "logbrew.trace_id" => "11111111111111111111111111111111",
    "logbrew.span_id" => "2222222222222222"
  )
  raise "expected Rack app exception"
rescue RuntimeError => error
  assert(error.message == "checkout failed", "expected original Rack exception")
end
rack_events = JSON.parse(client.preview_json).fetch("events")
assert(rack_events.map { |event| event.fetch("type") } == %w[issue span], "expected Rack issue and span")
assert(rack_events.map { |event| event.fetch("id") } == %w[rack_error_issue_1 rack_error_span_2], "expected Rack error ids")
issue_attributes = rack_events[0].fetch("attributes")
assert(issue_attributes.fetch("title") == "RuntimeError", "expected Rack issue title")
assert(issue_attributes.fetch("level") == "error", "expected Rack issue level")
assert(issue_attributes.fetch("message") == "checkout failed", "expected Rack issue message")
issue_metadata = issue_attributes.fetch("metadata")
assert(issue_metadata.fetch("exceptionType") == "RuntimeError", "expected Rack exception type")
assert(issue_metadata.fetch("exceptionMessage") == "checkout failed", "expected Rack exception message")
assert(!issue_metadata.key?("exceptionBacktrace"), "expected Rack exception backtrace to be opt-in")
error_span = rack_events[1].fetch("attributes")
assert(error_span.fetch("status") == "error", "expected Rack error span")
assert(error_span.fetch("metadata").fetch("http.status_code") == 500, "expected Rack error status metadata")
tests += 1

client = sample_client
transport = LogBrew::RecordingTransport.always_accept
rack = LogBrew::RackMiddleware.new(
  lambda { |_env| [204, {}, []] },
  client: client,
  transport: transport,
  flush_on_response: true,
  event_id_prefix: "rack_flush",
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 10) }
)
rack.call("REQUEST_METHOD" => "DELETE", "PATH_INFO" => "/cart")
assert(client.pending_events.zero?, "expected Rack flush-on-response to clear queue")
assert(transport.sent_bodies.length == 1, "expected Rack flush-on-response transport body")
assert(transport.last_body.include?('"id": "rack_flush_span_1"'), "expected Rack flush body")
tests += 1

client = sample_client
client.shutdown(LogBrew::RecordingTransport.always_accept)
errors = []
rack = LogBrew::RackMiddleware.new(
  lambda { |_env| [200, {}, []] },
  client: client,
  on_error: ->(error) { errors << error }
)
response = rack.call("REQUEST_METHOD" => "GET", "PATH_INFO" => "/safe")
assert(response[0] == 200, "expected Rack response despite capture failure")
assert(errors.length == 1, "expected Rack capture error callback")
assert(errors[0].message.include?("client is already shut down"), "expected Rack capture error message")
tests += 1

client = sample_client
subscriber = LogBrew::RailsErrorSubscriber.new(
  client: client,
  event_id_prefix: "rails_error",
  metadata: { service: "web", ignored: [] },
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 11) }
)
subscriber.report(
  RuntimeError.new("handled checkout failure"),
  handled: true,
  severity: :warning,
  context: { route: "checkout#create", user_id: 123, ignored: [] },
  source: "checkout.subscriber",
  extra_option: "ignored"
)
rails_events = JSON.parse(client.preview_json).fetch("events")
assert(rails_events.length == 1, "expected Rails subscriber issue")
rails_issue = rails_events[0]
assert(rails_issue.fetch("id") == "rails_error_1", "expected Rails issue id")
assert(rails_issue.fetch("timestamp") == "2026-06-02T10:00:11Z", "expected Rails issue timestamp")
issue_attributes = rails_issue.fetch("attributes")
assert(issue_attributes.fetch("title") == "RuntimeError", "expected Rails issue title")
assert(issue_attributes.fetch("level") == "warning", "expected Rails issue level")
assert(issue_attributes.fetch("message") == "handled checkout failure", "expected Rails issue message")
issue_metadata = issue_attributes.fetch("metadata")
assert(issue_metadata.fetch("service") == "web", "expected Rails base metadata")
assert(!issue_metadata.key?("ignored"), "expected Rails subscriber to skip non-primitive base metadata")
assert(issue_metadata.fetch("source") == "rails.error", "expected Rails source metadata")
assert(issue_metadata.fetch("rails.handled") == true, "expected Rails handled metadata")
assert(issue_metadata.fetch("rails.severity") == "warning", "expected Rails severity metadata")
assert(issue_metadata.fetch("rails.source") == "checkout.subscriber", "expected Rails source option metadata")
assert(issue_metadata.fetch("context.route") == "checkout#create", "expected Rails context route")
assert(issue_metadata.fetch("context.user_id") == 123, "expected Rails context user id")
assert(!issue_metadata.key?("context.ignored"), "expected Rails subscriber to skip non-primitive context")
assert(issue_metadata.fetch("exceptionType") == "RuntimeError", "expected Rails exception type")
assert(issue_metadata.fetch("exceptionMessage") == "handled checkout failure", "expected Rails exception message")
assert(!issue_metadata.key?("exceptionBacktrace"), "expected Rails exception backtrace to be opt-in")
tests += 1

client = sample_client
transport = LogBrew::RecordingTransport.always_accept
subscriber = LogBrew::RailsErrorSubscriber.new(
  client: client,
  transport: transport,
  flush_on_report: true,
  event_id_prefix: "rails_flush",
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 12) }
)
subscriber.report(RuntimeError.new("flush me"), handled: false, severity: :error, context: nil, source: "test")
assert(client.pending_events.zero?, "expected Rails flush-on-report to clear queue")
assert(transport.sent_bodies.length == 1, "expected Rails flush-on-report body")
assert(transport.last_body.include?('"id": "rails_flush_1"'), "expected Rails flush body")
tests += 1

client = sample_client
client.shutdown(LogBrew::RecordingTransport.always_accept)
errors = []
subscriber = LogBrew::RailsErrorSubscriber.new(
  client: client,
  on_error: ->(error) { errors << error }
)
subscriber.report(RuntimeError.new("safe failure"), handled: false, severity: :error)
assert(errors.length == 1, "expected Rails subscriber capture error callback")
assert(errors[0].message.include?("client is already shut down"), "expected Rails subscriber capture error message")
tests += 1

support_draft = LogBrew::SupportTicketDraft.create(
  source: "sdk",
  category: "ingest_failure",
  title: "Telemetry flush failed",
  description: "Flush returned usage_limit_exceeded",
  project_id: "proj_123",
  environment: "production",
  runtime: "ruby #{RUBY_VERSION}",
  framework: "rack",
  sdk_package: "logbrew-sdk",
  sdk_version: "0.1.0",
  release: "checkout@1.2.3",
  trace_id: "4BF92F3577B34DA6A3CE929D0E0E4736",
  event_id: "evt_checkout_flush",
  diagnostics: {
    attemptCount: 2,
    retryable: false,
    apiKey: "lbw_ingest_hidden",
    endpoint: "https://api.example/ingest?debug=true#frag",
    errorMessage: "api key leaked in camel case message",
    exception_message: "password leaked in snake case message",
    localPath: "/Users/example/app/.env",
    error: RuntimeError.new("contains hidden token"),
    headers: {
      authorization: "Bearer hidden",
      cookie: "sid=hidden",
      accept: "application/json"
    },
    events: [
      { id: "evt_checkout_flush", type: "span" },
      { token: "hidden" }
    ],
    callback: -> { "ignored" }
  }
)
assert(support_draft.fetch("source") == "sdk", "expected support source")
assert(support_draft.fetch("category") == "ingest_failure", "expected support category")
assert(support_draft.fetch("title") == "Telemetry flush failed", "expected support title")
assert(support_draft.fetch("description") == "Flush returned usage_limit_exceeded", "expected support description")
assert(support_draft.fetch("project_id") == "proj_123", "expected support project")
assert(support_draft.fetch("environment") == "production", "expected support environment")
assert(support_draft.fetch("runtime").start_with?("ruby "), "expected support runtime")
assert(support_draft.fetch("framework") == "rack", "expected support framework")
assert(support_draft.fetch("sdk_package") == "logbrew-sdk", "expected support sdk package")
assert(support_draft.fetch("sdk_version") == "0.1.0", "expected support sdk version")
assert(support_draft.fetch("release") == "checkout@1.2.3", "expected support release")
assert(support_draft.fetch("trace_id") == "4bf92f3577b34da6a3ce929d0e0e4736", "expected normalized support trace id")
assert(support_draft.fetch("event_id") == "evt_checkout_flush", "expected support event id")
support_diagnostics = support_draft.fetch("diagnostics")
assert(support_diagnostics.fetch("attemptCount") == 2, "expected support primitive diagnostic")
assert(support_diagnostics.fetch("retryable") == false, "expected support boolean diagnostic")
assert(support_diagnostics.fetch("apiKey") == "[redacted]", "expected support api key redaction")
assert(support_diagnostics.fetch("endpoint") == "[redacted-url]/ingest", "expected support URL redaction")
assert(support_diagnostics.fetch("errorMessage") == "[redacted]", "expected support error message redaction")
assert(support_diagnostics.fetch("exception_message") == "[redacted]", "expected support exception message redaction")
assert(support_diagnostics.fetch("localPath") == "[redacted-path]", "expected support path redaction")
assert(support_diagnostics.fetch("error").fetch("type") == "RuntimeError", "expected support exception type")
assert(!support_diagnostics.fetch("error").key?("message"), "expected support exception message omission")
headers = support_diagnostics.fetch("headers")
assert(headers.fetch("authorization") == "[redacted]", "expected support authorization redaction")
assert(headers.fetch("cookie") == "[redacted]", "expected support cookie redaction")
assert(headers.fetch("accept") == "application/json", "expected support harmless header")
events = support_diagnostics.fetch("events")
assert(events.length == 2, "expected support event diagnostics")
assert(events[1].fetch("token") == "[redacted]", "expected support nested token redaction")
assert(!support_diagnostics.key?("callback"), "expected support unsupported diagnostic omission")
support_json = JSON.generate(support_draft)
%w[hidden api.example /Users/example traceparent].each do |unsafe|
  assert(!support_json.include?(unsafe), "support draft leaked #{unsafe}: #{support_json}")
end
tests += 1

large_support_draft = LogBrew::SupportTicketDraft.create(
  source: "sdk",
  category: "other",
  title: "Large diagnostics",
  description: "Diagnostic maps should be bounded",
  diagnostics: Hash[(0...25).map { |index| ["item#{index}", index] }]
)
large_support_diagnostics = large_support_draft.fetch("diagnostics")
assert(large_support_diagnostics.length == 20, "expected support diagnostic map item bound")
assert(!large_support_diagnostics.key?("item24"), "expected support diagnostic map tail truncation")
tests += 1

expect_error("validation_error", "support ticket source must be one of") do
  LogBrew::SupportTicketDraft.create(
    source: "daemon",
    category: "ingest_failure",
    title: "Telemetry failed",
    description: "Flush failed"
  )
end
expect_error("validation_error", "support ticket trace_id must be 32 non-zero hex characters") do
  LogBrew::SupportTicketDraft.create(
    source: "sdk",
    category: "ingest_failure",
    title: "Telemetry failed",
    description: "Flush failed",
    trace_id: "00000000000000000000000000000000"
  )
end
expect_error("validation_error", "support ticket diagnostics must be an object") do
  LogBrew::SupportTicketDraft.create(
    source: "sdk",
    category: "other",
    title: "Telemetry failed",
    description: "Flush failed",
    diagnostics: []
  )
end
tests += 1

puts "ruby package tests ok (#{tests} tests)"
load File.expand_path("trace_correlation.rb", __dir__)
load File.expand_path("operation_tracing.rb", __dir__)
