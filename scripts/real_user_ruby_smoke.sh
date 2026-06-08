#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/ruby/logbrew-ruby"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

gem_path="$tmp_dir/logbrew-sdk-0.1.0.gem"
(cd "$package_dir" && gem build logbrew-sdk.gemspec --strict --output "$gem_path" >/dev/null)
test -f "$gem_path"

gem specification "$gem_path" --yaml > "$tmp_dir/spec.yaml"
grep -q '^name: logbrew-sdk$' "$tmp_dir/spec.yaml"
grep -q '^summary: Public LogBrew Ruby SDK$' "$tmp_dir/spec.yaml"
grep -q '^required_ruby_version: !ruby/object:Gem::Requirement$' "$tmp_dir/spec.yaml"

gem unpack "$gem_path" --target "$tmp_dir/unpacked" >/dev/null
unpacked_dir="$tmp_dir/unpacked/logbrew-sdk-0.1.0"
test -f "$unpacked_dir/logbrew-sdk.gemspec" || true
test -f "$unpacked_dir/lib/logbrew.rb"
test -f "$unpacked_dir/README.md"
test -f "$unpacked_dir/examples/readme_example.rb"
test -f "$unpacked_dir/examples/real_user_smoke.rb"
test -f "$unpacked_dir/examples/Makefile"
grep -q 'gem install logbrew-sdk' "$unpacked_dir/README.md"
grep -q 'LOGBREW_API_KEY' "$unpacked_dir/README.md"
grep -q 'preview_json' "$unpacked_dir/README.md"
grep -q 'LogBrew::HttpTransport' "$unpacked_dir/README.md"
grep -q 'Net::HTTP' "$unpacked_dir/README.md"
grep -q 'LogBrew::Logger' "$unpacked_dir/README.md"
grep -q 'LogBrew::RackMiddleware' "$unpacked_dir/README.md"
grep -q 'Rack And Rails Middleware' "$unpacked_dir/README.md"
grep -q 'LogBrew::RailsErrorSubscriber' "$unpacked_dir/README.md"
grep -q 'Rails Error Subscriber' "$unpacked_dir/README.md"
grep -q 'Rails.error.subscribe' "$unpacked_dir/README.md"
grep -q 'copyable snippets' "$unpacked_dir/README.md"

make -C "$unpacked_dir/examples" > "$tmp_dir/unpacked-examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/unpacked-examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/unpacked-examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/unpacked-examples-help.txt"
(cd "$unpacked_dir/examples" && RUBYLIB="$unpacked_dir/lib" make run-readme-example) > "$tmp_dir/unpacked-readme.stdout.json" 2> "$tmp_dir/unpacked-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/unpacked-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/unpacked-readme.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/unpacked-readme.stderr.json"
(cd "$unpacked_dir/examples" && RUBYLIB="$unpacked_dir/lib" make run) > "$tmp_dir/unpacked-smoke.stdout.json" 2> "$tmp_dir/unpacked-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/unpacked-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/unpacked-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/unpacked-smoke.stderr.json"

gem_home="$tmp_dir/gems"
mkdir -p "$gem_home"
GEM_HOME="$gem_home" GEM_PATH="$gem_home" gem install --local --install-dir "$gem_home" --no-document "$gem_path" >/dev/null
GEM_HOME="$gem_home" GEM_PATH="$gem_home" gem list --local logbrew-sdk > "$tmp_dir/gem-list.txt"
grep -q '^logbrew-sdk (0.1.0)$' "$tmp_dir/gem-list.txt"
GEM_HOME="$gem_home" GEM_PATH="$gem_home" ruby -e 'require "logbrew"; puts LogBrew::Client.create(api_key: "LOGBREW_API_KEY", sdk_name: "installed-app", sdk_version: "0.1.0").pending_events' > "$tmp_dir/installed-require.out"
grep -qx '0' "$tmp_dir/installed-require.out"
GEM_HOME="$gem_home" GEM_PATH="$gem_home" ruby -e 'require "logbrew"; puts(LogBrew::Logger < ::Logger)' > "$tmp_dir/installed-logger-class.out"
grep -qx 'true' "$tmp_dir/installed-logger-class.out"
GEM_HOME="$gem_home" GEM_PATH="$gem_home" ruby -e 'require "logbrew"; puts(LogBrew::RackMiddleware.instance_methods.include?(:call))' > "$tmp_dir/installed-rack-middleware.out"
grep -qx 'true' "$tmp_dir/installed-rack-middleware.out"
GEM_HOME="$gem_home" GEM_PATH="$gem_home" ruby -e 'require "logbrew"; puts(LogBrew::RailsErrorSubscriber.instance_methods.include?(:report))' > "$tmp_dir/installed-rails-subscriber.out"
grep -qx 'true' "$tmp_dir/installed-rails-subscriber.out"
gem_dir="$(GEM_HOME="$gem_home" GEM_PATH="$gem_home" ruby -e 'require "rubygems"; puts Gem::Specification.find_by_name("logbrew-sdk").gem_dir')"
test -f "$gem_dir/README.md"
test -f "$gem_dir/examples/readme_example.rb"
test -f "$gem_dir/examples/real_user_smoke.rb"
test -f "$gem_dir/examples/Makefile"
grep -q 'LogBrew::RackMiddleware' "$gem_dir/README.md"
grep -q 'Rack And Rails Middleware' "$gem_dir/README.md"
grep -q 'LogBrew::RailsErrorSubscriber' "$gem_dir/README.md"
grep -q 'Rails Error Subscriber' "$gem_dir/README.md"
grep -q 'Rails.error.subscribe' "$gem_dir/README.md"

GEM_HOME="$gem_home" GEM_PATH="$gem_home" ruby "$gem_dir/examples/readme_example.rb" > "$tmp_dir/installed-readme.stdout.json" 2> "$tmp_dir/installed-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/installed-readme.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/installed-readme.stderr.json"
GEM_HOME="$gem_home" GEM_PATH="$gem_home" ruby "$gem_dir/examples/real_user_smoke.rb" > "$tmp_dir/installed-smoke.stdout.json" 2> "$tmp_dir/installed-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/installed-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/installed-smoke.stderr.json"
(cd "$gem_dir/examples" && GEM_HOME="$gem_home" GEM_PATH="$gem_home" make) > "$tmp_dir/installed-examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/installed-examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/installed-examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/installed-examples-help.txt"

GEM_HOME="$gem_home" GEM_PATH="$gem_home" gem uninstall logbrew-sdk --all --executables --ignore-dependencies --force >/dev/null
GEM_HOME="$gem_home" GEM_PATH="$gem_home" gem list --local logbrew-sdk > "$tmp_dir/removed-gem-list.txt"
if grep -q '^logbrew-sdk ' "$tmp_dir/removed-gem-list.txt"; then
  echo "expected gem list to omit SDK after uninstall" >&2
  exit 1
fi
removed_app="$tmp_dir/removed-app"
mkdir -p "$removed_app"
if (cd "$removed_app" && GEM_HOME="$gem_home" GEM_PATH="$gem_home" ruby -e 'require "logbrew"') 2> "$tmp_dir/removed-require.err"; then
  echo "expected require to fail after gem uninstall" >&2
  exit 1
fi
test -s "$tmp_dir/removed-require.err"
GEM_HOME="$gem_home" GEM_PATH="$gem_home" gem install --local --install-dir "$gem_home" --no-document "$gem_path" >/dev/null

app_dir="$tmp_dir/smoke-app"
mkdir -p "$app_dir"
cat > "$app_dir/main.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"
require "socket"

def enqueue_all(client)
  client.release("evt_release_001", "2026-06-02T10:00:00Z", version: "1.2.3", commit: "abc123def456", notes: "Public release marker")
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", name: "production", region: "global")
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", title: "Checkout timeout", level: "error", message: "Request timed out after retry budget")
  client.log("evt_log_001", "2026-06-02T10:00:03Z", message: "worker started", level: "info", logger: "job-runner")
  client.span("evt_span_001", "2026-06-02T10:00:04Z", name: "GET /health", traceId: "trace_001", spanId: "span_001", status: "ok", durationMs: 12.5)
  client.action("evt_action_001", "2026-06-02T10:00:05Z", name: "deploy", status: "success")
end

def client(max_retries: 2)
  LogBrew::Client.create(api_key: "LOGBREW_API_KEY", sdk_name: "smoke-app", sdk_version: "0.1.0", max_retries: max_retries)
end

def expect(code)
  yield
rescue LogBrew::SdkError => error
  raise "expected #{code}, got #{error.code}" unless error.code == code
  return
end

class LocalHttpIntake
  attr_reader :endpoint, :last_method, :last_path, :last_authorization, :last_content_type, :last_source, :last_body,
              :bodies, :request_count

  def initialize(statuses = [202])
    @server = TCPServer.new("127.0.0.1", 0)
    @endpoint = "http://127.0.0.1:#{@server.addr[1]}/v1/events"
    @statuses = statuses.dup
    @bodies = []
    @request_count = 0
    @closed = false
    @thread = Thread.new { accept_loop }
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
    request_line = socket.gets.to_s.strip
    parts = request_line.split(" ")
    @last_method = parts[0].to_s
    @last_path = parts[1].to_s

    headers = {}
    while (line = socket.gets)
      stripped = line.chomp
      break if stripped.empty?

      name, value = stripped.split(":", 2)
      headers[name.downcase] = value.to_s.strip if name && value
    end

    body = socket.read(headers.fetch("content-length", "0").to_i).to_s
    @last_body = body
    @bodies << body
    @last_authorization = headers.fetch("authorization", "")
    @last_content_type = headers.fetch("content-type", "")
    @last_source = headers.fetch("x-logbrew-source", "")
    @request_count += 1

    status = @statuses.empty? ? 202 : @statuses.shift
    reason = status == 503 ? "Service Unavailable" : "Accepted"
    socket.write("HTTP/1.1 #{status} #{reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
  end
end

happy = client
enqueue_all(happy)
puts happy.preview_json
response = happy.flush(LogBrew::RecordingTransport.always_accept)
raise "unexpected flush" unless response.status_code == 202 && response.attempts == 1 && happy.pending_events.zero?
empty = happy.flush(LogBrew::RecordingTransport.always_accept)
raise "unexpected empty flush" unless empty.status_code == 204 && empty.attempts.zero?

expect("validation_error") { happy.log("evt_bad", "2026-06-02T10:00:03", message: "worker started", level: "info") }

unauthenticated = client
enqueue_all(unauthenticated)
expect("unauthenticated") { unauthenticated.flush(LogBrew::RecordingTransport.new([401])) }
raise "unauthenticated should preserve queue" unless unauthenticated.pending_events == 6

retry_client = client
enqueue_all(retry_client)
retry_response = retry_client.flush(LogBrew::RecordingTransport.new([LogBrew::TransportError.network("temporary outage"), 202]))
raise "expected retry recovery" unless retry_response.attempts == 2

exhausted = client(max_retries: 1)
enqueue_all(exhausted)
expect("network_failure") do
  exhausted.flush(LogBrew::RecordingTransport.new([
    LogBrew::TransportError.network("temporary outage"),
    LogBrew::TransportError.network("still down")
  ]))
end
raise "retry budget should preserve queue" unless exhausted.pending_events == 6

non_retryable = client
enqueue_all(non_retryable)
expect("transport_error") { non_retryable.flush(LogBrew::RecordingTransport.new([400])) }
raise "non-retryable status should preserve queue" unless non_retryable.pending_events == 6

http_attempts = 0
http_requests = 0
intake = LocalHttpIntake.new([503, 202])
begin
  http = client(max_retries: 1)
  http.log("evt_ruby_http", "2026-06-02T10:00:08Z", message: "http delivery", level: "info")
  http_response = http.flush(
    LogBrew::HttpTransport.new(
      endpoint: intake.endpoint,
      headers: { "x-logbrew-source" => "ruby-smoke" },
      timeout: 2
    )
  )
  http_attempts = http_response.attempts
  http_requests = intake.request_count
  raise "expected HTTP delivery status" unless http_response.status_code == 202
  raise "expected HTTP retry recovery" unless http_attempts == 2
  raise "expected two HTTP intake requests" unless http_requests == 2
  raise "expected HTTP delivery to clear queue" unless http.pending_events.zero?
  raise "expected HTTP POST" unless intake.last_method == "POST"
  raise "expected HTTP path" unless intake.last_path == "/v1/events"
  raise "expected HTTP authorization header" unless intake.last_authorization == "Bearer LOGBREW_API_KEY"
  raise "expected HTTP custom header" unless intake.last_source == "ruby-smoke"
  raise "expected HTTP content type" unless intake.last_content_type.start_with?("application/json")
  raise "expected HTTP request body" unless intake.last_body.include?("evt_ruby_http")
  raise "expected retry body capture" unless intake.bodies.length == 2
  raise "expected retry body to stay unchanged" unless intake.bodies[0] == intake.bodies[1]
ensure
  intake.close
end

closed = client
enqueue_all(closed)
closed.shutdown(LogBrew::RecordingTransport.always_accept)
expect("shutdown_error") { closed.action("evt_action_002", "2026-06-02T10:00:06Z", name: "deploy", status: "success") }

logger_client = client
logger = LogBrew::Logger.new(
  client: logger_client,
  logger_name: "checkout",
  event_id_prefix: "installed_ruby_log",
  metadata: { service: "web", ignored: [] },
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 6) },
  progname: "checkout"
)
logger.warn("checkout slow")
logger.add(::Logger::ERROR, RuntimeError.new("payment failed"), "payment")
logger_payload = JSON.parse(logger_client.preview_json)
logger_events = logger_payload.fetch("events")
raise "expected logger event count" unless logger_events.length == 2
raise "expected logger ids" unless logger_events.map { |event| event.fetch("id") } == %w[installed_ruby_log_1 installed_ruby_log_2]
raise "expected logger timestamps" unless logger_events.map { |event| event.fetch("timestamp") }.uniq == ["2026-06-02T10:00:06Z"]
raise "expected logger levels" unless logger_events.map { |event| event.fetch("attributes").fetch("level") } == %w[warning error]
raise "expected logger message" unless logger_events[0].fetch("attributes").fetch("message") == "checkout slow"
raise "expected logger name" unless logger_events[0].fetch("attributes").fetch("logger") == "checkout"
logger_metadata = logger_events[1].fetch("attributes").fetch("metadata")
raise "expected logger metadata" unless logger_metadata.fetch("service") == "web"
raise "expected skipped metadata" if logger_metadata.key?("ignored")
raise "expected Ruby severity" unless logger_metadata.fetch("rubySeverity") == "ERROR"
raise "expected logger progname" unless logger_metadata.fetch("progname") == "payment"
raise "expected exception type" unless logger_metadata.fetch("exceptionType") == "RuntimeError"
raise "expected exception message" unless logger_metadata.fetch("exceptionMessage") == "payment failed"
raise "expected opt-in backtrace" if logger_metadata.key?("exceptionBacktrace")
logger_response = logger.flush_logbrew(LogBrew::RecordingTransport.always_accept)
raise "expected logger flush" unless logger_response.status_code == 202 && logger_client.pending_events.zero?

flush_client = client
flush_transport = LogBrew::RecordingTransport.always_accept
flush_logger = LogBrew::Logger.new(
  client: flush_client,
  event_id_prefix: "installed_flush_log",
  transport: flush_transport,
  flush_on_log: true,
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 7) }
)
flush_logger.info("flush now")
raise "expected flush-on-log" unless flush_client.pending_events.zero? && flush_transport.sent_bodies.length == 1

capture_errors = []
safe_logger = LogBrew::Logger.new(
  client: client,
  timestamp_provider: -> { "not-a-timestamp" },
  on_error: ->(error) { capture_errors << error }
)
safe_logger.info("bad timestamp should not break normal logging")
raise "expected logger capture callback" unless capture_errors.length == 1

rack_client = client
rack_app = lambda { |_env| [201, { "content-type" => "text/plain" }, ["created"]] }
rack = LogBrew::RackMiddleware.new(
  rack_app,
  client: rack_client,
  event_id_prefix: "installed_rack",
  metadata: { service: "web", ignored: [] },
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 9) }
)
rack_response = rack.call(
  "REQUEST_METHOD" => "POST",
  "PATH_INFO" => "/checkout",
  "QUERY_STRING" => "cart=123",
  "rack.url_scheme" => "https",
  "HTTP_X_REQUEST_ID" => "req_123",
  "logbrew.trace_id" => "trace_rack",
  "logbrew.span_id" => "span_rack"
)
raise "expected Rack response passthrough" unless rack_response[0] == 201
rack_payload = JSON.parse(rack_client.preview_json)
rack_events = rack_payload.fetch("events")
raise "expected Rack span event" unless rack_events.length == 1
rack_span = rack_events[0]
raise "expected Rack span id" unless rack_span.fetch("id") == "installed_rack_span_1"
raise "expected Rack timestamp" unless rack_span.fetch("timestamp") == "2026-06-02T10:00:09Z"
rack_attributes = rack_span.fetch("attributes")
raise "expected Rack span name" unless rack_attributes.fetch("name") == "POST /checkout"
raise "expected Rack trace id" unless rack_attributes.fetch("traceId") == "trace_rack"
raise "expected Rack span id attribute" unless rack_attributes.fetch("spanId") == "span_rack"
raise "expected Rack status" unless rack_attributes.fetch("status") == "ok"
raise "expected Rack duration" unless rack_attributes.fetch("durationMs") >= 0
rack_metadata = rack_attributes.fetch("metadata")
raise "expected Rack metadata" unless rack_metadata.fetch("service") == "web"
raise "expected skipped Rack metadata" if rack_metadata.key?("ignored")
raise "expected Rack source" unless rack_metadata.fetch("source") == "rack"
raise "expected Rack method" unless rack_metadata.fetch("http.method") == "POST"
raise "expected Rack path" unless rack_metadata.fetch("http.path") == "/checkout"
raise "expected Rack path without query" if rack_metadata.fetch("http.path").include?("?")
raise "expected Rack status code" unless rack_metadata.fetch("http.status_code") == 201
raise "expected Rack scheme" unless rack_metadata.fetch("rack.url_scheme") == "https"
raise "expected Rack request id" unless rack_metadata.fetch("HTTP_X_REQUEST_ID") == "req_123"

rack_error_client = client
rack_error = LogBrew::RackMiddleware.new(
  lambda { |_env| raise RuntimeError, "checkout failed" },
  client: rack_error_client,
  event_id_prefix: "installed_rack_error",
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 10) }
)
begin
  rack_error.call("REQUEST_METHOD" => "GET", "PATH_INFO" => "/boom", "logbrew.trace_id" => "trace_error", "logbrew.span_id" => "span_error")
  raise "expected Rack app exception"
rescue RuntimeError => error
  raise "expected original Rack error" unless error.message == "checkout failed"
end
rack_error_events = JSON.parse(rack_error_client.preview_json).fetch("events")
raise "expected Rack issue and span" unless rack_error_events.map { |event| event.fetch("type") } == %w[issue span]
raise "expected Rack error ids" unless rack_error_events.map { |event| event.fetch("id") } == %w[installed_rack_error_issue_1 installed_rack_error_span_2]
issue = rack_error_events[0].fetch("attributes")
raise "expected Rack issue title" unless issue.fetch("title") == "RuntimeError"
raise "expected Rack issue message" unless issue.fetch("message") == "checkout failed"
issue_metadata = issue.fetch("metadata")
raise "expected Rack exception type" unless issue_metadata.fetch("exceptionType") == "RuntimeError"
raise "expected Rack exception message" unless issue_metadata.fetch("exceptionMessage") == "checkout failed"
raise "expected opt-in Rack backtrace" if issue_metadata.key?("exceptionBacktrace")
raise "expected Rack error span" unless rack_error_events[1].fetch("attributes").fetch("status") == "error"

rack_flush_client = client
rack_flush_transport = LogBrew::RecordingTransport.always_accept
rack_flush = LogBrew::RackMiddleware.new(
  lambda { |_env| [204, {}, []] },
  client: rack_flush_client,
  transport: rack_flush_transport,
  flush_on_response: true,
  event_id_prefix: "installed_rack_flush",
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 11) }
)
rack_flush.call("REQUEST_METHOD" => "DELETE", "PATH_INFO" => "/cart")
raise "expected Rack flush" unless rack_flush_client.pending_events.zero? && rack_flush_transport.sent_bodies.length == 1

rails_client = client
rails_subscriber = LogBrew::RailsErrorSubscriber.new(
  client: rails_client,
  event_id_prefix: "installed_rails_error",
  metadata: { service: "web", ignored: [] },
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 12) }
)
rails_subscriber.report(
  RuntimeError.new("handled checkout failure"),
  handled: true,
  severity: :warning,
  context: { route: "checkout#create", user_id: 123, ignored: [] },
  source: "checkout.subscriber",
  extra_option: "ignored"
)
rails_events = JSON.parse(rails_client.preview_json).fetch("events")
raise "expected Rails subscriber issue" unless rails_events.length == 1
rails_issue = rails_events[0]
raise "expected Rails subscriber id" unless rails_issue.fetch("id") == "installed_rails_error_1"
raise "expected Rails subscriber timestamp" unless rails_issue.fetch("timestamp") == "2026-06-02T10:00:12Z"
rails_attributes = rails_issue.fetch("attributes")
raise "expected Rails issue title" unless rails_attributes.fetch("title") == "RuntimeError"
raise "expected Rails issue level" unless rails_attributes.fetch("level") == "warning"
raise "expected Rails issue message" unless rails_attributes.fetch("message") == "handled checkout failure"
rails_metadata = rails_attributes.fetch("metadata")
raise "expected Rails metadata" unless rails_metadata.fetch("service") == "web"
raise "expected skipped Rails metadata" if rails_metadata.key?("ignored")
raise "expected Rails source" unless rails_metadata.fetch("source") == "rails.error"
raise "expected Rails handled flag" unless rails_metadata.fetch("rails.handled") == true
raise "expected Rails severity" unless rails_metadata.fetch("rails.severity") == "warning"
raise "expected Rails source option" unless rails_metadata.fetch("rails.source") == "checkout.subscriber"
raise "expected Rails context route" unless rails_metadata.fetch("context.route") == "checkout#create"
raise "expected Rails context user id" unless rails_metadata.fetch("context.user_id") == 123
raise "expected skipped Rails context" if rails_metadata.key?("context.ignored")
raise "expected Rails exception type" unless rails_metadata.fetch("exceptionType") == "RuntimeError"
raise "expected Rails exception message" unless rails_metadata.fetch("exceptionMessage") == "handled checkout failure"
raise "expected opt-in Rails backtrace" if rails_metadata.key?("exceptionBacktrace")

rails_flush_client = client
rails_flush_transport = LogBrew::RecordingTransport.always_accept
rails_flush = LogBrew::RailsErrorSubscriber.new(
  client: rails_flush_client,
  transport: rails_flush_transport,
  flush_on_report: true,
  event_id_prefix: "installed_rails_flush",
  timestamp_provider: -> { Time.utc(2026, 6, 2, 10, 0, 13) }
)
rails_flush.report(RuntimeError.new("flush me"), handled: false, severity: :error, source: "smoke")
raise "expected Rails flush" unless rails_flush_client.pending_events.zero? && rails_flush_transport.sent_bodies.length == 1

$stderr.puts JSON.generate(
  ok: true,
  status: 202,
  attempts: 1,
  events: 6,
  loggerEvents: 2,
  rackEvents: rack_events.length + rack_error_events.length,
  railsErrorEvents: rails_events.length,
  httpAttempts: http_attempts,
  httpRequests: http_requests
)
RUBY
GEM_HOME="$gem_home" GEM_PATH="$gem_home" ruby "$app_dir/main.rb" > "$tmp_dir/smoke-app.stdout.json" 2> "$tmp_dir/smoke-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke-app.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/smoke-app.stderr.json"
grep -q '"loggerEvents":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"rackEvents":3' "$tmp_dir/smoke-app.stderr.json"
grep -q '"railsErrorEvents":1' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpRequests":2' "$tmp_dir/smoke-app.stderr.json"

echo "ruby real-user smoke passed"
