#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/ruby/logbrew-ruby"
tmp_dir="$(mktemp -d)"
package_version="$(
  cd "$package_dir"
  ruby -e 'spec = Gem::Specification.load("logbrew-sdk.gemspec") or abort "failed to load logbrew-sdk.gemspec"; print spec.version'
)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

find "$package_dir" -name '*.rb' -not -path '*/.bundle/*' -print0 | while IFS= read -r -d '' file; do
  ruby -w -c "$file" >/dev/null
done

(cd "$package_dir" && ruby tests/run.rb)
rdoc --quiet --op "$tmp_dir/rdoc" "$package_dir/lib/logbrew.rb" "$package_dir/lib/logbrew/support_ticket.rb"
test -f "$tmp_dir/rdoc/LogBrew/Client.html"
test -f "$tmp_dir/rdoc/LogBrew/Logger.html"
test -f "$tmp_dir/rdoc/LogBrew/RackMiddleware.html"
test -f "$tmp_dir/rdoc/LogBrew/RailsErrorSubscriber.html"
test -f "$tmp_dir/rdoc/LogBrew/HttpTransport.html"
test -f "$tmp_dir/rdoc/LogBrew/RecordingTransport.html"
test -f "$tmp_dir/rdoc/LogBrew/SdkError.html"
test -f "$tmp_dir/rdoc/LogBrew/SupportTicketDraft.html"

(cd "$package_dir" && gem build logbrew-sdk.gemspec --strict --output "$tmp_dir/logbrew-sdk-${package_version}.gem" >/dev/null)
test -f "$tmp_dir/logbrew-sdk-${package_version}.gem"
gem specification "$tmp_dir/logbrew-sdk-${package_version}.gem" --yaml > "$tmp_dir/spec.yaml"
grep -q '^name: logbrew-sdk$' "$tmp_dir/spec.yaml"
grep -q '^version: !ruby/object:Gem::Version$' "$tmp_dir/spec.yaml"
grep -q '^summary: Public LogBrew Ruby SDK$' "$tmp_dir/spec.yaml"

gem unpack "$tmp_dir/logbrew-sdk-${package_version}.gem" --target "$tmp_dir/unpacked" >/dev/null
unpacked_dir="$tmp_dir/unpacked/logbrew-sdk-${package_version}"
test -f "$unpacked_dir/lib/logbrew.rb"
test -f "$unpacked_dir/lib/logbrew/trace.rb"
test -f "$unpacked_dir/lib/logbrew/support_ticket.rb"
test -f "$unpacked_dir/README.md"
test -f "$unpacked_dir/examples/readme_example.rb"
test -f "$unpacked_dir/examples/real_user_smoke.rb"
test -f "$unpacked_dir/examples/http_trace_correlation.rb"
test -f "$unpacked_dir/examples/Makefile"
grep -q 'gem install logbrew-sdk' "$unpacked_dir/README.md"
grep -q 'LOGBREW_API_KEY' "$unpacked_dir/README.md"
grep -q 'preview_json' "$unpacked_dir/README.md"
grep -q 'client.metric' "$unpacked_dir/README.md"
grep -q 'Metric' "$unpacked_dir/README.md"
grep -q 'LogBrew::HttpTransport' "$unpacked_dir/README.md"
grep -q 'Net::HTTP' "$unpacked_dir/README.md"
grep -q 'LogBrew::Logger' "$unpacked_dir/README.md"
grep -q 'LogBrew::Trace.current' "$unpacked_dir/README.md"
grep -q 'HTTP Request Trace Correlation' "$unpacked_dir/README.md"
grep -q 'LogBrew::RackMiddleware' "$unpacked_dir/README.md"
grep -q 'Rack And Rails Middleware' "$unpacked_dir/README.md"
grep -q 'LogBrew::RailsErrorSubscriber' "$unpacked_dir/README.md"
grep -q 'Rails Error Subscriber' "$unpacked_dir/README.md"
grep -q 'Rails.error.subscribe' "$unpacked_dir/README.md"
grep -q 'Support Ticket Draft Diagnostics' "$unpacked_dir/README.md"
grep -q 'LogBrew::SupportTicketDraft.create' "$unpacked_dir/README.md"
grep -q 'support-ticket routes' "$unpacked_dir/README.md"
grep -q 'copyable snippets' "$unpacked_dir/README.md"

ruby -I "$package_dir/lib" "$package_dir/examples/readme_example.rb" > "$tmp_dir/readme-example.stdout.json" 2> "$tmp_dir/readme-example.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme-example.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme-example.stderr.json"
grep -q '"events":6' "$tmp_dir/readme-example.stderr.json"

ruby -I "$package_dir/lib" "$package_dir/examples/real_user_smoke.rb" > "$tmp_dir/real-user-smoke.stdout.json" 2> "$tmp_dir/real-user-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/real-user-smoke.stderr.json"
grep -q '"supportDraftRedacted":true' "$tmp_dir/real-user-smoke.stderr.json"
grep -q '"supportDraftTrace":"4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/real-user-smoke.stderr.json"

ruby -I "$package_dir/lib" "$package_dir/examples/http_trace_correlation.rb" > "$tmp_dir/http-trace.stdout.json" 2> "$tmp_dir/http-trace.stderr.json"
python3 "$repo_root/scripts/check_ruby_http_trace_payload.py" "$tmp_dir/http-trace.stdout.json" "$tmp_dir/http-trace.stderr.json" >/dev/null

make -C "$package_dir/examples" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"
grep -qx 'run-first-useful-telemetry -> make run-first-useful-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-http-trace-correlation -> make run-http-trace-correlation' "$tmp_dir/examples-help.txt"

echo "ruby package checks passed"
