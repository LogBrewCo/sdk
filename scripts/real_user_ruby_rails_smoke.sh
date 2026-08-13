#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/ruby/logbrew-ruby"
tmp_dir="$(mktemp -d)"
ruby_bin="${LOGBREW_RUBY_BIN:-}"
rails_version="${LOGBREW_RAILS_SMOKE_VERSION:-8.1.3.1}"

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

"$ruby_bin" -e '
  require "rubygems"
  abort "Ruby 3.2 or newer is required for the current Rails smoke" if Gem::Version.new(RUBY_VERSION) < Gem::Version.new("3.2")
' >/dev/null

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
GEM_HOME="$base_home" GEM_PATH="$base_home" "$ruby_bin" -S gem install \
  --local --install-dir "$base_home" --no-document "$gem_path" >/dev/null
LOGBREW_RUBY_PACKAGE_VERSION="$package_version" \
GEM_HOME="$base_home" GEM_PATH="$base_home" "$ruby_bin" -e '
  require "logbrew-sdk"
  abort "core API missing" unless LogBrew::Client.respond_to?(:create)
  abort "version file missing" unless LogBrew::VERSION == ENV.fetch("LOGBREW_RUBY_PACKAGE_VERSION")
  abort "unexpected Rails dependency" unless Gem::Specification.find_all_by_name("rails").empty?
  abort "unexpected Rails load" if defined?(::Rails)
' > "$tmp_dir/base-consumer.out"
test ! -s "$tmp_dir/base-consumer.out"

integration_home="$tmp_dir/integration-gems"
mkdir -p "$integration_home"
RUBYOPT=-W0 GEM_HOME="$integration_home" GEM_PATH="$integration_home" "$ruby_bin" -S gem install \
  --no-document --install-dir "$integration_home" rails -v "$rails_version" >/dev/null
RUBYOPT=-W0 GEM_HOME="$integration_home" GEM_PATH="$integration_home" "$ruby_bin" -S gem install \
  --local --install-dir "$integration_home" --no-document "$gem_path" >/dev/null

consumer_path="$tmp_dir/consumer.rb"
cat > "$consumer_path" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logger"
require "rack/mock"
require "socket"
require "timeout"

class Intake
  attr_reader :endpoint, :records

  def initialize
    @server = TCPServer.new("127.0.0.1", 0)
    @endpoint = "http://127.0.0.1:#{@server.addr[1]}/v1/events"
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
    @records << [request_line[1], headers, body]
    socket.write("HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
  rescue IOError, Errno::EBADF
    nil
  ensure
    socket&.close unless socket&.closed?
  end
end

intake = Intake.new
begin
  ENV["RAILS_ENV"] = "test"
  ENV["LOGBREW_SERVER_API_KEY"] = "installed-rails-key"
  ENV["LOGBREW_SERVICE_NAME"] = "installed-rails-smoke"
  ENV["LOGBREW_ENVIRONMENT"] = "test"
  ENV["LOGBREW_ENDPOINT"] = intake.endpoint
  ENV["LOGBREW_REQUEST_TIMEOUT_MS"] = "2000"
  ENV["LOGBREW_FLUSH_INTERVAL_MS"] = "60000"
  ENV["LOGBREW_FLUSH_THRESHOLD"] = "1000"

  require "rails"
  require "action_controller/railtie"
  require "logbrew-sdk"

  expected_rails = ENV.fetch("LOGBREW_RAILS_SMOKE_VERSION")
  abort "unexpected Rails version" unless Rails.version == expected_rails
  abort "automatic Railtie missing" unless defined?(LogBrew::RailsRailtie)

  module InstalledRailsSmoke
    class Application < Rails::Application
      config.secret_key_base = "installed-rails-smoke-secret-key-base"
      config.eager_load = false
      config.logger = Logger.new(File::NULL)
      config.hosts.clear
    end
  end

  application = InstalledRailsSmoke::Application
  application.initialize!
  application.routes.draw do
    get "/tools/:id", to: lambda { |environment|
      parameters = environment.fetch("action_dispatch.request.path_parameters")
      ActiveSupport::Notifications.instrument("sql.active_record", sql: "SELECT private_accounts #{parameters.fetch(:id)}") { nil }
      ActiveSupport::Notifications.instrument("cache_read.active_support", key: "opaque-cache", hit: true) { nil }
      ActiveSupport::Notifications.instrument("render_template.action_view", identifier: "/srv/application/app/views/tools/show.html.erb") { nil }
      body = JSON.generate("tool" => parameters.fetch(:id))
      [200, { "content-type" => "application/json", "content-length" => body.bytesize.to_s }, [body]]
    }
    get "/failures/:id", to: lambda { |_environment|
      raise RuntimeError, "opaque escaped error detail"
    }
  end

  runtime = LogBrew::Rails.runtime
  abort "runtime was not installed" if runtime.nil?
  abort "runtime was not enabled" unless runtime.configuration.enabled?
  abort "service configuration changed" unless runtime.configuration.service_name == "installed-rails-smoke"
  middleware_entries = application.middleware.map { |entry| entry.klass }
  abort "request middleware missing" unless middleware_entries.include?(LogBrew::Rails::RequestMiddleware)

  incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  requests = Rack::MockRequest.new(application)
  response = requests.get(
    "/tools/opaque-record-id?session_hint=opaque-query",
    "HTTP_TRACEPARENT" => incoming,
    "HTTP_AUTHORIZATION" => "Bearer opaque-auth"
  )
  abort "application response changed" unless response.status == 200
  abort "application body changed" unless JSON.parse(response.body).fetch("tool") == "opaque-record-id"

  not_found_response = requests.get("/unmatched")
  abort "not-found response changed" unless not_found_response.status == 404

  failed_response = requests.get(
    "/failures/opaque-failure-id?session_hint=opaque-failure-query",
    "HTTP_TRACEPARENT" => incoming,
    "HTTP_AUTHORIZATION" => "Bearer opaque-failure-auth"
  )
  abort "failed application response changed" unless failed_response.status == 500

  Rails.error.report(
    RuntimeError.new("opaque handled error detail"),
    handled: true,
    severity: :warning,
    context: { controller: "tools", user_id: "opaque-user-id" },
    source: "application"
  )

  client = LogBrew::Rails.client
  abort "Rails client missing" if client.nil?
  preview_events = JSON.parse(client.preview_json).fetch("events")
  spans = preview_events.select { |event| event.fetch("type") == "span" }
  request_spans = spans.select { |event| event.dig("attributes", "metadata", "source") == "rails" }
  operation_spans = spans.select { |event| event.dig("attributes", "metadata", "source") == "rails.active_support" }
  issues = preview_events.select { |event| event.fetch("type") == "issue" }
  abort "environment event count changed" unless preview_events.count { |event| event.fetch("type") == "environment" } == 1
  abort "request span count changed" unless request_spans.length == 3
  abort "operation span count changed" unless operation_spans.length == 3
  abort "issue count changed" unless issues.length == 2

  span = request_spans.fetch(0).fetch("attributes")
  abort "route template span changed: #{span.fetch("name").inspect}" unless span.fetch("name") == "GET /tools/:id(.:format)"
  abort "incoming trace changed" unless span.fetch("traceId") == "4bf92f3577b34da6a3ce929d0e0e4736"
  abort "incoming parent changed" unless span.fetch("parentSpanId") == "00f067aa0ba902b7"
  span_context = span.fetch("context")
  span_resource = span_context.fetch("resource")
  abort "typed service context changed" unless span_resource.fetch("service") == { "name" => "installed-rails-smoke" }
  abort "typed deployment context changed" unless span_resource.fetch("deployment") == { "environment" => "test" }
  abort "typed framework context changed" unless span_resource.fetch("framework") == { "name" => "rails", "version" => expected_rails }
  abort "typed runtime context missing" if span_resource.dig("runtime", "name").to_s.empty?
  abort "typed request trace changed" unless span_context.dig("trace", "traceId") == span.fetch("traceId")
  abort "typed request span changed" unless span_context.dig("trace", "spanId") == span.fetch("spanId")
  span_metadata = span.fetch("metadata")
  abort "route metadata changed" unless span_metadata.fetch("http.route") == "/tools/:id(.:format)"
  abort "service metadata changed" unless span_metadata.fetch("service") == "installed-rails-smoke"
  abort "environment metadata changed" unless span_metadata.fetch("environment") == "test"
  abort "operation receipt changed" unless span_metadata.values_at("rails.operations.observed", "rails.operations.captured", "rails.operations.truncated") == [3, 3, false]
  abort "operation trace changed" unless operation_spans.all? do |event|
    attributes = event.fetch("attributes")
    attributes.fetch("traceId") == span.fetch("traceId") && attributes.fetch("parentSpanId") == span.fetch("spanId")
  end
  operation_times = operation_spans.map { |event| Time.iso8601(event.fetch("timestamp")) }
  abort "operation chronology changed" unless operation_times == operation_times.sort
  abort "cache hit missing" unless operation_spans.any? { |event| event.dig("attributes", "metadata", "cache.hit") == true }
  abort "relative template missing" unless operation_spans.any? { |event| event.dig("attributes", "metadata", "view.template") == "tools/show.html.erb" }

  not_found_span = request_spans.find { |event| event.dig("attributes", "metadata", "http.status_code") == 404 }
  abort "not-found span missing" if not_found_span.nil?
  abort "not-found span status changed" unless not_found_span.fetch("attributes").fetch("status") == "ok"

  handled_issue = issues.find do |event|
    event.fetch("attributes").dig("exception", "mechanism", "type") == "rails.error_reporter"
  end&.fetch("attributes")
  abort "handled Rails issue missing" if handled_issue.nil?
  abort "handled issue title changed" unless handled_issue.fetch("title") == "RuntimeError"
  abort "handled issue message became enabled" if handled_issue.key?("message")
  abort "handled marker changed" unless handled_issue.fetch("metadata").fetch("rails.handled") == true
  abort "handled typed mechanism changed" unless handled_issue.fetch("exception") == {
    "type" => "RuntimeError",
    "mechanism" => { "type" => "rails.error_reporter", "handled" => true }
  }

  escaped_issue = issues.find do |event|
    event.fetch("attributes").dig("exception", "mechanism", "type") == "rails.middleware"
  end&.fetch("attributes")
  abort "escaped Rails issue missing" if escaped_issue.nil?
  abort "escaped issue message became enabled" if escaped_issue.key?("message")
  abort "escaped typed mechanism changed" unless escaped_issue.fetch("exception") == {
    "type" => "RuntimeError",
    "mechanism" => { "type" => "rails.middleware", "handled" => false }
  }
  escaped_frames = escaped_issue.fetch("stackFrames")
  abort "escaped Rails frames changed" unless escaped_frames.length.between?(1, 32)
  abort "escaped Rails frame path changed" unless escaped_frames.fetch(0).fetch("filename") == "consumer.rb"
  failed_span = request_spans.find { |event| event.fetch("attributes").fetch("status") == "error" }.fetch("attributes")
  escaped_metadata = escaped_issue.fetch("metadata")
  abort "escaped Rails trace correlation changed" unless escaped_metadata.fetch("traceId") == failed_span.fetch("traceId")
  abort "escaped Rails span correlation changed" unless escaped_metadata.fetch("spanId") == failed_span.fetch("spanId")
  abort "escaped Rails grouping changed" unless escaped_metadata.fetch("issueGroupingKey").match?(
    /\Arails-exception-[0-9a-f]{64}\z/
  )

  serialized = JSON.generate(preview_events)
  %w[
    opaque-record-id opaque-query opaque-auth installed-rails-key
    private_accounts opaque-cache /srv/application
    opaque\ handled\ error\ detail opaque\ escaped\ error\ detail opaque-user-id
    opaque-failure-id opaque-failure-query opaque-failure-auth
  ].each do |forbidden|
    abort "Rails telemetry privacy changed" if serialized.include?(forbidden.tr("\\", " "))
  end

  shutdown_response = LogBrew::Rails.shutdown
  abort "shutdown status changed" unless shutdown_response.status_code == 202
  abort "shutdown idempotency changed" unless LogBrew::Rails.shutdown.equal?(shutdown_response)
  route, headers, body = Timeout.timeout(3) { intake.records.pop }
  abort "intake route changed" unless route == "/v1/events"
  abort "authorization changed" unless headers.fetch("authorization") == "Bearer installed-rails-key"
  delivered = JSON.parse(body).fetch("events")
  abort "delivered event count changed" unless delivered.length == 9
  abort "pending events remain" unless client.pending_events.zero?

  puts "installed Rails consumer ok requests=3 operations=3 issues=2 environments=1"
ensure
  intake.close
end
RUBY

LOGBREW_RUBY_PACKAGE_VERSION="$package_version" \
LOGBREW_RAILS_SMOKE_VERSION="$rails_version" \
RUBYOPT=-W0 \
GEM_HOME="$integration_home" GEM_PATH="$integration_home" \
  "$ruby_bin" "$consumer_path" > "$tmp_dir/consumer.out"
grep -qx 'installed Rails consumer ok requests=3 operations=3 issues=2 environments=1' "$tmp_dir/consumer.out"

printf 'ruby Rails installed smoke ok version=%s rails=%s sha256:%s requests=3 operations=3 issues=2 environments=1\n' \
  "$package_version" "$rails_version" "$gem_digest"
