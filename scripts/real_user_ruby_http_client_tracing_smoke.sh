#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/ruby/logbrew-ruby"
tmp_dir="$(mktemp -d)"
package_version="$(
  cd "$package_dir"
  ruby -e 'spec = Gem::Specification.load("logbrew-sdk.gemspec") or abort "invalid gemspec"; print spec.version'
)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

gem_path="$tmp_dir/logbrew-sdk-${package_version}.gem"
(cd "$package_dir" && gem build logbrew-sdk.gemspec --strict --output "$gem_path" >/dev/null)
gem_digest="$(shasum -a 256 "$gem_path" | awk '{print $1}')"
test -n "$gem_digest"

base_home="$tmp_dir/base-gems"
mkdir -p "$base_home"
GEM_HOME="$base_home" GEM_PATH="$base_home" gem install --local --install-dir "$base_home" --no-document "$gem_path" >/dev/null
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
require "socket"
require "timeout"
require "uri"

abort "unexpected Faraday version" unless Faraday::VERSION == "2.8.1"
abort "unexpected Faraday adapter version" unless Gem.loaded_specs.fetch("faraday-net_http").version.to_s == "3.0.2"
abort "unexpected Net::HTTP package version" unless Gem.loaded_specs.fetch("net-http").version.to_s == "0.1.1"

Record = Struct.new(:path, :headers, :body, keyword_init: true)

class Intake
  attr_reader :endpoint, :records

  def initialize
    @server = TCPServer.new("127.0.0.1", 0)
    @endpoint = "http://localhost:#{@server.addr[1]}"
    @records = Queue.new
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
      handle(socket)
    end
  rescue IOError, Errno::EBADF
    nil
  end

  def handle(socket)
    request_line = socket.gets.to_s.strip.split(" ")
    headers = {}
    while (line = socket.gets)
      stripped = line.chomp
      break if stripped.empty?

      name, value = stripped.split(":", 2)
      headers[name.to_s.downcase] = value.to_s.strip
    end
    body = socket.read(headers.fetch("content-length", "0").to_i).to_s
    request_target = request_line[1]
    route = request_target.to_s.split("?", 2)[0]
    @records << Record.new(path: request_target, headers: headers, body: body)
    status = route == "/faraday" ? 201 : 202
    payload = route == "/v1/events" ? "" : "app-response"
    socket.write("HTTP/1.1 #{status} OK\r\nContent-Length: #{payload.bytesize}\r\nConnection: close\r\n\r\n#{payload}")
  ensure
    socket.close unless socket.closed?
  end
end

intake = Intake.new
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
  abort "propagation mismatch" unless app_headers.map { |value| value.split("-")[1] }.uniq == [parent.trace_id]
  abort "child propagation mismatch" unless app_headers.map { |value| value.split("-")[2] }.sort == spans.map { |span| span.fetch("spanId") }.sort

  transport = LogBrew::HttpTransport.new(endpoint: "#{intake.endpoint}/v1/events", http_client: net_http)
  LogBrew::Trace.with_context(parent) { client.flush(transport) }
  intake_record = Timeout.timeout(3) { intake.records.pop }
  abort "intake route mismatch" unless intake_record.path == "/v1/events"
  abort "SDK request was traced" if intake_record.headers.key?("traceparent")
  abort "intake event mismatch" unless JSON.parse(intake_record.body).fetch("events").length == 2
  abort "pending events remain" unless client.pending_events.zero?

  serialized = JSON.generate(spans)
  %w[/net /faraday debug omitted caller-net caller-faraday package-smoke-key app-response].each do |value|
    abort "span privacy mismatch" if serialized.include?(value)
  end
  puts "installed Ruby HTTP tracing ok requests=3 spans=2"
ensure
  intake.close
end
RUBY

LOGBREW_RUBY_PACKAGE_VERSION="$package_version" GEM_HOME="$integration_home" GEM_PATH="$integration_home" \
  ruby "$tmp_dir/consumer.rb" > "$tmp_dir/integration-consumer.out"
grep -qx 'installed Ruby HTTP tracing ok requests=3 spans=2' "$tmp_dir/integration-consumer.out"

printf 'ruby HTTP client tracing installed smoke ok version=%s sha256:%s\n' "$package_version" "$gem_digest"
