# frozen_string_literal: true

require "json"
require_relative "../lib/logbrew"

def assert_bounded_batching(condition, message)
  raise message unless condition
end

def expect_bounded_batching_error(code, message_fragment)
  yield
  raise "expected #{code}"
rescue LogBrew::SdkError => error
  assert_bounded_batching(error.code == code, "expected #{code}, got #{error.code}")
  assert_bounded_batching(error.message.include?(message_fragment), "expected error containing #{message_fragment}")
  error
end

def bounded_batching_client(**options)
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby",
    sdk_version: "0.1.0",
    **options
  )
end

def bounded_batching_ids(body)
  JSON.parse(body).fetch("events").map { |event| event.fetch("id") }
end

def add_bounded_batching_logs(client, prefix, count, message: "bounded batch")
  count.times do |index|
    client.log(
      format("%s_%02d", prefix, index),
      "2026-07-13T10:00:00Z",
      message: message,
      level: "info"
    )
  end
end

class ReentrantBatchingTransport
  attr_reader :flush_error, :sent_bodies

  def initialize(client)
    @client = client
    @sent_bodies = []
  end

  def send(_api_key, body)
    @sent_bodies << body
    @client.log(
      "evt_during_flush",
      "2026-07-13T10:00:01Z",
      message: "captured during transport",
      level: "info"
    )
    begin
      @client.flush(LogBrew::RecordingTransport.always_accept)
    rescue LogBrew::SdkError => error
      @flush_error = error
    end
    LogBrew::TransportResponse.new(202, 1)
  end
end

class BlockingBatchingTransport
  attr_reader :sent_bodies

  def initialize
    @entered = Queue.new
    @release = Queue.new
    @sent_bodies = []
  end

  def send(_api_key, body)
    @sent_bodies << body
    @entered << true
    @release.pop
    LogBrew::TransportResponse.new(202, 1)
  end

  def wait_until_entered
    @entered.pop
  end

  def release
    @release << true
  end
end

tests = 0

expect_bounded_batching_error("validation_error", "max_batch_size must be a positive integer") do
  bounded_batching_client(max_batch_size: 0)
end
expect_bounded_batching_error("validation_error", "max_batch_bytes must be a positive integer") do
  bounded_batching_client(max_batch_bytes: 0)
end
expect_bounded_batching_error("validation_error", "max_batch_bytes must fit the SDK envelope") do
  bounded_batching_client(max_batch_bytes: 8)
end
invalid_sdk = "\xB1\x31".dup.force_encoding(Encoding::UTF_8)
expect_bounded_batching_error("validation_error", "sdk_name must be non-empty") do
  LogBrew::Client.create(api_key: "LOGBREW_API_KEY", sdk_name: invalid_sdk, sdk_version: "0.1.0")
end
tests += 1

direct_response = LogBrew::RecordingTransport.always_accept.send("LOGBREW_API_KEY", "{}")
assert_bounded_batching(direct_response.batches == 1, "a direct transport response must represent one batch")
empty_response = bounded_batching_client.flush(LogBrew::RecordingTransport.always_accept)
assert_bounded_batching(empty_response.batches.zero?, "an empty flush must report zero accepted batches")
tests += 1

count_client = bounded_batching_client(max_retries: 1, max_batch_size: 2, max_batch_bytes: 1_048_576)
add_bounded_batching_logs(count_client, "evt_count", 5)
count_transport = LogBrew::RecordingTransport.new([503, 202, 202, 202])
count_response = count_client.flush(count_transport)
assert_bounded_batching(count_response.status_code == 202, "count split must return the final accepted status")
assert_bounded_batching(count_response.attempts == 4, "count split must aggregate transport attempts")
assert_bounded_batching(count_response.batches == 3, "count split must report accepted batches")
assert_bounded_batching(count_transport.sent_bodies.length == 4, "count split must retry once and send three batches")
assert_bounded_batching(count_transport.sent_bodies[0] == count_transport.sent_bodies[1], "retry body must be identical")
assert_bounded_batching(!count_transport.sent_bodies[0].include?("\n"), "transport batches must use compact JSON")
assert_bounded_batching(
  count_transport.sent_bodies.map { |body| bounded_batching_ids(body) } == [
    %w[evt_count_00 evt_count_01],
    %w[evt_count_00 evt_count_01],
    %w[evt_count_02 evt_count_03],
    %w[evt_count_04]
  ],
  "count splitting must preserve ordered immutable prefixes"
)
assert_bounded_batching(count_client.pending_events.zero?, "count splitting must acknowledge every accepted event")
tests += 1

byte_probe = bounded_batching_client
byte_probe.log(
  "evt_utf8_a",
  "2026-07-13T10:00:02Z",
  message: "espresso-\u2615",
  level: "info"
)
single_event_body_bytes = JSON.generate(JSON.parse(byte_probe.preview_json)).bytesize
byte_client = bounded_batching_client(max_batch_size: 10, max_batch_bytes: single_event_body_bytes)
2.times do |index|
  byte_client.log(
    index.zero? ? "evt_utf8_a" : "evt_utf8_b",
    "2026-07-13T10:00:02Z",
    message: "espresso-\u2615",
    level: "info"
  )
end
byte_transport = LogBrew::RecordingTransport.always_accept
byte_response = byte_client.flush(byte_transport)
assert_bounded_batching(byte_response.batches == 2, "exact byte limit must split two events")
assert_bounded_batching(
  byte_transport.sent_bodies.map(&:bytesize) == [single_event_body_bytes, single_event_body_bytes],
  "each UTF-8 batch must match the exact byte limit"
)
tests += 1

oversized_notice = nil
oversized_client = bounded_batching_client(
  max_queue_bytes: 1_048_576,
  max_batch_bytes: 256,
  on_event_dropped: ->(notice) { oversized_notice = notice }
)
oversized_client.log(
  "evt_batch_oversized",
  "2026-07-13T10:00:03Z",
  message: "private-batch-content-" * 100,
  level: "error"
)
assert_bounded_batching(oversized_client.pending_events.zero?, "batch-oversized event must not enter the queue")
assert_bounded_batching(oversized_notice.reason == "event_too_large", "batch-oversized event must use stable loss reason")
tests += 1

mutable_message = String.new("captured value")
immutable_client = bounded_batching_client(max_queue_bytes: 1_048_576, max_batch_bytes: 256)
immutable_client.log(
  "evt_immutable",
  "2026-07-13T10:00:03Z",
  message: mutable_message,
  level: "info"
)
admission_bytes = immutable_client.pending_event_bytes
mutable_message.replace("mutated-after-capture-" * 100)
immutable_transport = LogBrew::RecordingTransport.always_accept
immutable_client.flush(immutable_transport)
immutable_event = JSON.parse(immutable_transport.last_body).fetch("events").fetch(0)
assert_bounded_batching(
  immutable_event.fetch("attributes").fetch("message") == "captured value",
  "caller mutation must not change queued event content"
)
assert_bounded_batching(admission_bytes.positive?, "admission byte accounting must be observable")
assert_bounded_batching(immutable_client.pending_event_bytes.zero?, "accepted immutable event must clear exact byte accounting")
tests += 1

mutable_sdk_name = String.new("logbrew-ruby")
mutable_sdk_version = String.new("0.1.0")
identity_client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: mutable_sdk_name,
  sdk_version: mutable_sdk_version
)
mutable_sdk_name.replace("mutated-name")
mutable_sdk_version.replace("mutated-version")
identity_client.log("evt_identity", "2026-07-13T10:00:03Z", message: "identity", level: "info")
identity_preview = JSON.parse(identity_client.preview_json).fetch("sdk")
identity_transport = LogBrew::RecordingTransport.always_accept
identity_client.flush(identity_transport)
identity_wire = JSON.parse(identity_transport.last_body).fetch("sdk")
expected_identity = { "name" => "logbrew-ruby", "language" => "ruby", "version" => "0.1.0" }
assert_bounded_batching(identity_preview == expected_identity, "preview SDK identity must be copied at client creation")
assert_bounded_batching(identity_wire == expected_identity, "wire SDK identity must match the immutable preview identity")
tests += 1

partial_client = bounded_batching_client(max_retries: 0, max_batch_size: 2)
add_bounded_batching_logs(partial_client, "evt_partial", 5)
expect_bounded_batching_error("transport_error", "unexpected transport status 500") do
  partial_client.flush(LogBrew::RecordingTransport.new([202, 500]))
end
assert_bounded_batching(partial_client.pending_events == 3, "partial success must remove only the accepted prefix")
assert_bounded_batching(
  bounded_batching_ids(partial_client.preview_json) == %w[evt_partial_02 evt_partial_03 evt_partial_04],
  "partial failure must retain failed and later events in order"
)
partial_retry = LogBrew::RecordingTransport.always_accept
partial_response = partial_client.flush(partial_retry)
assert_bounded_batching(partial_response.batches == 2, "partial retry must drain two retained batches")
assert_bounded_batching(
  partial_retry.sent_bodies.map { |body| bounded_batching_ids(body) } == [
    %w[evt_partial_02 evt_partial_03],
    %w[evt_partial_04]
  ],
  "partial retry must resume at the first unacknowledged event"
)
tests += 1

frozen_client = bounded_batching_client(max_retries: 0, max_batch_size: 100)
frozen_client.log("evt_frozen_original", "2026-07-13T10:00:04Z", message: "original", level: "warning")
failed_transport = LogBrew::RecordingTransport.new([500])
expect_bounded_batching_error("transport_error", "unexpected transport status 500") do
  frozen_client.flush(failed_transport)
end
frozen_client.log("evt_frozen_later", "2026-07-13T10:00:05Z", message: "later", level: "info")
frozen_retry = LogBrew::RecordingTransport.always_accept
frozen_response = frozen_client.flush(frozen_retry)
assert_bounded_batching(frozen_response.batches == 2, "retry plus later capture must use two accepted batches")
assert_bounded_batching(failed_transport.sent_bodies[0] == frozen_retry.sent_bodies[0], "later capture must not change failed body")
assert_bounded_batching(
  frozen_retry.sent_bodies.map { |body| bounded_batching_ids(body) } == [
    %w[evt_frozen_original],
    %w[evt_frozen_later]
  ],
  "failed body must retry before later capture"
)
tests += 1

reentrant_client = bounded_batching_client
reentrant_client.log("evt_before_flush", "2026-07-13T10:00:06Z", message: "before", level: "info")
reentrant_transport = ReentrantBatchingTransport.new(reentrant_client)
reentrant_response = reentrant_client.flush(reentrant_transport)
assert_bounded_batching(reentrant_response.batches == 1, "outer flush must accept its start snapshot")
assert_bounded_batching(reentrant_transport.flush_error.code == "flush_error", "reentrant flush must use stable error code")
assert_bounded_batching(reentrant_client.pending_events == 1, "transport-time capture must remain queued")
assert_bounded_batching(
  bounded_batching_ids(reentrant_client.preview_json) == %w[evt_during_flush],
  "only transport-time capture must remain"
)
reentrant_client.flush(LogBrew::RecordingTransport.always_accept)
tests += 1

serialized_client = bounded_batching_client
serialized_client.log("evt_flush_a", "2026-07-13T10:00:06Z", message: "first", level: "info")
first_transport = BlockingBatchingTransport.new
first_flush = Thread.new { serialized_client.flush(first_transport) }
first_transport.wait_until_entered
serialized_client.log("evt_flush_b", "2026-07-13T10:00:06Z", message: "second", level: "info")
second_transport = BlockingBatchingTransport.new
second_ready = Queue.new
second_start = Queue.new
second_attempting = Queue.new
second_flush = Thread.new do
  second_ready << true
  second_start.pop
  second_attempting << true
  serialized_client.flush(second_transport)
end
second_ready.pop
second_start << true
second_attempting.pop
deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 1
until second_flush.status == "sleep" || Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
  sleep 0.001
end
assert_bounded_batching(second_flush.status == "sleep", "second flush must reach a serialized wait")
assert_bounded_batching(second_transport.sent_bodies.empty?, "second flush must wait for the active flush")
first_transport.release
first_flush.value
second_transport.wait_until_entered
second_transport.release
second_flush.value
assert_bounded_batching(
  first_transport.sent_bodies.map { |body| bounded_batching_ids(body) } == [%w[evt_flush_a]],
  "first serialized flush must deliver only its start snapshot"
)
assert_bounded_batching(
  second_transport.sent_bodies.map { |body| bounded_batching_ids(body) } == [%w[evt_flush_b]],
  "waiting flush must deliver transport-time capture exactly once"
)
assert_bounded_batching(serialized_client.pending_events.zero?, "serialized flushes must drain both snapshots")
tests += 1

shutdown_client = bounded_batching_client(max_retries: 0)
shutdown_client.log("evt_shutdown_original", "2026-07-13T10:00:07Z", message: "original", level: "info")
shutdown_failed = LogBrew::RecordingTransport.new([500])
expect_bounded_batching_error("transport_error", "unexpected transport status 500") do
  shutdown_client.shutdown(shutdown_failed)
end
shutdown_client.log("evt_shutdown_later", "2026-07-13T10:00:08Z", message: "later", level: "info")
shutdown_retry = LogBrew::RecordingTransport.always_accept
shutdown_response = shutdown_client.shutdown(shutdown_retry)
assert_bounded_batching(shutdown_response.batches == 2, "recovered shutdown must preserve the failed boundary")
assert_bounded_batching(shutdown_failed.sent_bodies[0] == shutdown_retry.sent_bodies[0], "shutdown retry body must stay frozen")
assert_bounded_batching(
  shutdown_retry.sent_bodies.map { |body| bounded_batching_ids(body) } == [
    %w[evt_shutdown_original],
    %w[evt_shutdown_later]
  ],
  "shutdown recovery must retry original body before later capture"
)
expect_bounded_batching_error("shutdown_error", "client is already shut down") do
  shutdown_client.log("evt_after_shutdown", "2026-07-13T10:00:09Z", message: "closed", level: "info")
end
tests += 1

puts "ruby bounded batching tests ok (#{tests} tests)"
