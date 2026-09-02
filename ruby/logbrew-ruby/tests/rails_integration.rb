# frozen_string_literal: true

require "json"
require "net/http"
require "stringio"
require "timeout"
require "uri"
require_relative "../lib/logbrew"
require_relative "../lib/logbrew/rails_integration"
require_relative "local_http_intake"
require_relative "test_helpers"
include SdkTestHelpers

def rails_configuration(overrides = {}, keyed: true)
  defaults = {
    "LOGBREW_SERVER_API_KEY" => "installed-rails-key",
    "LOGBREW_FLUSH_INTERVAL_MS" => "60000",
    "LOGBREW_FLUSH_THRESHOLD" => "1000"
  }
  LogBrew::Rails::Configuration.from_environment(
    keyed ? defaults.merge(overrides) : overrides,
    application_name: "circulate",
    rails_environment: "test",
    rails_version: "8.1.3.1"
  )
end

def rails_runtime(configuration = rails_configuration, transport = LogBrew::RecordingTransport.always_accept)
  LogBrew::Rails::Runtime.new(configuration, transport_factory: ->(_config) { transport })
end

disabled = rails_configuration({}, keyed: false)
assert(!disabled.enabled?, "expected Rails integration to stay disabled without a key")

assert(
  !rails_configuration({ "LOGBREW_ENABLED" => "false", "LOGBREW_API_KEY" => "legacy-hidden" }, keyed: false).enabled?,
  "expected explicit disable to ignore legacy configuration"
)

expect_sdk_error("configuration_error", "LOGBREW_SERVER_API_KEY", forbidden: "legacy-hidden") do
  rails_configuration({ "LOGBREW_API_KEY" => "legacy-hidden" }, keyed: false)
end

expect_sdk_error("configuration_error", "LOGBREW_SERVER_API_KEY", forbidden: "nil") do
  rails_configuration({ "LOGBREW_ENABLED" => "true" }, keyed: false)
end

{
  "LOGBREW_ENABLED" => "sometimes",
  "LOGBREW_CAPTURE_RAILS_LOGS" => "sometimes",
  "LOGBREW_ENDPOINT" => "http://example.test/v1/events",
  "LOGBREW_REQUEST_TIMEOUT_MS" => "unbounded",
  "LOGBREW_FLUSH_THRESHOLD" => "1001",
  "LOGBREW_SERVICE_NAME" => "line-one\nline-two"
}.each do |name, value|
  expect_sdk_error("configuration_error", name) { rails_configuration({ name => value }) }
end

configuration = rails_configuration(
  {
    "LOGBREW_SERVICE_NAME" => "circulate-web",
    "LOGBREW_ENVIRONMENT" => "staging",
    "LOGBREW_RELEASE" => "circulate@2026.08.01",
    "LOGBREW_REQUEST_TIMEOUT_MS" => "2500",
    "LOGBREW_FLUSH_THRESHOLD" => "50"
  }
)
configuration_values = [
  configuration.enabled?, configuration.service_name, configuration.app_environment,
  configuration.release, configuration.request_timeout, configuration.flush_interval,
  configuration.flush_threshold, configuration.capture_exception_messages?, configuration.capture_rails_logs?
]
assert(
  configuration_values == [true, "circulate-web", "staging", "circulate@2026.08.01", 2.5, 60.0, 50, false, false],
  "expected normalized Rails configuration"
)

opted_in_configuration = rails_configuration(
  {
    "LOGBREW_ENDPOINT" => "http://127.0.0.1:4000/v1/events",
    "LOGBREW_CAPTURE_EXCEPTION_MESSAGES" => "true",
    "LOGBREW_CAPTURE_RAILS_LOGS" => "true",
    "LOGBREW_INCLUDE_EXCEPTION_BACKTRACE" => "true"
  }
)
assert(
  [opted_in_configuration.endpoint, opted_in_configuration.capture_exception_messages?, opted_in_configuration.capture_rails_logs?, opted_in_configuration.include_exception_backtrace?] ==
    ["http://127.0.0.1:4000/v1/events", true, true, true],
  "expected explicit Rails capture opt-ins"
)

fake_notifications = Struct.new(:subscriptions).new([])
fake_notifications.define_singleton_method(:subscribe) { |pattern, &subscriber| subscriptions << [pattern, subscriber] }
operations = LogBrew::Rails.const_get(:RequestOperations)
operations.install(fake_notifications)
operations.install(fake_notifications)
assert(fake_notifications.subscriptions.length == 1, "expected one idempotent Rails operation subscription")

runtime = rails_runtime(configuration)
log_runtime = rails_runtime(opted_in_configuration)
log_output = StringIO.new
application_logger = Logger.new(log_output)
log_capture = LogBrew::Rails.const_get(:ApplicationLogCapture)
2.times { log_capture.install(application_logger, log_runtime, application_root: __dir__) }
log_parent = LogBrew::Trace.create(trace_id: "6bf92f3577b34da6a3ce929d0e0e4736", span_id: "20f067aa0ba902b7")
block_calls = 0
log_result = LogBrew::Trace.with_context(log_parent) do
  application_logger.warn { block_calls += 1; "checkout delayed" }.tap do
    application_logger.info("x" * 2_049)
  end
  application_logger.add(Logger::WARN, false)
  eval('application_logger.warn("framework noise")', binding, "/vendor/gems/framework.rb", 1)
end
log_events = JSON.parse(log_runtime.client.preview_json).fetch("events").select { |event| event.fetch("type") == "log" }
assert(log_result == true && block_calls == 1 && log_output.string.include?("checkout delayed"), "expected transparent lazy Rails logging")
assert(log_events.map { |event| event.dig("attributes", "message").length } == [16, 2_048, 5], "expected bounded application-only Rails log messages")
assert(log_events.map { |event| event.dig("attributes", "metadata", "messageState") } == %w[captured truncated captured], "expected explicit Rails log message states")
assert(log_events.fetch(0).dig("attributes", "context", "trace", "traceId") == log_parent.trace_id, "expected Rails log trace correlation")
application_response = [200, { "content-type" => "text/plain" }, ["ok"]]
app = lambda do |environment|
  environment["action_dispatch.route_uri_pattern"] = "/tools/:id(.:format)"
  environment["action_dispatch.request.path_parameters"] = {
    controller: "tools",
    action: "show",
    id: "opaque-record-id"
  }
  first_operation_at = Time.utc(2026, 8, 1, 12, 0, 0)
  operations.record("sql.active_record", first_operation_at, first_operation_at + 0.025, nil, sql: "SELECT * FROM private_accounts WHERE email = 'opaque@example.test'", exception_object: ArgumentError.new("opaque SQL failure"))
  operations.record("cache_read.active_support", first_operation_at + 1, first_operation_at + 1.003, nil, key: "opaque-account-cache-key", hit: true)
  operations.record("render_template.action_view", first_operation_at + 2, first_operation_at + 2.012, nil, identifier: "/srv/application/app/views/tools/show.html.erb")
  7.times do |index|
    operations.record("sql.active_record", first_operation_at + 3 + index, first_operation_at + 3.001 + index + (index / 10_000.0), nil, sql: "UPDATE private_rows")
  end
  application_response
end
middleware = LogBrew::Rails::RequestMiddleware.new(app, runtime: runtime)
incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
response = middleware.call(
  "REQUEST_METHOD" => "GET",
  "PATH_INFO" => "/tools/opaque-record-id",
  "QUERY_STRING" => "session_hint=opaque-query",
  "HTTP_TRACEPARENT" => incoming,
  "HTTP_AUTHORIZATION" => "Bearer opaque-auth"
)
assert(response.equal?(application_response), "expected Rails response identity to stay unchanged")

events = JSON.parse(runtime.client.preview_json).fetch("events")
request_span = events.find do |event|
  event.fetch("type") == "span" && event.dig("attributes", "metadata", "source") == "rails"
end
assert(!request_span.nil?, "expected one Rails request span")
attributes = request_span.fetch("attributes")
metadata = attributes.fetch("metadata")
typed_context = attributes.fetch("context")
operation_spans = events.select { |event| event.fetch("type") == "span" && event.dig("attributes", "metadata", "source") == "rails.active_support" }
assert(operation_spans.length == 8, "expected the eight slowest bounded Rails operation spans")
assert(
  metadata.values_at("rails.operations.observed", "rails.operations.captured", "rails.operations.truncated") == [10, 8, true],
  "expected exact bounded Rails operation receipt"
)
assert(operation_spans.all? { |event| event.dig("attributes", "parentSpanId") == attributes.fetch("spanId") }, "expected exact request children")
assert(operation_spans.all? { |event| event.dig("attributes", "context", "trace", "spanId") == event.dig("attributes", "spanId") }, "expected typed operation span identity")
assert(operation_spans.any? { |event| event.dig("attributes", "metadata", "view.template") == "tools/show.html.erb" }, "expected relative template")
assert(operation_spans.any? { |event| event.dig("attributes", "metadata", "cache.hit") == true }, "expected cache result evidence")
assert(operation_spans.any? { |event| event.dig("attributes", "status") == "error" && event.dig("attributes", "metadata", "exceptionType") == "ArgumentError" }, "expected type-only operation failure")
assert(operation_spans.any? { |event| event.fetch("timestamp") == "2026-08-01T12:00:00.000000Z" }, "expected operation start timestamp")
assert(
  attributes.values_at("name", "traceId", "parentSpanId") ==
    ["GET /tools/:id(.:format)", "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"],
  "expected Rails request identity and incoming trace"
)
assert(
  typed_context.fetch("trace").values_at("traceId", "spanId") == attributes.values_at("traceId", "spanId"),
  "expected typed Rails request correlation"
)
assert(
  metadata.values_at("http.route", "rails.controller", "rails.action", "service", "environment") ==
    ["/tools/:id(.:format)", "tools", "show", "circulate-web", "staging"],
  "expected bounded Rails request metadata"
)
serialized = JSON.generate(events)
%w[opaque-record-id opaque-query opaque-auth installed-rails-key opaque@example.test opaque-account-cache-key private_accounts opaque\ SQL\ failure /srv/application].each do |forbidden|
  assert(!serialized.include?(forbidden), "expected Rails telemetry to omit #{forbidden}")
end

error_runtime = rails_runtime
application_error = RuntimeError.new("opaque application error detail")
error_app = lambda do |environment|
  environment["action_dispatch.route_uri_pattern"] = "/failures/:id(.:format)"
  raise application_error
end
error_middleware = LogBrew::Rails::RequestMiddleware.new(error_app, runtime: error_runtime)
raised = nil
begin
  error_middleware.call("REQUEST_METHOD" => "POST", "PATH_INFO" => "/failures/opaque-id")
rescue RuntimeError => error
  raised = error
end
assert(raised.equal?(application_error), "expected Rails application error identity to stay unchanged")
error_events = JSON.parse(error_runtime.client.preview_json).fetch("events")
issue = error_events.find { |event| event.fetch("type") == "issue" }
assert(!issue.nil?, "expected unhandled Rails issue")
issue_attributes = issue.fetch("attributes")
issue_frames = issue_attributes.fetch("stackFrames")
issue_metadata = issue_attributes.fetch("metadata")
failed_span = error_events.find { |event| event.fetch("type") == "span" }.fetch("attributes")
assert_values("expected bounded privacy-safe unhandled Rails issue", [
  issue_attributes.fetch("title"), issue_attributes.key?("message"), issue_attributes.fetch("exception"),
  issue_frames.length.between?(1, 32), issue_frames.fetch(0).fetch("filename"),
  issue_metadata.values_at("errorName", "handled", "mechanism", "errorFrameFile"),
  issue_metadata.fetch("issueGroupingKey").match?(/\Arails-exception-[0-9a-f]{64}\z/),
  issue_metadata.values_at("traceId", "spanId"),
  JSON.generate(error_events).include?("opaque application error detail"),
  JSON.generate(error_events).include?(File.expand_path("..", __dir__))
], [
  "RuntimeError", false,
  { "type" => "RuntimeError", "mechanism" => { "type" => "rails.middleware", "handled" => false } },
  true, "rails_integration.rb", ["RuntimeError", false, "rails.middleware", "rails_integration.rb"], true,
  failed_span.values_at("traceId", "spanId"), false, false
])

reporter = LogBrew::Rails::ErrorReporter.new(error_runtime)
reporter.report(
  RuntimeError.new("opaque handled error detail"),
  handled: true,
  severity: :warning,
  context: { controller: "tools", user_id: "opaque-user-id" },
  source: "application"
)
before_unhandled = error_runtime.client.pending_events
reporter.report(RuntimeError.new("duplicate unhandled detail"), handled: false, severity: :error)
assert(error_runtime.client.pending_events == before_unhandled, "expected unhandled reporter event to avoid middleware duplicate")
reporter_events = JSON.parse(error_runtime.client.preview_json).fetch("events")
handled_issue = reporter_events.reverse.find { |event| event.fetch("type") == "issue" }
handled_attributes = handled_issue.fetch("attributes")
handled_metadata = handled_attributes.fetch("metadata")
reporter_json = JSON.generate(reporter_events)
assert_values("expected bounded privacy-safe handled Rails issue", [
  handled_attributes.fetch("exception"), handled_metadata.values_at("rails.handled", "handled", "mechanism"),
  reporter_json.include?("opaque handled error detail"), reporter_json.include?("opaque-user-id")
], [
  { "type" => "RuntimeError", "mechanism" => { "type" => "rails.error_reporter", "handled" => true } },
  [true, true, "rails.error_reporter"], false, false
])

concurrent_runtime = rails_runtime
concurrent_app = lambda do |environment|
  environment["action_dispatch.route_uri_pattern"] = "/health(.:format)"
  [204, {}, []]
end
concurrent_middleware = LogBrew::Rails::RequestMiddleware.new(concurrent_app, runtime: concurrent_runtime)
threads = 100.times.map do
  Thread.new { concurrent_middleware.call("REQUEST_METHOD" => "GET", "PATH_INFO" => "/health") }
end
threads.each(&:join)
concurrent_events = JSON.parse(concurrent_runtime.client.preview_json).fetch("events")
span_ids = concurrent_events.select { |event| event.fetch("type") == "span" }.map { |event| event.fetch("id") }
assert(span_ids.length == 100 && span_ids.uniq.length == 100, "expected every concurrent Rails span id to be unique")

response = runtime.shutdown
assert(response.status_code == 202 && runtime.shutdown.equal?(response), "expected idempotent Rails shutdown flush")
log_runtime.shutdown
error_runtime.shutdown
concurrent_runtime.shutdown

disabled_runtime = LogBrew::Rails::Runtime.new(disabled)
disabled_response = Object.new
disabled_app = ->(_environment) { disabled_response }
assert(
  LogBrew::Rails::RequestMiddleware.new(disabled_app, runtime: disabled_runtime).call({}).equal?(disabled_response) &&
    disabled_runtime.client.nil?,
  "expected disabled Rails runtime to remain transparent"
)

capture_failures = []
broken_runtime = LogBrew::Rails::Runtime.new(
  rails_configuration,
  transport_factory: ->(_config) { Object.new },
  client_factory: ->(_config, _transport) { raise "opaque client construction detail" },
  on_error: ->(stage, error) { capture_failures << [stage, error.class.name] }
)
broken_calls = 0
broken_response = Object.new
broken_app = lambda do |_environment|
  broken_calls += 1
  broken_response
end
actual_response = LogBrew::Rails::RequestMiddleware.new(broken_app, runtime: broken_runtime).call({})
assert(actual_response.equal?(broken_response), "expected capture initialization failure to preserve response")
assert(broken_calls == 1, "expected capture initialization failure to call the application once")
assert(capture_failures == [["client_initialization", "RuntimeError"]], "expected bounded capture failure")

FakeRailsClient = Struct.new(:environment_events, :release_events, :shutdown_calls, :shutdown_response) do
  def initialize
    super([], [], 0, Object.new)
  end

  %i[environment release].each do |kind|
    define_method(kind) { |*arguments| public_send("#{kind}_events") << arguments }
  end

  def shutdown
    self.shutdown_calls += 1
    shutdown_response
  end
end

fake_process_id = 100
fork_runtime = LogBrew::Rails::Runtime.new(
  rails_configuration,
  process_id_provider: -> { fake_process_id },
  transport_factory: ->(_config) { Object.new },
  client_factory: ->(_config, _transport) { FakeRailsClient.new }
)
first_process_client = fork_runtime.client
assert(first_process_client.environment_events.length == 1, "expected first process environment marker")
fake_process_id = 101
second_process_client = fork_runtime.client
assert(!second_process_client.equal?(first_process_client), "expected a fresh client after process change")
assert(first_process_client.shutdown_calls.zero?, "expected inherited client state to remain untouched")
assert(fork_runtime.shutdown.equal?(fork_runtime.shutdown), "expected process-local shutdown idempotency")
assert(second_process_client.shutdown_calls == 1, "expected one shutdown in the active process")

class ActiveJobProbe
  attr_reader :serialized, :last_error, :executions

  def initialize(failing_attempts: 0)
    @executions = 0
    @failing_attempts = failing_attempts
  end

  def enqueue(_options = {})
    @serialized = serialize
    self
  end

  def serialize
    {
      "job_class" => self.class.name,
      "job_id" => "opaque-job-id",
      "queue_name" => "opaque-queue-name",
      "arguments" => ["opaque-job-argument"],
      "executions" => @executions,
      "failing_attempts" => @failing_attempts
    }
  end

  def deserialize(payload)
    @executions = payload.fetch("executions")
    @failing_attempts = payload.fetch("failing_attempts")
    self
  end

  def perform_now
    @executions += 1
    _perform_job
  rescue RuntimeError
    raise unless @executions < @failing_attempts

    enqueue
    :retried
  end

  def _perform_job
    return :performed if @executions > @failing_attempts

    @last_error = RuntimeError.new("opaque ActiveJob failure detail")
    raise @last_error
  end
end

ActiveJobProbe.prepend(LogBrew::Rails.const_get(:ActiveJobExtension))
active_job_runtime = rails_runtime
previous_runtime = LogBrew::Rails.instance_variable_get(:@runtime)
LogBrew::Rails.instance_variable_set(:@runtime, active_job_runtime)
begin
  parent = LogBrew::Trace.create(
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b7"
  )
  producer = ActiveJobProbe.new(failing_attempts: 2)
  enqueue_result = LogBrew::Trace.with_context(parent) { producer.enqueue }
  assert(enqueue_result.equal?(producer), "expected ActiveJob enqueue result identity")
  carrier = producer.serialized.fetch("logbrew")
  assert(carrier.keys.sort == %w[enqueuedAtMs traceparent version], "expected bounded ActiveJob carrier")

  first_worker = ActiveJobProbe.new.deserialize(producer.serialized)
  assert(first_worker.perform_now == :retried, "expected first ActiveJob failure to schedule a retry")
  retry_payload = first_worker.serialized
  first_events = JSON.parse(active_job_runtime.client.preview_json).fetch("events")
  assert(first_events.count { |event| event.fetch("type") == "span" } == 3, "expected enqueue, failed worker, and retry spans")
  assert(first_events.none? { |event| event.fetch("type") == "issue" }, "expected retryable ActiveJob failure to remain span-only")

  second_worker = ActiveJobProbe.new.deserialize(retry_payload)
  raised = nil
  begin
    second_worker.perform_now
  rescue RuntimeError => error
    raised = error
  end
  assert(raised.equal?(second_worker.last_error), "expected terminal ActiveJob exception identity")
  active_job_events = JSON.parse(active_job_runtime.client.preview_json).fetch("events")
  spans = active_job_events.select { |event| event.fetch("type") == "span" }
  issues = active_job_events.select { |event| event.fetch("type") == "issue" }
  span_attributes = spans.map { |event| event.fetch("attributes") }
  assert(spans.length == 4, "expected two ActiveJob producer and two worker spans")
  assert(spans.all? { |event| event.dig("attributes", "traceId") == parent.trace_id }, "expected one ActiveJob trace")
  assert(spans.map { |event| event.dig("attributes", "metadata", "operation") } == %w[queue.publish queue.process queue.publish queue.process], "expected semantic ActiveJob operations")
  assert(span_attributes.fetch(0).fetch("parentSpanId") == parent.span_id, "expected enqueue under caller span")
  assert(span_attributes.fetch(1).fetch("parentSpanId") == span_attributes.fetch(0).fetch("spanId"), "expected first worker under enqueue")
  assert(span_attributes.fetch(2).fetch("parentSpanId") == span_attributes.fetch(1).fetch("spanId"), "expected retry enqueue under worker")
  assert(span_attributes.fetch(3).fetch("parentSpanId") == span_attributes.fetch(2).fetch("spanId"), "expected retry worker under enqueue")
  assert(spans.count { |event| event.dig("attributes", "status") == "error" } == 2, "expected failed attempt spans")
  assert(spans.map { |event| event.dig("attributes", "metadata", "retryCount") } == [0, 0, 1, 1], "expected retry sequence")
  assert(issues.length == 1, "expected one terminal ActiveJob issue")
  issue = issues.fetch(0).fetch("attributes")
  assert(issue.fetch("title") == "RuntimeError", "expected typed ActiveJob issue title")
  assert(issue.fetch("exception") == {
    "type" => "RuntimeError",
    "mechanism" => { "type" => "rails.active_job", "handled" => false }
  }, "expected unhandled ActiveJob mechanism")
  assert(issue.fetch("stackFrames").length.between?(1, 32), "expected bounded ActiveJob frames")
  assert(issue.dig("metadata", "activeJob.class") == "ActiveJobProbe", "expected bounded job class")
  assert(issue.dig("metadata", "traceId") == parent.trace_id, "expected ActiveJob issue trace correlation")
  assert(issue.dig("metadata", "spanId") == span_attributes.fetch(3).fetch("spanId"), "expected ActiveJob issue span correlation")
  serialized = JSON.generate(active_job_events)
  %w[opaque-job-id opaque-queue-name opaque-job-argument opaque\ ActiveJob\ failure\ detail installed-rails-key].each do |forbidden|
    assert(!serialized.include?(forbidden.tr("\\", " ")), "expected ActiveJob telemetry to omit private job data")
  end
ensure
  LogBrew::Rails.instance_variable_set(:@runtime, previous_runtime)
  active_job_runtime.shutdown
end

outbound_runtime = rails_runtime
outbound_server = LocalHttpIntake.new([204, 204], host: "localhost", path: "/private")
previous_runtime = LogBrew::Rails.instance_variable_get(:@runtime)
LogBrew::Rails.instance_variable_set(:@runtime, outbound_runtime)
begin
  LogBrew::Rails.const_get(:OutboundHttp).install
  uri = URI("#{outbound_server.endpoint}?marker=opaque-query")
  request = Net::HTTP::Get.new(uri)
  parent = LogBrew::Trace.create(
    trace_id: "33333333333333333333333333333333",
    span_id: "4444444444444444"
  )
  response = LogBrew::Trace.with_context(parent) { Net::HTTP.start(uri.host, uri.port) { |http| http.request(request) } }
  assert(response.code == "204", "expected automatic Rails outbound response")
  record = Timeout.timeout(2) { outbound_server.records.pop }
  events = JSON.parse(outbound_runtime.client.preview_json).fetch("events")
  spans = events.select { |event| event.fetch("type") == "span" }
  span = spans.fetch(0).fetch("attributes")
  assert(spans.length == 1, "expected one automatic Rails outbound span")
  assert(span.values_at("traceId", "parentSpanId") == [parent.trace_id, parent.span_id], "expected outbound parent trace")
  assert(span.fetch("metadata") == {
    "method" => "GET",
    "host" => "localhost",
    "statusCode" => 204,
    "source" => "net_http",
    "sampled" => true
  }, "expected bounded automatic outbound evidence")
  assert(record.headers.fetch("traceparent").include?(span.fetch("spanId")), "expected outbound propagation")
  serialized = JSON.generate(events)
  %w[private opaque-query].each do |forbidden|
    assert(!serialized.include?(forbidden), "expected automatic outbound telemetry to omit #{forbidden}")
  end

  pending_events = outbound_runtime.client.pending_events
  Net::HTTP.get_response(uri)
  assert(outbound_runtime.client.pending_events == pending_events, "expected no automatic span without a parent trace")
  Timeout.timeout(2) { outbound_server.records.pop }
ensure
  LogBrew::Rails.instance_variable_set(:@runtime, previous_runtime)
  outbound_server.close
  outbound_runtime.shutdown
end

puts "ruby Rails integration tests passed"
