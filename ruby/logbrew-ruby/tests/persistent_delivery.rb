# frozen_string_literal: true

require "json"
require "tmpdir"
require_relative "../lib/logbrew"

def assert_persistent_delivery(condition, message)
  raise message unless condition
end

def expect_persistent_delivery_error(code, message_fragment)
  yield
  raise "expected #{code}"
rescue LogBrew::SdkError => error
  assert_persistent_delivery(error.code == code, "expected #{code}, got #{error.code}")
  assert_persistent_delivery(error.message.include?(message_fragment), "expected error containing #{message_fragment}")
  assert_persistent_delivery(!error.message.include?(Dir.tmpdir), "persistent errors must not expose local paths")
  error
end

def persistent_store_class
  LogBrew.const_get(:PersistentEventStore, false)
end

def with_persistent_root
  Dir.mktmpdir("logbrew-persistent-test") do |root|
    File.chmod(0o700, root)
    yield root
  end
end

def serialized_persistent_event(id, message: "persisted event")
  JSON.generate(
    "type" => "log",
    "timestamp" => "2026-07-13T18:00:00Z",
    "id" => id,
    "attributes" => { "message" => message, "level" => "info" }
  ).freeze
end

def persistent_client(path, **options)
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby",
    sdk_version: "0.1.0",
    persistent_queue_path: path,
    **options
  )
end

class BlockingPersistentTransport
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

expect_persistent_delivery_error("validation_error", "normalized absolute path") do
  persistent_store_class.open(path: "relative/queue")
end

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  store = persistent_store_class.open(path: queue_path)
  assert_persistent_delivery(File.directory?(queue_path), "persistent store must create its final directory")
  assert_persistent_delivery(File.stat(queue_path).mode & 0o777 == 0o700, "persistent directory must be owner-only")
  assert_persistent_delivery(File.stat(File.join(queue_path, ".lock")).mode & 0o777 == 0o600, "lock file must be owner-only")

  expect_persistent_delivery_error("persistent_queue_error", "already in use") do
    persistent_store_class.open(path: queue_path)
  end

  store.close
  reopened = persistent_store_class.open(path: queue_path)
  reopened.close
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  Dir.mkdir(queue_path, 0o700)
  File.write(File.join(queue_path, "unrelated.txt"), "not queue state")
  expect_persistent_delivery_error("persistent_queue_error", "unexpected entries") do
    persistent_store_class.open(path: queue_path)
  end

  symlink_path = File.join(root, "linked-queue")
  File.symlink(queue_path, symlink_path)
  expect_persistent_delivery_error("persistent_queue_error", "dedicated directory") do
    persistent_store_class.open(path: symlink_path)
  end
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  Dir.mkdir(queue_path, 0o700)
  stale_path = File.join(queue_path, ".tmp-#{"a" * 32}")
  File.open(stale_path, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |file| file.write("partial") }

  store = persistent_store_class.open(path: queue_path)
  assert_persistent_delivery(!File.exist?(stale_path), "owned stale temp records must be removed")
  store.close
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  store = persistent_store_class.open(path: queue_path)
  first = store.append(serialized_persistent_event("evt_persistent_1"))
  second = store.append(serialized_persistent_event("evt_persistent_2"))
  assert_persistent_delivery(first.sequence == 1, "first persistent sequence must start at one")
  assert_persistent_delivery(second.sequence == 2, "persistent sequences must be monotonic")
  assert_persistent_delivery(store.records.map(&:json) == [first.json, second.json], "store order must match admission order")
  store.close

  recovered = persistent_store_class.open(path: queue_path)
  assert_persistent_delivery(recovered.records.map(&:sequence) == [1, 2], "restart must recover sequence order")
  compaction_error = recovered.acknowledge([recovered.records.fetch(0)])
  assert_persistent_delivery(compaction_error.nil?, "normal accepted-prefix compaction must succeed")
  assert_persistent_delivery(recovered.records.map(&:sequence) == [2], "acknowledge must retain only the suffix")
  recovered.close

  after_ack = persistent_store_class.open(path: queue_path)
  assert_persistent_delivery(after_ack.records.map(&:sequence) == [2], "accepted prefix must not replay")
  assert_persistent_delivery(File.read(File.join(queue_path, ".ack")).strip == "1", "accepted marker must record the prefix")
  purge_error = after_ack.acknowledge(after_ack.records)
  assert_persistent_delivery(purge_error.nil?, "accepted-prefix discard must compact normally")
  assert_persistent_delivery(after_ack.records.empty?, "accepted-prefix discard must empty active records")
  after_ack.close

  empty = persistent_store_class.open(path: queue_path)
  assert_persistent_delivery(empty.records.empty?, "purged records must not recover")
  empty.close
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  store = persistent_store_class.open(path: queue_path)
  store.append(serialized_persistent_event("evt_private", message: "event-content-is-intentional"))
  record_path = Dir.glob(File.join(queue_path, "*.event")).fetch(0)
  record = File.binread(record_path)
  assert_persistent_delivery(File.stat(record_path).mode & 0o777 == 0o600, "event records must be owner-only")
  assert_persistent_delivery(record.include?("event-content-is-intentional"), "store must preserve exact event content")
  assert_persistent_delivery(!record.include?("LOGBREW_API_KEY"), "store must not add the API key")
  assert_persistent_delivery(!record.include?(queue_path), "store must not add local paths")
  store.close

  File.binwrite(record_path, "not-json")
  expect_persistent_delivery_error("persistent_queue_error", "unreadable records") do
    persistent_store_class.open(path: queue_path)
  end
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  child_pid = Process.fork do
    client = persistent_client(queue_path)
    client.release("evt_restart_release", "2026-07-13T18:00:00Z", version: "2.0.0")
    client.log("evt_restart_log", "2026-07-13T18:00:01Z", message: "restart me", level: "info")
    exit! 0
  end
  assert_persistent_delivery(Process.wait2(child_pid).fetch(1).success?, "seed process must exit successfully")

  recovered = persistent_client(queue_path)
  assert_persistent_delivery(recovered.pending_events == 2, "client must recover abrupt-exit events")
  assert_persistent_delivery(
    JSON.parse(recovered.preview_json).fetch("events").map { |event| event.fetch("id") } ==
      %w[evt_restart_release evt_restart_log],
    "client recovery must preserve event order"
  )
  response = recovered.shutdown(LogBrew::RecordingTransport.always_accept)
  assert_persistent_delivery(response.status_code == 202, "recovered client must drain normally")
  assert_persistent_delivery(recovered.pending_events.zero?, "successful shutdown must drain recovered records")

  reopened = persistent_client(queue_path)
  assert_persistent_delivery(reopened.pending_events.zero?, "successful shutdown must release an empty store")
  reopened.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  drops = []
  client = persistent_client(
    queue_path,
    max_queue_size: 2,
    on_event_dropped: ->(drop) { drops << drop }
  )
  client.release("evt_bound_release", "2026-07-13T18:00:00Z", version: "2.0.0")
  client.environment("evt_bound_environment", "2026-07-13T18:00:01Z", name: "production")
  client.log("evt_bound_drop", "2026-07-13T18:00:02Z", message: "drop newest", level: "warning")
  assert_persistent_delivery(client.pending_events == 2, "persistent count bound must retain the prefix")
  assert_persistent_delivery(client.dropped_events == 1, "persistent count pressure must be observable")
  assert_persistent_delivery(drops.fetch(0).reason == "queue_overflow", "persistent count pressure must use queue_overflow")
  assert_persistent_delivery(client.purge_pending_events == 2, "public purge must report discarded persistent events")
  assert_persistent_delivery(client.pending_events.zero?, "public purge must empty the persistent queue")
  client.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  drops = []
  client = persistent_client(queue_path, on_event_dropped: ->(drop) { drops << drop })
  File.chmod(0o500, queue_path)
  begin
    client.log("evt_disk_failure", "2026-07-13T18:00:00Z", message: "do not break app work", level: "error")
  ensure
    File.chmod(0o700, queue_path)
  end
  assert_persistent_delivery(client.pending_events.zero?, "failed persistence must not create an in-memory-only event")
  assert_persistent_delivery(client.dropped_events == 1, "failed persistence must increment local loss")
  assert_persistent_delivery(drops.fetch(0).reason == "persistence_failure", "failed persistence needs a stable reason")
  assert_persistent_delivery(!drops.fetch(0).instance_variables.join.include?("do not break"), "persistence notice must exclude content")
  client.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  store = persistent_store_class.open(path: queue_path)
  reader, writer = IO.pipe
  child_pid = Process.fork do
    reader.close
    code = begin
      store.records
      "accepted"
    rescue LogBrew::SdkError => error
      error.code
    end
    writer.write(code)
    writer.close
    exit! 0
  end
  writer.close
  inherited_result = reader.read
  reader.close
  assert_persistent_delivery(Process.wait2(child_pid).fetch(1).success?, "ownership probe child must exit")
  assert_persistent_delivery(inherited_result == "process_ownership_error", "inherited store must fail before disk access")
  expect_persistent_delivery_error("persistent_queue_error", "already in use") do
    persistent_store_class.open(path: queue_path)
  end
  store.append(serialized_persistent_event("evt_parent_after_fork"))
  assert_persistent_delivery(store.records.length == 1, "child exit must not release the parent store")
  store.close
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  client = persistent_client(queue_path)
  client.log("evt_parent_only", "2026-07-13T18:00:00Z", message: "parent", level: "info")
  reader, writer = IO.pipe
  child_pid = Process.fork do
    reader.close
    transport = Object.new
    transport.define_singleton_method(:send) do |_api_key, _body|
      writer.puts("sent")
      LogBrew::TransportResponse.new(202, 1)
    end
    begin
      client.flush(transport)
      writer.puts("accepted")
    rescue LogBrew::SdkError => error
      writer.puts(error.code)
    end
    writer.close
    exit! 0
  end
  writer.close
  inherited_flush = reader.read.lines.map(&:strip)
  reader.close
  assert_persistent_delivery(Process.wait2(child_pid).fetch(1).success?, "inherited flush child must exit")
  assert_persistent_delivery(
    inherited_flush == ["process_ownership_error"],
    "inherited clients must reject flush before transport access"
  )
  client.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  displaced_path = File.join(root, "displaced")
  store = persistent_store_class.open(path: queue_path)
  File.rename(queue_path, displaced_path)
  Dir.mkdir(queue_path, 0o700)

  expect_persistent_delivery_error("persistent_queue_error", "directory changed") do
    store.append(serialized_persistent_event("evt_replaced_directory"))
  end
  assert_persistent_delivery(
    Dir.glob(File.join(queue_path, "*.event")).empty?,
    "a replaced queue directory must not receive events from the original owner"
  )
  store.close
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  drops = []
  client = persistent_client(queue_path, on_event_dropped: ->(drop) { drops << drop })
  queue = client.instance_variable_get(:@event_queue)
  store = queue.instance_variable_get(:@event_store)
  original_sync_directory = store.method(:sync_directory)
  store.define_singleton_method(:sync_directory) { raise IOError, "injected directory sync failure" }

  expect_persistent_delivery_error("persistence_commit_error", "durability is unconfirmed") do
    client.log("evt_sync_uncertain", "2026-07-13T18:00:00Z", message: "retain", level: "info")
  end
  assert_persistent_delivery(client.pending_events == 1, "rename-complete admission must remain pending")
  assert_persistent_delivery(drops.empty?, "rename-complete admission must not be reported as dropped")

  expect_persistent_delivery_error("persistence_commit_error", "durability is unconfirmed") do
    client.log("evt_while_sync_unhealthy", "2026-07-13T18:00:01Z", message: "reject", level: "info")
  end
  assert_persistent_delivery(client.pending_events == 1, "later captures must not displace unconfirmed admission")
  assert_persistent_delivery(drops.empty?, "later sync uncertainty must not be reported as a drop")

  expect_persistent_delivery_error("persistence_commit_error", "durability is unconfirmed") do
    client.purge_pending_events
  end
  assert_persistent_delivery(client.pending_events == 1, "unconfirmed admission must not be purged")

  sends = 0
  transport = Object.new
  transport.define_singleton_method(:send) do |_api_key, _body|
    sends += 1
    LogBrew::TransportResponse.new(202, 1)
  end
  expect_persistent_delivery_error("persistence_commit_error", "durability is unconfirmed") do
    client.flush(transport)
  end
  assert_persistent_delivery(sends.zero?, "unconfirmed admission must not reach transport")

  store.define_singleton_method(:sync_directory) { original_sync_directory.call }
  accepted_transport = LogBrew::RecordingTransport.always_accept
  client.shutdown(accepted_transport)
  delivered_ids = JSON.parse(accepted_transport.last_body).fetch("events").map { |event| event.fetch("id") }
  assert_persistent_delivery(delivered_ids == ["evt_sync_uncertain"], "reconfirmed admission must deliver once")
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  client = persistent_client(queue_path)
  client.log("evt_ack_sync_uncertain", "2026-07-13T18:00:00Z", message: "retry", level: "info")
  queue = client.instance_variable_get(:@event_queue)
  store = queue.instance_variable_get(:@event_store)
  original_sync_directory = store.method(:sync_directory)
  store.define_singleton_method(:sync_directory) { raise IOError, "injected accepted marker sync failure" }
  first_transport = LogBrew::RecordingTransport.always_accept

  expect_persistent_delivery_error("persistent_queue_error", "acknowledgement durability") do
    client.flush(first_transport)
  end
  assert_persistent_delivery(client.pending_events == 1, "unconfirmed accepted marker must retain its queue prefix")

  store.define_singleton_method(:sync_directory) { original_sync_directory.call }
  retry_transport = LogBrew::RecordingTransport.always_accept
  client.flush(retry_transport)
  assert_persistent_delivery(
    first_transport.last_body == retry_transport.last_body,
    "unconfirmed accepted marker must retry the exact frozen body"
  )
  assert_persistent_delivery(client.pending_events.zero?, "durably reconfirmed retry must drain the prefix")
  client.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  seed = persistent_store_class.open(path: queue_path)
  seed.append(serialized_persistent_event("evt_too_many_1"))
  seed.append(serialized_persistent_event("evt_too_many_2"))
  seed.close

  expect_persistent_delivery_error("persistent_queue_error", "configured bounds") do
    persistent_client(queue_path, max_queue_size: 1)
  end
  lock_probe = persistent_store_class.open(path: queue_path)
  assert_persistent_delivery(lock_probe.records.length == 2, "failed client construction must release the store lock")
  lock_probe.acknowledge(lock_probe.records)
  lock_probe.close
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  child_pid = Process.fork do
    client = persistent_client(queue_path, max_retries: 0, max_batch_size: 1)
    3.times do |index|
      client.log(
        "evt_failed_shutdown_#{index}",
        "2026-07-13T18:00:00Z",
        message: "recover accepted suffix",
        level: "info"
      )
    end
    begin
      client.shutdown(LogBrew::RecordingTransport.new([202, 400]))
      exit! 1
    rescue LogBrew::SdkError => error
      exit! error.code == "transport_error" ? 0 : 1
    end
  end
  assert_persistent_delivery(Process.wait2(child_pid).fetch(1).success?, "failed-shutdown seed must exercise transport failure")

  recovered = persistent_client(queue_path, max_retries: 0, max_batch_size: 1)
  recovered_ids = JSON.parse(recovered.preview_json).fetch("events").map { |event| event.fetch("id") }
  assert_persistent_delivery(
    recovered_ids == %w[evt_failed_shutdown_1 evt_failed_shutdown_2],
    "restart must exclude the accepted prefix and retain the failed suffix"
  )
  recovered.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  client = persistent_client(queue_path)
  client.log("evt_before_active_flush", "2026-07-13T18:00:00Z", message: "before", level: "info")
  transport = BlockingPersistentTransport.new
  flush_thread = Thread.new do
    client.flush(transport)
  rescue StandardError => error
    error
  end
  transport.wait_until_entered
  client.log("evt_during_active_flush", "2026-07-13T18:00:01Z", message: "during", level: "info")
  transport.release
  result = flush_thread.value
  raise result if result.is_a?(StandardError)

  remaining_ids = JSON.parse(client.preview_json).fetch("events").map { |event| event.fetch("id") }
  assert_persistent_delivery(remaining_ids == ["evt_during_active_flush"], "active flush must retain later persistent work")
  client.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  client = persistent_client(queue_path)
  client.log("evt_compaction_accepted", "2026-07-13T18:00:00Z", message: "accepted", level: "info")
  queue = client.instance_variable_get(:@event_queue)
  store = queue.instance_variable_get(:@event_store)
  store.define_singleton_method(:compact_records) do |_records|
    LogBrew::SdkError.new("persistent_queue_error", "persistent queue accepted-prefix compaction is incomplete")
  end

  expect_persistent_delivery_error("persistent_queue_error", "compaction is incomplete") do
    client.flush(LogBrew::RecordingTransport.always_accept)
  end
  assert_persistent_delivery(client.pending_events.zero?, "durably acknowledged events must leave the active queue")

  store.define_singleton_method(:compact_records) { |_records| nil }
  client.log("evt_after_compaction_error", "2026-07-13T18:00:01Z", message: "later", level: "info")
  later_transport = LogBrew::RecordingTransport.always_accept
  client.flush(later_transport)
  later_ids = JSON.parse(later_transport.last_body).fetch("events").map { |event| event.fetch("id") }
  assert_persistent_delivery(later_ids == ["evt_after_compaction_error"], "compaction errors must clear the accepted retry body")
  client.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

puts "ruby persistent delivery tests ok (#{tests} tests)"
