#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=ruby_smoke_package.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ruby_smoke_package.sh"
ruby_smoke_create_tmp_dir
ruby_smoke_prepare_package homebrew

"$ruby_bin" -e 'require "rubygems"; abort "Ruby 3.2 or newer is required for the current Sidekiq smoke" if Gem::Version.new(RUBY_VERSION) < Gem::Version.new("3.2")' >/dev/null

base_home="$tmp_dir/base-gems"
ruby_smoke_install_local "$base_home"
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
ruby_smoke_install_local "$integration_home"

cat > "$tmp_dir/consumer.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"
require "logbrew/sidekiq"
require "sidekiq"
require "timeout"
require ENV.fetch("LOGBREW_TEST_INTAKE")

abort "unexpected Sidekiq version" unless Sidekiq::VERSION == "8.1.6"

intake = LocalHttpIntake.new
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
  abort "quiet lifecycle changed" unless quiet_result.equal?(app_response) && quiet_job.empty?

  response = instrumentation.shutdown
  abort "shutdown status changed" unless response.status_code == 202
  record = Timeout.timeout(3) { intake.records.pop }
  abort "intake route changed" unless record.path == "/v1/events"
  events = JSON.parse(record.body).fetch("events")
  spans = events.select { |event| event.fetch("type") == "span" }
  issues = events.select { |event| event.fetch("type") == "issue" }
  abort "signal counts changed" unless [spans.length, issues.length] == [5, 1]
  abort "trace correlation changed" unless spans.first(4).all? { |event| event.fetch("attributes").fetch("traceId") == parent.trace_id }

  serialized = JSON.generate(events)
  %w[OpaqueWorker opaque-argument opaque-job-reference opaque-queue opaque-failure-argument opaque-failure-reference
     opaque\ failure\ detail installed-sidekiq-key].each do |forbidden|
    abort "telemetry privacy changed" if serialized.include?(forbidden.tr("\\", ""))
  end
  abort "shutdown cleanup changed" unless client.pending_events.zero? &&
    instrumentation.unregister_client(config) && instrumentation.unregister_server(config)
ensure
  intake.close
end
RUBY

LOGBREW_RUBY_PACKAGE_VERSION="$package_version" LOGBREW_TEST_INTAKE="$package_dir/tests/local_http_intake" \
  GEM_HOME="$integration_home" GEM_PATH="$integration_home" \
  "$ruby_bin" "$tmp_dir/consumer.rb"

printf 'ruby Sidekiq installed smoke ok version=%s sidekiq=8.1.6 sha256:%s requests=1 spans=5 issues=1\n' \
  "$package_version" "$gem_digest"
