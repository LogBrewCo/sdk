#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/ruby/logbrew-ruby"
tmp_dir="$(mktemp -d)"
ruby_bin="${LOGBREW_RUBY_BIN:-}"

cleanup() {
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

if [[ -z "$ruby_bin" ]]; then
  if [[ -x /opt/homebrew/opt/ruby/bin/ruby ]]; then
    ruby_bin=/opt/homebrew/opt/ruby/bin/ruby
  else
    ruby_bin="$(command -v ruby)"
  fi
fi

"$ruby_bin" -e 'require "rubygems"; abort "Ruby 3.2 or newer is required for the current Sidekiq smoke" if Gem::Version.new(RUBY_VERSION) < Gem::Version.new("3.2")' >/dev/null

package_version="$(
  cd "$package_dir"
  "$ruby_bin" -e 'spec = Gem::Specification.load("logbrew-sdk.gemspec") or abort "invalid gemspec"; print spec.version'
)"
gem_path="$tmp_dir/logbrew-sdk-${package_version}.gem"
(cd "$package_dir" && "$ruby_bin" -S gem build logbrew-sdk.gemspec --strict --output "$gem_path" >/dev/null)
gem_digest="$(shasum -a 256 "$gem_path" | awk '{print $1}')"
test -n "$gem_digest"

base_home="$tmp_dir/base-gems"
mkdir -p "$base_home"
GEM_HOME="$base_home" GEM_PATH="$base_home" "$ruby_bin" -S gem install --local --install-dir "$base_home" --no-document "$gem_path" >/dev/null
GEM_HOME="$base_home" GEM_PATH="$base_home" "$ruby_bin" -e '
  require "logbrew"
  require "logbrew/sidekiq"
  abort "core API missing" unless LogBrew::Client.respond_to?(:create)
  abort "Sidekiq integration missing" unless LogBrew::Sidekiq::Instrumentation.respond_to?(:create)
  abort "unexpected Sidekiq package" unless Gem::Specification.find_all_by_name("sidekiq").empty?
  abort "unexpected framework load" if defined?(::Sidekiq)
' > "$tmp_dir/base-consumer.out"
test ! -s "$tmp_dir/base-consumer.out"

integration_home="$tmp_dir/integration-gems"
mkdir -p "$integration_home"
GEM_HOME="$integration_home" GEM_PATH="$integration_home" "$ruby_bin" -S gem install --no-document --install-dir "$integration_home" sidekiq -v 8.1.6 >/dev/null
GEM_HOME="$integration_home" GEM_PATH="$integration_home" "$ruby_bin" -S gem install --local --install-dir "$integration_home" --no-document "$gem_path" >/dev/null

cat > "$tmp_dir/consumer.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"
require "logbrew/sidekiq"
require "sidekiq"
require "socket"
require "timeout"

abort "unexpected Sidekiq version" unless Sidekiq::VERSION == "8.1.6"

class Intake
  attr_reader :endpoint, :records

  def initialize
    @server = TCPServer.new("127.0.0.1", 0)
    @endpoint = "http://localhost:#{@server.addr[1]}/v1/events"
    @records = Queue.new
    @thread = Thread.new { serve }
  end

  def close
    @server.close unless @server.closed?
    @thread.join(2)
  end

  private

  def serve
    socket = @server.accept
    request_line = socket.gets.to_s.split(" ")
    headers = {}
    while (line = socket.gets)
      value = line.chomp
      break if value.empty?

      name, content = value.split(":", 2)
      headers[name.to_s.downcase] = content.to_s.strip
    end
    body = socket.read(headers.fetch("content-length", "0").to_i)
    @records << [request_line[1], body]
    socket.write("HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
  rescue IOError, Errno::EBADF
    nil
  ensure
    socket&.close unless socket&.closed?
  end
end

intake = Intake.new
begin
  client = LogBrew::Client.create(
    api_key: "installed-sidekiq-key",
    sdk_name: "installed-sidekiq-app",
    sdk_version: ENV.fetch("LOGBREW_RUBY_PACKAGE_VERSION")
  )
  instrumentation = LogBrew::Sidekiq::Instrumentation.create(
    client: client,
    transport: LogBrew::HttpTransport.new(endpoint: intake.endpoint),
    max_retries: 2
  )
  config = Sidekiq::Config.new
  abort "client registration failed" unless instrumentation.register_client(config)
  abort "duplicate client registration changed" if instrumentation.register_client(config)
  abort "server registration failed" unless instrumentation.register_server(config)
  config.client_middleware { |chain| abort "client middleware missing" unless chain.exists?(LogBrew::Sidekiq::ClientMiddleware) }
  config.server_middleware { |chain| abort "server middleware missing" unless chain.exists?(LogBrew::Sidekiq::ServerMiddleware) }

  client_middleware = LogBrew::Sidekiq::ClientMiddleware.new(instrumentation)
  server_middleware = LogBrew::Sidekiq::ServerMiddleware.new(instrumentation)
  parent = LogBrew::Trace.create(trace_id: "1" * 32, span_id: "2" * 16, trace_flags: "01")
  success_job = {
    "class" => "OpaqueWorker",
    "args" => ["opaque-argument"],
    "jid" => "opaque-job-reference",
    "queue" => "opaque-queue",
    "retry" => 2
  }
  app_response = Object.new
  enqueue_result = LogBrew::Trace.with_context(parent) do
    client_middleware.call(nil, success_job, nil, nil) { app_response }
  end
  abort "enqueue result changed" unless enqueue_result.equal?(app_response)
  carrier = success_job.fetch("logbrew")
  abort "carrier shape changed" unless carrier.keys.sort == %w[enqueuedAtMs traceparent version]
  worker_result = server_middleware.call(nil, success_job, nil) { app_response }
  abort "worker result changed" unless worker_result.equal?(app_response)

  failure_job = {
    "class" => "OpaqueWorker",
    "args" => ["opaque-failure-argument"],
    "jid" => "opaque-failure-reference",
    "queue" => "opaque-queue",
    "retry" => false
  }
  LogBrew::Trace.with_context(parent) { client_middleware.call(nil, failure_job, nil, nil) { true } }
  app_error = RuntimeError.new("opaque failure detail")
  raised = nil
  begin
    server_middleware.call(nil, failure_job, nil) { raise app_error }
  rescue RuntimeError => error
    raised = error
  end
  abort "worker exception changed" unless raised.equal?(app_error)

  malformed_job = { "logbrew" => { "version" => 1, "traceparent" => "invalid", "enqueuedAtMs" => -1 } }
  malformed_context = nil
  server_middleware.call(nil, malformed_job, nil) do
    malformed_context = LogBrew::Trace.current
    true
  end
  abort "malformed carrier did not fail closed" unless malformed_context.parent_span_id.nil?

  instrumentation.quiet
  quiet_job = {}
  quiet_result = client_middleware.call(nil, quiet_job, nil, nil) { app_response }
  abort "quiet result changed" unless quiet_result.equal?(app_response)
  abort "quiet middleware changed the job" unless quiet_job.empty?

  response = instrumentation.shutdown
  abort "shutdown status changed" unless response.status_code == 202
  route, body = Timeout.timeout(3) { intake.records.pop }
  abort "intake route changed" unless route == "/v1/events"
  events = JSON.parse(body).fetch("events")
  spans = events.select { |event| event.fetch("type") == "span" }
  issues = events.select { |event| event.fetch("type") == "issue" }
  abort "span count changed" unless spans.length == 5
  abort "issue count changed" unless issues.length == 1
  abort "trace correlation changed" unless spans.first(4).all? { |event| event.fetch("attributes").fetch("traceId") == parent.trace_id }

  serialized = JSON.generate(events)
  %w[OpaqueWorker opaque-argument opaque-job-reference opaque-queue opaque-failure-argument opaque-failure-reference
     opaque\ failure\ detail installed-sidekiq-key].each do |forbidden|
    abort "telemetry privacy changed" if serialized.include?(forbidden.tr("\\", ""))
  end
  abort "pending events remain" unless client.pending_events.zero?
  abort "client removal failed" unless instrumentation.unregister_client(config)
  abort "server removal failed" unless instrumentation.unregister_server(config)
  puts "installed Sidekiq consumer ok requests=1 spans=5 issues=1"
ensure
  intake.close
end
RUBY

LOGBREW_RUBY_PACKAGE_VERSION="$package_version" GEM_HOME="$integration_home" GEM_PATH="$integration_home" \
  "$ruby_bin" "$tmp_dir/consumer.rb" > "$tmp_dir/consumer.out"
grep -qx 'installed Sidekiq consumer ok requests=1 spans=5 issues=1' "$tmp_dir/consumer.out"

printf 'ruby Sidekiq installed smoke ok version=%s sidekiq=8.1.6 sha256:%s requests=1 spans=5 issues=1\n' \
  "$package_version" "$gem_digest"
