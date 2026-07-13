# frozen_string_literal: true

require "json"
require "thread"
require_relative "../lib/logbrew"

def assert_bounded_queue(condition, message)
  raise message unless condition
end

def expect_bounded_queue_error(code, message_fragment)
  yield
  raise "expected #{code}"
rescue LogBrew::SdkError => error
  assert_bounded_queue(error.code == code, "expected #{code}, got #{error.code}")
  assert_bounded_queue(error.message.include?(message_fragment), "expected error containing #{message_fragment}")
  return error
end

class BlockingQueueTransport
  attr_reader :sent_bodies

  def initialize(status_code: 202)
    @status_code = status_code
    @entered = Queue.new
    @release = Queue.new
    @sent_bodies = []
  end

  def send(_api_key, body)
    @sent_bodies << body
    @entered << true
    @release.pop
    LogBrew::TransportResponse.new(@status_code, 1)
  end

  def wait_until_entered
    @entered.pop
  end

  def release
    @release << true
  end
end

def bounded_queue_client(**options)
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby",
    sdk_version: "0.1.0",
    **options
  )
end

tests = 0

expect_bounded_queue_error("validation_error", "max_queue_size must be a positive integer") do
  bounded_queue_client(max_queue_size: 0)
end
expect_bounded_queue_error("validation_error", "max_queue_bytes must be a positive integer") do
  bounded_queue_client(max_queue_bytes: 0)
end
expect_bounded_queue_error("validation_error", "on_event_dropped must respond to call") do
  bounded_queue_client(on_event_dropped: Object.new)
end
tests += 1

invalid_json_client = bounded_queue_client
invalid_utf8 = "\xB1\x31".dup.force_encoding(Encoding::UTF_8)
expect_bounded_queue_error("validation_error", "event must be JSON serializable") do
  invalid_json_client.log(
    "evt_invalid_json",
    "2026-07-12T10:00:00Z",
    message: "valid message",
    level: "info",
    metadata: { invalid: invalid_utf8 }
  )
end
tests += 1

drop_notices = []
context_client = bounded_queue_client(
  max_queue_size: 2,
  max_queue_bytes: 1_048_576,
  on_event_dropped: ->(notice) { drop_notices << notice }
)
context_client.release("evt_release_context", "2026-07-12T10:00:00Z", version: "2.0.0")
context_client.environment("evt_environment_context", "2026-07-12T10:00:01Z", name: "production")
dropped_event_id = String.new("evt_log_dropped")
context_client.log(dropped_event_id, "2026-07-12T10:00:02Z", message: "queue pressure", level: "warning")
dropped_event_id.replace("evt_mutated_by_app")

assert_bounded_queue(context_client.pending_events == 2, "count pressure must preserve the existing queue")
assert_bounded_queue(context_client.pending_event_bytes.positive?, "queued event bytes must be observable")
assert_bounded_queue(context_client.pending_event_bytes <= 1_048_576, "queued event bytes must stay bounded")
assert_bounded_queue(context_client.dropped_events == 1, "count pressure must increment the drop total")
assert_bounded_queue(drop_notices.length == 1, "count pressure must publish one local drop notice")

notice = drop_notices.fetch(0)
assert_bounded_queue(notice.event_id == "evt_log_dropped", "drop notice must identify the rejected event")
assert_bounded_queue(notice.event_id.frozen?, "drop notice identifiers must be immutable")
assert_bounded_queue(notice.event_type == "log", "drop notice must identify the rejected event type")
assert_bounded_queue(notice.reason == "queue_overflow", "count pressure must use a stable reason")
assert_bounded_queue(notice.dropped_events == 1, "drop notice must include cumulative loss")
assert_bounded_queue(notice.pending_events == 2, "drop notice must include retained event count")
assert_bounded_queue(
  notice.pending_event_bytes == context_client.pending_event_bytes,
  "drop notice must include retained event bytes"
)
assert_bounded_queue(notice.frozen?, "drop notices must be immutable")
assert_bounded_queue(
  notice.instance_variables.sort == %i[
    @dropped_events
    @event_id
    @event_type
    @pending_event_bytes
    @pending_events
    @reason
  ],
  "drop notice must not expose event attributes or payload content"
)
context_events = JSON.parse(context_client.preview_json).fetch("events")
assert_bounded_queue(context_events.map { |event| event.fetch("type") } == %w[release environment], "drop-new must retain leading context")
assert_bounded_queue(!context_client.preview_json.include?("queue pressure"), "rejected content must stay out of the queue")
tests += 1

oversized_notices = []
oversized_client = bounded_queue_client(
  max_queue_size: 10,
  max_queue_bytes: 256,
  on_event_dropped: ->(event) { oversized_notices << event }
)
oversized_client.log(
  "evt_log_oversized",
  "2026-07-12T10:00:03Z",
  message: "private-content-" * 100,
  level: "error"
)
assert_bounded_queue(oversized_client.pending_events.zero?, "an oversized event must not enter the queue")
assert_bounded_queue(oversized_client.pending_event_bytes.zero?, "an oversized event must not consume queue bytes")
assert_bounded_queue(oversized_client.dropped_events == 1, "an oversized event must increment loss")
assert_bounded_queue(oversized_notices.fetch(0).reason == "event_too_large", "oversized events need a stable reason")
assert_bounded_queue(
  !oversized_notices.fetch(0).instance_variables.join.include?("private-content"),
  "drop notices must exclude rejected content"
)
tests += 1

byte_probe = bounded_queue_client
byte_probe.log("evt_byte_a", "2026-07-12T10:00:04Z", message: "same size", level: "info")
single_event_bytes = byte_probe.pending_event_bytes
aggregate_reason = nil
aggregate_client = bounded_queue_client(
  max_queue_size: 10,
  max_queue_bytes: single_event_bytes + 1,
  on_event_dropped: ->(event) { aggregate_reason = event.reason }
)
aggregate_client.log("evt_byte_a", "2026-07-12T10:00:04Z", message: "same size", level: "info")
aggregate_client.log("evt_byte_b", "2026-07-12T10:00:04Z", message: "same size", level: "info")
assert_bounded_queue(aggregate_client.pending_events == 1, "aggregate byte pressure must retain the first event")
assert_bounded_queue(aggregate_client.pending_event_bytes == single_event_bytes, "aggregate byte accounting must stay exact")
assert_bounded_queue(aggregate_client.dropped_events == 1, "aggregate byte pressure must increment loss")
assert_bounded_queue(aggregate_reason == "queue_overflow", "aggregate byte pressure must use queue_overflow")
tests += 1

full_queue_reason = nil
full_queue_client = bounded_queue_client(
  max_queue_size: 1,
  on_event_dropped: ->(event) { full_queue_reason = event.reason }
)
full_queue_client.log("evt_log_full", "2026-07-12T10:00:05Z", message: "retained", level: "info")
full_queue_client.log(
  "evt_log_no_encode",
  "2026-07-12T10:00:06Z",
  message: "not serialized",
  level: "info",
  metadata: { invalid: invalid_utf8 }
)
assert_bounded_queue(full_queue_client.pending_events == 1, "a full queue must retain its existing event")
assert_bounded_queue(full_queue_client.dropped_events == 1, "a full queue must drop before serialization")
assert_bounded_queue(full_queue_reason == "queue_overflow", "count pressure must take precedence")
tests += 1

callback_failure_client = bounded_queue_client(
  max_queue_size: 1,
  on_event_dropped: ->(_event) { raise "app callback failed" }
)
callback_failure_client.log("evt_callback_retained", "2026-07-12T10:00:07Z", message: "retained", level: "info")
callback_failure_client.log("evt_callback_dropped", "2026-07-12T10:00:08Z", message: "dropped", level: "info")
assert_bounded_queue(callback_failure_client.pending_events == 1, "callback failures must not change queue state")
assert_bounded_queue(callback_failure_client.dropped_events == 1, "callback failures must not hide loss")
tests += 1

reentrant_calls = 0
reentrant_client = nil
reentrant_callback = lambda do |_event|
  reentrant_calls += 1
  raise "drop callback re-entered" if reentrant_calls > 1

  reentrant_client.log("evt_callback_reentrant", "2026-07-12T10:00:09Z", message: "callback", level: "info")
end
reentrant_client = bounded_queue_client(max_queue_size: 1, on_event_dropped: reentrant_callback)
reentrant_client.log("evt_reentrant_retained", "2026-07-12T10:00:10Z", message: "retained", level: "info")
reentrant_client.log("evt_reentrant_dropped", "2026-07-12T10:00:11Z", message: "dropped", level: "info")
assert_bounded_queue(reentrant_calls == 1, "drop callbacks must not recursively invoke themselves")
assert_bounded_queue(reentrant_client.dropped_events == 2, "reentrant capture attempts must remain visible")
tests += 1

failed_flush_client = bounded_queue_client(max_queue_size: 2)
failed_flush_client.log("evt_failed_flush", "2026-07-12T10:00:12Z", message: "preserve me", level: "error")
failed_flush_bytes = failed_flush_client.pending_event_bytes
expect_bounded_queue_error("transport_error", "unexpected transport status 400") do
  failed_flush_client.flush(LogBrew::RecordingTransport.new([400]))
end
assert_bounded_queue(failed_flush_client.pending_events == 1, "failed flush must preserve events")
assert_bounded_queue(failed_flush_client.pending_event_bytes == failed_flush_bytes, "failed flush must preserve bytes")
tests += 1

retry_client = bounded_queue_client(max_queue_size: 2)
retry_client.release("evt_retry_release", "2026-07-12T10:00:13Z", version: "2.0.0")
retry_client.log("evt_retry_log", "2026-07-12T10:00:14Z", message: "retry me", level: "warning")
retry_transport = LogBrew::RecordingTransport.new([503, 202])
retry_response = retry_client.shutdown(retry_transport)
assert_bounded_queue(retry_response.status_code == 202, "shutdown retry must accept the batch")
assert_bounded_queue(retry_response.attempts == 2, "shutdown retry must report both attempts")
assert_bounded_queue(retry_transport.sent_bodies.length == 2, "shutdown retry must send twice")
assert_bounded_queue(retry_transport.sent_bodies[0] == retry_transport.sent_bodies[1], "retry bodies must be byte-identical")
assert_bounded_queue(retry_client.pending_events.zero?, "shutdown must clear accepted events")
assert_bounded_queue(retry_client.pending_event_bytes.zero?, "shutdown must clear accepted bytes")
expect_bounded_queue_error("shutdown_error", "client is already shut down") do
  retry_client.log("evt_after_shutdown", "2026-07-12T10:00:15Z", message: "closed", level: "info")
end
tests += 1

concurrent_flush_client = bounded_queue_client(max_queue_size: 10)
concurrent_flush_client.log("evt_before_flush", "2026-07-12T10:00:16Z", message: "before", level: "info")
blocking_flush_transport = BlockingQueueTransport.new
flush_thread = Thread.new do
  concurrent_flush_client.flush(blocking_flush_transport)
rescue StandardError => error
  error
end
blocking_flush_transport.wait_until_entered
concurrent_flush_client.log("evt_during_flush", "2026-07-12T10:00:17Z", message: "during", level: "info")
blocking_flush_transport.release
flush_result = flush_thread.value
raise flush_result if flush_result.is_a?(StandardError)

remaining_events = JSON.parse(concurrent_flush_client.preview_json).fetch("events")
assert_bounded_queue(remaining_events.length == 1, "successful flush must retain concurrently captured events")
assert_bounded_queue(remaining_events.fetch(0).fetch("id") == "evt_during_flush", "flush must acknowledge only its snapshot")
second_flush_transport = LogBrew::RecordingTransport.always_accept
concurrent_flush_client.flush(second_flush_transport)
assert_bounded_queue(second_flush_transport.last_body.include?("evt_during_flush"), "next flush must send the retained event")
tests += 1

shutdown_client = bounded_queue_client(max_queue_size: 10)
shutdown_client.log("evt_before_shutdown", "2026-07-12T10:00:18Z", message: "before", level: "info")
blocking_shutdown_transport = BlockingQueueTransport.new
shutdown_thread = Thread.new do
  shutdown_client.shutdown(blocking_shutdown_transport)
rescue StandardError => error
  error
end
blocking_shutdown_transport.wait_until_entered
expect_bounded_queue_error("shutdown_error", "client is shutting down") do
  shutdown_client.log("evt_during_shutdown", "2026-07-12T10:00:19Z", message: "reject", level: "info")
end
blocking_shutdown_transport.release
shutdown_result = shutdown_thread.value
raise shutdown_result if shutdown_result.is_a?(StandardError)
assert_bounded_queue(shutdown_client.pending_events.zero?, "successful shutdown must leave no stranded events")
tests += 1

failed_shutdown_client = bounded_queue_client(max_queue_size: 10)
failed_shutdown_client.log("evt_failed_shutdown", "2026-07-12T10:00:20Z", message: "retain", level: "info")
blocking_failed_shutdown = BlockingQueueTransport.new(status_code: 400)
failed_shutdown_thread = Thread.new do
  failed_shutdown_client.shutdown(blocking_failed_shutdown)
rescue StandardError => error
  error
end
blocking_failed_shutdown.wait_until_entered
expect_bounded_queue_error("shutdown_error", "client is shutting down") do
  failed_shutdown_client.log("evt_rejected_while_closing", "2026-07-12T10:00:21Z", message: "reject", level: "info")
end
blocking_failed_shutdown.release
failed_shutdown_result = failed_shutdown_thread.value
assert_bounded_queue(failed_shutdown_result.is_a?(LogBrew::SdkError), "failed shutdown must return its transport error")
assert_bounded_queue(failed_shutdown_result.code == "transport_error", "failed shutdown must preserve transport classification")
failed_shutdown_client.log("evt_after_failed_shutdown", "2026-07-12T10:00:22Z", message: "accepted", level: "info")
assert_bounded_queue(failed_shutdown_client.pending_events == 2, "failed shutdown must reopen capture and preserve its queue")
tests += 1

drop_callback_count = 0
drop_callback_mutex = Mutex.new
high_load_client = bounded_queue_client(
  on_event_dropped: lambda do |_event|
    drop_callback_mutex.synchronize { drop_callback_count += 1 }
  end
)
workers = 10.times.map do |worker|
  Thread.new do
    1_000.times do |index|
      high_load_client.log(
        format("evt_load_%02d_%04d", worker, index),
        "2026-07-12T10:00:23Z",
        message: "bounded load",
        level: "info"
      )
    end
  end
end
workers.each(&:join)
assert_bounded_queue(high_load_client.pending_events == 1_000, "concurrent default queue must retain exactly 1,000 events")
assert_bounded_queue(high_load_client.dropped_events == 9_000, "concurrent default queue must report exactly 9,000 drops")
assert_bounded_queue(drop_callback_count == 9_000, "concurrent callback count must match local loss")
assert_bounded_queue(high_load_client.pending_event_bytes.positive?, "concurrent queue must expose retained bytes")
assert_bounded_queue(high_load_client.pending_event_bytes <= 4_194_304, "concurrent queue must honor its byte bound")
tests += 1

puts "ruby bounded queue tests ok (#{tests} tests)"
