#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

json_mode=false
json_output_path=""
current_step_number=0
current_step_label="startup"
failure_json_emitted=false
steps_completed=0
schema_version="1"
lock_dir="${TMPDIR:-/tmp}/logbrewco-sdk-public-checks.lock"
lock_pid_file="$lock_dir/pid"
run_started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
run_started_epoch="$(python3 - <<'PY'
import time
print(f"{time.time():.6f}")
PY
)"
STEP_LABELS=(
  "Root contract tests"
  "Rust tests"
  "Rust package dry-run"
  "JavaScript tests"
  "JavaScript package dry-run"
  "Python tests"
  "FastAPI package checks"
  "Django package checks"
  "Go tests"
  "C package checks"
  "C++ package checks"
  "Java package checks"
  ".NET package checks"
  "Unity package checks"
  "Kotlin package checks"
  "Ruby package checks"
  "Swift package checks"
  "Rust real-user smoke"
  "Rust http-client real-user smoke"
  "Rust dependency-span real-user smoke"
  "Rust Axum real-user smoke"
  "Rust Actix real-user smoke"
  "Rust Rocket real-user smoke"
  "Rust tracing real-user smoke"
  "crates.io public install smoke"
  "JavaScript real-user smoke"
  "JavaScript high-load installed-artifact smoke"
  "JavaScript OpenTelemetry installed-artifact smoke"
  "Browser real-user smoke"
  "Browser installed-artifact fake-intake smoke"
  "Node.js real-user smoke"
  "Node Redis real-package smoke"
  "Node Mongoose real-package smoke"
  "Node Axios real-package smoke"
  "Node HTTP client real-package smoke"
  "Node queue high-load fake-intake smoke"
  "Node persistent delivery restart smoke"
  "Node encrypted persistent delivery smoke"
  "Prisma real-user smoke"
  "BullMQ real-user smoke"
  "KafkaJS real-user smoke"
  "AMQP/RabbitMQ real-user smoke"
  "AWS SQS real-user smoke"
  "npm public registry install smoke"
  "Express real-user smoke"
  "Fastify real-user smoke"
  "NestJS real-user smoke"
  "Angular real-user smoke"
  "Vue real-user smoke"
  "Svelte real-user smoke"
  "React real-user smoke"
  "React Native real-user smoke"
  "Next.js real-user smoke"
  "Python real-user smoke"
  "Python high-load installed-artifact smoke"
  "Python OpenTelemetry installed-artifact smoke"
  "Python Celery real-user smoke"
  "FastAPI real-user smoke"
  "Django real-user smoke"
  "Python public PyPI install smoke"
  "Go real-user smoke"
  "Go OpenTelemetry installed-artifact smoke"
  "Go high-load installed-artifact smoke"
  "Go delivery lifecycle installed-artifact smoke"
  "Go support-ticket real-user smoke"
  "Go public module install smoke"
  "C real-user smoke"
  "C++ real-user smoke"
  "Java real-user smoke"
  "Java OpenTelemetry installed-artifact smoke"
  "Java Spring Kafka installed-artifact smoke"
  "Java Spring HTTP installed-artifact smoke"
  "Java queue trace installed-artifact smoke"
  "Java JMS installed-artifact smoke"
  "Java high-load installed-artifact smoke"
  "Maven Central public install smoke"
  "Spring Boot real-user smoke"
  ".NET real-user smoke"
  ".NET high-load installed-artifact smoke"
  ".NET public NuGet install smoke"
  "Unity real-user smoke"
  "OpenUPM public install smoke"
  "Kotlin real-user smoke"
  "Ruby real-user smoke"
  "RubyGems public install smoke"
  "Swift real-user smoke"
  "SwiftPM public install smoke"
  "PHP package metadata"
  "PHP package install"
  "PHP package tests"
  "PHP real-user smoke"
  "Packagist public install smoke"
  "Python package build checks"
  "Objective-C package checks"
  "Objective-C real-user smoke"
  "Backend contract report checks"
  "Release metadata checks"
  "GitHub release safety checks"
  "Markdown link checks"
  "Shell static analysis"
  "Workflow YAML validation"
  "Confidentiality leak scan"
  "JavaScript release artifact smoke"
  "JavaScript release artifact installed CLI smoke"
  "Vite release artifact smoke"
  "Next.js release artifact smoke"
  "React Native release artifact smoke"
  "JavaScript release artifact upload smoke"
  "Native release artifact smoke"
  "Native release artifact upload smoke"
  "Generated artifact hygiene"
)
steps_total="${#STEP_LABELS[@]}"

json_array_from_args() {
  python3 - "$@" <<'PY'
import json
import sys

print(json.dumps(sys.argv[1:], separators=(",", ":")))
PY
}

toolchain_versions_json() {
  python3 <<'PY'
import json
import subprocess

commands = {
    "node": ["node", "--version"],
    "npm": ["npm", "--version"],
    "pnpm": ["pnpm", "--version"],
    "cc": ["cc", "--version"],
    "clang": ["clang", "--version"],
    "objc": ["clang", "--version"],
    "c++": ["c++", "--version"],
    "clang++": ["clang++", "--version"],
    "make": ["make", "--version"],
    "python3": ["python3", "--version"],
    "pip": ["python3", "-m", "pip", "--version"],
    "go": ["go", "version"],
    "java": ["java", "-version"],
    "javac": ["javac", "-version"],
    "jar": ["jar", "--version"],
    "jdeps": ["jdeps", "--version"],
    "dotnet": ["dotnet", "--version"],
    "kotlinc": ["kotlinc", "-version"],
    "gradle": ["gradle", "--version"],
    "swift": ["swift", "--version"],
    "swiftformat": ["swiftformat", "--version"],
    "swiftlint": ["swiftlint", "version"],
    "cargo": ["cargo", "--version"],
    "rustc": ["rustc", "--version"],
    "php": ["php", "--version"],
    "composer": ["composer", "--version"],
    "ruby": ["ruby", "--version"],
    "gem": ["gem", "--version"],
    "bundler": ["bundle", "--version"],
}

payload = {}
for name, command in commands.items():
    try:
        completed = subprocess.run(command, check=False, capture_output=True, text=True)
    except FileNotFoundError:
        payload[name] = "not installed"
        continue
    output = completed.stdout.strip() or completed.stderr.strip()
    first_line = output.splitlines()[0] if output else ""
    payload[name] = first_line

print(json.dumps(payload, separators=(",", ":")))
PY
}

write_summary_json() {
  local ok="$1"
  local message="$2"
  local failed_step_number="${3:-}"
  local failed_step_label="${4:-}"
  local failure_reason="${5:-}"
  local exit_code="${6:-}"
  local step_labels_json
  local completed_step_labels_json
  local toolchain_versions_json_payload
  local finished_at
  local duration_ms

  step_labels_json="$(json_array_from_args "${STEP_LABELS[@]}")"
  if (( steps_completed > 0 )); then
    completed_step_labels_json="$(json_array_from_args "${STEP_LABELS[@]:0:steps_completed}")"
  else
    completed_step_labels_json="[]"
  fi
  toolchain_versions_json_payload="$(toolchain_versions_json)"
  finished_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  duration_ms="$(
    python3 - "$run_started_epoch" <<'PY'
import sys
import time

started = float(sys.argv[1])
print(int(round((time.time() - started) * 1000)))
PY
  )"

  local json_payload
  json_payload="$(
    python3 - "$ok" "$steps_completed" "$steps_total" "$message" "$failed_step_number" "$failed_step_label" "$step_labels_json" "$completed_step_labels_json" "$toolchain_versions_json_payload" "$run_started_at" "$finished_at" "$duration_ms" "$failure_reason" "$exit_code" "$schema_version" <<'PY'
import json
import sys

ok = sys.argv[1] == "true"
steps_completed = int(sys.argv[2])
steps_total = int(sys.argv[3])
message = sys.argv[4]
failed_step_number = sys.argv[5]
failed_step_label = sys.argv[6]
step_labels = json.loads(sys.argv[7])
completed_step_labels = json.loads(sys.argv[8])
toolchain_versions = json.loads(sys.argv[9])
started_at = sys.argv[10]
finished_at = sys.argv[11]
duration_ms = int(sys.argv[12])
failure_reason = sys.argv[13]
exit_code = sys.argv[14]
schema_version = sys.argv[15]

payload = {
    "schema_version": schema_version,
    "ok": ok,
    "steps_completed": steps_completed,
    "steps_total": steps_total,
    "message": message,
    "step_labels": step_labels,
    "completed_step_labels": completed_step_labels,
    "toolchain_versions": toolchain_versions,
    "started_at": started_at,
    "finished_at": finished_at,
    "duration_ms": duration_ms,
}
if failure_reason:
    payload["failure_reason"] = failure_reason
if exit_code:
    payload["exit_code"] = int(exit_code)
if failed_step_number:
    payload["failed_step_number"] = int(failed_step_number)
if failed_step_label:
    payload["failed_step_label"] = failed_step_label

print(json.dumps(payload, separators=(",", ":")))
PY
  )"

  if [[ -n "$json_output_path" ]]; then
    printf '%s' "$json_payload" > "$json_output_path"
  else
    printf '%s\n' "$json_payload"
  fi
}

emit_failure_json() {
  local message="$1"
  local failure_reason="${2:-step_failure}"
  local exit_code="${3:-1}"
  if [[ "$json_mode" == true && "$failure_json_emitted" == false ]]; then
    write_summary_json false "$message" "$current_step_number" "$current_step_label" "$failure_reason" "$exit_code"
    failure_json_emitted=true
  fi
}

on_error() {
  local exit_code="$1"
  emit_failure_json "public SDK checks failed" "step_failure" "$exit_code"
  exit "$exit_code"
}

trap 'on_error "$?"' ERR

for arg in "$@"; do
  case "$arg" in
    --json)
      json_mode=true
      ;;
    --json-out=*)
      json_mode=true
      json_output_path="${arg#--json-out=}"
      ;;
    *)
      if [[ "$json_mode" == true ]]; then
        write_summary_json false "unknown argument: $arg" "" "" "invalid_argument" "1"
      fi
      echo "unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

acquire_lock() {
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock_pid_file"
    return 0
  fi

  local existing_pid=""
  if [[ -f "$lock_pid_file" ]]; then
    existing_pid="$(tr -d '[:space:]' < "$lock_pid_file")"
  fi

  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    return 1
  fi

  rm -rf "$lock_dir"
  mkdir "$lock_dir"
  printf '%s\n' "$$" > "$lock_pid_file"
}

if ! acquire_lock; then
  if [[ "$json_mode" == true ]]; then
    write_summary_json false "another public SDK verifier run is already in progress" "" "" "concurrent_run" "1"
  fi
  echo "another public SDK verifier run is already in progress" >&2
  exit 1
fi

cleanup_build_artifacts() {
  rm -rf \
    Cargo.lock \
    target \
    php/logbrew-php/vendor \
    php/logbrew-php/composer.lock \
    .mypy_cache \
    .ruff_cache \
    java/logbrew-java/build \
    python/logbrew_py/build \
    python/logbrew_py/dist \
    python/logbrew_py/src/logbrew_sdk.egg-info \
    python/logbrew_fastapi/build \
    python/logbrew_fastapi/dist \
    python/logbrew_fastapi/src/logbrew_fastapi.egg-info \
    python/logbrew_flask/build \
    python/logbrew_flask/dist \
    python/logbrew_flask/src/logbrew_flask.egg-info \
    python/logbrew_django/build \
    python/logbrew_django/dist \
    python/logbrew_django/src/logbrew_django.egg-info \
    swift/logbrew-swift/.build
  rm -rf c/logbrew-c/build c/logbrew-c/examples/build
  rm -rf cpp/logbrew-cpp/build cpp/logbrew-cpp/examples/build
  rm -rf objc/logbrew-objc/build objc/logbrew-objc/examples/build
  find scripts tests python/logbrew_py python/logbrew_fastapi python/logbrew_flask python/logbrew_django -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
  find js -maxdepth 2 -type f -path 'js/logbrew-*/*.tgz' -delete 2>/dev/null || true
  find dotnet/logbrew-dotnet -type d \( -name bin -o -name obj \) -prune -exec rm -rf {} + 2>/dev/null || true
  find unity/logbrew-unity -type d \( -name bin -o -name obj \) -prune -exec rm -rf {} + 2>/dev/null || true
  find kotlin/logbrew-kotlin -type d \( -name build -o -name .gradle \) -prune -exec rm -rf {} + 2>/dev/null || true
  find kotlin/logbrew-kotlin-okhttp -type d \( -name build -o -name .gradle \) -prune -exec rm -rf {} + 2>/dev/null || true
}

cleanup_generated_artifacts() {
  cleanup_build_artifacts
  rmdir "$lock_dir" 2>/dev/null || true
}

trap cleanup_generated_artifacts EXIT

log_line() {
  if [[ "$json_mode" == true && -z "$json_output_path" ]]; then
    printf '%s\n' "$1" >&2
  else
    printf '%s\n' "$1"
  fi
}

run_shell_step() {
  local command="$1"
  if [[ "$json_mode" == true && -z "$json_output_path" ]]; then
    bash -lc "$command" >&2
  else
    bash -lc "$command"
  fi
}

mark_step_complete() {
  steps_completed=$((steps_completed + 1))
}

begin_next_step() {
  local expected_label
  current_step_number=$((current_step_number + 1))
  current_step_label="$1"
  expected_label="${STEP_LABELS[$((current_step_number - 1))]:-}"
  if [[ "$expected_label" != "$current_step_label" ]]; then
    log_line "step label mismatch for step $current_step_number: expected '$expected_label', got '$current_step_label'"
    exit 1
  fi
  log_line "[$current_step_number/$steps_total] $current_step_label"
}

begin_next_step "Root contract tests"
run_shell_step "python3 -m unittest discover -s tests -p 'test_*.py'"
mark_step_complete

begin_next_step "Rust tests"
run_shell_step "cd rust/logbrew && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo clippy --all-targets --features http -- -D warnings && cargo test && cargo test --features http && bash tests/run.sh"
mark_step_complete

begin_next_step "Rust package dry-run"
run_shell_step "cd rust/logbrew && cargo publish --dry-run --allow-dirty"
mark_step_complete

begin_next_step "JavaScript tests"
run_shell_step "python3 scripts/check_js_sources.py && bash scripts/check_js_lint.sh && cd js/logbrew-js && npm test && cd ../logbrew-browser && npm test && cd ../logbrew-node && npm test && cd ../logbrew-prisma && npm test && cd ../logbrew-bullmq && npm test && cd ../logbrew-kafkajs && npm test && cd ../logbrew-amqplib && npm test && cd ../logbrew-aws-sqs && npm test && cd ../logbrew-express && npm test && cd ../logbrew-fastify && npm test && cd ../logbrew-nestjs && npm test && cd ../logbrew-angular && npm test && cd ../logbrew-vue && npm test && cd ../logbrew-svelte && npm test && cd ../logbrew-react && npm test && cd ../logbrew-react-native && npm test && cd ../logbrew-next && npm test"
mark_step_complete

begin_next_step "JavaScript package dry-run"
run_shell_step "bash scripts/check_js_package.sh && cd js/logbrew-js && npm pack --dry-run >/dev/null && cd ../logbrew-browser && npm pack --dry-run >/dev/null && cd ../logbrew-node && npm pack --dry-run >/dev/null && cd ../logbrew-prisma && npm pack --dry-run >/dev/null && cd ../logbrew-bullmq && npm pack --dry-run >/dev/null && cd ../logbrew-kafkajs && npm pack --dry-run >/dev/null && cd ../logbrew-amqplib && npm pack --dry-run >/dev/null && cd ../logbrew-aws-sqs && npm pack --dry-run >/dev/null && cd ../logbrew-express && npm pack --dry-run >/dev/null && cd ../logbrew-fastify && npm pack --dry-run >/dev/null && cd ../logbrew-nestjs && npm pack --dry-run >/dev/null && cd ../logbrew-angular && npm pack --dry-run >/dev/null && cd ../logbrew-vue && npm pack --dry-run >/dev/null && cd ../logbrew-svelte && npm pack --dry-run >/dev/null && cd ../logbrew-react && npm pack --dry-run >/dev/null && cd ../logbrew-react-native && npm pack --dry-run >/dev/null && cd ../logbrew-next && npm pack --dry-run >/dev/null"
mark_step_complete

begin_next_step "Python tests"
run_shell_step "python3 scripts/check_python_sources.py && bash scripts/check_python_static.sh && PYTHONPATH=python/logbrew_py/src python3 -m unittest discover -s python/logbrew_py/tests -p 'test_*.py'"
mark_step_complete

begin_next_step "FastAPI package checks"
run_shell_step "bash scripts/check_fastapi_package.sh"
mark_step_complete

begin_next_step "Django package checks"
run_shell_step "bash scripts/check_django_package.sh"
mark_step_complete

begin_next_step "Go tests"
run_shell_step "bash scripts/check_go_tests.sh && bash scripts/check_go_static.sh"
mark_step_complete

begin_next_step "C package checks"
run_shell_step "bash scripts/check_c_package.sh"
mark_step_complete

begin_next_step "C++ package checks"
run_shell_step "bash scripts/check_cpp_package.sh"
mark_step_complete

begin_next_step "Java package checks"
run_shell_step "bash scripts/check_java_static.sh && bash scripts/check_java_package.sh"
mark_step_complete

begin_next_step ".NET package checks"
run_shell_step "bash scripts/check_dotnet_package.sh"
mark_step_complete

begin_next_step "Unity package checks"
run_shell_step "bash scripts/check_unity_package.sh"
mark_step_complete

begin_next_step "Kotlin package checks"
run_shell_step "bash scripts/check_kotlin_style.sh && bash scripts/check_kotlin_package.sh"
mark_step_complete

begin_next_step "Ruby package checks"
run_shell_step "bash scripts/check_ruby_package.sh"
mark_step_complete

begin_next_step "Swift package checks"
run_shell_step "bash scripts/check_swift_style.sh && bash scripts/check_swift_package.sh"
mark_step_complete

begin_next_step "Rust real-user smoke"
run_shell_step "bash scripts/real_user_rust_smoke.sh"
mark_step_complete

begin_next_step "Rust http-client real-user smoke"
run_shell_step "bash scripts/real_user_rust_http_client_smoke.sh"
mark_step_complete

begin_next_step "Rust dependency-span real-user smoke"
run_shell_step "bash scripts/real_user_rust_dependency_smoke.sh"
mark_step_complete

begin_next_step "Rust Axum real-user smoke"
run_shell_step "bash scripts/real_user_rust_axum_smoke.sh"
mark_step_complete

begin_next_step "Rust Actix real-user smoke"
run_shell_step "bash scripts/real_user_rust_actix_smoke.sh"
mark_step_complete

begin_next_step "Rust Rocket real-user smoke"
run_shell_step "bash scripts/real_user_rust_rocket_smoke.sh"
mark_step_complete

begin_next_step "Rust tracing real-user smoke"
run_shell_step "bash scripts/real_user_rust_tracing_smoke.sh"
mark_step_complete

begin_next_step "crates.io public install smoke"
run_shell_step "bash scripts/real_user_cratesio_public_smoke.sh"
mark_step_complete

begin_next_step "JavaScript real-user smoke"
run_shell_step "bash scripts/real_user_js_smoke.sh"
mark_step_complete

begin_next_step "JavaScript high-load installed-artifact smoke"
run_shell_step "bash scripts/real_user_js_high_load_smoke.sh"
mark_step_complete

begin_next_step "JavaScript OpenTelemetry installed-artifact smoke"
run_shell_step "bash scripts/real_user_js_opentelemetry_smoke.sh"
mark_step_complete

begin_next_step "Browser real-user smoke"
run_shell_step "bash scripts/real_user_browser_smoke.sh"
mark_step_complete

begin_next_step "Browser installed-artifact fake-intake smoke"
run_shell_step "bash scripts/real_user_browser_fake_intake_smoke.sh"
mark_step_complete

begin_next_step "Node.js real-user smoke"
run_shell_step "bash scripts/real_user_node_smoke.sh"
mark_step_complete

begin_next_step "Node Redis real-package smoke"
run_shell_step "bash scripts/real_user_node_redis_packages_smoke.sh"
mark_step_complete

begin_next_step "Node Mongoose real-package smoke"
run_shell_step "bash scripts/real_user_node_mongoose_smoke.sh"
mark_step_complete

begin_next_step "Node Axios real-package smoke"
run_shell_step "bash scripts/real_user_node_axios_smoke.sh"
mark_step_complete

begin_next_step "Node HTTP client real-package smoke"
run_shell_step "bash scripts/real_user_node_http_client_smoke.sh"
mark_step_complete

begin_next_step "Node queue high-load fake-intake smoke"
run_shell_step "bash scripts/real_user_node_queue_high_load_smoke.sh"
mark_step_complete

begin_next_step "Node persistent delivery restart smoke"
run_shell_step "bash scripts/real_user_node_persistent_delivery_smoke.sh"
mark_step_complete

begin_next_step "Node encrypted persistent delivery smoke"
run_shell_step "bash scripts/real_user_node_encrypted_persistent_delivery_smoke.sh"
mark_step_complete

begin_next_step "Prisma real-user smoke"
run_shell_step "bash scripts/real_user_prisma_smoke.sh"
mark_step_complete

begin_next_step "BullMQ real-user smoke"
run_shell_step "bash scripts/real_user_bullmq_smoke.sh"
mark_step_complete

begin_next_step "KafkaJS real-user smoke"
run_shell_step "bash scripts/real_user_kafkajs_smoke.sh"
mark_step_complete

begin_next_step "AMQP/RabbitMQ real-user smoke"
run_shell_step "bash scripts/real_user_amqplib_smoke.sh"
mark_step_complete

begin_next_step "AWS SQS real-user smoke"
run_shell_step "bash scripts/real_user_aws_sqs_smoke.sh"
mark_step_complete

begin_next_step "npm public registry install smoke"
run_shell_step "bash scripts/real_user_npm_public_registry_smoke.sh"
mark_step_complete

begin_next_step "Express real-user smoke"
run_shell_step "bash scripts/real_user_express_smoke.sh"
mark_step_complete

begin_next_step "Fastify real-user smoke"
run_shell_step "bash scripts/real_user_fastify_smoke.sh"
mark_step_complete

begin_next_step "NestJS real-user smoke"
run_shell_step "bash scripts/real_user_nestjs_smoke.sh"
mark_step_complete

begin_next_step "Angular real-user smoke"
run_shell_step "bash scripts/real_user_angular_smoke.sh"
mark_step_complete

begin_next_step "Vue real-user smoke"
run_shell_step "bash scripts/real_user_vue_smoke.sh"
mark_step_complete

begin_next_step "Svelte real-user smoke"
run_shell_step "bash scripts/real_user_svelte_smoke.sh"
mark_step_complete

begin_next_step "React real-user smoke"
run_shell_step "bash scripts/real_user_react_smoke.sh"
mark_step_complete

begin_next_step "React Native real-user smoke"
run_shell_step "bash scripts/real_user_react_native_smoke.sh"
mark_step_complete

begin_next_step "Next.js real-user smoke"
run_shell_step "bash scripts/real_user_next_smoke.sh"
mark_step_complete

begin_next_step "Python real-user smoke"
run_shell_step "bash scripts/real_user_python_smoke.sh"
mark_step_complete

begin_next_step "Python high-load installed-artifact smoke"
run_shell_step "bash scripts/real_user_python_high_load_smoke.sh"
mark_step_complete

begin_next_step "Python OpenTelemetry installed-artifact smoke"
run_shell_step "bash scripts/real_user_python_opentelemetry_smoke.sh"
mark_step_complete

begin_next_step "Python Celery real-user smoke"
run_shell_step "bash scripts/real_user_python_celery_smoke.sh"
mark_step_complete

begin_next_step "FastAPI real-user smoke"
run_shell_step "bash scripts/real_user_fastapi_smoke.sh"
mark_step_complete

begin_next_step "Django real-user smoke"
run_shell_step "bash scripts/real_user_django_smoke.sh"
mark_step_complete

begin_next_step "Python public PyPI install smoke"
run_shell_step "bash scripts/real_user_python_public_pypi_smoke.sh"
mark_step_complete

begin_next_step "Go real-user smoke"
run_shell_step "bash scripts/real_user_go_smoke.sh"
mark_step_complete

begin_next_step "Go OpenTelemetry installed-artifact smoke"
run_shell_step "bash scripts/real_user_go_opentelemetry_smoke.sh"
mark_step_complete

begin_next_step "Go high-load installed-artifact smoke"
run_shell_step "bash scripts/real_user_go_high_load_smoke.sh"
mark_step_complete

begin_next_step "Go delivery lifecycle installed-artifact smoke"
run_shell_step "bash scripts/real_user_go_delivery_lifecycle_smoke.sh"
mark_step_complete

begin_next_step "Go support-ticket real-user smoke"
run_shell_step "bash scripts/real_user_go_support_ticket_smoke.sh"
mark_step_complete

begin_next_step "Go public module install smoke"
run_shell_step "bash scripts/real_user_go_public_module_smoke.sh"
mark_step_complete

begin_next_step "C real-user smoke"
run_shell_step "bash scripts/real_user_c_smoke.sh"
mark_step_complete

begin_next_step "C++ real-user smoke"
run_shell_step "bash scripts/real_user_cpp_smoke.sh"
mark_step_complete

begin_next_step "Java real-user smoke"
run_shell_step "bash scripts/real_user_java_smoke.sh"
mark_step_complete

begin_next_step "Java OpenTelemetry installed-artifact smoke"
run_shell_step "bash scripts/real_user_java_opentelemetry_smoke.sh"
mark_step_complete

begin_next_step "Java Spring Kafka installed-artifact smoke"
run_shell_step "bash scripts/real_user_java_spring_kafka_smoke.sh"
mark_step_complete

begin_next_step "Java Spring HTTP installed-artifact smoke"
run_shell_step "bash scripts/real_user_java_spring_http_smoke.sh"
mark_step_complete

begin_next_step "Java queue trace installed-artifact smoke"
run_shell_step "bash scripts/real_user_java_queue_trace_smoke.sh"
mark_step_complete

begin_next_step "Java JMS installed-artifact smoke"
run_shell_step "bash scripts/real_user_java_jms_smoke.sh"
mark_step_complete

begin_next_step "Java high-load installed-artifact smoke"
run_shell_step "bash scripts/real_user_java_high_load_smoke.sh"
mark_step_complete

begin_next_step "Maven Central public install smoke"
run_shell_step "bash scripts/real_user_maven_central_public_smoke.sh"
mark_step_complete

begin_next_step "Spring Boot real-user smoke"
run_shell_step "bash scripts/real_user_spring_boot_smoke.sh"
mark_step_complete

begin_next_step ".NET real-user smoke"
run_shell_step "bash scripts/real_user_dotnet_smoke.sh"
mark_step_complete

begin_next_step ".NET high-load installed-artifact smoke"
run_shell_step "bash scripts/real_user_dotnet_high_load_smoke.sh"
mark_step_complete

begin_next_step ".NET public NuGet install smoke"
run_shell_step "bash scripts/real_user_dotnet_public_nuget_smoke.sh"
mark_step_complete

begin_next_step "Unity real-user smoke"
run_shell_step "bash scripts/real_user_unity_smoke.sh"
mark_step_complete

begin_next_step "OpenUPM public install smoke"
run_shell_step "bash scripts/real_user_openupm_public_smoke.sh"
mark_step_complete

begin_next_step "Kotlin real-user smoke"
run_shell_step "bash scripts/real_user_kotlin_smoke.sh"
mark_step_complete

begin_next_step "Ruby real-user smoke"
run_shell_step "bash scripts/real_user_ruby_smoke.sh"
mark_step_complete

begin_next_step "RubyGems public install smoke"
run_shell_step "bash scripts/real_user_rubygems_public_smoke.sh"
mark_step_complete

begin_next_step "Swift real-user smoke"
run_shell_step "bash scripts/real_user_swift_smoke.sh"
mark_step_complete

begin_next_step "SwiftPM public install smoke"
run_shell_step "bash scripts/real_user_swiftpm_public_smoke.sh"
mark_step_complete

begin_next_step "PHP package metadata"
run_shell_step "cd php/logbrew-php && composer validate --no-check-publish --strict"
mark_step_complete

begin_next_step "PHP package install"
run_shell_step "cd php/logbrew-php && composer update --no-interaction"
mark_step_complete

begin_next_step "PHP package tests"
run_shell_step "python3 scripts/check_php_sources.py && bash scripts/check_php_static.sh && cd php/logbrew-php && php tests/run.php"
mark_step_complete

begin_next_step "PHP real-user smoke"
run_shell_step "bash scripts/real_user_php_smoke.sh"
mark_step_complete

begin_next_step "Packagist public install smoke"
run_shell_step "bash scripts/real_user_packagist_public_smoke.sh"
mark_step_complete

begin_next_step "Python package build checks"
run_shell_step "cd python/logbrew_py && python3 -m build && python3 -m twine check 'dist/*' && cd ../logbrew_fastapi && python3 -m build && python3 -m twine check 'dist/*' && cd ../logbrew_flask && python3 -m build && python3 -m twine check 'dist/*' && cd ../logbrew_django && python3 -m build && python3 -m twine check 'dist/*'"
mark_step_complete

begin_next_step "Objective-C package checks"
run_shell_step "bash scripts/check_objc_package.sh"
mark_step_complete

begin_next_step "Objective-C real-user smoke"
run_shell_step "bash scripts/real_user_objc_smoke.sh"
mark_step_complete

begin_next_step "Backend contract report checks"
run_shell_step "python3 scripts/check_backend_contract_reports.py"
mark_step_complete

begin_next_step "Release metadata checks"
run_shell_step "python3 scripts/check_release_metadata.py"
mark_step_complete

begin_next_step "GitHub release safety checks"
run_shell_step "python3 scripts/check_github_release_safety.py"
mark_step_complete

begin_next_step "Markdown link checks"
run_shell_step "python3 scripts/check_markdown_links.py"
mark_step_complete

begin_next_step "Shell static analysis"
run_shell_step "bash scripts/check_shell_static.sh"
mark_step_complete

begin_next_step "Workflow YAML validation"
run_shell_step "ruby -e 'require \"yaml\"; YAML.load_file(\".github/workflows/ci.yml\"); YAML.load_file(\".github/workflows/release-readiness.yml\"); puts \"yaml ok\"'"
mark_step_complete

begin_next_step "Confidentiality leak scan"
run_shell_step "python3 scripts/check_confidentiality_scan.py"
mark_step_complete

begin_next_step "JavaScript release artifact smoke"
run_shell_step "bash scripts/real_user_js_release_artifact_smoke.sh"
mark_step_complete

begin_next_step "JavaScript release artifact installed CLI smoke"
run_shell_step "bash scripts/real_user_js_release_artifact_cli_smoke.sh"
mark_step_complete

begin_next_step "Vite release artifact smoke"
run_shell_step "bash scripts/real_user_vite_release_artifact_smoke.sh"
mark_step_complete

begin_next_step "Next.js release artifact smoke"
run_shell_step "bash scripts/real_user_next_release_artifact_smoke.sh"
mark_step_complete

begin_next_step "React Native release artifact smoke"
run_shell_step "bash scripts/real_user_react_native_release_artifact_smoke.sh"
mark_step_complete

begin_next_step "JavaScript release artifact upload smoke"
run_shell_step "bash scripts/real_user_js_release_artifact_upload_smoke.sh"
mark_step_complete

begin_next_step "Native release artifact smoke"
run_shell_step "bash scripts/real_user_native_release_artifact_smoke.sh"
mark_step_complete

begin_next_step "Native release artifact upload smoke"
run_shell_step "bash scripts/real_user_native_release_artifact_upload_smoke.sh"
mark_step_complete

begin_next_step "Generated artifact hygiene"
cleanup_build_artifacts
run_shell_step "PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_generated_artifacts.py"
mark_step_complete

log_line "all public SDK checks passed"

if [[ "$json_mode" == true ]]; then
  write_summary_json true "all public SDK checks passed"
fi
