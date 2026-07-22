#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/ruby/logbrew-ruby"
load_events="${LOGBREW_RUBY_LOAD_EVENTS:-10000}"
retained_events=1000
batch_size=100
accepted_batches=$((retained_events / batch_size))
expected_requests=$((accepted_batches + 1))

if [[ ! "$load_events" =~ ^[0-9]+$ ]] || ((load_events < 1010 || load_events > 100000)); then
  printf '%s\n' "LOGBREW_RUBY_LOAD_EVENTS must be an integer from 1010 through 100000" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
gem_home="$tmp_dir/gems"
intake_dir="$tmp_dir/intake"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT
mkdir -p "$gem_home" "$intake_dir"

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
abort "installed queue API is unavailable" unless LogBrew.const_defined?(:DroppedEvent)
abort "installed client API is unavailable" unless LogBrew.const_defined?(:Client)
'
GEM_HOME="$gem_home" GEM_PATH="$gem_home" \
  gem uninstall logbrew-sdk --all --executables --ignore-dependencies --silent >/dev/null
if installed_ruby -e 'require "logbrew"' 2>/dev/null; then
  printf '%s\n' "removed gem remained importable" >&2
  exit 1
fi
install_gem

cat > "$tmp_dir/intake_server.rb" <<'RUBY'
# frozen_string_literal: true

require "socket"

directory = ARGV.fetch(0)
expected_requests = Integer(ARGV.fetch(1))
server = TCPServer.new("127.0.0.1", 0)
File.write(File.join(directory, "endpoint.txt"), "http://127.0.0.1:#{server.addr[1]}/v1/events")

expected_requests.times do |index|
  status = index.zero? ? 503 : 202
  socket = server.accept
  begin
    head = +""
    while (line = socket.gets)
      head << line
      break if line == "\r\n"
    end
    content_length = head[/^content-length:\s*(\d+)/i, 1].to_i
    body = socket.read(content_length).to_s
    File.write(File.join(directory, "request-#{index}.head"), head)
    File.write(File.join(directory, "request-#{index}.body"), body)

    reason = status == 503 ? "Service Unavailable" : "Accepted"
    socket.write("HTTP/1.1 #{status} #{reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
  ensure
    socket.close
  end
end
server.close
RUBY

installed_ruby "$tmp_dir/intake_server.rb" "$intake_dir" "$expected_requests" >"$intake_dir/server.stdout" 2>"$intake_dir/server.stderr" &
server_pid="$!"

for _ in {1..200}; do
  if [[ -s "$intake_dir/endpoint.txt" ]]; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    printf '%s\n' "local intake failed to start" >&2
    exit 1
  fi
  sleep 0.05
done
test -s "$intake_dir/endpoint.txt"

cat > "$tmp_dir/high_load.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"
require "thread"

attempted = Integer(ENV.fetch("LOGBREW_RUBY_LOAD_EVENTS"))
endpoint = ENV.fetch("LOGBREW_RUBY_INTAKE_ENDPOINT")
queued_ids_path = ENV.fetch("LOGBREW_RUBY_QUEUED_IDS_PATH")
package_version = Gem.loaded_specs.fetch("logbrew-sdk").version.to_s
callback_calls = 0
last_drop = nil
callback_mutex = Mutex.new

def run_parallel(values, workers: 10)
  partitions = Array.new(workers) { [] }
  values.each_with_index { |value, index| partitions.fetch(index % workers) << value }
  raise "each worker must receive capture work" if partitions.any?(&:empty?)

  ready = Queue.new
  start = Queue.new
  completed = Queue.new
  threads = partitions.each_with_index.map do |partition, worker_id|
    Thread.new do
      ready << worker_id
      start.pop
      partition.each { |value| yield value }
      completed << worker_id
      worker_id
    end
  end

  expected_worker_ids = (0...workers).to_a
  ready_worker_ids = workers.times.map { ready.pop }.sort
  raise "not every worker reached the start barrier" unless ready_worker_ids == expected_worker_ids

  workers.times { start << true }
  returned_worker_ids = threads.map(&:value).sort
  completed_worker_ids = workers.times.map { completed.pop }.sort
  unless returned_worker_ids == expected_worker_ids && completed_worker_ids == expected_worker_ids
    raise "not every worker completed its assigned captures"
  end
  completed_worker_ids
end

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby",
  sdk_version: package_version,
  max_retries: 1,
  on_event_dropped: lambda do |drop|
    current_calls = callback_mutex.synchronize do
      callback_calls += 1
      last_drop = drop
      callback_calls
    end
    raise "local callback failure" if current_calls == 1
  end
)
client.release("evt_load_release", "2026-07-12T10:00:00Z", version: "2.0.0")
client.environment("evt_load_environment", "2026-07-12T10:00:01Z", name: "production")

capture = lambda do |index|
  message = index == 998 ? "private-dropped-content" : "bounded load"
  client.log(
    format("evt_load_%05d", index),
    "2026-07-12T10:00:02Z",
    message: message,
    level: "info",
    metadata: { worker: index % 8 }
  )
end
retained_worker_ids = run_parallel(0...998, &capture)
dropped_worker_ids = run_parallel(998...(attempted - 2), &capture)

expected_dropped = attempted - 1_000
raise "unexpected retained count" unless client.pending_events == 1_000
raise "unexpected dropped count" unless client.dropped_events == expected_dropped
raise "unexpected callback count" unless callback_calls == expected_dropped
raise "unexpected final notice" unless last_drop.reason == "queue_overflow" && last_drop.pending_events == 1_000

pending_bytes = client.pending_event_bytes
raise "unexpected byte accounting" unless pending_bytes.positive? && pending_bytes <= 4_194_304
preview = client.preview_json
raise "queued payload leaked excluded data" if preview.include?("LOGBREW_API_KEY") || preview.include?("private-dropped-content")
queued_ids = JSON.parse(preview).fetch("events").map { |event| event.fetch("id") }
File.write(queued_ids_path, JSON.generate(queued_ids))

transport = LogBrew::HttpTransport.new(endpoint: endpoint, timeout: 2)
response = client.shutdown(transport)
unless response.status_code == 202 && response.attempts == 11 && response.batches == 10
  raise "unexpected batched retry result"
end
raise "shutdown retained events" unless client.pending_events.zero? && client.pending_event_bytes.zero?

begin
  client.log("evt_after_shutdown", "2026-07-12T10:00:03Z", message: "closed", level: "info")
  raise "closed client accepted an event"
rescue LogBrew::SdkError => error
  raise unless error.code == "shutdown_error"
end

oversized_reason = nil
oversized = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "logbrew-ruby",
  sdk_version: package_version,
  max_queue_bytes: 1_048_576,
  max_batch_bytes: 256,
  on_event_dropped: ->(drop) { oversized_reason = drop.reason }
)
oversized.log(
  "evt_oversized",
  "2026-07-12T10:00:04Z",
  message: "private-oversized-content-" * 100,
  level: "error"
)
unless oversized.pending_events.zero? && oversized.dropped_events == 1 && oversized_reason == "event_too_large"
  raise "oversized event contract failed"
end

puts JSON.generate(
  "ok" => true,
  "packageVersion" => package_version,
  "attempted" => attempted,
  "queued" => 1_000,
  "dropped" => expected_dropped,
  "attempts" => response.attempts,
  "batches" => response.batches,
  "requests" => response.attempts,
  "workers" => retained_worker_ids.length,
  "retainedWorkerIds" => retained_worker_ids,
  "droppedWorkerIds" => dropped_worker_ids,
  "pendingBytesBeforeFlush" => pending_bytes,
  "oversizedDropped" => 1
)
RUBY

LOGBREW_RUBY_LOAD_EVENTS="$load_events" \
LOGBREW_RUBY_INTAKE_ENDPOINT="$(<"$intake_dir/endpoint.txt")" \
LOGBREW_RUBY_QUEUED_IDS_PATH="$tmp_dir/queued-ids.json" \
installed_ruby "$tmp_dir/high_load.rb" >"$tmp_dir/result.json"

wait "$server_pid"
server_pid=""

cat > "$tmp_dir/verify.rb" <<'RUBY'
# frozen_string_literal: true

require "json"

directory, result_path, queued_ids_path, attempted_text, package_version = ARGV
attempted = Integer(attempted_text)
result = JSON.parse(File.read(result_path))
expected = {
  "ok" => true,
  "packageVersion" => package_version,
  "attempted" => attempted,
  "queued" => 1_000,
  "dropped" => attempted - 1_000,
  "attempts" => 11,
  "batches" => 10,
  "requests" => 11,
  "workers" => 10,
  "oversizedDropped" => 1
}
expected.each do |key, value|
  raise "unexpected installed result" unless result[key] == value
end
expected_worker_ids = (0...10).to_a
unless result.fetch("retainedWorkerIds") == expected_worker_ids && result.fetch("droppedWorkerIds") == expected_worker_ids
  raise "not every declared worker completed both capture phases"
end

request_count = result.fetch("requests")
bodies = request_count.times.map { |index| File.binread(File.join(directory, "request-#{index}.body")) }
raise "retry bodies differ" if bodies.fetch(0).empty? || bodies.fetch(0) != bodies.fetch(1)

unsafe_markers = [
  "LOGBREW_API_KEY",
  "private-dropped-content",
  "private-oversized-content",
  directory,
  ENV.fetch("HOME", "")
].reject(&:empty?)
bodies.each do |body|
  raise "request body exceeded byte limit" if body.bytesize > 262_144
  raise "request body was not compact" if body.include?("\n")
  raise "installed payload leaked excluded data" if unsafe_markers.any? { |marker| body.include?(marker) }
end

accepted_events = bodies.drop(1).flat_map do |body|
  events = JSON.parse(body).fetch("events")
  raise "request batch exceeded event limit" if events.empty? || events.length > 100
  events
end
accepted_ids = accepted_events.map { |event| event.fetch("id") }
queued_ids = JSON.parse(File.read(queued_ids_path))
raise "accepted event order or identity changed" unless accepted_ids == queued_ids
raise "accepted event ids were duplicated" unless accepted_ids.uniq.length == 1_000
raise "installed payload lost release context" unless accepted_events.fetch(0).fetch("type") == "release"
raise "installed payload lost environment context" unless accepted_events.fetch(1).fetch("type") == "environment"

request_count.times do |index|
  head = File.read(File.join(directory, "request-#{index}.head"))
  lines = head.lines
  raise "unexpected intake request line" unless lines.fetch(0).match?(/\APOST \/v1\/events HTTP\/1\.1\r?\n\z/)
  authorization = lines.grep(/\Aauthorization:/i)
  content_type = lines.grep(/\Acontent-type:/i)
  content_length = lines.grep(/\Acontent-length:/i)
  unless authorization.length == 1 && authorization.fetch(0).match?(/\Aauthorization: Bearer LOGBREW_API_KEY\r?\n\z/i)
    raise "authorization header placement changed"
  end
  unless content_type.length == 1 && content_type.fetch(0).match?(/\Acontent-type: application\/json\r?\n\z/i)
    raise "content type placement changed"
  end
  raise "content length placement changed" unless content_length.length == 1
  declared_length = Integer(content_length.fetch(0).split(":", 2).fetch(1).strip)
  raise "content length did not match request bytes" unless declared_length == bodies.fetch(index).bytesize
end
RUBY
installed_ruby \
  "$tmp_dir/verify.rb" \
  "$intake_dir" \
  "$tmp_dir/result.json" \
  "$tmp_dir/queued-ids.json" \
  "$load_events" \
  "$package_version"

GEM_HOME="$gem_home" GEM_PATH="$gem_home" gem list --local --exact logbrew-sdk >"$tmp_dir/gem-list.txt"
grep -qx "logbrew-sdk (${package_version})" "$tmp_dir/gem-list.txt"

printf 'ruby installed high-load smoke passed (%d attempted, 1000 queued, %d dropped, 10 batches, 11 requests)\n' \
  "$load_events" "$((load_events - 1000))"
