#!/usr/bin/env bash
set -Eeuo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf '%s\n' "$message" >&2
    exit 1
  fi
}

run_command() {
  local cwd="$1"
  shift

  local stdout_file
  local stderr_file
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"
  if ! (cd "$cwd" && "$@" >"$stdout_file" 2>"$stderr_file"); then
    cat "$stderr_file" >&2
    rm -f "$stdout_file" "$stderr_file"
    printf 'expected command to succeed: %s\n' "$*" >&2
    exit 1
  fi

  cat "$stdout_file"
  printf '\n__LOGBREW_STDERR_SPLIT__\n'
  cat "$stderr_file"
  rm -f "$stdout_file" "$stderr_file"
}

split_output() {
  local combined="$1"
  local stdout_part="${combined%%$'\n'__LOGBREW_STDERR_SPLIT__$'\n'*}"
  local stderr_part="${combined#*$'\n'__LOGBREW_STDERR_SPLIT__$'\n'}"
  printf '%s\n__LOGBREW_STDERR_SPLIT__\n%s' "$stdout_part" "$stderr_part"
}

readme_combined="$(run_command "$package_root" cargo run --quiet --example readme_example)"
readme_split="$(split_output "$readme_combined")"
readme_stdout="${readme_split%%$'\n'__LOGBREW_STDERR_SPLIT__$'\n'*}"
readme_stderr="${readme_split#*$'\n'__LOGBREW_STDERR_SPLIT__$'\n'}"

assert_contains "$readme_stdout" '"type": "release"' 'expected release event in Rust README example output'
assert_contains "$readme_stdout" '"type": "environment"' 'expected environment event in Rust README example output'
assert_contains "$readme_stdout" '"type": "issue"' 'expected issue event in Rust README example output'
assert_contains "$readme_stdout" '"type": "log"' 'expected log event in Rust README example output'
assert_contains "$readme_stdout" '"type": "span"' 'expected span event in Rust README example output'
assert_contains "$readme_stdout" '"type": "action"' 'expected action event in Rust README example output'
assert_contains "$readme_stderr" '"ok":true' 'expected success status in Rust README example stderr'
assert_contains "$readme_stderr" '"events":6' 'expected event count in Rust README example stderr'

real_user_combined="$(run_command "$package_root" cargo run --quiet --example real_user_smoke)"
real_user_split="$(split_output "$real_user_combined")"
real_user_stdout="${real_user_split%%$'\n'__LOGBREW_STDERR_SPLIT__$'\n'*}"
real_user_stderr="${real_user_split#*$'\n'__LOGBREW_STDERR_SPLIT__$'\n'}"

assert_contains "$real_user_stdout" '"type": "release"' 'expected release event in Rust real-user smoke output'
assert_contains "$real_user_stdout" '"type": "environment"' 'expected environment event in Rust real-user smoke output'
assert_contains "$real_user_stdout" '"type": "issue"' 'expected issue event in Rust real-user smoke output'
assert_contains "$real_user_stdout" '"type": "log"' 'expected log event in Rust real-user smoke output'
assert_contains "$real_user_stdout" '"type": "span"' 'expected span event in Rust real-user smoke output'
assert_contains "$real_user_stdout" '"type": "action"' 'expected action event in Rust real-user smoke output'
assert_contains "$real_user_stderr" '"ok":true' 'expected success status in Rust real-user smoke stderr'
assert_contains "$real_user_stderr" '"events":6' 'expected event count in Rust real-user smoke stderr'

make_help_output="$(cd "$package_root/examples" && make)"
expected_help_output=$'run-readme-example -> make run-readme-example\nrun (real-user-smoke) -> make run\nrun-real-user-smoke -> make run-real-user-smoke\nrun-first-useful-telemetry -> make run-first-useful-telemetry\nrun-http-server-request -> make run-http-server-request\nrun-axum-request-middleware -> make run-axum-request-middleware\nrun-actix-request-middleware -> make run-actix-request-middleware\nrun-rocket-request-fairing -> make run-rocket-request-fairing\nrun-tracing-bridge -> make run-tracing-bridge'
if [[ "$make_help_output" != "$expected_help_output" ]]; then
  printf 'unexpected Rust examples make output\n' >&2
  exit 1
fi

make_run_combined="$(run_command "$package_root/examples" make run)"
make_run_split="$(split_output "$make_run_combined")"
make_run_stdout="${make_run_split%%$'\n'__LOGBREW_STDERR_SPLIT__$'\n'*}"
make_run_stderr="${make_run_split#*$'\n'__LOGBREW_STDERR_SPLIT__$'\n'}"

assert_contains "$make_run_stdout" '"type": "release"' 'expected release event in Rust make run output'
assert_contains "$make_run_stdout" '"type": "environment"' 'expected environment event in Rust make run output'
assert_contains "$make_run_stdout" '"type": "issue"' 'expected issue event in Rust make run output'
assert_contains "$make_run_stdout" '"type": "log"' 'expected log event in Rust make run output'
assert_contains "$make_run_stdout" '"type": "span"' 'expected span event in Rust make run output'
assert_contains "$make_run_stdout" '"type": "action"' 'expected action event in Rust make run output'
assert_contains "$make_run_stderr" '"ok":true' 'expected success status in Rust make run stderr'
assert_contains "$make_run_stderr" '"events":6' 'expected event count in Rust make run stderr'

make_readme_combined="$(run_command "$package_root/examples" make run-readme-example)"
make_readme_split="$(split_output "$make_readme_combined")"
make_readme_stdout="${make_readme_split%%$'\n'__LOGBREW_STDERR_SPLIT__$'\n'*}"
make_readme_stderr="${make_readme_split#*$'\n'__LOGBREW_STDERR_SPLIT__$'\n'}"

assert_contains "$make_readme_stdout" '"type": "release"' 'expected release event in Rust make run-readme-example output'
assert_contains "$make_readme_stdout" '"type": "environment"' 'expected environment event in Rust make run-readme-example output'
assert_contains "$make_readme_stdout" '"type": "issue"' 'expected issue event in Rust make run-readme-example output'
assert_contains "$make_readme_stdout" '"type": "log"' 'expected log event in Rust make run-readme-example output'
assert_contains "$make_readme_stdout" '"type": "span"' 'expected span event in Rust make run-readme-example output'
assert_contains "$make_readme_stdout" '"type": "action"' 'expected action event in Rust make run-readme-example output'
assert_contains "$make_readme_stderr" '"ok":true' 'expected success status in Rust make run-readme-example stderr'
assert_contains "$make_readme_stderr" '"events":6' 'expected event count in Rust make run-readme-example stderr'

make_real_user_combined="$(run_command "$package_root/examples" make run-real-user-smoke)"
make_real_user_split="$(split_output "$make_real_user_combined")"
make_real_user_stdout="${make_real_user_split%%$'\n'__LOGBREW_STDERR_SPLIT__$'\n'*}"
make_real_user_stderr="${make_real_user_split#*$'\n'__LOGBREW_STDERR_SPLIT__$'\n'}"

assert_contains "$make_real_user_stdout" '"type": "release"' 'expected release event in Rust make run-real-user-smoke output'
assert_contains "$make_real_user_stdout" '"type": "environment"' 'expected environment event in Rust make run-real-user-smoke output'
assert_contains "$make_real_user_stdout" '"type": "issue"' 'expected issue event in Rust make run-real-user-smoke output'
assert_contains "$make_real_user_stdout" '"type": "log"' 'expected log event in Rust make run-real-user-smoke output'
assert_contains "$make_real_user_stdout" '"type": "span"' 'expected span event in Rust make run-real-user-smoke output'
assert_contains "$make_real_user_stdout" '"type": "action"' 'expected action event in Rust make run-real-user-smoke output'
assert_contains "$make_real_user_stderr" '"ok":true' 'expected success status in Rust make run-real-user-smoke stderr'
assert_contains "$make_real_user_stderr" '"events":6' 'expected event count in Rust make run-real-user-smoke stderr'

printf 'rust sdk checkout checks passed\n'
