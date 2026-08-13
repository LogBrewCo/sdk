# frozen_string_literal: true

require "json"
require_relative "../lib/logbrew"
require_relative "../lib/logbrew/rails_integration"

def assert(condition, message)
  raise message unless condition
end

def expect_sdk_error(code, message_fragment)
  yield
rescue LogBrew::SdkError => error
  assert(error.code == code, "expected #{code}, got #{error.code}")
  assert(error.message.include?(message_fragment), "expected error containing #{message_fragment}")
  return error
end

def rails_configuration(overrides = {})
  environment = {
    "LOGBREW_SERVER_API_KEY" => "installed-rails-key",
    "LOGBREW_FLUSH_INTERVAL_MS" => "60000",
    "LOGBREW_FLUSH_THRESHOLD" => "1000"
  }.merge(overrides)
  LogBrew::Rails::Configuration.from_environment(
    environment,
    application_name: "circulate",
    rails_environment: "test",
    rails_version: "8.1.3.1"
  )
end

tests = 0

disabled = LogBrew::Rails::Configuration.from_environment(
  {},
  application_name: "circulate",
  rails_environment: "test",
  rails_version: "8.1.3.1"
)
assert(!disabled.enabled?, "expected Rails integration to stay disabled without a key")
tests += 1

explicitly_disabled = LogBrew::Rails::Configuration.from_environment(
  { "LOGBREW_ENABLED" => "false", "LOGBREW_API_KEY" => "legacy-hidden" },
  application_name: "circulate",
  rails_environment: "test",
  rails_version: "8.1.3.1"
)
assert(!explicitly_disabled.enabled?, "expected explicit disable to ignore legacy configuration")
tests += 1

legacy_error = expect_sdk_error("configuration_error", "LOGBREW_SERVER_API_KEY") do
  LogBrew::Rails::Configuration.from_environment(
    { "LOGBREW_API_KEY" => "legacy-hidden" },
    application_name: "circulate",
    rails_environment: "test",
    rails_version: "8.1.3.1"
  )
end
assert(!legacy_error.message.include?("legacy-hidden"), "expected legacy-key error to omit the key value")
tests += 1

missing_key_error = expect_sdk_error("configuration_error", "LOGBREW_SERVER_API_KEY") do
  LogBrew::Rails::Configuration.from_environment(
    { "LOGBREW_ENABLED" => "true" },
    application_name: "circulate",
    rails_environment: "test",
    rails_version: "8.1.3.1"
  )
end
assert(!missing_key_error.message.include?("nil"), "expected missing-key error to omit raw state")
tests += 1

expect_sdk_error("configuration_error", "LOGBREW_ENABLED") do
  LogBrew::Rails::Configuration.from_environment(
    { "LOGBREW_ENABLED" => "sometimes" },
    application_name: "circulate",
    rails_environment: "test",
    rails_version: "8.1.3.1"
  )
end
tests += 1

expect_sdk_error("configuration_error", "LOGBREW_ENDPOINT") do
  rails_configuration("LOGBREW_ENDPOINT" => "http://example.test/v1/events")
end
expect_sdk_error("configuration_error", "LOGBREW_REQUEST_TIMEOUT_MS") do
  rails_configuration("LOGBREW_REQUEST_TIMEOUT_MS" => "unbounded")
end
expect_sdk_error("configuration_error", "LOGBREW_FLUSH_THRESHOLD") do
  rails_configuration("LOGBREW_FLUSH_THRESHOLD" => "1001")
end
expect_sdk_error("configuration_error", "LOGBREW_SERVICE_NAME") do
  rails_configuration("LOGBREW_SERVICE_NAME" => "line-one\nline-two")
end
tests += 1

configuration = rails_configuration(
  "LOGBREW_SERVICE_NAME" => "circulate-web",
  "LOGBREW_ENVIRONMENT" => "staging",
  "LOGBREW_RELEASE" => "circulate@2026.08.01",
  "LOGBREW_REQUEST_TIMEOUT_MS" => "2500",
  "LOGBREW_FLUSH_THRESHOLD" => "50"
)
assert(configuration.enabled?, "expected canonical key to enable Rails integration")
assert(configuration.service_name == "circulate-web", "expected configured service name")
assert(configuration.app_environment == "staging", "expected configured environment")
assert(configuration.release == "circulate@2026.08.01", "expected configured release")
assert(configuration.request_timeout == 2.5, "expected millisecond timeout conversion")
assert(configuration.flush_interval == 60.0, "expected millisecond flush conversion")
assert(configuration.flush_threshold == 50, "expected configured flush threshold")
assert(!configuration.capture_exception_messages?, "expected privacy-safe exception-message default")
tests += 1

opted_in_configuration = rails_configuration(
  "LOGBREW_ENDPOINT" => "http://127.0.0.1:4000/v1/events",
  "LOGBREW_CAPTURE_EXCEPTION_MESSAGES" => "true",
  "LOGBREW_INCLUDE_EXCEPTION_BACKTRACE" => "true"
)
assert(opted_in_configuration.endpoint == "http://127.0.0.1:4000/v1/events", "expected loopback HTTP")
assert(opted_in_configuration.capture_exception_messages?, "expected explicit message opt-in")
assert(opted_in_configuration.include_exception_backtrace?, "expected explicit backtrace opt-in")
tests += 1

fake_notifications = Struct.new(:subscriptions).new([])
fake_notifications.define_singleton_method(:subscribe) { |pattern, &subscriber| subscriptions << [pattern, subscriber] }
operations = LogBrew::Rails.const_get(:RequestOperations)
operations.install(fake_notifications)
operations.install(fake_notifications)
assert(fake_notifications.subscriptions.length == 1, "expected one idempotent Rails operation subscription")
tests += 1

transport = LogBrew::RecordingTransport.always_accept
runtime = LogBrew::Rails::Runtime.new(configuration, transport_factory: ->(_config) { transport })
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
assert(metadata.fetch("rails.operations.observed") == 10, "expected exact observed Rails operation count")
assert(metadata.fetch("rails.operations.captured") == 8, "expected exact captured Rails operation count")
assert(metadata.fetch("rails.operations.truncated") == true, "expected explicit Rails operation truncation")
assert(operation_spans.all? { |event| event.dig("attributes", "parentSpanId") == attributes.fetch("spanId") }, "expected exact request children")
assert(operation_spans.all? { |event| event.dig("attributes", "context", "trace", "spanId") == event.dig("attributes", "spanId") }, "expected typed operation span identity")
assert(operation_spans.any? { |event| event.dig("attributes", "metadata", "view.template") == "tools/show.html.erb" }, "expected relative template")
assert(operation_spans.any? { |event| event.dig("attributes", "metadata", "cache.hit") == true }, "expected cache result evidence")
assert(operation_spans.any? { |event| event.dig("attributes", "status") == "error" && event.dig("attributes", "metadata", "exceptionType") == "ArgumentError" }, "expected type-only operation failure")
assert(operation_spans.any? { |event| event.fetch("timestamp") == "2026-08-01T12:00:00.000000Z" }, "expected operation start timestamp")
assert(attributes.fetch("name") == "GET /tools/:id(.:format)", "expected Rails route-template span name")
assert(attributes.fetch("traceId") == "4bf92f3577b34da6a3ce929d0e0e4736", "expected incoming trace continuation")
assert(attributes.fetch("parentSpanId") == "00f067aa0ba902b7", "expected incoming parent span")
assert(
  typed_context.dig("trace", "traceId") == attributes.fetch("traceId"),
  "expected typed Rails request trace correlation"
)
assert(
  typed_context.dig("trace", "spanId") == attributes.fetch("spanId"),
  "expected typed Rails request span correlation"
)
assert(metadata.fetch("http.route") == "/tools/:id(.:format)", "expected route template metadata")
assert(metadata.fetch("rails.controller") == "tools", "expected bounded controller metadata")
assert(metadata.fetch("rails.action") == "show", "expected bounded action metadata")
assert(metadata.fetch("service") == "circulate-web", "expected service metadata")
assert(metadata.fetch("environment") == "staging", "expected environment metadata")
serialized = JSON.generate(events)
%w[opaque-record-id opaque-query opaque-auth installed-rails-key opaque@example.test opaque-account-cache-key private_accounts opaque\ SQL\ failure].each do |forbidden|
  assert(!serialized.include?(forbidden), "expected Rails telemetry to omit #{forbidden}")
end
assert(!serialized.include?("/srv/application"), "expected Rails telemetry to omit absolute template paths")
tests += 1

error_transport = LogBrew::RecordingTransport.always_accept
error_runtime = LogBrew::Rails::Runtime.new(
  rails_configuration,
  transport_factory: ->(_config) { error_transport }
)
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
assert(issue_attributes.fetch("title") == "RuntimeError", "expected type-only issue title")
assert(!issue_attributes.key?("message"), "expected exception message to be omitted by default")
assert(
  issue_attributes.fetch("exception") == {
    "type" => "RuntimeError",
    "mechanism" => { "type" => "rails.middleware", "handled" => false }
  },
  "expected first-class unhandled Rails exception mechanism"
)
issue_frames = issue_attributes.fetch("stackFrames")
assert(issue_frames.length.between?(1, 32), "expected bounded Rails exception frames")
assert(issue_frames.fetch(0).fetch("filename") == "rails_integration.rb", "expected newest-first Rails throw frame")
assert(!issue_frames.fetch(0).fetch("filename").include?(File::SEPARATOR), "expected basename-only Rails frames")
issue_metadata = issue_attributes.fetch("metadata")
assert(issue_metadata.fetch("errorName") == "RuntimeError", "expected backend-native Rails exception type")
assert(issue_metadata.fetch("handled") == false, "expected Rails exception to be unhandled")
assert(issue_metadata.fetch("mechanism") == "rails.middleware", "expected Rails middleware mechanism")
assert(
  issue_metadata.fetch("issueGroupingKey").match?(/\Arails-exception-[0-9a-f]{64}\z/),
  "expected stable Rails issue grouping key"
)
assert(issue_metadata.fetch("errorFrameFile") == "rails_integration.rb", "expected Rails frame basename metadata")
failed_span = error_events.find { |event| event.fetch("type") == "span" }.fetch("attributes")
assert(issue_metadata.fetch("traceId") == failed_span.fetch("traceId"), "expected Rails issue/span trace correlation")
assert(issue_metadata.fetch("spanId") == failed_span.fetch("spanId"), "expected Rails issue/span span correlation")
assert(!JSON.generate(error_events).include?("opaque application error detail"), "expected private exception detail to stay local")
assert(!JSON.generate(error_events).include?(File.expand_path("..", __dir__)), "expected absolute Rails source paths to stay local")
tests += 1

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
assert(
  handled_attributes.fetch("exception") == {
    "type" => "RuntimeError",
    "mechanism" => { "type" => "rails.error_reporter", "handled" => true }
  },
  "expected first-class handled Rails reporter mechanism"
)
assert(handled_metadata.fetch("rails.handled") == true, "expected handled Rails issue metadata")
assert(handled_metadata.fetch("handled") == true, "expected handled Rails mechanism state")
assert(handled_metadata.fetch("mechanism") == "rails.error_reporter", "expected Rails error-reporter mechanism")
assert(!JSON.generate(reporter_events).include?("opaque handled error detail"), "expected handled error message to stay local")
assert(!JSON.generate(reporter_events).include?("opaque-user-id"), "expected user context to stay local")
tests += 1

concurrent_runtime = LogBrew::Rails::Runtime.new(
  rails_configuration,
  transport_factory: ->(_config) { LogBrew::RecordingTransport.always_accept }
)
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
assert(span_ids.length == 100, "expected every concurrent Rails request span")
assert(span_ids.uniq.length == 100, "expected unique concurrent Rails event ids")
tests += 1

response = runtime.shutdown
assert(response.status_code == 202, "expected Rails runtime shutdown flush")
assert(runtime.shutdown.equal?(response), "expected repeated Rails shutdown to be idempotent")
error_runtime.shutdown
concurrent_runtime.shutdown
tests += 1

disabled_runtime = LogBrew::Rails::Runtime.new(disabled)
disabled_response = Object.new
disabled_app = ->(_environment) { disabled_response }
assert(
  LogBrew::Rails::RequestMiddleware.new(disabled_app, runtime: disabled_runtime).call({}).equal?(disabled_response),
  "expected disabled Rails middleware to remain transparent"
)
assert(disabled_runtime.client.nil?, "expected disabled Rails runtime to create no client")
tests += 1

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
tests += 1

class FakeRailsClient
  attr_reader :environment_events, :release_events, :shutdown_calls

  def initialize
    @environment_events = []
    @release_events = []
    @shutdown_calls = 0
    @shutdown_response = Object.new
  end

  def environment(*arguments)
    @environment_events << arguments
  end

  def release(*arguments)
    @release_events << arguments
  end

  def shutdown
    @shutdown_calls += 1
    @shutdown_response
  end
end

fake_process_id = 100
fake_clients = []
fork_runtime = LogBrew::Rails::Runtime.new(
  rails_configuration,
  process_id_provider: -> { fake_process_id },
  transport_factory: ->(_config) { Object.new },
  client_factory: lambda do |_config, _transport|
    FakeRailsClient.new.tap { |client| fake_clients << client }
  end
)
first_process_client = fork_runtime.client
assert(first_process_client.environment_events.length == 1, "expected first process environment marker")
fake_process_id = 101
second_process_client = fork_runtime.client
assert(!second_process_client.equal?(first_process_client), "expected a fresh client after process change")
assert(first_process_client.shutdown_calls.zero?, "expected inherited client state to remain untouched")
fork_shutdown = fork_runtime.shutdown
assert(fork_runtime.shutdown.equal?(fork_shutdown), "expected process-local shutdown idempotency")
assert(second_process_client.shutdown_calls == 1, "expected one shutdown in the active process")
tests += 1

puts "ruby Rails integration tests passed: #{tests}"
