#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/ruby/logbrew-ruby"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

find "$package_dir" -name '*.rb' -not -path '*/.bundle/*' -print0 | while IFS= read -r -d '' file; do
  ruby -w -c "$file" >/dev/null
done

(cd "$package_dir" && ruby tests/run.rb)
rdoc --quiet --op "$tmp_dir/rdoc" "$package_dir/lib/logbrew.rb"
test -f "$tmp_dir/rdoc/LogBrew/Client.html"
test -f "$tmp_dir/rdoc/LogBrew/Logger.html"
test -f "$tmp_dir/rdoc/LogBrew/RackMiddleware.html"
test -f "$tmp_dir/rdoc/LogBrew/RailsErrorSubscriber.html"
test -f "$tmp_dir/rdoc/LogBrew/HttpTransport.html"
test -f "$tmp_dir/rdoc/LogBrew/RecordingTransport.html"
test -f "$tmp_dir/rdoc/LogBrew/SdkError.html"

(cd "$package_dir" && gem build logbrew-sdk.gemspec --strict --output "$tmp_dir/logbrew-sdk-0.1.0.gem" >/dev/null)
test -f "$tmp_dir/logbrew-sdk-0.1.0.gem"
gem specification "$tmp_dir/logbrew-sdk-0.1.0.gem" --yaml > "$tmp_dir/spec.yaml"
grep -q '^name: logbrew-sdk$' "$tmp_dir/spec.yaml"
grep -q '^version: !ruby/object:Gem::Version$' "$tmp_dir/spec.yaml"
grep -q '^summary: Public LogBrew Ruby SDK$' "$tmp_dir/spec.yaml"

gem unpack "$tmp_dir/logbrew-sdk-0.1.0.gem" --target "$tmp_dir/unpacked" >/dev/null
unpacked_dir="$tmp_dir/unpacked/logbrew-sdk-0.1.0"
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
grep -q 'cd examples && make run-real-user-smoke' "$unpacked_dir/README.md"

ruby -I "$package_dir/lib" "$package_dir/examples/readme_example.rb" > "$tmp_dir/readme-example.stdout.json" 2> "$tmp_dir/readme-example.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme-example.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme-example.stderr.json"
grep -q '"events":6' "$tmp_dir/readme-example.stderr.json"

ruby -I "$package_dir/lib" "$package_dir/examples/real_user_smoke.rb" > "$tmp_dir/real-user-smoke.stdout.json" 2> "$tmp_dir/real-user-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/real-user-smoke.stderr.json"

make -C "$package_dir/examples" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"

echo "ruby package checks passed"
