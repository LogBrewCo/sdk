#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-rubygems-public.XXXXXX")"

version="${1:-${LOGBREW_RUBYGEMS_VERSION:-0.1.2}}"
source_url="https://rubygems.org"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"

on_error() {
  local status=$?
  if [[ "$receipt_mode" == "1" ]]; then
    echo "RubyGems release receipt failed" >&2
    exit "$status"
  fi
  echo "real_user_rubygems_public_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
  for diagnostic in \
    "$tmp_dir/gem-env.txt" \
    "$tmp_dir/gem-list.txt" \
    "$tmp_dir/spec.yaml" \
    "$tmp_dir/readme-example.stdout.json" \
    "$tmp_dir/readme-example.stderr.json" \
    "$tmp_dir/first-useful.stdout.json" \
    "$tmp_dir/first-useful.stderr.json" \
    "$tmp_dir/http-trace.stdout.json" \
    "$tmp_dir/http-trace.stderr.json" \
    "$tmp_dir/real-user-smoke.stdout.json" \
    "$tmp_dir/real-user-smoke.stderr.json" \
    "$tmp_dir/proof.json"; do
    if [[ -f "$diagnostic" ]]; then
      echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
      sed -n '1,120p' "$diagnostic" >&2
    fi
  done
  exit "$status"
}

trap 'rm -rf "$tmp_dir"' EXIT
trap on_error ERR

gem_home="$tmp_dir/gems"
mkdir -p "$gem_home"
export GEM_HOME="$gem_home"
export GEM_PATH="$gem_home"

run_receipt_smoke() {
  local bound="$tmp_dir/receipt-artifacts"
  local metadata="$tmp_dir/receipt-metadata.json"
  python3 "$repo_root/scripts/release_artifact_receipt.py" bind \
    --family "rubygems" --output-dir "$bound" --metadata "$metadata" \
    >"$tmp_dir/receipt-bind.out" 2>"$tmp_dir/receipt-bind.err"
  gem install "$bound/0.gem" --local --install-dir "$gem_home" --no-document \
    >"$tmp_dir/receipt-install.out" 2>"$tmp_dir/receipt-install.err"
  EXPECTED_LOGBREW_RUBYGEMS_VERSION="$version" ruby >"$tmp_dir/receipt-run.out" \
    2>"$tmp_dir/receipt-run.err" <<'RUBY'
require "logbrew"
require "rubygems"

version = ENV.fetch("EXPECTED_LOGBREW_RUBYGEMS_VERSION")
spec = Gem::Specification.find_by_name("logbrew-sdk", version)
raise "receipt identity failed" unless spec.version.to_s == version
client = LogBrew::Client.create(api_key: "key", sdk_name: "receipt", sdk_version: "0.1.0")
client.log("event", "2026-01-01T00:00:00Z", { message: "ok", level: "info" })
response = client.shutdown(LogBrew::RecordingTransport.always_accept)
raise "receipt execution failed" unless response.status_code == 202
RUBY
  python3 "$repo_root/scripts/release_artifact_receipt.py" attest \
    --family "rubygems" --metadata "$metadata"
}

if [[ "$receipt_mode" == "1" ]]; then
  run_receipt_smoke
  exit 0
fi

gem env home > "$tmp_dir/gem-env.txt"
gem install logbrew-sdk \
  --version "$version" \
  --source "$source_url" \
  --clear-sources \
  --install-dir "$gem_home" \
  --no-document >/dev/null
gem list --local logbrew-sdk > "$tmp_dir/gem-list.txt"
grep -qx "logbrew-sdk ($version)" "$tmp_dir/gem-list.txt"
gem specification logbrew-sdk -v "$version" --yaml > "$tmp_dir/spec.yaml"
grep -q '^name: logbrew-sdk$' "$tmp_dir/spec.yaml"
grep -q '^summary: Public LogBrew Ruby SDK$' "$tmp_dir/spec.yaml"

export EXPECTED_LOGBREW_RUBYGEMS_VERSION="$version"

cat > "$tmp_dir/prove_public_rubygems_install.rb" <<'RUBY'
# frozen_string_literal: true

require "json"
require "logbrew"
require "rubygems"

expected_version = ENV.fetch("EXPECTED_LOGBREW_RUBYGEMS_VERSION")
spec = Gem::Specification.find_by_name("logbrew-sdk", expected_version)
raise "unexpected gem version #{spec.version}" unless spec.version.to_s == expected_version

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "ruby-public-rubygems-smoke",
  sdk_version: expected_version,
  max_retries: 1
)
client.log(
  "evt_public_rubygems_smoke",
  "2026-07-01T00:00:00Z",
  { message: "public RubyGems smoke", level: "info", metadata: { source: "rubygems" } }
)

transport = LogBrew::RecordingTransport.always_accept
response = client.flush(transport)
raise "expected flush status 202, got #{response.status_code}" unless response.status_code == 202
raise "expected one flush attempt, got #{response.attempts}" unless response.attempts == 1
raise "expected one recorded body" unless transport.sent_bodies.length == 1
raise "expected empty queue after flush" unless client.pending_events.zero?

raise "http transport missing" unless defined?(LogBrew::HttpTransport)
raise "recording transport missing" unless defined?(LogBrew::RecordingTransport)
raise "logger missing" unless LogBrew::Logger < ::Logger
raise "rack middleware missing" unless LogBrew::RackMiddleware.instance_methods.include?(:call)
raise "rails subscriber missing" unless LogBrew::RailsErrorSubscriber.instance_methods.include?(:report)
raise "traceparent parser missing" unless LogBrew::Traceparent.respond_to?(:parse)
raise "trace scope missing" unless LogBrew::Trace.respond_to?(:with_context)
raise "database operation tracing missing" unless LogBrew::OperationTracing.respond_to?(:database_operation)
raise "support ticket draft missing" unless LogBrew::SupportTicketDraft.respond_to?(:create)

operation_client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "ruby-public-rubygems-operation-smoke",
  sdk_version: expected_version
)
parent = LogBrew::Trace.create(trace_id: "11111111111111111111111111111111", span_id: "2222222222222222")
operation_result = LogBrew::Trace.with_context(parent) do
  LogBrew::OperationTracing.database_operation(
    operation_client,
    "users.lookup",
    event_id: "evt_public_rubygems_db_span",
    timestamp: "2026-07-01T00:00:01Z",
    duration_ms: 12.5,
    system: "postgresql",
    operation: "select",
    metadata: {
      service: "api",
      sql: "select * from users where email = ?",
      connectionString: "postgres://placeholder.example/db",
      rowCount: 1
    }
  ) { "ok" }
end
raise "operation tracing result mismatch" unless operation_result == "ok"
operation_span = JSON.parse(operation_client.preview_json).fetch("events").find do |event|
  event.fetch("id") == "evt_public_rubygems_db_span"
end
raise "operation tracing span missing" unless operation_span
operation_metadata = operation_span.fetch("attributes").fetch("metadata")
raise "operation tracing safe metadata missing" unless operation_metadata.fetch("source") == "database.operation"
raise "operation tracing primitive metadata missing" unless operation_metadata.fetch("rowCount") == 1
raise "operation tracing leaked SQL" if operation_metadata.key?("sql") || operation_metadata.key?("connectionString")

support_draft = LogBrew::SupportTicketDraft.create(
  source: "sdk",
  category: "ingest_failure",
  title: "Telemetry flush failed",
  description: "Flush returned usage_limit_exceeded",
  trace_id: "4BF92F3577B34DA6A3CE929D0E0E4736",
  diagnostics: {
    apiKey: "lbw_ingest_hidden",
    endpoint: "https://api.example/ingest?debug=true#frag",
    localPath: "/Users/example/app/.env",
    error: RuntimeError.new("diagnostic detail")
  }
)
support_diagnostics = support_draft.fetch("diagnostics")
raise "support ticket draft trace mismatch" unless support_draft.fetch("trace_id") == "4bf92f3577b34da6a3ce929d0e0e4736"
raise "support ticket draft did not redact API key" unless support_diagnostics.fetch("apiKey") == "[redacted]"
raise "support ticket draft did not redact URL" unless support_diagnostics.fetch("endpoint") == "[redacted-url]/ingest"
raise "support ticket draft did not redact local path" unless support_diagnostics.fetch("localPath") == "[redacted-path]"
support_json = JSON.generate(support_draft)
raise "support ticket draft leaked sensitive diagnostics" if support_json.include?("diagnostic detail") || support_json.include?("api.example") || support_json.include?("/Users/example")

puts JSON.generate(
  gem_version: spec.version.to_s,
  flush_status: response.status_code,
  flush_attempts: response.attempts,
  recorded_bodies: transport.sent_bodies.length,
  logger: LogBrew::Logger < ::Logger,
  rack_middleware: LogBrew::RackMiddleware.instance_methods.include?(:call),
  rails_subscriber: LogBrew::RailsErrorSubscriber.instance_methods.include?(:report),
  traceparent: LogBrew::Traceparent.respond_to?(:parse),
  trace_scope: LogBrew::Trace.respond_to?(:with_context),
  operation_tracing: operation_result,
  support_ticket_draft: support_draft.fetch("trace_id")
)
RUBY

ruby "$tmp_dir/prove_public_rubygems_install.rb" | tee "$tmp_dir/proof.json"

ruby -rjson - "$tmp_dir/proof.json" <<'RUBY'
payload = JSON.parse(File.read(ARGV.fetch(0)))
raise "expected flush status 202" unless payload.fetch("flush_status") == 202
raise "expected one flush attempt" unless payload.fetch("flush_attempts") == 1
raise "expected one recorded body" unless payload.fetch("recorded_bodies") == 1
raise "expected logger proof" unless payload.fetch("logger") == true
raise "expected rack middleware proof" unless payload.fetch("rack_middleware") == true
raise "expected rails subscriber proof" unless payload.fetch("rails_subscriber") == true
raise "expected traceparent proof" unless payload.fetch("traceparent") == true
raise "expected trace scope proof" unless payload.fetch("trace_scope") == true
raise "expected operation tracing proof" unless payload.fetch("operation_tracing") == "ok"
raise "expected support ticket draft proof" unless payload.fetch("support_ticket_draft") == "4bf92f3577b34da6a3ce929d0e0e4736"
RUBY

gem_dir="$(ruby -e 'require "rubygems"; puts Gem::Specification.find_by_name("logbrew-sdk", ENV.fetch("EXPECTED_LOGBREW_RUBYGEMS_VERSION")).gem_dir')"
test -f "$gem_dir/README.md"
test -f "$gem_dir/lib/logbrew.rb"
test -f "$gem_dir/lib/logbrew/product_timeline.rb"
test -f "$gem_dir/lib/logbrew/traceparent.rb"
test -f "$gem_dir/lib/logbrew/trace.rb"
test -f "$gem_dir/lib/logbrew/operation_tracing.rb"
test -f "$gem_dir/lib/logbrew/support_ticket.rb"
test -f "$gem_dir/examples/readme_example.rb"
test -f "$gem_dir/examples/real_user_smoke.rb"
test -f "$gem_dir/examples/first_useful_telemetry.rb"
test -f "$gem_dir/examples/http_trace_correlation.rb"
grep -q 'LogBrew::Traceparent' "$gem_dir/README.md"
grep -q 'LogBrew::OperationTracing' "$gem_dir/README.md"
grep -q 'Support Ticket Draft Diagnostics' "$gem_dir/README.md"

ruby "$gem_dir/examples/readme_example.rb" > "$tmp_dir/readme-example.stdout.json" 2> "$tmp_dir/readme-example.stderr.json"
ruby "$gem_dir/examples/first_useful_telemetry.rb" > "$tmp_dir/first-useful.stdout.json" 2> "$tmp_dir/first-useful.stderr.json"
ruby "$gem_dir/examples/http_trace_correlation.rb" > "$tmp_dir/http-trace.stdout.json" 2> "$tmp_dir/http-trace.stderr.json"
ruby "$gem_dir/examples/real_user_smoke.rb" > "$tmp_dir/real-user-smoke.stdout.json" 2> "$tmp_dir/real-user-smoke.stderr.json"

ruby -rjson - "$tmp_dir/readme-example.stdout.json" "$tmp_dir/readme-example.stderr.json" "$tmp_dir/first-useful.stdout.json" "$tmp_dir/first-useful.stderr.json" "$tmp_dir/http-trace.stdout.json" "$tmp_dir/http-trace.stderr.json" "$tmp_dir/real-user-smoke.stdout.json" "$tmp_dir/real-user-smoke.stderr.json" <<'RUBY'
readme_stdout, readme_stderr, first_stdout, first_stderr, http_stdout, http_stderr, smoke_stdout, smoke_stderr = ARGV
readme_payload = JSON.parse(File.read(readme_stdout))
readme_status = JSON.parse(File.read(readme_stderr))
first_payload = JSON.parse(File.read(first_stdout))
first_status = JSON.parse(File.read(first_stderr))
http_payload = JSON.parse(File.read(http_stdout))
http_status = JSON.parse(File.read(http_stderr))
smoke_payload = JSON.parse(File.read(smoke_stdout))
smoke_status = JSON.parse(File.read(smoke_stderr))
raise "expected readme batch sdk" unless readme_payload.fetch("sdk").fetch("language") == "ruby"
raise "expected readme example events" unless readme_payload.fetch("events").length >= 1
raise "expected readme local ok" unless readme_status.fetch("ok") == true
raise "expected first-useful batch sdk" unless first_payload.fetch("sdk").fetch("language") == "ruby"
raise "expected first-useful trace events" unless first_payload.fetch("events").length >= 7
raise "expected first-useful outgoing traceparent" unless first_status.fetch("outgoingTraceparent").start_with?("00-4bf92f3577b34da6a3ce929d0e0e4736-")
raise "expected HTTP trace batch sdk" unless http_payload.fetch("sdk").fetch("language") == "ruby"
raise "expected HTTP trace events" unless http_payload.fetch("events").length >= 7
raise "expected HTTP outgoing traceparent" unless http_status.fetch("outgoingTraceparent").start_with?("00-4bf92f3577b34da6a3ce929d0e0e4736-")
raise "expected smoke batch sdk" unless smoke_payload.fetch("sdk").fetch("language") == "ruby"
raise "expected smoke example events" unless smoke_payload.fetch("events").length >= 1
raise "expected smoke retry attempts" unless smoke_status.fetch("retryAttempts") == 2
raise "expected support ticket draft redaction" unless smoke_status.fetch("supportDraftRedacted") == true
RUBY

echo "ruby public RubyGems install smoke passed for logbrew-sdk ${version}"
