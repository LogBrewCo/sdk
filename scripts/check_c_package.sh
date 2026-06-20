#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/c/logbrew-c"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

cc_command="${CC:-}"
if [[ -z "$cc_command" ]]; then
  if command -v clang >/dev/null 2>&1; then
    cc_command="clang"
  else
    cc_command="cc"
  fi
fi

run_examples_make() {
    make --no-print-directory -C "$package_dir/examples"
}

cflags=(-std=c99 -Wall -Wextra -Wpedantic -Werror -I"$package_dir/include")
sdk_sources=("$package_dir/src/logbrew.c" "$package_dir/src/logbrew_metric.c" "$package_dir/src/logbrew_recording_transport.c" "$package_dir/src/logbrew_timeline.c" "$package_dir/src/logbrew_trace.c")

mkdir -p "$tmp_dir/build"
"$cc_command" "${cflags[@]}" "${sdk_sources[@]}" "$package_dir/tests/test_logbrew.c" -o "$tmp_dir/build/test_logbrew"
"$tmp_dir/build/test_logbrew"

if command -v curl-config >/dev/null 2>&1; then
  curl_cflags=()
  curl_libs=()
  curl_cflags_output="$(curl-config --cflags)"
  curl_libs_output="$(curl-config --libs)"
  if [[ -n "$curl_cflags_output" ]]; then
    read -r -a curl_cflags <<<"$curl_cflags_output"
  fi
  if [[ -n "$curl_libs_output" ]]; then
    read -r -a curl_libs <<<"$curl_libs_output"
  fi
  "$cc_command" "${cflags[@]}" ${curl_cflags[@]+"${curl_cflags[@]}"} -DLOGBREW_C_TEST_HTTP_TRANSPORT \
    "${sdk_sources[@]}" "$package_dir/src/logbrew_http_transport.c" "$package_dir/tests/test_logbrew.c" \
    ${curl_libs[@]+"${curl_libs[@]}"} -o "$tmp_dir/build/test_logbrew_http"
  "$tmp_dir/build/test_logbrew_http" >/dev/null
fi

"$cc_command" "${cflags[@]}" "${sdk_sources[@]}" "$package_dir/examples/readme_example.c" -o "$tmp_dir/build/readme_example"
"$tmp_dir/build/readme_example" > "$tmp_dir/readme.stdout.json" 2> "$tmp_dir/readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme.stderr.json"

"$cc_command" "${cflags[@]}" "${sdk_sources[@]}" "$package_dir/examples/real_user_smoke.c" -o "$tmp_dir/build/real_user_smoke"
"$tmp_dir/build/real_user_smoke" > "$tmp_dir/smoke.stdout.json" 2> "$tmp_dir/smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":3' "$tmp_dir/smoke.stderr.json"

"$cc_command" "${cflags[@]}" "${sdk_sources[@]}" "$package_dir/examples/trace_correlation.c" -o "$tmp_dir/build/trace_correlation"
"$tmp_dir/build/trace_correlation" > "$tmp_dir/trace.stdout.json" 2> "$tmp_dir/trace.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/trace.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_c_trace_correlation_payload.py" "$tmp_dir/trace.stdout.json" "$tmp_dir/trace.stderr.json" >/dev/null

run_examples_make > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"
grep -qx 'run-trace-correlation -> make run-trace-correlation' "$tmp_dir/examples-help.txt"

archive="$tmp_dir/logbrew-c-0.1.0.tar.gz"
(cd "$package_dir" && tar -czf "$archive" README.md Makefile include src examples tests)
tar -tzf "$archive" > "$tmp_dir/archive-contents.txt"
grep -qx 'README.md' "$tmp_dir/archive-contents.txt"
grep -qx 'Makefile' "$tmp_dir/archive-contents.txt"
grep -qx 'include/logbrew.h' "$tmp_dir/archive-contents.txt"
grep -qx 'src/logbrew.c' "$tmp_dir/archive-contents.txt"
grep -qx 'src/logbrew_http_transport.c' "$tmp_dir/archive-contents.txt"
grep -qx 'src/logbrew_internal.h' "$tmp_dir/archive-contents.txt"
grep -qx 'src/logbrew_metric.c' "$tmp_dir/archive-contents.txt"
grep -qx 'src/logbrew_recording_transport.c' "$tmp_dir/archive-contents.txt"
grep -qx 'src/logbrew_timeline.c' "$tmp_dir/archive-contents.txt"
grep -qx 'src/logbrew_trace.c' "$tmp_dir/archive-contents.txt"
grep -qx 'examples/readme_example.c' "$tmp_dir/archive-contents.txt"
grep -qx 'examples/real_user_smoke.c' "$tmp_dir/archive-contents.txt"
grep -qx 'examples/trace_correlation.c' "$tmp_dir/archive-contents.txt"
grep -qx 'examples/Makefile' "$tmp_dir/archive-contents.txt"
grep -qx 'tests/test_logbrew.c' "$tmp_dir/archive-contents.txt"

extracted_dir="$tmp_dir/extracted"
mkdir -p "$extracted_dir"
tar -xzf "$archive" -C "$extracted_dir"
make --no-print-directory -C "$extracted_dir" CC="$cc_command"

python3 - "$archive" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    readme = archive.extractfile("README.md").read().decode()
    header = archive.extractfile("include/logbrew.h").read().decode()
readme_needles = (
    "LOGBREW_API_KEY",
    "copy into your own native application",
    "logbrew_client_flush",
    "LogBrewMetricAttributes",
    "logbrew_client_metric",
    "logbrew_client_product_action",
    "logbrew_client_network_milestone",
    "LogBrewOpenTelemetrySpanContext",
    "logbrew_trace_context_from_traceparent",
    "logbrew_trace_context_from_opentelemetry_span_context",
    "logbrew_trace_span_attributes_from_opentelemetry_span_context",
    "logbrew_trace_scope_enter",
    "logbrew_http_transport_init",
)
header_needles = (
    "LOGBREW_C_VERSION",
    "LogBrewClient",
    "LogBrewRecordingTransport",
    "LogBrewMetricAttributes",
    "logbrew_client_metric",
    "LogBrewProductTimelineContext",
    "logbrew_client_product_action",
    "logbrew_client_network_milestone",
    "LogBrewTraceContext",
    "LogBrewOpenTelemetrySpanContext",
    "logbrew_trace_context_from_opentelemetry_span_context",
    "logbrew_trace_span_attributes_from_opentelemetry_span_context",
    "logbrew_trace_current_context",
    "LogBrewHttpTransport",
    "logbrew_http_transport_init",
)
for needle in readme_needles:
    if needle not in readme:
        raise SystemExit(f"missing README guidance: {needle}")
for needle in header_needles:
    if needle not in header:
        raise SystemExit(f"missing public header symbol: {needle}")
PY

echo "c package checks passed with $($cc_command --version | head -n 1)"
