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
require "net/http"
require "rack/mock"
require "timeout"
require "uri"
require ENV.fetch("LOGBREW_TEST_INTAKE")

intake = LocalHttpIntake.new
dependency = LocalHttpIntake.new([503], host: "localhost", path: "/private-dependency")
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
  require "active_job/railtie"
  require "logbrew-sdk"

  expected_rails = ENV.fetch("LOGBREW_RAILS_SMOKE_VERSION")
  abort "Rails integration contract changed" unless Rails.version == expected_rails && defined?(LogBrew::RailsRailtie)

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
      dependency_uri = URI("#{dependency.endpoint}?marker=opaque-outbound-query")
      dependency_request = Net::HTTP::Post.new(dependency_uri)
      dependency_request.body = "opaque-outbound-body"
      dependency_response = Net::HTTP.start(dependency_uri.host, dependency_uri.port) do |http|
        http.request(dependency_request)
      end
      abort "dependency response changed" unless dependency_response.code == "503"
      body = JSON.generate("tool" => parameters.fetch(:id))
      [200, { "content-type" => "application/json", "content-length" => body.bytesize.to_s }, [body]]
    }
    get "/failures/:id", to: lambda { |_environment|
      raise RuntimeError, "opaque escaped error detail"
    }
  end

  class InstalledFailureJob < ActiveJob::Base
    self.queue_adapter = :test
    retry_on RuntimeError, wait: 0, attempts: 2

    def perform(_private_argument)
      raise RuntimeError, "opaque ActiveJob failure detail"
    end
  end

  runtime = LogBrew::Rails.runtime
  middleware_entries = application.middleware.map { |entry| entry.klass }
  abort "runtime contract changed" unless runtime && runtime.configuration.enabled? &&
    runtime.configuration.service_name == "installed-rails-smoke" &&
    middleware_entries.include?(LogBrew::Rails::RequestMiddleware)

  incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  requests = Rack::MockRequest.new(application)
  response = requests.get(
    "/tools/opaque-record-id?session_hint=opaque-query",
    "HTTP_TRACEPARENT" => incoming,
    "HTTP_AUTHORIZATION" => "Bearer opaque-auth"
  )
  dependency_record = Timeout.timeout(3) { dependency.records.pop }
  abort "application or dependency response changed" unless response.status == 200 &&
    JSON.parse(response.body).fetch("tool") == "opaque-record-id" &&
    !dependency_record.headers["traceparent"].to_s.empty?

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

  abort "ActiveJob adapter missing" unless ActiveJob::Base.ancestors.include?(LogBrew::Rails::ActiveJobExtension)
  job_parent = LogBrew::Trace.create(
    trace_id: "5bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "10f067aa0ba902b7",
    trace_flags: "01"
  )
  LogBrew::Trace.with_context(job_parent) { InstalledFailureJob.perform_later("opaque-job-argument") }
  adapter = InstalledFailureJob.queue_adapter
  abort "ActiveJob producer did not enqueue" unless adapter.enqueued_jobs.length == 1
  ActiveJob::Base.execute(adapter.enqueued_jobs.shift)
  abort "ActiveJob retry did not enqueue" unless adapter.enqueued_jobs.length == 1
  terminal_error = begin
    ActiveJob::Base.execute(adapter.enqueued_jobs.shift)
    nil
  rescue RuntimeError => error
    error
  end
  abort "ActiveJob terminal error changed" unless terminal_error&.message == "opaque ActiveJob failure detail"

  client = LogBrew::Rails.client
  abort "Rails client missing" if client.nil?
  preview_events = JSON.parse(client.preview_json).fetch("events")
  spans = preview_events.select { |event| event.fetch("type") == "span" }
  request_spans = spans.select { |event| event.dig("attributes", "metadata", "source") == "rails" }
  operation_spans = spans.select { |event| event.dig("attributes", "metadata", "source") == "rails.active_support" }
  job_spans = spans.select { |event| event.dig("attributes", "metadata", "source") == "rails.active_job" }
  outbound_spans = spans.select { |event| event.dig("attributes", "metadata", "source") == "net_http" }
  issues = preview_events.select { |event| event.fetch("type") == "issue" }
  counts = [preview_events.count { |event| event.fetch("type") == "environment" }, request_spans.length,
            operation_spans.length, job_spans.length, outbound_spans.length, issues.length]
  abort "Rails event counts changed" unless counts == [1, 3, 3, 4, 1, 3]

  span = request_spans.fetch(0).fetch("attributes")
  abort "request span identity changed" unless span.values_at("name", "traceId", "parentSpanId") ==
    ["GET /tools/:id(.:format)", "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"]
  span_context = span.fetch("context")
  span_resource = span_context.fetch("resource")
  abort "typed resource context changed" unless span_resource.values_at("service", "deployment", "framework") == [
    { "name" => "installed-rails-smoke" }, { "environment" => "test" },
    { "name" => "rails", "version" => expected_rails }
  ]
  abort "typed runtime context missing" if span_resource.dig("runtime", "name").to_s.empty?
  abort "typed request correlation changed" unless span_context.fetch("trace").values_at("traceId", "spanId") ==
    span.values_at("traceId", "spanId")
  span_metadata = span.fetch("metadata")
  abort "request metadata changed" unless span_metadata.values_at(
    "http.route", "service", "environment", "rails.operations.observed",
    "rails.operations.captured", "rails.operations.truncated"
  ) == ["/tools/:id(.:format)", "installed-rails-smoke", "test", 3, 3, false]
  abort "operation trace changed" unless operation_spans.all? do |event|
    attributes = event.fetch("attributes")
    attributes.fetch("traceId") == span.fetch("traceId") && attributes.fetch("parentSpanId") == span.fetch("spanId")
  end
  operation_times = operation_spans.map { |event| Time.iso8601(event.fetch("timestamp")) }
  abort "operation evidence changed" unless operation_times == operation_times.sort &&
    operation_spans.any? { |event| event.dig("attributes", "metadata", "cache.hit") == true } &&
    operation_spans.any? { |event| event.dig("attributes", "metadata", "view.template") == "tools/show.html.erb" }
  outbound_span = outbound_spans.fetch(0).fetch("attributes")
  abort "outbound evidence changed" unless outbound_span.values_at("traceId", "parentSpanId", "status", "metadata") == [
    span.fetch("traceId"), span.fetch("spanId"), "error", {
    "method" => "POST", "host" => "localhost", "statusCode" => 503,
    "source" => "net_http", "sampled" => true
  }]

  not_found_span = request_spans.find { |event| event.dig("attributes", "metadata", "http.status_code") == 404 }
  abort "not-found span changed" unless not_found_span&.dig("attributes", "status") == "ok"

  handled_issue = issues.find do |event|
    event.fetch("attributes").dig("exception", "mechanism", "type") == "rails.error_reporter"
  end&.fetch("attributes")
  abort "handled Rails issue changed" unless handled_issue && !handled_issue.key?("message") &&
    handled_issue.fetch("title") == "RuntimeError" && handled_issue.dig("metadata", "rails.handled") == true &&
    handled_issue.fetch("exception") == { "type" => "RuntimeError", "mechanism" => { "type" => "rails.error_reporter", "handled" => true } }

  escaped_issue = issues.find do |event|
    event.fetch("attributes").dig("exception", "mechanism", "type") == "rails.middleware"
  end&.fetch("attributes")
  abort "escaped Rails issue changed" unless escaped_issue && !escaped_issue.key?("message") &&
    escaped_issue.fetch("exception") == { "type" => "RuntimeError", "mechanism" => { "type" => "rails.middleware", "handled" => false } }
  escaped_frames = escaped_issue.fetch("stackFrames")
  abort "escaped Rails frames changed" unless escaped_frames.length.between?(1, 32) &&
    escaped_frames.fetch(0).fetch("filename") == "consumer.rb"
  failed_span = request_spans.find { |event| event.fetch("attributes").fetch("status") == "error" }.fetch("attributes")
  escaped_metadata = escaped_issue.fetch("metadata")
  abort "escaped Rails correlation changed" unless escaped_metadata.values_at("traceId", "spanId") ==
    failed_span.values_at("traceId", "spanId") &&
    escaped_metadata.fetch("issueGroupingKey").match?(/\Arails-exception-[0-9a-f]{64}\z/)

  job_issue = issues.find do |event|
    event.fetch("attributes").dig("exception", "mechanism", "type") == "rails.active_job"
  end&.fetch("attributes")
  abort "ActiveJob evidence changed" unless job_issue &&
    job_spans.all? { |event| event.dig("attributes", "traceId") == job_parent.trace_id } &&
    job_spans.count { |event| event.dig("attributes", "status") == "error" } == 2 &&
    job_spans.map { |event| event.dig("attributes", "metadata", "retryCount") } == [0, 0, 1, 1] &&
    job_issue.dig("metadata", "activeJob.class") == "InstalledFailureJob" &&
    job_issue.fetch("exception") == { "type" => "RuntimeError", "mechanism" => { "type" => "rails.active_job", "handled" => false } }

  serialized = JSON.generate(preview_events)
  %w[
    opaque-record-id opaque-query opaque-auth installed-rails-key
    private_accounts opaque-cache /srv/application
    opaque\ handled\ error\ detail opaque\ escaped\ error\ detail opaque-user-id
    opaque-failure-id opaque-failure-query opaque-failure-auth
    opaque-job-argument opaque\ ActiveJob\ failure\ detail
    private-dependency opaque-outbound-query opaque-outbound-body
  ].each do |forbidden|
    abort "Rails telemetry privacy changed" if serialized.include?(forbidden.tr("\\", " "))
  end

  shutdown_response = LogBrew::Rails.shutdown
  record = Timeout.timeout(3) { intake.records.pop }
  delivered = JSON.parse(record.body).fetch("events")
  abort "delivery contract changed" unless shutdown_response.status_code == 202 &&
    LogBrew::Rails.shutdown.equal?(shutdown_response) && record.path == "/v1/events" &&
    record.headers.fetch("authorization") == "Bearer installed-rails-key" &&
    delivered.length == 15 && client.pending_events.zero?

  puts "installed Rails consumer ok requests=3 operations=3 jobs=4 outbound=1 issues=3 environments=1"
ensure
  dependency.close
  intake.close
end
RUBY

LOGBREW_RUBY_PACKAGE_VERSION="$package_version" \
LOGBREW_RAILS_SMOKE_VERSION="$rails_version" \
LOGBREW_TEST_INTAKE="$package_dir/tests/local_http_intake" \
RUBYOPT=-W0 \
GEM_HOME="$integration_home" GEM_PATH="$integration_home" \
  "$ruby_bin" "$consumer_path" > "$tmp_dir/consumer.out"
grep -qx 'installed Rails consumer ok requests=3 operations=3 jobs=4 outbound=1 issues=3 environments=1' "$tmp_dir/consumer.out"

printf 'ruby Rails installed smoke ok version=%s rails=%s sha256:%s requests=3 operations=3 jobs=4 outbound=1 issues=3 environments=1\n' \
  "$package_version" "$rails_version" "$gem_digest"
