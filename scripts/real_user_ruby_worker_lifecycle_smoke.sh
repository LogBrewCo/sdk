#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/ruby/logbrew-ruby"
child_count=4
events_per_child=2500
events_per_boundary=25
boundaries_per_child=$((events_per_child / events_per_boundary))
expected_requests=$((child_count * boundaries_per_child + 2))
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

package_version="$({
  cd "$package_dir"
  ruby -e 'spec = Gem::Specification.load("logbrew-sdk.gemspec") or abort "invalid gemspec"; print spec.version'
})"
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
abort "installed lifecycle API is unavailable" unless LogBrew.const_defined?(:WorkerLifecycle)
abort "installed diagnostic API is unavailable" unless LogBrew.const_defined?(:WorkerDeliveryFailure)
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
retry_event_id = ARGV.fetch(2)
server = TCPServer.new("127.0.0.1", 0)
File.write(File.join(directory, "endpoint.txt"), "http://127.0.0.1:#{server.addr[1]}/v1/events")
retry_failed = false

expected_requests.times do |index|
  socket = server.accept
  begin
    head = +""
    while (line = socket.gets)
      head << line
      break if line == "\r\n"
    end
    content_length = head[/^content-length:\s*(\d+)/i, 1].to_i
    body = socket.read(content_length).to_s
    status = if !retry_failed && body.include?(retry_event_id)
               retry_failed = true
               503
             else
               202
             end
    File.binwrite(File.join(directory, "request-#{index}.head"), head)
    File.binwrite(File.join(directory, "request-#{index}.body"), body)
    File.write(File.join(directory, "request-#{index}.status"), status.to_s)

    reason = status == 503 ? "Service Unavailable" : "Accepted"
    socket.write("HTTP/1.1 #{status} #{reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
  ensure
    socket.close
  end
end
server.close
raise "retry path was not exercised" unless retry_failed
RUBY

retry_event_id="evt_child_02_00425"
installed_ruby \
  "$tmp_dir/intake_server.rb" \
  "$intake_dir" \
  "$expected_requests" \
  "$retry_event_id" \
  >"$intake_dir/server.stdout" 2>"$intake_dir/server.stderr" &
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

cat > "$tmp_dir/worker_app.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"

endpoint = ENV.fetch("LOGBREW_RUBY_WORKER_INTAKE_ENDPOINT")
child_count = Integer(ENV.fetch("LOGBREW_RUBY_WORKER_CHILDREN"))
events_per_child = Integer(ENV.fetch("LOGBREW_RUBY_WORKER_EVENTS_PER_CHILD"))
events_per_boundary = Integer(ENV.fetch("LOGBREW_RUBY_WORKER_EVENTS_PER_BOUNDARY"))
package_version = Gem.loaded_specs.fetch("logbrew-sdk").version.to_s
raise "fork is unavailable" unless Process.respond_to?(:fork)
raise "invalid worker partition" unless (events_per_child % events_per_boundary).zero?

def create_client(package_version, child_id: nil)
  suffix = child_id.nil? ? "parent" : format("child-%02d", child_id)
  LogBrew::Client.create(
    api_key: "LOGBREW_API_KEY",
    sdk_name: "logbrew-ruby-worker-#{suffix}",
    sdk_version: package_version,
    max_retries: 1
  )
end

def add_log(client, event_id)
  client.log(
    event_id,
    "2026-07-13T15:00:00Z",
    message: "worker lifecycle event",
    level: "info",
    logger: "serialized-worker"
  )
end

parent_client = create_client(package_version)
add_log(parent_client, "evt_parent_before_fork")
parent_transport = LogBrew::HttpTransport.new(endpoint: endpoint, timeout: 5)
parent_lifecycle = LogBrew::WorkerLifecycle.create(client: parent_client, transport: parent_transport)

ready_reader, ready_writer = IO.pipe
result_reader, result_writer = IO.pipe
start_pipes = Array.new(child_count) { IO.pipe }

children = child_count.times.map do |child_id|
  Process.fork do
    ready_reader.close
    result_reader.close
    start_pipes.each_with_index do |(reader, writer), index|
      writer.close
      reader.close unless index == child_id
    end

    begin
      inherited_callback_ran = false
      inherited_code = nil
      begin
        parent_lifecycle.run { inherited_callback_ran = true }
      rescue LogBrew::SdkError => error
        inherited_code = error.code
      end
      unless inherited_code == "process_ownership_error" && !inherited_callback_ran
        raise "inherited lifecycle did not fail closed"
      end

      client = create_client(package_version, child_id: child_id)
      transport = LogBrew::HttpTransport.new(endpoint: endpoint, timeout: 5)
      delivery_failures = 0
      lifecycle = LogBrew::WorkerLifecycle.create(
        client: client,
        transport: transport,
        on_delivery_failure: ->(_failure) { delivery_failures += 1 }
      )

      post_work_rejected = false
      if child_id.zero?
        ownership_reader, ownership_writer = IO.pipe
        grandchild_pid = nil
        begin
          lifecycle.run do
            grandchild_pid = Process.fork
            if grandchild_pid.nil?
              ownership_reader.close
            else
              ownership_writer.close
              Process.wait(grandchild_pid)
            end
          end
        rescue LogBrew::SdkError => error
          raise unless grandchild_pid.nil?

          ownership_writer.puts(error.code)
          ownership_writer.close
          exit! error.code == "process_ownership_error" ? 0 : 1
        end
        ownership_code = ownership_reader.read.strip
        ownership_reader.close
        post_work_rejected = ownership_code == "process_ownership_error"
        raise "post-work process change did not fail closed" unless post_work_rejected
      end

      ready_writer.puts(child_id)
      ready_writer.flush
      raise "missing start signal" unless start_pipes.fetch(child_id).fetch(0).read(1) == "s"

      boundary_count = events_per_child / events_per_boundary
      boundary_count.times do |boundary_index|
        result = lifecycle.run do
          start_index = boundary_index * events_per_boundary
          events_per_boundary.times do |offset|
            event_index = start_index + offset
            add_log(client, format("evt_child_%02d_%05d", child_id, event_index))
          end
          boundary_index
        end
        raise "application result changed" unless result == boundary_index
      end

      first_shutdown = lifecycle.shutdown
      second_shutdown = lifecycle.shutdown
      raise "shutdown response was not cached" unless first_shutdown.equal?(second_shutdown)
      raise "child retained telemetry" unless client.pending_events.zero?

      result_writer.puts(JSON.generate(
        "child" => child_id,
        "ok" => true,
        "events" => events_per_child,
        "boundaries" => boundary_count,
        "deliveryFailures" => delivery_failures,
        "inheritedRejected" => true,
        "postWorkRejected" => post_work_rejected
      ))
      result_writer.flush
      exit! 0
    rescue StandardError => error
      result_writer.puts(JSON.generate("child" => child_id, "ok" => false, "errorType" => error.class.name))
      result_writer.flush
      exit! 1
    end
  ensure
    ready_writer.close unless ready_writer.closed?
    result_writer.close unless result_writer.closed?
    start_pipes.each do |reader, _writer|
      reader.close unless reader.closed?
    end
  end
end

ready_writer.close
result_writer.close
start_pipes.each { |reader, _writer| reader.close }

ready_ids = child_count.times.map do
  line = ready_reader.gets
  raise "child did not reach ready barrier" if line.nil?

  Integer(line)
end.sort
expected_child_ids = (0...child_count).to_a
raise "ready barrier did not include every child" unless ready_ids == expected_child_ids
start_pipes.each do |_reader, writer|
  writer.write("s")
  writer.close
end

results = child_count.times.map do
  line = result_reader.gets
  raise "child did not report completion" if line.nil?

  JSON.parse(line)
end.sort_by { |result| result.fetch("child") }
statuses = children.map { |pid| Process.wait2(pid).fetch(1) }
raise "a child process failed" unless statuses.all?(&:success?)
unless results.map { |result| result.fetch("child") } == expected_child_ids && results.all? { |result| result["ok"] }
  raise "completion barrier did not include every child"
end

parent_result = parent_lifecycle.run do
  add_log(parent_client, "evt_parent_after_fork")
  :parent_complete
end
raise "parent result changed" unless parent_result == :parent_complete
first_parent_shutdown = parent_lifecycle.shutdown
second_parent_shutdown = parent_lifecycle.shutdown
raise "parent shutdown response was not cached" unless first_parent_shutdown.equal?(second_parent_shutdown)

puts JSON.generate(
  "ok" => true,
  "packageVersion" => package_version,
  "children" => child_count,
  "eventsPerChild" => events_per_child,
  "eventsPerBoundary" => events_per_boundary,
  "childEvents" => child_count * events_per_child,
  "parentEvents" => 2,
  "readyIds" => ready_ids,
  "completionIds" => results.map { |result| result.fetch("child") },
  "childDeliveryFailures" => results.sum { |result| result.fetch("deliveryFailures") },
  "inheritedRejected" => results.all? { |result| result.fetch("inheritedRejected") },
  "postWorkRejected" => results.any? { |result| result.fetch("postWorkRejected") }
)
RUBY

LOGBREW_RUBY_WORKER_INTAKE_ENDPOINT="$(<"$intake_dir/endpoint.txt")" \
LOGBREW_RUBY_WORKER_CHILDREN="$child_count" \
LOGBREW_RUBY_WORKER_EVENTS_PER_CHILD="$events_per_child" \
LOGBREW_RUBY_WORKER_EVENTS_PER_BOUNDARY="$events_per_boundary" \
installed_ruby "$tmp_dir/worker_app.rb" >"$tmp_dir/result.json"

wait "$server_pid"
server_pid=""

cat > "$tmp_dir/verify.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "uri"

directory, result_path, expected_requests_text, child_count_text, events_per_child_text,
  events_per_boundary_text, package_version = ARGV
expected_requests = Integer(expected_requests_text)
child_count = Integer(child_count_text)
events_per_child = Integer(events_per_child_text)
events_per_boundary = Integer(events_per_boundary_text)
result = JSON.parse(File.read(result_path))
expected_ids = (0...child_count).to_a
endpoint = URI.parse(File.read(File.join(directory, "endpoint.txt")))
expected_host = "#{endpoint.host}:#{endpoint.port}"
unsafe_markers = [directory, ENV.fetch("HOME", "")].reject(&:empty?)

expected_result = {
  "ok" => true,
  "packageVersion" => package_version,
  "children" => child_count,
  "eventsPerChild" => events_per_child,
  "eventsPerBoundary" => events_per_boundary,
  "childEvents" => child_count * events_per_child,
  "parentEvents" => 2,
  "readyIds" => expected_ids,
  "completionIds" => expected_ids,
  "childDeliveryFailures" => 0,
  "inheritedRejected" => true,
  "postWorkRejected" => true
}
raise "unexpected installed worker result" unless result == expected_result

requests = expected_requests.times.map do |index|
  {
    head: File.binread(File.join(directory, "request-#{index}.head")),
    body: File.binread(File.join(directory, "request-#{index}.body")),
    status: Integer(File.read(File.join(directory, "request-#{index}.status")))
  }
end
failed_requests = requests.select { |request| request.fetch(:status) == 503 }
accepted_requests = requests.select { |request| request.fetch(:status) == 202 }
raise "expected one selected retryable failure" unless failed_requests.length == 1
failed_body = failed_requests.fetch(0).fetch(:body)
raise "retry body was not byte-identical" unless requests.count { |request| request.fetch(:body) == failed_body } == 2
raise "retry body was not eventually accepted" unless accepted_requests.any? { |request| request.fetch(:body) == failed_body }

allowed_headers = %w[accept accept-encoding authorization connection content-length content-type host user-agent].freeze
requests.each do |request|
  head = request.fetch(:head)
  body = request.fetch(:body)
  lines = head.lines
  raise "unexpected intake request line" unless lines.fetch(0).match?(/\APOST \/v1\/events HTTP\/1\.1\r?\n\z/)
  headers = lines.drop(1).each_with_object([]) do |line, parsed|
    next if line == "\r\n" || line == "\n"

    name, value = line.split(":", 2)
    parsed << [name.downcase, value.to_s.strip]
  end
  names = headers.map(&:first)
  raise "unexpected request header" unless (names - allowed_headers).empty?
  raise "duplicate request header" unless names.uniq.length == names.length
  values = headers.to_h
  raise "authorization header changed" unless values.fetch("authorization") == "Bearer LOGBREW_API_KEY"
  raise "content type changed" unless values.fetch("content-type") == "application/json"
  raise "host header changed" unless values.fetch("host") == expected_host
  raise "user agent header changed" unless values.fetch("user-agent") == "Ruby"
  raise "accept header changed" unless values.fetch("accept") == "*/*"
  accept_encoding = values.fetch("accept-encoding")
  unless accept_encoding.match?(/\A(?:gzip|deflate|identity)(?:;q=(?:0(?:\.\d+)?|1(?:\.0+)?))?(?:, ?(?:gzip|deflate|identity)(?:;q=(?:0(?:\.\d+)?|1(?:\.0+)?))?)*\z/)
    raise "accept encoding header changed"
  end
  if values.key?("connection") && !%w[close keep-alive].include?(values.fetch("connection"))
    raise "connection header changed"
  end
  content_length = values.fetch("content-length")
  raise "content length changed" unless Integer(content_length) == body.bytesize
  raise "request exceeded event batch byte bound" if body.bytesize > 262_144
  raise "request body was not compact" if body.include?("\n")
  raise "request headers leaked local state" if unsafe_markers.any? { |marker| head.include?(marker) }
end

accepted_events = accepted_requests.flat_map do |request|
  events = JSON.parse(request.fetch(:body)).fetch("events")
  unless events.length.positive? && events.length <= events_per_boundary
    raise "work boundary exceeded its event partition"
  end
  events
end
accepted_ids = accepted_events.map { |event| event.fetch("id") }
raise "accepted event identity was duplicated" unless accepted_ids.uniq.length == accepted_ids.length
raise "unexpected accepted event count" unless accepted_ids.length == child_count * events_per_child + 2

child_count.times do |child_id|
  expected = events_per_child.times.map { |index| format("evt_child_%02d_%05d", child_id, index) }
  actual = accepted_ids.select { |event_id| event_id.start_with?(format("evt_child_%02d_", child_id)) }
  raise "child event order or identity changed" unless actual == expected
end
parent_ids = accepted_ids.select { |event_id| event_id.start_with?("evt_parent_") }
unless parent_ids == %w[evt_parent_before_fork evt_parent_after_fork]
  raise "parent events were lost, duplicated, or sent from inherited child state"
end

requests.each do |request|
  ids = JSON.parse(request.fetch(:body)).fetch("events").map { |event| event.fetch("id") }
  next unless ids.any? { |event_id| event_id.start_with?("evt_parent_") }

  unless ids == %w[evt_parent_before_fork evt_parent_after_fork]
    raise "a child request included copied parent telemetry"
  end
end

requests.each do |request|
  body = request.fetch(:body)
  raise "request body leaked local state" if unsafe_markers.any? { |marker| body.include?(marker) }
end
RUBY

installed_ruby \
  "$tmp_dir/verify.rb" \
  "$intake_dir" \
  "$tmp_dir/result.json" \
  "$expected_requests" \
  "$child_count" \
  "$events_per_child" \
  "$events_per_boundary" \
  "$package_version"

GEM_HOME="$gem_home" GEM_PATH="$gem_home" gem list --local --exact logbrew-sdk >"$tmp_dir/gem-list.txt"
grep -qx "logbrew-sdk (${package_version})" "$tmp_dir/gem-list.txt"

printf 'ruby installed worker lifecycle smoke passed (%d children, %d child events, %d parent events, %d requests)\n' \
  "$child_count" "$((child_count * events_per_child))" 2 "$expected_requests"
