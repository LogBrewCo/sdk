#!/usr/bin/env bash
set -Eeuo pipefail

# shellcheck source=ruby_smoke_package.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ruby_smoke_package.sh"
ruby_smoke_create_tmp_dir
ruby_smoke_prepare_package

base_home="$tmp_dir/base-gems"
ruby_smoke_install_local "$base_home"
GEM_HOME="$base_home" GEM_PATH="$base_home" ruby -e '
  require "logbrew"
  abort "core API missing" unless LogBrew::Client.respond_to?(:create)
  abort "HTTP wrapper missing" unless LogBrew::HttpClientTracing.respond_to?(:wrap_net_http)
  abort "unexpected Faraday package" unless Gem::Specification.find_all_by_name("faraday").empty?
  abort "unexpected Faraday adapter package" unless Gem::Specification.find_all_by_name("faraday-net_http").empty?
' > "$tmp_dir/base-consumer.out"
test ! -s "$tmp_dir/base-consumer.out"

integration_home="$tmp_dir/integration-gems"
mkdir -p "$integration_home"
GEM_HOME="$integration_home" GEM_PATH="$integration_home" gem install --no-document --install-dir "$integration_home" net-http -v 0.1.1 >/dev/null
GEM_HOME="$integration_home" GEM_PATH="$integration_home" gem install --no-document --install-dir "$integration_home" base64 -v 0.1.1 >/dev/null
GEM_HOME="$integration_home" GEM_PATH="$integration_home" gem install --no-document --install-dir "$integration_home" ruby2_keywords -v 0.0.5 >/dev/null
GEM_HOME="$integration_home" GEM_PATH="$integration_home" gem install --ignore-dependencies --no-document --install-dir "$integration_home" faraday -v 2.8.1 >/dev/null
GEM_HOME="$integration_home" GEM_PATH="$integration_home" gem install --ignore-dependencies --no-document --install-dir "$integration_home" faraday-net_http -v 3.0.2 >/dev/null
GEM_HOME="$integration_home" GEM_PATH="$integration_home" ruby "$package_dir/tests/http_client_tracing.rb" > "$tmp_dir/focused-tests.out"
grep -qx 'ruby HTTP client tracing tests ok (28 tests)' "$tmp_dir/focused-tests.out"
GEM_HOME="$integration_home" GEM_PATH="$integration_home" gem install --local --install-dir "$integration_home" --no-document "$gem_path" >/dev/null

cat > "$tmp_dir/consumer.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "rubygems"
gem "net-http", "= 0.1.1"
gem "faraday", "= 2.8.1"
gem "faraday-net_http", "= 3.0.2"
require "net/http"
require "logbrew"
require "logbrew/faraday_tracing"
require "timeout"
require "uri"
require ENV.fetch("LOGBREW_TEST_INTAKE")

abort "unexpected Faraday version" unless Faraday::VERSION == "2.8.1"
abort "unexpected Faraday adapter version" unless Gem.loaded_specs.fetch("faraday-net_http").version.to_s == "3.0.2"
abort "unexpected Net::HTTP package version" unless Gem.loaded_specs.fetch("net-http").version.to_s == "0.1.1"

intake = LocalHttpIntake.new(host: "localhost", path: "") do |record|
  route = record.path.split("?", 2).first
  [route == "/faraday" ? 201 : 202, route == "/v1/events" ? "" : "app-response"]
end
begin
  client = LogBrew::Client.create(
    api_key: "package-smoke-key",
    sdk_name: "installed-http-app",
    sdk_version: ENV.fetch("LOGBREW_RUBY_PACKAGE_VERSION")
  )
  parent = LogBrew::Trace.create(
    trace_id: "11111111111111111111111111111111",
    span_id: "2222222222222222",
    trace_flags: "01"
  )
  uri = URI(intake.endpoint)
  net_http = LogBrew::HttpClientTracing.wrap_net_http(Net::HTTP.new(uri.host, uri.port), client: client)
  net_request = Net::HTTP::Get.new("/net?debug=omitted")
  net_request["traceparent"] = "caller-net"
  faraday = Faraday.new(intake.endpoint) do |builder|
    builder.use LogBrew::FaradayTracingMiddleware, client: client
    builder.adapter :net_http
  end

  net_response = nil
  faraday_response = nil
  LogBrew::Trace.with_context(parent) do
    net_response = net_http.request(net_request)
    faraday_response = faraday.get("/faraday?debug=omitted") do |request|
      request.headers["traceparent"] = "caller-faraday"
    end
  end

  abort "Net::HTTP response changed" unless net_response.code == "202" && net_response.body == "app-response"
  abort "Faraday response changed" unless faraday_response.status == 201 && faraday_response.body == "app-response"
  abort "Net::HTTP caller header changed" unless net_request["traceparent"] == "caller-net"
  abort "Faraday caller header changed" unless faraday_response.env.request_headers["traceparent"] == "caller-faraday"

  preview = JSON.parse(client.preview_json)
  spans = preview.fetch("events").map { |event| event.fetch("attributes") }
  abort "span count mismatch" unless spans.length == 2
  abort "trace mismatch" unless spans.all? { |span| span.fetch("traceId") == parent.trace_id }
  abort "parent mismatch" unless spans.all? { |span| span.fetch("parentSpanId") == parent.span_id }
  abort "child mismatch" unless spans.map { |span| span.fetch("spanId") }.uniq.length == 2
  abort "source mismatch" unless spans.map { |span| span.fetch("metadata").fetch("source") }.sort == %w[faraday net_http]
  abort "host mismatch" unless spans.all? { |span| span.fetch("metadata").fetch("host") == "localhost" }

  app_records = 2.times.map { Timeout.timeout(3) { intake.records.pop } }
  app_headers = app_records.map { |record| record.headers.fetch("traceparent") }
  abort "propagation mismatch" unless app_headers.map { |value| value.split("-")[1] }.uniq == [parent.trace_id] &&
    app_headers.map { |value| value.split("-")[2] }.sort == spans.map { |span| span.fetch("spanId") }.sort

  transport = LogBrew::HttpTransport.new(endpoint: "#{intake.endpoint}/v1/events", http_client: net_http)
  LogBrew::Trace.with_context(parent) { client.flush(transport) }
  intake_record = Timeout.timeout(3) { intake.records.pop }
  abort "intake request mismatch" unless intake_record.path == "/v1/events" &&
    !intake_record.headers.key?("traceparent") && JSON.parse(intake_record.body).fetch("events").length == 2
  abort "pending events remain" unless client.pending_events.zero?

  serialized = JSON.generate(spans)
  %w[/net /faraday debug omitted caller-net caller-faraday package-smoke-key app-response].each do |value|
    abort "span privacy mismatch" if serialized.include?(value)
  end
ensure
  intake.close
end
RUBY

LOGBREW_RUBY_PACKAGE_VERSION="$package_version" LOGBREW_TEST_INTAKE="$package_dir/tests/local_http_intake" \
  GEM_HOME="$integration_home" GEM_PATH="$integration_home" \
  ruby "$tmp_dir/consumer.rb"

printf 'ruby HTTP client tracing installed smoke ok version=%s sha256:%s\n' "$package_version" "$gem_digest"
