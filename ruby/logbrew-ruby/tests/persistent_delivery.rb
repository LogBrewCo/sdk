# frozen_string_literal: true

require "json"
require "tmpdir"
require_relative "../lib/logbrew"
require_relative "blocking_transport"
require_relative "test_helpers"
include SdkTestHelpers

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

tests = 0

expect_sdk_error("validation_error", "normalized absolute path", forbidden: Dir.tmpdir) do
  persistent_store_class.open(path: "relative/queue")
end

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  store = persistent_store_class.open(path: queue_path)
  assert(File.directory?(queue_path), "persistent store must create its final directory")
  assert(File.stat(queue_path).mode & 0o777 == 0o700, "persistent directory must be owner-only")
  assert(File.stat(File.join(queue_path, ".lock")).mode & 0o777 == 0o600, "lock file must be owner-only")

  expect_sdk_error("persistent_queue_error", "already in use", forbidden: Dir.tmpdir) do
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
  expect_sdk_error("persistent_queue_error", "unexpected entries", forbidden: Dir.tmpdir) do
    persistent_store_class.open(path: queue_path)
  end

  symlink_path = File.join(root, "linked-queue")
  File.symlink(queue_path, symlink_path)
  expect_sdk_error("persistent_queue_error", "dedicated directory", forbidden: Dir.tmpdir) do
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
  assert(!File.exist?(stale_path), "owned stale temp records must be removed")
  store.close
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  store = persistent_store_class.open(path: queue_path)
  first = store.append(serialized_persistent_event("evt_persistent_1"))
  second = store.append(serialized_persistent_event("evt_persistent_2"))
  assert(first.sequence == 1, "first persistent sequence must start at one")
  assert(second.sequence == 2, "persistent sequences must be monotonic")
  assert(store.records.map(&:json) == [first.json, second.json], "store order must match admission order")
  store.close

  recovered = persistent_store_class.open(path: queue_path)
  assert(recovered.records.map(&:sequence) == [1, 2], "restart must recover sequence order")
  compaction_error = recovered.acknowledge([recovered.records.fetch(0)])
  assert(compaction_error.nil?, "normal accepted-prefix compaction must succeed")
  assert(recovered.records.map(&:sequence) == [2], "acknowledge must retain only the suffix")
  recovered.close

  after_ack = persistent_store_class.open(path: queue_path)
  assert(after_ack.records.map(&:sequence) == [2], "accepted prefix must not replay")
  assert(File.read(File.join(queue_path, ".ack")).strip == "1", "accepted marker must record the prefix")
  purge_error = after_ack.acknowledge(after_ack.records)
  assert(purge_error.nil?, "accepted-prefix discard must compact normally")
  assert(after_ack.records.empty?, "accepted-prefix discard must empty active records")
  after_ack.close

  empty = persistent_store_class.open(path: queue_path)
  assert(empty.records.empty?, "purged records must not recover")
  empty.close
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  store = persistent_store_class.open(path: queue_path)
  store.append(serialized_persistent_event("evt_private", message: "event-content-is-intentional"))
  record_path = Dir.glob(File.join(queue_path, "*.event")).fetch(0)
  record = File.binread(record_path)
  assert(File.stat(record_path).mode & 0o777 == 0o600, "event records must be owner-only")
  assert(record.include?("event-content-is-intentional"), "store must preserve exact event content")
  assert(!record.include?("LOGBREW_API_KEY"), "store must not add the API key")
  assert(!record.include?(queue_path), "store must not add local paths")
  store.close

  File.binwrite(record_path, "not-json")
  expect_sdk_error("persistent_queue_error", "unreadable records", forbidden: Dir.tmpdir) do
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
  assert(Process.wait2(child_pid).fetch(1).success?, "seed process must exit successfully")

  recovered = persistent_client(queue_path)
  assert(recovered.pending_events == 2, "client must recover abrupt-exit events")
  assert(
    JSON.parse(recovered.preview_json).fetch("events").map { |event| event.fetch("id") } ==
      %w[evt_restart_release evt_restart_log],
    "client recovery must preserve event order"
  )
  response = recovered.shutdown(LogBrew::RecordingTransport.always_accept)
  assert(response.status_code == 202, "recovered client must drain normally")
  assert(recovered.pending_events.zero?, "successful shutdown must drain recovered records")

  reopened = persistent_client(queue_path)
  assert(reopened.pending_events.zero?, "successful shutdown must release an empty store")
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
  assert(client.pending_events == 2, "persistent count bound must retain the prefix")
  assert(client.dropped_events == 1, "persistent count pressure must be observable")
  assert(drops.fetch(0).reason == "queue_overflow", "persistent count pressure must use queue_overflow")
  assert(client.purge_pending_events == 2, "public purge must report discarded persistent events")
  assert(client.pending_events.zero?, "public purge must empty the persistent queue")
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
  assert(client.pending_events.zero?, "failed persistence must not create an in-memory-only event")
  assert(client.dropped_events == 1, "failed persistence must increment local loss")
  assert(drops.fetch(0).reason == "persistence_failure", "failed persistence needs a stable reason")
  assert(!drops.fetch(0).instance_variables.join.include?("do not break"), "persistence notice must exclude content")
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
  assert(Process.wait2(child_pid).fetch(1).success?, "ownership probe child must exit")
  assert(inherited_result == "process_ownership_error", "inherited store must fail before disk access")
  expect_sdk_error("persistent_queue_error", "already in use", forbidden: Dir.tmpdir) do
    persistent_store_class.open(path: queue_path)
  end
  store.append(serialized_persistent_event("evt_parent_after_fork"))
  assert(store.records.length == 1, "child exit must not release the parent store")
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
  assert(Process.wait2(child_pid).fetch(1).success?, "inherited flush child must exit")
  assert(
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

  expect_sdk_error("persistent_queue_error", "directory changed", forbidden: Dir.tmpdir) do
    store.append(serialized_persistent_event("evt_replaced_directory"))
  end
  assert(
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

  expect_sdk_error("persistence_commit_error", "durability is unconfirmed", forbidden: Dir.tmpdir) do
    client.log("evt_sync_uncertain", "2026-07-13T18:00:00Z", message: "retain", level: "info")
  end
  assert(client.pending_events == 1, "rename-complete admission must remain pending")
  assert(drops.empty?, "rename-complete admission must not be reported as dropped")

  expect_sdk_error("persistence_commit_error", "durability is unconfirmed", forbidden: Dir.tmpdir) do
    client.log("evt_while_sync_unhealthy", "2026-07-13T18:00:01Z", message: "reject", level: "info")
  end
  assert(client.pending_events == 1, "later captures must not displace unconfirmed admission")
  assert(drops.empty?, "later sync uncertainty must not be reported as a drop")

  expect_sdk_error("persistence_commit_error", "durability is unconfirmed", forbidden: Dir.tmpdir) do
    client.purge_pending_events
  end
  assert(client.pending_events == 1, "unconfirmed admission must not be purged")

  sends = 0
  transport = Object.new
  transport.define_singleton_method(:send) do |_api_key, _body|
    sends += 1
    LogBrew::TransportResponse.new(202, 1)
  end
  expect_sdk_error("persistence_commit_error", "durability is unconfirmed", forbidden: Dir.tmpdir) do
    client.flush(transport)
  end
  assert(sends.zero?, "unconfirmed admission must not reach transport")

  store.define_singleton_method(:sync_directory) { original_sync_directory.call }
  accepted_transport = LogBrew::RecordingTransport.always_accept
  client.shutdown(accepted_transport)
  delivered_ids = JSON.parse(accepted_transport.last_body).fetch("events").map { |event| event.fetch("id") }
  assert(delivered_ids == ["evt_sync_uncertain"], "reconfirmed admission must deliver once")
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

  expect_sdk_error("persistent_queue_error", "acknowledgement durability", forbidden: Dir.tmpdir) do
    client.flush(first_transport)
  end
  assert(client.pending_events == 1, "unconfirmed accepted marker must retain its queue prefix")

  store.define_singleton_method(:sync_directory) { original_sync_directory.call }
  retry_transport = LogBrew::RecordingTransport.always_accept
  client.flush(retry_transport)
  assert(
    first_transport.last_body == retry_transport.last_body,
    "unconfirmed accepted marker must retry the exact frozen body"
  )
  assert(client.pending_events.zero?, "durably reconfirmed retry must drain the prefix")
  client.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

with_persistent_root do |root|
  queue_path = File.join(root, "queue")
  seed = persistent_store_class.open(path: queue_path)
  seed.append(serialized_persistent_event("evt_too_many_1"))
  seed.append(serialized_persistent_event("evt_too_many_2"))
  seed.close

  expect_sdk_error("persistent_queue_error", "configured bounds", forbidden: Dir.tmpdir) do
    persistent_client(queue_path, max_queue_size: 1)
  end
  lock_probe = persistent_store_class.open(path: queue_path)
  assert(lock_probe.records.length == 2, "failed client construction must release the store lock")
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
  assert(Process.wait2(child_pid).fetch(1).success?, "failed-shutdown seed must exercise transport failure")

  recovered = persistent_client(queue_path, max_retries: 0, max_batch_size: 1)
  recovered_ids = JSON.parse(recovered.preview_json).fetch("events").map { |event| event.fetch("id") }
  assert(
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
  transport = BlockingTransport.new
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
  assert(remaining_ids == ["evt_during_active_flush"], "active flush must retain later persistent work")
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

  expect_sdk_error("persistent_queue_error", "compaction is incomplete", forbidden: Dir.tmpdir) do
    client.flush(LogBrew::RecordingTransport.always_accept)
  end
  assert(client.pending_events.zero?, "durably acknowledged events must leave the active queue")

  store.define_singleton_method(:compact_records) { |_records| nil }
  client.log("evt_after_compaction_error", "2026-07-13T18:00:01Z", message: "later", level: "info")
  later_transport = LogBrew::RecordingTransport.always_accept
  client.flush(later_transport)
  later_ids = JSON.parse(later_transport.last_body).fetch("events").map { |event| event.fetch("id") }
  assert(later_ids == ["evt_after_compaction_error"], "compaction errors must clear the accepted retry body")
  client.shutdown(LogBrew::RecordingTransport.always_accept)
end
tests += 1

puts "ruby persistent delivery tests ok (#{tests} tests)"
