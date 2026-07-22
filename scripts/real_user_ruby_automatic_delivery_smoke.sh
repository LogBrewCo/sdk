#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/ruby/logbrew-ruby"
tmp_dir="$(mktemp -d)"
gem_home="$tmp_dir/gems"
stdout_file="$tmp_dir/proof.stdout.json"
stderr_file="$tmp_dir/proof.stderr"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

package_version="$(
  cd "$package_dir"
  ruby -e 'spec = Gem::Specification.load("logbrew-sdk.gemspec") or abort "invalid gemspec"; print spec.version'
)"
gem_file="$tmp_dir/logbrew-sdk-${package_version}.gem"

(
  cd "$package_dir"
  gem build logbrew-sdk.gemspec --strict --output "$gem_file" >/dev/null
)
gem_digest="$(shasum -a 256 "$gem_file" | awk '{print $1}')"
gem install --local --install-dir "$gem_home" --no-document "$gem_file" >/dev/null

cat > "$tmp_dir/proof.rb" <<'RUBY'
# frozen_string_literal: true

require "digest"
require "json"
require "socket"
require "tmpdir"
require "logbrew"

API_KEY = "installed-proof-api-key"
SOURCE = "ruby-automatic-proof"

def assert_proof(condition, message)
  raise message unless condition
end

def wait_for_proof(message, timeout: 8)
  deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
  until yield
    raise message if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline

    sleep(0.005)
  end
end

def capture_log(client, id, message = "proof event")
  client.log(id, "2026-07-18T12:00:00Z", message: message, level: "info")
end

class StrictIntake
  Request = Struct.new(:path, :headers, :body, :status, :ids, keyword_init: true)

  attr_reader :endpoint

  def initialize
    @server = TCPServer.new("127.0.0.1", 0)
    @endpoint = "http://127.0.0.1:#{@server.addr[1]}/v1/events"
    @requests = []
    @mutex = Mutex.new
    @retry_attempts = 0
    @terminal_attempts = 0
    @high_load_blocked = false
    @high_load_entered = Queue.new
    @high_load_release = Queue.new
    @closed = false
    @thread = Thread.new { accept_loop }
  end

  def requests
    @mutex.synchronize { @requests.dup }
  end

  def requests_for(id)
    requests.select { |request| request.ids.include?(id) }
  end

  def wait_for_high_load
    @high_load_entered.pop
  end

  def release_high_load
    @high_load_release << true
  end

  def close
    @closed = true
    @server.close unless @server.closed?
    @thread.join(2)
  end

  private

  def accept_loop
    until @closed
      socket = @server.accept
      begin
        handle(socket)
      ensure
        socket.close unless socket.closed?
      end
    end
  rescue IOError, Errno::EBADF
    nil
  end

  def handle(socket)
    request_line = socket.gets.to_s.strip.split(" ")
    headers = {}
    while (line = socket.gets)
      line = line.chomp
      break if line.empty?

      name, value = line.split(":", 2)
      headers[name.to_s.downcase] = value.to_s.strip
    end
    body = socket.read(headers.fetch("content-length", "0").to_i).to_s
    ids = JSON.parse(body).fetch("events").map { |event| event.fetch("id") }
    status, block_high_load = classify(ids)
    request = Request.new(path: request_line.fetch(1), headers: headers, body: body, status: status, ids: ids)
    @mutex.synchronize { @requests << request }

    if block_high_load
      @high_load_entered << true
      @high_load_release.pop
    end

    reason = case status
             when 202 then "Accepted"
             when 401 then "Unauthorized"
             else "Service Unavailable"
             end
    socket.write("HTTP/1.1 #{status} #{reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
  end

  def classify(ids)
    @mutex.synchronize do
      if ids.include?("evt_retry_original")
        @retry_attempts += 1
        return [@retry_attempts == 1 ? 503 : 202, false]
      end
      if ids.include?("evt_terminal_original")
        @terminal_attempts += 1
        return [@terminal_attempts == 1 ? 401 : 202, false]
      end
      if ids.include?("evt_high_0000") && !@high_load_blocked
        @high_load_blocked = true
        return [202, true]
      end

      [202, false]
    end
  end
end

def transport_for(intake)
  LogBrew::HttpTransport.new(
    endpoint: intake.endpoint,
    headers: { "x-logbrew-source" => SOURCE },
    timeout: 2
  )
end

def automatic_client(intake, **options)
  LogBrew::Client.create_automatic(
    api_key: API_KEY,
    sdk_name: "installed-ruby-automatic",
    sdk_version: "0.1.1",
    transport: transport_for(intake),
    max_retries: 0,
    flush_interval: 0.08,
    flush_threshold: 2,
    retry_base_delay: 0.04,
    retry_max_delay: 0.04,
    **options
  )
end

intake = StrictIntake.new
restart_preview_digest = nil
begin
  threshold_client = automatic_client(intake, flush_interval: 1, flush_threshold: 2)
  capture_log(threshold_client, "evt_threshold_1")
  sleep(0.03)
  assert_proof(intake.requests_for("evt_threshold_1").empty?, "threshold sent a partial queue")
  capture_log(threshold_client, "evt_threshold_2")
  wait_for_proof("threshold delivery did not run") { intake.requests_for("evt_threshold_1").length == 1 }
  capture_log(threshold_client, "evt_interval")
  wait_for_proof("interval delivery did not run") { intake.requests_for("evt_interval").length == 1 }
  threshold_client.shutdown

  retry_client = automatic_client(intake, flush_interval: 1, flush_threshold: 1)
  capture_log(retry_client, "evt_retry_original", "retry original")
  wait_for_proof("retry failure was not observed") do
    intake.requests_for("evt_retry_original").any? { |request| request.status == 503 }
  end
  capture_log(retry_client, "evt_retry_later", "retry later")
  wait_for_proof("retry sequence did not drain") do
    intake.requests_for("evt_retry_original").length == 2 && intake.requests_for("evt_retry_later").length == 1
  end
  retry_requests = intake.requests_for("evt_retry_original")
  assert_proof(retry_requests[0].body == retry_requests[1].body, "503 retry body changed")
  retry_client.shutdown

  terminal_client = automatic_client(intake, flush_interval: 1, flush_threshold: 1)
  capture_log(terminal_client, "evt_terminal_original", "terminal original")
  wait_for_proof("terminal delivery did not pause") { terminal_client.delivery_health.state == "paused" }
  capture_log(terminal_client, "evt_terminal_later", "terminal later")
  sleep(0.08)
  assert_proof(intake.requests_for("evt_terminal_original").length == 1, "terminal pause retried automatically")
  assert_proof(terminal_client.delivery_health.pause_reason == "authentication", "terminal pause reason changed")
  terminal_client.recover_automatic_delivery
  capture_log(terminal_client, "evt_terminal_recovered", "terminal recovered")
  wait_for_proof("recovered terminal delivery did not run") do
    intake.requests_for("evt_terminal_recovered").length == 1
  end
  terminal_client.shutdown

  fork_client = automatic_client(intake, flush_interval: 60, flush_threshold: 2)
  reader, writer = IO.pipe
  child_pid = fork do
    reader.close
    codes = []
    [
      -> { capture_log(fork_client, "evt_inherited_child") },
      -> { fork_client.flush },
      -> { fork_client.purge_pending_events },
      -> { fork_client.stop_automatic_delivery },
      -> { fork_client.shutdown }
    ].each do |operation|
      begin
        operation.call
        codes << "missing_error"
      rescue LogBrew::SdkError => error
        codes << error.code
      end
    end
    writer.write(JSON.generate(codes))
    writer.close
    exit! 0
  end
  writer.close
  child_codes = JSON.parse(reader.read)
  reader.close
  _, child_status = Process.wait2(child_pid)
  assert_proof(child_status.success?, "fork child failed")
  assert_proof(child_codes.uniq == ["process_ownership_error"], "inherited client did not fail closed")
  capture_log(fork_client, "evt_parent_1")
  capture_log(fork_client, "evt_parent_2")
  wait_for_proof("parent owner stopped after fork") { intake.requests_for("evt_parent_1").length == 1 }
  assert_proof(intake.requests_for("evt_inherited_child").empty?, "child sent copied work")
  fork_client.shutdown

  Dir.mktmpdir("logbrew-installed-persistence-") do |directory|
    queue_path = File.join(directory, "queue")
    reader, writer = IO.pipe
    seed_pid = fork do
      reader.close
      client = automatic_client(
        intake,
        persistent_queue_path: queue_path,
        flush_interval: 60,
        flush_threshold: 100
      )
      capture_log(client, "evt_restart_1", "restart one")
      capture_log(client, "evt_restart_2", "restart two")
      writer.write(Digest::SHA256.hexdigest(client.preview_json))
      writer.close
      exit! 0
    end
    writer.close
    preview_digest = reader.read
    restart_preview_digest = preview_digest
    reader.close
    _, seed_status = Process.wait2(seed_pid)
    assert_proof(seed_status.success?, "persistent seed failed")

    recovered = automatic_client(
      intake,
      persistent_queue_path: queue_path,
      flush_interval: 60,
      flush_threshold: 100
    )
    assert_proof(recovered.delivery_health.queued_events == 2, "hydrated health count changed")
    wait_for_proof("restart work was not sent") { intake.requests_for("evt_restart_1").length == 1 }
    restart_request = intake.requests_for("evt_restart_1").fetch(0)
    wire_digest = Digest::SHA256.hexdigest(JSON.pretty_generate(JSON.parse(restart_request.body)))
    assert_proof(wire_digest == preview_digest, "restart preview digest changed")
    assert_proof(restart_request.ids == %w[evt_restart_1 evt_restart_2], "restart order changed")
    recovered.shutdown

    stored_content = Dir.glob(File.join(queue_path, "**", "*"), File::FNM_DOTMATCH).select { |path| File.file?(path) }.map do |path|
      File.binread(path)
    rescue IOError, SystemCallError
      ""
    end.join
    assert_proof(!stored_content.include?(API_KEY), "persistent storage contains the API key")
  end

  dropped = 0
  high_client = automatic_client(
    intake,
    max_queue_size: 1_000,
    max_queue_bytes: 4 * 1024 * 1024,
    max_batch_size: 100,
    max_batch_bytes: 256 * 1024,
    flush_interval: 60,
    flush_threshold: 1_000,
    on_event_dropped: ->(_notice) { dropped += 1 }
  )
  1_000.times do |index|
    capture_log(high_client, format("evt_high_%04d", index), "bounded high load")
  end
  intake.wait_for_high_load
  500.times do |index|
    capture_log(high_client, format("evt_high_drop_%04d", index), "bounded overflow")
  end
  assert_proof(high_client.pending_events == 1_000, "high-load queue bound changed")
  assert_proof(dropped == 500 && high_client.dropped_events == 500, "high-load drop count changed")
  intake.release_high_load
  wait_for_proof("high-load queue did not drain") { high_client.pending_events.zero? }
  high_requests = intake.requests.select { |request| request.ids.any? { |id| id.start_with?("evt_high_") } }
  accepted_ids = high_requests.flat_map(&:ids)
  expected_ids = 1_000.times.map { |index| format("evt_high_%04d", index) }
  assert_proof(high_requests.length == 10, "high-load request count changed")
  assert_proof(accepted_ids == expected_ids, "high-load accepted order changed")
  assert_proof(accepted_ids.uniq.length == 1_000, "high-load accepted duplicate detected")
  assert_proof(high_requests.all? { |request| request.ids.length <= 100 }, "high-load event request bound changed")
  assert_proof(high_requests.all? { |request| request.body.bytesize <= 256 * 1024 }, "high-load byte request bound changed")
  high_client.shutdown

  requests = intake.requests
  requests.each do |request|
    assert_proof(request.path == "/v1/events", "request path changed")
    assert_proof(request.headers.fetch("authorization") == "Bearer #{API_KEY}", "authorization header changed")
    assert_proof(request.headers.fetch("content-type") == "application/json", "content type changed")
    assert_proof(request.headers.fetch("x-logbrew-source") == SOURCE, "source header changed")
    assert_proof(!request.body.include?(API_KEY), "request body contains the API key")
    assert_proof(!request.path.include?(API_KEY), "request path contains the API key")
  end
  assert_proof(
    Thread.list.none? { |thread| thread.name == "logbrew-delivery" && thread.alive? },
    "automatic delivery worker leaked after shutdown"
  )

  puts JSON.generate(
    "ok" => true,
    "requests" => requests.length,
    "acceptedEvents" => requests.select { |request| request.status == 202 }.sum { |request| request.ids.length },
    "highLoadAccepted" => accepted_ids.length,
    "highLoadDropped" => dropped,
    "retryBodyDigest" => Digest::SHA256.hexdigest(retry_requests.fetch(0).body),
    "restartPreviewDigest" => restart_preview_digest,
    "states" => %w[idle running retrying paused stopped closing closed]
  )
ensure
  intake.close
end
RUBY

if ! env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  GEM_HOME="$gem_home" GEM_PATH="$gem_home" \
  ruby "$tmp_dir/proof.rb" > "$stdout_file" 2> "$stderr_file"; then
  sed -E 's#(/[^ :]+)+/proof\.rb#proof.rb#g' "$stderr_file" >&2
  exit 1
fi

proof_counts="$(ruby -rjson -e '
  payload = JSON.parse(File.read(ARGV.fetch(0)))
  raise unless payload.fetch("ok") == true
  raise unless payload.fetch("requests") == 21
  raise unless payload.fetch("acceptedEvents") == 1_012
  raise unless payload.fetch("highLoadAccepted") == 1_000
  raise unless payload.fetch("highLoadDropped") == 500
  raise unless payload.fetch("states") == %w[idle running retrying paused stopped closing closed]
  print "#{payload.fetch("requests")} #{payload.fetch("acceptedEvents")}"
' "$stdout_file")"
read -r proof_requests proof_accepted_events <<< "$proof_counts"

test ! -s "$stderr_file"
if grep -Eqi 'installed-proof-api-key|Bearer|authorization|private|/Users/|127\.0\.0\.1|localhost|http://' "$stdout_file"; then
  echo "automatic delivery proof output leaked sensitive data" >&2
  exit 1
fi

printf 'ruby automatic delivery installed smoke passed version=%s sha256=%s requests=%s acceptedEvents=%s\n' \
  "$package_version" "$gem_digest" "$proof_requests" "$proof_accepted_events"
