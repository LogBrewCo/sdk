#!/usr/bin/env bash
set -Eeuo pipefail

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-rubygems-public.XXXXXX")"

version="${1:-${LOGBREW_RUBYGEMS_VERSION:-0.1.0}}"
source_url="https://rubygems.org"

on_error() {
  local status=$?
  echo "real_user_rubygems_public_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
  for diagnostic in \
    "$tmp_dir/gem-env.txt" \
    "$tmp_dir/gem-list.txt" \
    "$tmp_dir/spec.yaml" \
    "$tmp_dir/readme-example.stdout.json" \
    "$tmp_dir/readme-example.stderr.json" \
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

puts JSON.generate(
  gem_version: spec.version.to_s,
  flush_status: response.status_code,
  flush_attempts: response.attempts,
  recorded_bodies: transport.sent_bodies.length,
  logger: LogBrew::Logger < ::Logger,
  rack_middleware: LogBrew::RackMiddleware.instance_methods.include?(:call),
  rails_subscriber: LogBrew::RailsErrorSubscriber.instance_methods.include?(:report)
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
RUBY

gem_dir="$(ruby -e 'require "rubygems"; puts Gem::Specification.find_by_name("logbrew-sdk", ENV.fetch("EXPECTED_LOGBREW_RUBYGEMS_VERSION")).gem_dir')"
test -f "$gem_dir/README.md"
test -f "$gem_dir/lib/logbrew.rb"
test -f "$gem_dir/examples/readme_example.rb"
test -f "$gem_dir/examples/real_user_smoke.rb"

ruby "$gem_dir/examples/readme_example.rb" > "$tmp_dir/readme-example.stdout.json" 2> "$tmp_dir/readme-example.stderr.json"
ruby "$gem_dir/examples/real_user_smoke.rb" > "$tmp_dir/real-user-smoke.stdout.json" 2> "$tmp_dir/real-user-smoke.stderr.json"

ruby -rjson - "$tmp_dir/readme-example.stdout.json" "$tmp_dir/readme-example.stderr.json" "$tmp_dir/real-user-smoke.stdout.json" "$tmp_dir/real-user-smoke.stderr.json" <<'RUBY'
readme_stdout, readme_stderr, smoke_stdout, smoke_stderr = ARGV
readme_payload = JSON.parse(File.read(readme_stdout))
readme_status = JSON.parse(File.read(readme_stderr))
smoke_payload = JSON.parse(File.read(smoke_stdout))
smoke_status = JSON.parse(File.read(smoke_stderr))
raise "expected readme batch sdk" unless readme_payload.fetch("sdk").fetch("language") == "ruby"
raise "expected readme example events" unless readme_payload.fetch("events").length >= 1
raise "expected readme local ok" unless readme_status.fetch("ok") == true
raise "expected smoke batch sdk" unless smoke_payload.fetch("sdk").fetch("language") == "ruby"
raise "expected smoke example events" unless smoke_payload.fetch("events").length >= 1
raise "expected smoke retry attempts" unless smoke_status.fetch("retryAttempts") == 2
RUBY

echo "ruby public RubyGems install smoke passed"
