#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/ruby/logbrew-ruby"
attempted_events=1500
worker_count=10
tmp_dir="$(mktemp -d)"
gem_home="$tmp_dir/gems"
store_path="$tmp_dir/persistent-queue"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT
mkdir -p "$gem_home"
chmod 700 "$tmp_dir" "$gem_home"

package_version="$(
  cd "$package_dir"
  ruby -e 'spec = Gem::Specification.load("logbrew-sdk.gemspec") or abort "invalid gemspec"; print spec.version'
)"
gem_path="$tmp_dir/logbrew-sdk-${package_version}.gem"
(
  cd "$package_dir"
  gem build logbrew-sdk.gemspec --strict --output "$gem_path" >/dev/null
)
test -f "$gem_path"
gem_sha256="$(ruby -rdigest -e 'print Digest::SHA256.file(ARGV.fetch(0)).hexdigest' "$gem_path")"
[[ "$gem_sha256" =~ ^[0-9a-f]{64}$ ]]

install_gem() {
  GEM_HOME="$gem_home" GEM_PATH="$gem_home" \
    gem install --local --install-dir "$gem_home" --no-document "$gem_path" >/dev/null
}

installed_ruby() {
  GEM_HOME="$gem_home" GEM_PATH="$gem_home" ruby "$@"
}

install_gem
installed_ruby -e '
require "logbrew"
create_parameters = LogBrew::Client.method(:create).parameters
abort "installed persistent path option is unavailable" unless create_parameters.include?([:key, :persistent_queue_path])
abort "installed purge API is unavailable" unless LogBrew::Client.instance_methods.include?(:purge_pending_events)
'
GEM_HOME="$gem_home" GEM_PATH="$gem_home" \
  gem uninstall logbrew-sdk --all --executables --ignore-dependencies --silent >/dev/null
if installed_ruby -e 'require "logbrew"' 2>/dev/null; then
  printf '%s\n' "removed gem remained importable" >&2
  exit 1
fi
install_gem

cat > "$tmp_dir/seed.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"
require "thread"

store_path = ENV.fetch("LOGBREW_PERSISTENT_STORE_PATH")
result_path = ENV.fetch("LOGBREW_PERSISTENT_RESULT_PATH")
attempted = Integer(ENV.fetch("LOGBREW_PERSISTENT_ATTEMPTED"))
worker_count = Integer(ENV.fetch("LOGBREW_PERSISTENT_WORKERS"))
api_key = "LOGBREW_API_KEY"
dropped = 0
last_drop = nil
drop_mutex = Mutex.new

client = LogBrew::Client.create(
  api_key: api_key,
  sdk_name: "logbrew-ruby-persistent-proof",
  sdk_version: Gem.loaded_specs.fetch("logbrew-sdk").version.to_s,
  persistent_queue_path: store_path,
  on_event_dropped: lambda do |notice|
    drop_mutex.synchronize do
      dropped += 1
      last_drop = notice
    end
  end
)

partitions = Array.new(worker_count) { [] }
attempted.times { |index| partitions.fetch(index % worker_count) << index }
ready = Queue.new
start = Queue.new
completed = Queue.new
threads = partitions.each_with_index.map do |partition, worker_id|
  Thread.new do
    ready << worker_id
    start.pop
    partition.each do |index|
      client.log(
        format("evt_persistent_%05d", index),
        "2026-07-13T20:00:00Z",
        message: "persistent worker event",
        level: "info",
        metadata: { worker: worker_id, index: index }
      )
    end
    completed << worker_id
    worker_id
  end
end

expected_worker_ids = (0...worker_count).to_a
ready_ids = worker_count.times.map { ready.pop }.sort
raise "not every worker reached the start barrier" unless ready_ids == expected_worker_ids
worker_count.times { start << true }
returned_ids = threads.map(&:value).sort
completed_ids = worker_count.times.map { completed.pop }.sort
unless returned_ids == expected_worker_ids && completed_ids == expected_worker_ids
  raise "not every worker completed capture"
end

preview = JSON.parse(client.preview_json)
retained_ids = preview.fetch("events").map { |event| event.fetch("id") }
raise "unexpected retained count" unless retained_ids.length == 1000 && client.pending_events == 1000
raise "unexpected dropped count" unless dropped == attempted - 1000 && client.dropped_events == dropped
unless last_drop.reason == "queue_overflow" && last_drop.pending_events == 1000
  raise "unexpected final pressure notice"
end

directory_mode = File.stat(store_path).mode & 0o777
raise "persistent directory permissions changed" unless directory_mode == 0o700
entries = Dir.children(store_path)
event_files = entries.grep(/\A\d{20}\.event\z/).sort
raise "persistent file count changed" unless event_files.length == 1000
raise "temporary records remained" unless entries.grep(/\A\.tmp-/).empty?
raise "unexpected persistent entries" unless (entries - event_files - [".lock"]).empty?

stored_ids = event_files.map do |name|
  path = File.join(store_path, name)
  raise "persistent event permissions changed" unless (File.stat(path).mode & 0o777) == 0o600

  body = File.binread(path)
  forbidden = [api_key, store_path, "authorization", "api.logbrew", "traceparent"]
  raise "SDK-generated private delivery data was persisted" if forbidden.any? { |value| body.include?(value) }
  JSON.parse(body).fetch("id")
end
raise "stored event set differs from queued events" unless stored_ids == retained_ids

result = {
  "attempted" => attempted,
  "retained" => retained_ids.length,
  "dropped" => dropped,
  "pendingBytes" => client.pending_event_bytes,
  "readyIds" => ready_ids,
  "completionIds" => completed_ids,
  "retainedIds" => retained_ids
}
File.open(result_path, "w", 0o600) do |file|
  file.write(JSON.generate(result))
  file.flush
  file.fsync
end
exit! 0
RUBY

LOGBREW_PERSISTENT_STORE_PATH="$store_path" \
LOGBREW_PERSISTENT_RESULT_PATH="$tmp_dir/seed-result.json" \
LOGBREW_PERSISTENT_ATTEMPTED="$attempted_events" \
LOGBREW_PERSISTENT_WORKERS="$worker_count" \
installed_ruby "$tmp_dir/seed.rb"
test -s "$tmp_dir/seed-result.json"

cat > "$tmp_dir/intake_server.rb" <<'RUBY'
# frozen_string_literal: true

require "socket"

directory = ARGV.fetch(0)
statuses = ARGV.fetch(1).split(",").map { |value| Integer(value) }
block_first = ARGV.fetch(2) == "true"
server = TCPServer.new("127.0.0.1", 0)
File.write(File.join(directory, "endpoint.txt"), "http://127.0.0.1:#{server.addr[1]}/v1/events")

statuses.each_with_index do |status, index|
  socket = server.accept
  begin
    head = +""
    while (line = socket.gets)
      head << line
      break if line == "\r\n"
    end
    content_length = head[/^content-length:\s*(\d+)/i, 1].to_i
    body = socket.read(content_length).to_s
    File.binwrite(File.join(directory, format("request-%02d.head", index)), head)
    File.binwrite(File.join(directory, format("request-%02d.body", index)), body)
    File.write(File.join(directory, format("request-%02d.status", index)), status.to_s)

    if block_first && index.zero?
      File.write(File.join(directory, "first-entered"), "ready")
      400.times do
        break if File.exist?(File.join(directory, "release-first"))

        sleep 0.01
      end
      raise "first request was not released" unless File.exist?(File.join(directory, "release-first"))
    end

    reason = case status
             when 202 then "Accepted"
             when 400 then "Bad Request"
             else "Service Unavailable"
             end
    socket.write("HTTP/1.1 #{status} #{reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
  ensure
    socket.close
  end
end
server.close
RUBY

wait_for_endpoint() {
  local directory="$1"
  for _ in {1..200}; do
    if [[ -s "$directory/endpoint.txt" ]]; then
      return
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      printf '%s\n' "local intake failed to start" >&2
      exit 1
    fi
    sleep 0.05
  done
  printf '%s\n' "local intake endpoint was not ready" >&2
  exit 1
}

phase_one_intake="$tmp_dir/phase-one-intake"
mkdir -m 700 "$phase_one_intake"
installed_ruby "$tmp_dir/intake_server.rb" "$phase_one_intake" "202,400" "false" \
  >"$phase_one_intake/server.stdout" 2>"$phase_one_intake/server.stderr" &
server_pid="$!"
wait_for_endpoint "$phase_one_intake"

cat > "$tmp_dir/failed_shutdown.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"

store_path = ENV.fetch("LOGBREW_PERSISTENT_STORE_PATH")
result_path = ENV.fetch("LOGBREW_PERSISTENT_RESULT_PATH")
endpoint = ENV.fetch("LOGBREW_PERSISTENT_ENDPOINT")
client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby-persistent-proof",
  sdk_version: Gem.loaded_specs.fetch("logbrew-sdk").version.to_s,
  persistent_queue_path: store_path,
  max_retries: 0,
  max_batch_size: 100
)
raise "restart did not recover the bounded prefix" unless client.pending_events == 1000

begin
  client.shutdown(LogBrew::HttpTransport.new(endpoint: endpoint, timeout: 5))
  exit! 1
rescue LogBrew::SdkError => error
  raise unless error.code == "transport_error"
  raise "accepted prefix was not acknowledged" unless client.pending_events == 900

  File.open(result_path, "w", 0o600) do |file|
    file.write(JSON.generate("errorCode" => error.code, "recovered" => 1000, "pending" => client.pending_events))
    file.flush
    file.fsync
  end
  exit! 0
end
RUBY

LOGBREW_PERSISTENT_STORE_PATH="$store_path" \
LOGBREW_PERSISTENT_RESULT_PATH="$tmp_dir/failed-result.json" \
LOGBREW_PERSISTENT_ENDPOINT="$(<"$phase_one_intake/endpoint.txt")" \
installed_ruby "$tmp_dir/failed_shutdown.rb"
wait "$server_pid"
server_pid=""
test -s "$tmp_dir/failed-result.json"

phase_two_intake="$tmp_dir/phase-two-intake"
mkdir -m 700 "$phase_two_intake"
phase_two_statuses="503,202,202,202,202,202,202,202,202,202,202"
installed_ruby "$tmp_dir/intake_server.rb" "$phase_two_intake" "$phase_two_statuses" "true" \
  >"$phase_two_intake/server.stdout" 2>"$phase_two_intake/server.stderr" &
server_pid="$!"
wait_for_endpoint "$phase_two_intake"

cat > "$tmp_dir/recover_and_drain.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"

store_path = ENV.fetch("LOGBREW_PERSISTENT_STORE_PATH")
result_path = ENV.fetch("LOGBREW_PERSISTENT_RESULT_PATH")
endpoint = ENV.fetch("LOGBREW_PERSISTENT_ENDPOINT")
intake_path = ENV.fetch("LOGBREW_PERSISTENT_INTAKE_PATH")
client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby-persistent-proof",
  sdk_version: Gem.loaded_specs.fetch("logbrew-sdk").version.to_s,
  persistent_queue_path: store_path,
  max_retries: 1,
  max_batch_size: 100
)
raise "failed suffix did not recover" unless client.pending_events == 900
transport = LogBrew::HttpTransport.new(endpoint: endpoint, timeout: 5)

flush_thread = Thread.new do
  client.flush(transport)
rescue StandardError => error
  error
end
400.times do
  break if File.exist?(File.join(intake_path, "first-entered"))

  sleep 0.01
end
raise "active flush did not reach intake" unless File.exist?(File.join(intake_path, "first-entered"))
client.log(
  "evt_persistent_late",
  "2026-07-13T20:00:01Z",
  message: "captured during active recovery",
  level: "info"
)
File.write(File.join(intake_path, "release-first"), "go")
flush_response = flush_thread.value
raise flush_response if flush_response.is_a?(StandardError)
unless flush_response.status_code == 202 && flush_response.attempts == 10 && flush_response.batches == 9
  raise "unexpected restart flush response"
end
raise "active flush did not retain later work" unless client.pending_events == 1

shutdown_response = client.shutdown(transport)
unless shutdown_response.status_code == 202 && shutdown_response.attempts == 1 && shutdown_response.batches == 1
  raise "unexpected final shutdown response"
end
raise "final shutdown retained events" unless client.pending_events.zero?

File.open(result_path, "w", 0o600) do |file|
  file.write(JSON.generate(
    "recovered" => 900,
    "flushAttempts" => flush_response.attempts,
    "flushBatches" => flush_response.batches,
    "lateRetained" => 1,
    "shutdownAttempts" => shutdown_response.attempts
  ))
  file.flush
  file.fsync
end
RUBY

LOGBREW_PERSISTENT_STORE_PATH="$store_path" \
LOGBREW_PERSISTENT_RESULT_PATH="$tmp_dir/drain-result.json" \
LOGBREW_PERSISTENT_ENDPOINT="$(<"$phase_two_intake/endpoint.txt")" \
LOGBREW_PERSISTENT_INTAKE_PATH="$phase_two_intake" \
installed_ruby "$tmp_dir/recover_and_drain.rb"
wait "$server_pid"
server_pid=""
test -s "$tmp_dir/drain-result.json"

lifecycle_intake="$tmp_dir/lifecycle-intake"
mkdir -m 700 "$lifecycle_intake"
installed_ruby "$tmp_dir/intake_server.rb" "$lifecycle_intake" "202,202" "false" \
  >"$lifecycle_intake/server.stdout" 2>"$lifecycle_intake/server.stderr" &
server_pid="$!"
wait_for_endpoint "$lifecycle_intake"

cat > "$tmp_dir/lifecycle_persistence.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"

root = ENV.fetch("LOGBREW_LIFECYCLE_ROOT")
endpoint = ENV.fetch("LOGBREW_LIFECYCLE_ENDPOINT")
parent_result_path = ENV.fetch("LOGBREW_LIFECYCLE_PARENT_RESULT")
child_result_path = ENV.fetch("LOGBREW_LIFECYCLE_CHILD_RESULT")
version = Gem.loaded_specs.fetch("logbrew-sdk").version.to_s

write_result = lambda do |path, value|
  File.open(path, "w", 0o600) do |file|
    file.write(JSON.generate(value))
    file.flush
    file.fsync
  end
end

assert_store_layout = lambda do |path|
  raise "worker persistent directory permissions changed" unless (File.stat(path).mode & 0o777) == 0o700

  entries = Dir.children(path).sort
  raise "worker persistent queue retained event or temp files" unless entries == [".ack", ".lock"]
  entries.each do |name|
    raise "worker persistent metadata permissions changed" unless (File.stat(File.join(path, name)).mode & 0o777) == 0o600
  end
end

parent_store = File.join(root, "parent-store")
parent_client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby-worker-persistence-proof",
  sdk_version: version,
  persistent_queue_path: parent_store,
  max_retries: 0,
  max_batch_size: 100
)
parent_client.log(
  "evt_lifecycle_parent_before",
  "2026-07-13T20:01:00Z",
  message: "parent event before fork",
  level: "info"
)
parent_lifecycle = LogBrew::WorkerLifecycle.create(
  client: parent_client,
  transport: LogBrew::HttpTransport.new(endpoint: endpoint, timeout: 5)
)

child_pid = Process.fork do
  callback_ran = false
  inherited_error = nil
  begin
    parent_lifecycle.run { callback_ran = true }
  rescue LogBrew::SdkError => error
    inherited_error = error.code
  end

  child_store = File.join(root, "child-store")
  child_client = LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby-worker-persistence-proof",
    sdk_version: version,
    persistent_queue_path: child_store,
    max_retries: 0,
    max_batch_size: 100
  )
  child_lifecycle = LogBrew::WorkerLifecycle.create(
    client: child_client,
    transport: LogBrew::HttpTransport.new(endpoint: endpoint, timeout: 5)
  )
  application_result = child_lifecycle.run do
    child_client.log(
      "evt_lifecycle_child",
      "2026-07-13T20:01:01Z",
      message: "child-owned event",
      level: "info"
    )
    "child-result"
  end
  shutdown_response = child_lifecycle.shutdown
  cached_shutdown = child_lifecycle.shutdown
  assert_store_layout.call(child_store)
  write_result.call(
    child_result_path,
    "inheritedError" => inherited_error,
    "inheritedCallbackRan" => callback_ran,
    "applicationResult" => application_result,
    "shutdownStatus" => shutdown_response.status_code,
    "shutdownAttempts" => shutdown_response.attempts,
    "shutdownBatches" => shutdown_response.batches,
    "cachedShutdown" => cached_shutdown.equal?(shutdown_response),
    "pending" => child_client.pending_events,
    "ownerOnly" => true
  )
  exit! 0
end

_, child_status = Process.wait2(child_pid)
raise "worker child failed" unless child_status.success?

application_result = parent_lifecycle.run do
  parent_client.log(
    "evt_lifecycle_parent_after",
    "2026-07-13T20:01:02Z",
    message: "parent event after fork",
    level: "info"
  )
  "parent-result"
end
shutdown_response = parent_lifecycle.shutdown
cached_shutdown = parent_lifecycle.shutdown
assert_store_layout.call(parent_store)
write_result.call(
  parent_result_path,
  "applicationResult" => application_result,
  "shutdownStatus" => shutdown_response.status_code,
  "shutdownAttempts" => shutdown_response.attempts,
  "shutdownBatches" => shutdown_response.batches,
  "cachedShutdown" => cached_shutdown.equal?(shutdown_response),
  "pending" => parent_client.pending_events,
  "ownerOnly" => true
)
RUBY

installed_ruby -e 'Dir.mkdir(ARGV.fetch(0), 0o700)' "$tmp_dir/lifecycle-stores"
LOGBREW_LIFECYCLE_ROOT="$tmp_dir/lifecycle-stores" \
LOGBREW_LIFECYCLE_ENDPOINT="$(<"$lifecycle_intake/endpoint.txt")" \
LOGBREW_LIFECYCLE_PARENT_RESULT="$tmp_dir/lifecycle-parent-result.json" \
LOGBREW_LIFECYCLE_CHILD_RESULT="$tmp_dir/lifecycle-child-result.json" \
installed_ruby "$tmp_dir/lifecycle_persistence.rb"
wait "$server_pid"
server_pid=""
test -s "$tmp_dir/lifecycle-parent-result.json"
test -s "$tmp_dir/lifecycle-child-result.json"

cat > "$tmp_dir/persistence_safety.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"

root = ENV.fetch("LOGBREW_SAFETY_ROOT")
result_path = ENV.fetch("LOGBREW_SAFETY_RESULT")
version = Gem.loaded_specs.fetch("logbrew-sdk").version.to_s

new_client = lambda do |path, on_event_dropped = nil|
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby-persistence-safety-proof",
    sdk_version: version,
    persistent_queue_path: path,
    max_retries: 0,
    on_event_dropped: on_event_dropped
  )
end
log_event = lambda do |client, id|
  client.log(id, "2026-07-13T20:02:00Z", message: "persistent safety event", level: "info")
end
write_result = lambda do |path, value|
  File.open(path, "w", 0o600) do |file|
    file.write(JSON.generate(value))
    file.flush
    file.fsync
  end
end

corrupt_store = File.join(root, "corrupt-store")
seed_pid = Process.fork do
  client = new_client.call(corrupt_store)
  log_event.call(client, "evt_corrupt")
  exit! 0
end
_, seed_status = Process.wait2(seed_pid)
raise "corruption seed failed" unless seed_status.success?
corrupt_record = Dir.glob(File.join(corrupt_store, "*.event")).fetch(0)
File.binwrite(corrupt_record, "{}")
File.chmod(0o600, corrupt_record)
corruption_code = nil
begin
  new_client.call(corrupt_store)
rescue LogBrew::SdkError => error
  corruption_code = error.code
end

purge_store = File.join(root, "purge-store")
purge_client = new_client.call(purge_store)
log_event.call(purge_client, "evt_purge_1")
log_event.call(purge_client, "evt_purge_2")
purged = purge_client.purge_pending_events
purge_shutdown = purge_client.shutdown(LogBrew::RecordingTransport.always_accept)
reopened_purge = new_client.call(purge_store)
recovered_after_purge = reopened_purge.pending_events
reopened_shutdown = reopened_purge.shutdown(LogBrew::RecordingTransport.always_accept)

identity_result_path = File.join(root, "identity-result.json")
identity_pid = Process.fork do
  identity_store = File.join(root, "identity-store")
  moved_store = File.join(root, "identity-store-moved")
  identity_drops = []
  client = new_client.call(identity_store, ->(notice) { identity_drops << notice })
  log_event.call(client, "evt_identity_1")
  File.rename(identity_store, moved_store)
  Dir.mkdir(identity_store, 0o700)
  log_event.call(client, "evt_identity_2")
  identity_notice = identity_drops.fetch(0)
  write_result.call(
    identity_result_path,
    "reason" => identity_notice.reason,
    "dropped" => identity_notice.dropped_events,
    "pending" => client.pending_events,
    "replacementEntries" => Dir.children(identity_store)
  )
  exit! 0
end
_, identity_status = Process.wait2(identity_pid)
raise "identity probe failed" unless identity_status.success?
identity = JSON.parse(File.read(identity_result_path))

lock_store = File.join(root, "lock-store")
lock_owner = new_client.call(lock_store)
reader, writer = IO.pipe
lock_pid = Process.fork do
  reader.close
  lock_code = nil
  begin
    contender = new_client.call(lock_store)
    contender.shutdown(LogBrew::RecordingTransport.always_accept)
    lock_code = "opened"
  rescue LogBrew::SdkError => error
    lock_code = error.code
  end
  writer.write(lock_code)
  writer.close
  exit! 0
end
writer.close
lock_code = reader.read
reader.close
_, lock_status = Process.wait2(lock_pid)
raise "lock probe failed" unless lock_status.success?
lock_shutdown = lock_owner.shutdown(LogBrew::RecordingTransport.always_accept)

raise "corruption did not fail closed" unless corruption_code == "persistent_queue_error"
unless purged == 2 && recovered_after_purge.zero? && purge_shutdown.status_code == 204 && reopened_shutdown.status_code == 204
  raise "purge recovery changed"
end
unless identity == { "reason" => "persistence_failure", "dropped" => 1, "pending" => 1, "replacementEntries" => [] }
  raise "directory replacement did not fail closed"
end
raise "concurrent persistent owner was accepted" unless lock_code == "persistent_queue_error"
raise "lock owner did not close cleanly" unless lock_shutdown.status_code == 204
raise "safety root permissions changed" unless (File.stat(root).mode & 0o777) == 0o700

write_result.call(
  result_path,
  "corruptionCode" => corruption_code,
  "purged" => purged,
  "recoveredAfterPurge" => recovered_after_purge,
  "identityReason" => identity.fetch("reason"),
  "replacementEntries" => identity.fetch("replacementEntries"),
  "lockCode" => lock_code
)
RUBY

mkdir -m 700 "$tmp_dir/safety-stores"
LOGBREW_SAFETY_ROOT="$tmp_dir/safety-stores" \
LOGBREW_SAFETY_RESULT="$tmp_dir/safety-result.json" \
installed_ruby "$tmp_dir/persistence_safety.rb"
test -s "$tmp_dir/safety-result.json"

cat > "$tmp_dir/verify.rb" <<'RUBY'
# frozen_string_literal: true

require "json"

seed_path, failed_path, drain_path, phase_one, phase_two, store_path,
  lifecycle_parent_path, lifecycle_child_path, lifecycle_intake, safety_path,
  package_version, package_sha256 = ARGV
seed = JSON.parse(File.read(seed_path))
failed = JSON.parse(File.read(failed_path))
drain = JSON.parse(File.read(drain_path))
lifecycle_parent = JSON.parse(File.read(lifecycle_parent_path))
lifecycle_child = JSON.parse(File.read(lifecycle_child_path))
safety = JSON.parse(File.read(safety_path))

raise "seed counts changed" unless seed.values_at("attempted", "retained", "dropped") == [1500, 1000, 500]
raise "seed byte bound changed" unless seed.fetch("pendingBytes").positive? && seed.fetch("pendingBytes") <= 4_194_304
expected_workers = (0...10).to_a
unless seed.fetch("readyIds") == expected_workers && seed.fetch("completionIds") == expected_workers
  raise "synchronized worker completion changed"
end
raise "failed shutdown result changed" unless failed == { "errorCode" => "transport_error", "recovered" => 1000, "pending" => 900 }
unless drain == { "recovered" => 900, "flushAttempts" => 10, "flushBatches" => 9, "lateRetained" => 1, "shutdownAttempts" => 1 }
  raise "restart drain result changed"
end

phase_one_bodies = Dir.glob(File.join(phase_one, "request-*.body")).sort.map { |path| File.binread(path) }
phase_two_bodies = Dir.glob(File.join(phase_two, "request-*.body")).sort.map { |path| File.binread(path) }
raise "phase one request count changed" unless phase_one_bodies.length == 2
raise "phase two request count changed" unless phase_two_bodies.length == 11
raise "failed body changed across restart" unless phase_one_bodies.fetch(1) == phase_two_bodies.fetch(0)
raise "503 retry body changed" unless phase_two_bodies.fetch(0) == phase_two_bodies.fetch(1)

lifecycle_bodies = Dir.glob(File.join(lifecycle_intake, "request-*.body")).sort.map { |path| File.binread(path) }
raise "worker lifecycle request count changed" unless lifecycle_bodies.length == 2

extract_ids = lambda do |body|
  payload = JSON.parse(body)
  raise "request SDK envelope changed" unless payload.keys.sort == %w[events sdk]
  ids = payload.fetch("events").map { |event| event.fetch("id") }
  raise "request contained duplicate IDs" unless ids.uniq.length == ids.length
  raise "request event bound changed" unless ids.length.between?(1, 100)
  raise "request byte bound changed" unless body.bytesize <= 262_144
  ids
end
phase_one_ids = phase_one_bodies.map(&extract_ids)
phase_two_ids = phase_two_bodies.map(&extract_ids)
lifecycle_ids = lifecycle_bodies.map(&extract_ids)
raise "accepted prefix size changed" unless phase_one_ids.fetch(0).length == 100
raise "failed prefix size changed" unless phase_one_ids.fetch(1).length == 100
raise "failed prefix IDs changed across restart" unless phase_one_ids.fetch(1) == phase_two_ids.fetch(0)
raise "retry IDs changed" unless phase_two_ids.fetch(0) == phase_two_ids.fetch(1)

seed_ids = seed.fetch("retainedIds")
remaining_seed_ids = seed_ids.drop(100)
phase_two_unique_ids = phase_two_ids.flatten.uniq
unless phase_two_unique_ids == remaining_seed_ids + ["evt_persistent_late"]
  raise "restart delivery set or order changed"
end
raise "accepted prefix replayed" unless (phase_one_ids.fetch(0) & phase_two_unique_ids).empty?
raise "later work was not isolated to the final batch" unless phase_two_ids.last == ["evt_persistent_late"]
unless lifecycle_ids == [
  ["evt_lifecycle_child"],
  ["evt_lifecycle_parent_before", "evt_lifecycle_parent_after"]
]
  raise "worker process delivery ownership or order changed"
end

expected_parent = {
  "applicationResult" => "parent-result",
  "shutdownStatus" => 204,
  "shutdownAttempts" => 0,
  "shutdownBatches" => 0,
  "cachedShutdown" => true,
  "pending" => 0,
  "ownerOnly" => true
}
expected_child = {
  "inheritedError" => "process_ownership_error",
  "inheritedCallbackRan" => false,
  "applicationResult" => "child-result",
  "shutdownStatus" => 204,
  "shutdownAttempts" => 0,
  "shutdownBatches" => 0,
  "cachedShutdown" => true,
  "pending" => 0,
  "ownerOnly" => true
}
raise "parent worker lifecycle result changed" unless lifecycle_parent == expected_parent
raise "child worker lifecycle result changed" unless lifecycle_child == expected_child

expected_safety = {
  "corruptionCode" => "persistent_queue_error",
  "purged" => 2,
  "recoveredAfterPurge" => 0,
  "identityReason" => "persistence_failure",
  "replacementEntries" => [],
  "lockCode" => "persistent_queue_error"
}
raise "persistent safety result changed" unless safety == expected_safety

allowed_headers = %w[accept accept-encoding authorization connection content-length content-type host user-agent]
Dir.glob(File.join(phase_one, "request-*.head")).sort.concat(
  Dir.glob(File.join(phase_two, "request-*.head")).sort
).concat(
  Dir.glob(File.join(lifecycle_intake, "request-*.head")).sort
).each do |path|
  lines = File.binread(path).split("\r\n")
  raise "request route changed" unless lines.shift == "POST /v1/events HTTP/1.1"
  headers = lines.each_with_object({}) do |line, values|
    next if line.empty?

    name, value = line.split(":", 2)
    values[name.downcase] = value.to_s.strip
  end
  raise "unexpected request headers" unless (headers.keys - allowed_headers).empty?
  raise "authorization header changed" unless headers.fetch("authorization") == "Bearer LOGBREW_API_KEY"
  raise "content type changed" unless headers.fetch("content-type") == "application/json"
end

all_bodies = phase_one_bodies + phase_two_bodies + lifecycle_bodies
raise "request body leaked the API key" if all_bodies.any? { |body| body.include?("LOGBREW_API_KEY") }
proof_root = File.dirname(store_path)
raise "request body leaked a local path" if all_bodies.any? { |body| body.include?(proof_root) }

remaining_entries = Dir.children(store_path).sort
raise "successful shutdown retained event or temp files" unless remaining_entries == [".ack", ".lock"]
remaining_entries.each do |name|
  raise "persistent metadata permissions changed" unless (File.stat(File.join(store_path, name)).mode & 0o777) == 0o600
end
raise "installed package version was not bound" unless /\A\d+\.\d+\.\d+\z/.match?(package_version)
raise "installed package digest was not bound" unless /\A[0-9a-f]{64}\z/.match?(package_sha256)

puts JSON.generate(
  "ok" => true,
  "installedArtifact" => true,
  "version" => package_version,
  "sha256" => package_sha256,
  "attempted" => 1500,
  "retained" => 1000,
  "dropped" => 500,
  "acceptedPrefix" => 100,
  "recoveredSuffix" => 900,
  "retryIdentical" => true,
  "lateRetained" => 1,
  "requests" => 15,
  "acceptedEvents" => 1004,
  "workers" => 10,
  "forkOwnership" => true,
  "corruptionRejected" => true,
  "identityReplacementRejected" => true,
  "exclusiveOwner" => true,
  "purgeRecoveredEmpty" => true
)
RUBY

installed_ruby "$tmp_dir/verify.rb" \
  "$tmp_dir/seed-result.json" \
  "$tmp_dir/failed-result.json" \
  "$tmp_dir/drain-result.json" \
  "$phase_one_intake" \
  "$phase_two_intake" \
  "$store_path" \
  "$tmp_dir/lifecycle-parent-result.json" \
  "$tmp_dir/lifecycle-child-result.json" \
  "$lifecycle_intake" \
  "$tmp_dir/safety-result.json" \
  "$package_version" \
  "$gem_sha256"
