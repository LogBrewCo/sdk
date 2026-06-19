# frozen_string_literal: true

require "json"
require_relative "../lib/logbrew"

def operation_assert(condition, message)
  raise message unless condition
end

def operation_sample_client
  LogBrew::Client.create(api_key: "LOGBREW_API_KEY", sdk_name: "logbrew-ruby", sdk_version: "0.1.0")
end

operation_tests = 0
parent_context = LogBrew::Trace.create(
  trace_id: "11111111111111111111111111111111",
  span_id: "2222222222222222",
  trace_flags: "01"
)

client = operation_sample_client
result = LogBrew::Trace.with_context(parent_context) do
  LogBrew::OperationTracing.database_operation(
    client,
    "users.lookup",
    event_id: "evt_db_span",
    timestamp: "2026-06-02T10:00:13Z",
    duration_ms: 12.5,
    system: "postgresql",
    operation: "select",
    target: "users",
    metadata: {
      service: "api",
      rowCount: 1,
      sql: "select * from users where email = ?",
      connectionString: "postgres://placeholder.example/db",
      host: "db.internal",
      ignored: []
    }
  ) do
    active = LogBrew::Trace.current
    operation_assert(active.trace_id == parent_context.trace_id, "expected child trace id")
    operation_assert(active.parent_span_id == parent_context.span_id, "expected child parent span id")
    "user-123"
  end
end
operation_assert(result == "user-123", "expected database operation result")
event = JSON.parse(client.preview_json).fetch("events")[0]
attributes = event.fetch("attributes")
metadata = attributes.fetch("metadata")
operation_assert(event.fetch("id") == "evt_db_span", "expected database span event id")
operation_assert(attributes.fetch("name") == "database.operation:users.lookup", "expected database span name")
operation_assert(attributes.fetch("traceId") == parent_context.trace_id, "expected database trace id")
operation_assert(attributes.fetch("parentSpanId") == parent_context.span_id, "expected database parent span id")
operation_assert(attributes.fetch("status") == "ok", "expected database status")
operation_assert(attributes.fetch("durationMs") == 12.5, "expected database duration")
operation_assert(metadata.fetch("source") == "database.operation", "expected database source")
operation_assert(metadata.fetch("database.system") == "postgresql", "expected database system")
operation_assert(metadata.fetch("database.operation") == "select", "expected database operation")
operation_assert(metadata.fetch("database.target") == "users", "expected database target")
operation_assert(metadata.fetch("service") == "api", "expected safe metadata")
operation_assert(metadata.fetch("rowCount") == 1, "expected primitive metadata")
%w[sql connectionString host ignored].each do |key|
  operation_assert(!metadata.key?(key), "expected #{key} to be dropped")
end
operation_tests += 1

client = operation_sample_client
LogBrew::OperationTracing.cache_operation(
  client,
  "profile.get",
  event_id: "evt_cache_span",
  timestamp: "2026-06-02T10:00:14Z",
  duration_ms: 3.25,
  system: "redis",
  operation: "get",
  metadata: { hit: true, cacheKey: "profile:user-123", value: "redacted", command: "GET profile:user-123" }
) { :hit }
cache_metadata = JSON.parse(client.preview_json).fetch("events")[0].fetch("attributes").fetch("metadata")
operation_assert(cache_metadata.fetch("source") == "cache.operation", "expected cache source")
operation_assert(cache_metadata.fetch("cache.system") == "redis", "expected cache system")
operation_assert(cache_metadata.fetch("cache.operation") == "get", "expected cache operation")
operation_assert(cache_metadata.fetch("hit") == true, "expected cache hit")
%w[cacheKey value command].each do |key|
  operation_assert(!cache_metadata.key?(key), "expected cache #{key} to be dropped")
end
operation_tests += 1

client = operation_sample_client
begin
  LogBrew::OperationTracing.queue_operation(
    client,
    "checkout.process",
    event_id: "evt_queue_span",
    timestamp: "2026-06-02T10:00:15Z",
    duration_ms: 8.75,
    system: "sidekiq",
    operation: "process",
    target: "checkout",
    metadata: { attempt: 2, messageBody: "private", jid: "job_123", headerTrace: "redacted" }
  ) do
    raise ArgumentError, "private job failure"
  end
rescue ArgumentError => error
  operation_assert(error.message == "private job failure", "expected original queue exception")
else
  raise "expected queue exception"
end
queue_attributes = JSON.parse(client.preview_json).fetch("events")[0].fetch("attributes")
queue_metadata = queue_attributes.fetch("metadata")
operation_assert(queue_attributes.fetch("status") == "error", "expected queue error status")
operation_assert(queue_metadata.fetch("source") == "queue.operation", "expected queue source")
operation_assert(queue_metadata.fetch("queue.system") == "sidekiq", "expected queue system")
operation_assert(queue_metadata.fetch("queue.operation") == "process", "expected queue operation")
operation_assert(queue_metadata.fetch("queue.target") == "checkout", "expected queue target")
operation_assert(queue_metadata.fetch("attempt") == 2, "expected queue primitive metadata")
operation_assert(queue_metadata.fetch("exceptionType") == "ArgumentError", "expected exception type only")
%w[messageBody jid headerTrace exceptionMessage exceptionBacktrace].each do |key|
  operation_assert(!queue_metadata.key?(key), "expected queue #{key} to be omitted")
end
operation_tests += 1

client = operation_sample_client
client.shutdown(LogBrew::RecordingTransport.always_accept)
errors = []
result = LogBrew::OperationTracing.database_operation(
  client,
  "safe.capture.failure",
  on_error: ->(error) { errors << error }
) { "still returned" }
operation_assert(result == "still returned", "expected capture failure to preserve app result")
operation_assert(errors.length == 1, "expected capture error callback")
operation_assert(errors[0].message.include?("client is already shut down"), "expected capture error detail")
operation_tests += 1

puts "ruby operation tracing tests ok (#{operation_tests} tests)"
