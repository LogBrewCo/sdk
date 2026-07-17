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

cat > "$tmp_dir/verify.rb" <<'RUBY'
# frozen_string_literal: true

require "json"

seed_path, failed_path, drain_path, phase_one, phase_two, store_path = ARGV
seed = JSON.parse(File.read(seed_path))
failed = JSON.parse(File.read(failed_path))
drain = JSON.parse(File.read(drain_path))

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

extract_ids = lambda do |body|
  payload = JSON.parse(body)
  raise "request SDK envelope changed" unless payload.keys.sort == %w[events sdk]
  ids = payload.fetch("events").map { |event| event.fetch("id") }
  raise "request contained duplicate IDs" unless ids.uniq.length == ids.length
  ids
end
phase_one_ids = phase_one_bodies.map(&extract_ids)
phase_two_ids = phase_two_bodies.map(&extract_ids)
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

allowed_headers = %w[accept accept-encoding authorization connection content-length content-type host user-agent]
Dir.glob(File.join(phase_one, "request-*.head")).sort.concat(
  Dir.glob(File.join(phase_two, "request-*.head")).sort
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

all_bodies = phase_one_bodies + phase_two_bodies
raise "request body leaked the API key" if all_bodies.any? { |body| body.include?("LOGBREW_API_KEY") }
raise "request body leaked a local path" if all_bodies.any? { |body| body.include?(store_path) }

remaining_entries = Dir.children(store_path).sort
raise "successful shutdown retained event or temp files" unless remaining_entries == [".ack", ".lock"]
remaining_entries.each do |name|
  raise "persistent metadata permissions changed" unless (File.stat(File.join(store_path, name)).mode & 0o777) == 0o600
end

puts JSON.generate(
  "ok" => true,
  "installedArtifact" => true,
  "attempted" => 1500,
  "retained" => 1000,
  "dropped" => 500,
  "acceptedPrefix" => 100,
  "recoveredSuffix" => 900,
  "retryIdentical" => true,
  "lateRetained" => 1,
  "requests" => 13,
  "workers" => 10
)
RUBY

installed_ruby "$tmp_dir/verify.rb" \
  "$tmp_dir/seed-result.json" \
  "$tmp_dir/failed-result.json" \
  "$tmp_dir/drain-result.json" \
  "$phase_one_intake" \
  "$phase_two_intake" \
  "$store_path"
