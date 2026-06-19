#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
python_package_version="$(
    python3 - "$repo_root/python/logbrew_py/pyproject.toml" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    print(tomllib.load(handle)["project"]["version"])
PY
)"
wheel_artifact="logbrew_sdk-${python_package_version}-py3-none-any.whl"
sdist_artifact="logbrew_sdk-${python_package_version}.tar.gz"
dist_info_dir="logbrew_sdk-${python_package_version}.dist-info"
sdist_root="logbrew_sdk-${python_package_version}"
export LOGBREW_PYTHON_PACKAGE_VERSION="$python_package_version"

on_error() {
    local status=$?
    echo "real_user_python_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
    for diagnostic in \
        "$tmp_dir/build.log" \
        "$tmp_dir/pip-freeze.txt" \
        "$tmp_dir/pip-direct-requirements.txt" \
        "$tmp_dir/sdist-pip-freeze.txt" \
        "$tmp_dir/sdist-direct-requirements.txt" \
        "$tmp_dir/sdist-contents.txt" \
        "$tmp_dir/sdist-README.md" \
        "$tmp_dir/sdist-pyproject.toml"; do
        if [[ -f "$diagnostic" ]]; then
            echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
            sed -n '1,80p' "$diagnostic" >&2
        fi
    done
    exit "$status"
}

trap 'rm -rf "$tmp_dir"' EXIT
trap on_error ERR

run_make() {
    make --no-print-directory -C "$tmp_dir" "$@"
}

run_readme_example() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.json" 2> "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"type": "release"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "environment"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "issue"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "log"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "span"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "action"' "$tmp_dir/$output_prefix.stdout.json"
    python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    grep -q '"events": 6' "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stderr.json"
}

run_packaged_example_module() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.json" 2> "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"type": "release"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "environment"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "issue"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "log"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "span"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "action"' "$tmp_dir/$output_prefix.stdout.json"
    python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    grep -q '"events": 6' "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stderr.json"
}

run_packaged_real_user_module() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.json" 2> "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"type": "release"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "environment"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "issue"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "log"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "span"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "action"' "$tmp_dir/$output_prefix.stdout.json"
    python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    grep -q '"events": 6' "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stderr.json"
}

run_packaged_examples_entrypoint() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.json" 2> "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"type": "release"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "environment"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "issue"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "log"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "span"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "action"' "$tmp_dir/$output_prefix.stdout.json"
    python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    grep -q '"events": 6' "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stderr.json"
}

run_agent_timeline_example() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.json" 2> "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"type": "action"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"source": "product.action"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"source": "network.milestone"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"routeTemplate": "/checkout/:step"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"routeTemplate": "/payments/:id"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"method": "POST"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"statusCode": 202' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"durationMs": 94' "$tmp_dir/$output_prefix.stdout.json"
    if grep -q 'private@example.test' "$tmp_dir/$output_prefix.stdout.json"; then
        echo "agent timeline leaked query text" >&2
        exit 1
    fi
    if grep -q '"card"' "$tmp_dir/$output_prefix.stdout.json"; then
        echo "agent timeline leaked payload metadata" >&2
        exit 1
    fi
    if grep -q '"authorization"' "$tmp_dir/$output_prefix.stdout.json"; then
        echo "agent timeline leaked header metadata" >&2
        exit 1
    fi
    grep -q '"events": 2' "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"' "$tmp_dir/$output_prefix.stderr.json"
}

run_first_useful_telemetry_example() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.json" 2> "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"type": "release"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "environment"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "log"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "action"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "metric"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "span"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"id": "evt_release_checkout_api"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"id": "evt_environment_checkout_api"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"id": "evt_action_checkout_started"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"id": "evt_network_payment_authorized"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"id": "evt_metric_checkout_duration"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"id": "evt_span_checkout_request"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"routeTemplate": "/checkout/:cart_id"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"routeTemplate": "/payments/:payment_id"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"parentSpanId": "00f067aa0ba902b7"' "$tmp_dir/$output_prefix.stdout.json"
    if grep -q 'coupon=private' "$tmp_dir/$output_prefix.stdout.json"; then
        echo "first useful telemetry leaked query text" >&2
        exit 1
    fi
    if grep -q 'card=private' "$tmp_dir/$output_prefix.stdout.json"; then
        echo "first useful telemetry leaked payload text" >&2
        exit 1
    fi
    if grep -q '"authorization"' "$tmp_dir/$output_prefix.stdout.json"; then
        echo "first useful telemetry leaked header metadata" >&2
        exit 1
    fi
    python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    grep -q '"events": 7' "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"requestSpan": "evt_span_checkout_request"' "$tmp_dir/$output_prefix.stderr.json"
}

check_packaged_examples_listing() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.txt"
    grep -qx 'agent-timeline -> python -m logbrew_sdk.examples agent-timeline' <(sed -n '1p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'first-useful-telemetry -> python -m logbrew_sdk.examples first-useful-telemetry' <(sed -n '2p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'readme-example -> python -m logbrew_sdk.examples readme-example' <(sed -n '3p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'real-user-smoke -> python -m logbrew_sdk.examples real-user-smoke' <(sed -n '4p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'default (real-user-smoke) -> python -m logbrew_sdk.examples' <(sed -n '5p' "$tmp_dir/$output_prefix.stdout.txt")
    test "$(wc -l < "$tmp_dir/$output_prefix.stdout.txt" | tr -d ' ')" = "5"
}

check_packaged_examples_help() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.txt"
    grep -q '^usage:' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q 'Run the packaged LogBrew SDK examples' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q 'installed Python' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q 'package\.' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q -- '--list' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q 'agent-timeline' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q 'first-useful-telemetry' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q 'readme-example' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q 'real-user-smoke' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q '^Packaged examples:$' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q '^  agent-timeline -> python -m logbrew_sdk.examples agent-timeline$' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q '^  first-useful-telemetry -> python -m logbrew_sdk.examples first-useful-telemetry$' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q '^  readme-example -> python -m logbrew_sdk.examples readme-example$' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q '^  real-user-smoke -> python -m logbrew_sdk.examples real-user-smoke$' "$tmp_dir/$output_prefix.stdout.txt"
    grep -Fqx '  default (real-user-smoke) -> python -m logbrew_sdk.examples' <(grep '^  default ' "$tmp_dir/$output_prefix.stdout.txt")
}

check_makefile_help() {
    local output_prefix="$1"

    run_make > "$tmp_dir/$output_prefix.stdout.txt"
    grep -qx 'smoke-types -> make smoke-types' <(sed -n '1p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-test -> make smoke-test' <(sed -n '2p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-readme -> make smoke-readme' <(sed -n '3p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-packaged-example -> make smoke-packaged-example' <(sed -n '4p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-packaged-smoke -> make smoke-packaged-smoke' <(sed -n '5p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-packaged-examples-readme -> make smoke-packaged-examples-readme' <(sed -n '6p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-packaged-examples-agent-timeline -> make smoke-packaged-examples-agent-timeline' <(sed -n '7p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-packaged-examples-first-useful-telemetry -> make smoke-packaged-examples-first-useful-telemetry' <(sed -n '8p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-packaged-examples-list -> make smoke-packaged-examples-list' <(sed -n '9p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-packaged-examples-help -> make smoke-packaged-examples-help' <(sed -n '10p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-packaged-examples (default packaged entrypoint) -> make smoke-packaged-examples' <(sed -n '11p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-run (real-user-smoke) -> make smoke-run' <(sed -n '12p' "$tmp_dir/$output_prefix.stdout.txt")
    test "$(wc -l < "$tmp_dir/$output_prefix.stdout.txt" | tr -d ' ')" = "12"
}

run_smoke_script() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.json" 2> "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"type": "release"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "environment"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "issue"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "log"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "span"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"type": "action"' "$tmp_dir/$output_prefix.stdout.json"
    python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    grep -q '"events": 6' "$tmp_dir/$output_prefix.stderr.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stderr.json"
}

run_logging_smoke() {
    local output_prefix="$1"

    python "$tmp_dir/logging_smoke.py" > "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"deliveries": 2' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"firstLevel": "warning"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"secondLevel": "error"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"logger": "checkout.worker"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"orderId": "ord_123"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"exceptionName": "RuntimeError"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"hasPathname": false' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"hasExceptionText": false' "$tmp_dir/$output_prefix.stdout.json"
}

run_http_transport_smoke() {
    local output_prefix="$1"

    python "$tmp_dir/http_transport_smoke.py" > "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"httpAttempts": 2' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"httpEvents": 1' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"status": 202' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"pending": 0' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"requestCount": 2' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"authorization": "Bearer LOGBREW_API_KEY"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"source": "python-smoke"' "$tmp_dir/$output_prefix.stdout.json"
}

run_urlopen_span_smoke() {
    local output_prefix="$1"

    python "$tmp_dir/urlopen_span_smoke.py" > "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"status": 202' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"events": 1' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"activeSpan": "b7ad6b7169203331"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"routeTemplate": "/payments/123"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"method": "GET"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"callerHeader": "checkout"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"captureErrors": 1' "$tmp_dir/$output_prefix.stdout.json"
}

run_requests_span_smoke() {
    local output_prefix="$1"

    python "$tmp_dir/requests_span_smoke.py" > "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"ok": true' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"status": 201' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"events": 1' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"activeSpan": "b7ad6b7169203334"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203334-01"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"routeTemplate": "/payments/:payment_id"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"method": "POST"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"callerHeader": "checkout"' "$tmp_dir/$output_prefix.stdout.json"
    grep -q '"captureErrors": 1' "$tmp_dir/$output_prefix.stdout.json"
}

run_reinstall_from_freeze() {
    local freeze_file="$1"
    local expected_suffix="$2"
    local output_prefix="$3"
    local venv_path="$tmp_dir/$output_prefix-freeze-venv"
    local report_path="$tmp_dir/$output_prefix-freeze-pip-install-report.json"
    local inspect_path="$tmp_dir/$output_prefix-freeze-pip-inspect.json"
    local pip_show_path="$tmp_dir/$output_prefix-freeze-pip-show.txt"
    local pip_show_files_path="$tmp_dir/$output_prefix-freeze-pip-show-files.txt"
    local pip_list_path="$tmp_dir/$output_prefix-freeze-pip-list.json"

    python3 -m venv "$venv_path"
    source "$venv_path/bin/activate"

    python -m pip install --upgrade pip >/dev/null
    python -m pip install mypy >/dev/null
    python -m pip install --report "$report_path" -r "$freeze_file" >/dev/null
    python -m pip check >/dev/null
    python -m pip show logbrew-sdk > "$pip_show_path"
    python -m pip show -f logbrew-sdk > "$pip_show_files_path"
    python -m pip list --format=json > "$pip_list_path"
    python -m pip inspect > "$inspect_path"

    python "$tmp_dir/module_doc.py"
    check_makefile_help "$output_prefix-freeze-make-help"
    run_make smoke-types >/dev/null
    python "$tmp_dir/metadata.py" "$expected_suffix" "$report_path" "$inspect_path" "$pip_show_path" "$pip_show_files_path" "$pip_list_path"
    run_readme_example "smoke-readme" "$output_prefix-freeze-readme-example"
    run_packaged_example_module "smoke-packaged-example" "$output_prefix-freeze-packaged-example"
    run_packaged_real_user_module "smoke-packaged-smoke" "$output_prefix-freeze-packaged-smoke"
    run_packaged_example_module "smoke-packaged-examples-readme" "$output_prefix-freeze-packaged-examples-readme"
    run_agent_timeline_example "smoke-packaged-examples-agent-timeline" "$output_prefix-freeze-packaged-examples-agent-timeline"
    run_first_useful_telemetry_example "smoke-packaged-examples-first-useful-telemetry" "$output_prefix-freeze-packaged-examples-first-useful-telemetry"
    check_packaged_examples_listing "smoke-packaged-examples-list" "$output_prefix-freeze-packaged-examples-list"
    check_packaged_examples_help "smoke-packaged-examples-help" "$output_prefix-freeze-packaged-examples-help"
    run_packaged_examples_entrypoint "smoke-packaged-examples" "$output_prefix-freeze-packaged-examples"
    run_smoke_script "smoke-run" "$output_prefix-freeze-smoke"
    run_logging_smoke "$output_prefix-freeze-logging"
    run_http_transport_smoke "$output_prefix-freeze-http-transport"
    run_urlopen_span_smoke "$output_prefix-freeze-urlopen-span"
    run_requests_span_smoke "$output_prefix-freeze-requests-span"

    deactivate
}

run_reinstall_from_direct_requirement() {
    local requirements_file="$1"
    local expected_suffix="$2"
    local output_prefix="$3"
    local venv_path="$tmp_dir/$output_prefix-direct-venv"
    local report_path="$tmp_dir/$output_prefix-direct-pip-install-report.json"
    local inspect_path="$tmp_dir/$output_prefix-direct-pip-inspect.json"
    local pip_show_path="$tmp_dir/$output_prefix-direct-pip-show.txt"
    local pip_show_files_path="$tmp_dir/$output_prefix-direct-pip-show-files.txt"
    local pip_list_path="$tmp_dir/$output_prefix-direct-pip-list.json"

    python3 -m venv "$venv_path"
    source "$venv_path/bin/activate"

    python -m pip install --upgrade pip >/dev/null
    python -m pip install mypy >/dev/null
    python -m pip install --require-hashes --report "$report_path" -r "$requirements_file" >/dev/null
    python -m pip check >/dev/null
    python -m pip show logbrew-sdk > "$pip_show_path"
    python -m pip show -f logbrew-sdk > "$pip_show_files_path"
    python -m pip list --format=json > "$pip_list_path"
    python -m pip freeze > "$tmp_dir/$output_prefix-direct-pip-freeze.txt"
    grep -q "^logbrew-sdk @ file://.*${expected_suffix}#sha256=" "$tmp_dir/$output_prefix-direct-pip-freeze.txt"
    python -m pip inspect > "$inspect_path"

    python "$tmp_dir/module_doc.py"
    check_makefile_help "$output_prefix-direct-make-help"
    run_make smoke-types >/dev/null
    run_make smoke-test >/dev/null
    python "$tmp_dir/metadata.py" "$expected_suffix" "$report_path" "$inspect_path" "$pip_show_path" "$pip_show_files_path" "$pip_list_path"
    run_readme_example "smoke-readme" "$output_prefix-direct-readme-example"
    run_packaged_example_module "smoke-packaged-example" "$output_prefix-direct-packaged-example"
    run_packaged_real_user_module "smoke-packaged-smoke" "$output_prefix-direct-packaged-smoke"
    run_packaged_example_module "smoke-packaged-examples-readme" "$output_prefix-direct-packaged-examples-readme"
    run_agent_timeline_example "smoke-packaged-examples-agent-timeline" "$output_prefix-direct-packaged-examples-agent-timeline"
    run_first_useful_telemetry_example "smoke-packaged-examples-first-useful-telemetry" "$output_prefix-direct-packaged-examples-first-useful-telemetry"
    check_packaged_examples_listing "smoke-packaged-examples-list" "$output_prefix-direct-packaged-examples-list"
    check_packaged_examples_help "smoke-packaged-examples-help" "$output_prefix-direct-packaged-examples-help"
    run_packaged_examples_entrypoint "smoke-packaged-examples" "$output_prefix-direct-packaged-examples"
    run_smoke_script "smoke-run" "$output_prefix-direct-smoke"
    run_logging_smoke "$output_prefix-direct-logging"
    run_http_transport_smoke "$output_prefix-direct-http-transport"
    run_urlopen_span_smoke "$output_prefix-direct-urlopen-span"
    run_requests_span_smoke "$output_prefix-direct-requests-span"

    deactivate
}

assert_python_package_removed() {
    local pip_list_path="$1"

    if python -m pip show logbrew-sdk >/dev/null 2>&1; then
        echo "expected logbrew-sdk to be removed by pip uninstall" >&2
        exit 1
    fi
    python -m pip list --format=json > "$pip_list_path"
    python - "$pip_list_path" <<'EOF'
import importlib.util
import json
from pathlib import Path
import sys

if importlib.util.find_spec("logbrew_sdk") is not None:
    raise SystemExit("expected logbrew_sdk module to be absent after uninstall")

packages = json.loads(Path(sys.argv[1]).read_text())
if any(item.get("name") == "logbrew-sdk" for item in packages):
    raise SystemExit("expected logbrew-sdk to be absent from pip list after uninstall")
EOF
}

python3 -m venv "$tmp_dir/build-venv"
"$tmp_dir/build-venv/bin/python" -m pip install --upgrade pip build >/dev/null
"$tmp_dir/build-venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/dist" "$repo_root/python/logbrew_py" > "$tmp_dir/build.log" 2>&1
wheel_path="$(find "$tmp_dir/dist" -maxdepth 1 -name 'logbrew_sdk-*.whl' | head -n 1)"
export LOGBREW_WHEEL_PATH="$wheel_path"
export LOGBREW_PYTHON_DIST_INFO_DIR="$dist_info_dir"
python3 - <<'PY'
from pathlib import Path
import os
import zipfile

wheel_path = Path(os.environ["LOGBREW_WHEEL_PATH"])
dist_info_dir = os.environ["LOGBREW_PYTHON_DIST_INFO_DIR"]
package_version = os.environ["LOGBREW_PYTHON_PACKAGE_VERSION"]
with zipfile.ZipFile(wheel_path) as archive:
    names = set(archive.namelist())
    required = {
        "logbrew_sdk/_http_client.py",
        "logbrew_sdk/__init__.py",
        "logbrew_sdk/_timeline.py",
        "logbrew_sdk/_trace_context.py",
        "logbrew_sdk/examples/__init__.py",
        "logbrew_sdk/examples/__main__.py",
        "logbrew_sdk/examples/agent_timeline.py",
        "logbrew_sdk/examples/first_useful_telemetry.py",
        "logbrew_sdk/examples/readme_example.py",
        "logbrew_sdk/examples/real_user_smoke.py",
        "logbrew_sdk/py.typed",
        f"{dist_info_dir}/METADATA",
        f"{dist_info_dir}/WHEEL",
        f"{dist_info_dir}/RECORD",
    }
    missing = sorted(required - names)
    if missing:
        raise SystemExit(f"missing wheel payload files: {missing}")
    metadata = archive.read(f"{dist_info_dir}/METADATA").decode("utf-8")
for needle in (
    "Name: logbrew-sdk",
    f"Version: {package_version}",
    "python3 -m pip install logbrew-sdk",
    "LOGBREW_API_KEY",
    "preview_json()",
    "HttpTransport",
    "LogBrewLoggingHandler",
    "requests_request_with_logbrew_span",
    "urlopen_with_logbrew_span",
    "parse_traceparent",
    "create_product_action_attributes",
    "create_network_milestone_attributes",
    "span_attributes_from_traceparent",
    "first-useful-telemetry",
):
    if needle not in metadata:
        raise SystemExit(f"missing wheel metadata guidance: {needle}")
PY
sdist_path="$(find "$tmp_dir/dist" -maxdepth 1 -name 'logbrew_sdk-*.tar.gz' | head -n 1)"
export LOGBREW_SDIST_PATH="$sdist_path"
export LOGBREW_TMP_DIR="$tmp_dir"
export LOGBREW_PYTHON_SDIST_ROOT="$sdist_root"
python3 - <<'PY'
from pathlib import Path
import os
import tarfile

sdist_path = Path(os.environ["LOGBREW_SDIST_PATH"])
tmp_dir = Path(os.environ["LOGBREW_TMP_DIR"])
sdist_root = os.environ["LOGBREW_PYTHON_SDIST_ROOT"]

with tarfile.open(sdist_path, "r:gz") as archive:
    members = {member.name.lstrip("./"): member for member in archive.getmembers()}
    names = set(members)
    (tmp_dir / "sdist-contents.txt").write_text("\n".join(sorted(names)) + "\n")

    required = {
        f"{sdist_root}/README.md",
        f"{sdist_root}/pyproject.toml",
        f"{sdist_root}/src/logbrew_sdk/_http_client.py",
        f"{sdist_root}/src/logbrew_sdk/_timeline.py",
        f"{sdist_root}/src/logbrew_sdk/_trace_context.py",
        f"{sdist_root}/src/logbrew_sdk/py.typed",
        f"{sdist_root}/src/logbrew_sdk/examples/__init__.py",
        f"{sdist_root}/src/logbrew_sdk/examples/__main__.py",
        f"{sdist_root}/src/logbrew_sdk/examples/agent_timeline.py",
        f"{sdist_root}/src/logbrew_sdk/examples/first_useful_telemetry.py",
        f"{sdist_root}/src/logbrew_sdk/examples/readme_example.py",
        f"{sdist_root}/src/logbrew_sdk/examples/real_user_smoke.py",
    }
    missing = sorted(required - names)
    if missing:
        raise SystemExit(f"missing sdist payload files: {missing}")

    def read_text(member_name: str) -> str:
        extracted = archive.extractfile(members[member_name])
        if extracted is None:
            raise SystemExit(f"sdist member is not a regular file: {member_name}")
        return extracted.read().decode("utf-8")

    readme = read_text(f"{sdist_root}/README.md")
    pyproject = read_text(f"{sdist_root}/pyproject.toml")

(tmp_dir / "sdist-README.md").write_text(readme)
(tmp_dir / "sdist-pyproject.toml").write_text(pyproject)

for needle in (
    "python3 -m pip install logbrew-sdk",
    "LOGBREW_API_KEY",
    "preview_json()",
    "HttpTransport",
    "LogBrewLoggingHandler",
    "requests_request_with_logbrew_span",
    "urlopen_with_logbrew_span",
    "parse_traceparent",
    "create_product_action_attributes",
    "create_network_milestone_attributes",
    "span_attributes_from_traceparent",
    "first-useful-telemetry",
):
    if needle not in readme:
        raise SystemExit(f"missing sdist README guidance: {needle}")

for needle in (
    'readme = "README.md"',
    'name = "logbrew-sdk"',
):
    if needle not in pyproject.splitlines():
        raise SystemExit(f"missing sdist pyproject metadata: {needle}")
PY

python3 -m venv "$tmp_dir/venv"
source "$tmp_dir/venv/bin/activate"

python -m pip install --upgrade pip >/dev/null
python -m pip install mypy >/dev/null
python -m pip install --report "$tmp_dir/pip-install-report.json" "$wheel_path" >/dev/null
python -m pip check >/dev/null
python -m pip show logbrew-sdk > "$tmp_dir/pip-show.txt"
python -m pip show -f logbrew-sdk > "$tmp_dir/pip-show-files.txt"
python -m pip list --format=json > "$tmp_dir/pip-list.json"
python -m pip freeze > "$tmp_dir/pip-freeze.txt"
grep -q "^logbrew-sdk @ file://.*${wheel_artifact}#sha256=" "$tmp_dir/pip-freeze.txt"
grep "^logbrew-sdk @ file://.*${wheel_artifact}#sha256=" "$tmp_dir/pip-freeze.txt" > "$tmp_dir/pip-direct-requirements.txt"
test "$(wc -l < "$tmp_dir/pip-direct-requirements.txt" | tr -d ' ')" = "1"
python -m pip inspect > "$tmp_dir/pip-inspect.json"

cat > "$tmp_dir/module_doc.py" <<'EOF'
import inspect
from typing import Annotated, get_args, get_origin, get_type_hints
import logbrew_sdk

doc = (logbrew_sdk.__doc__ or "").strip()
if doc != "Public Python client for building, validating, previewing, and flushing LogBrew event batches.":
    raise SystemExit(f"unexpected module docstring: {doc!r}")

release_doc = inspect.getdoc(logbrew_sdk.ReleaseAttributes)
if release_doc != "Public release event attributes.":
    raise SystemExit(f"unexpected ReleaseAttributes docstring: {release_doc!r}")

environment_doc = inspect.getdoc(logbrew_sdk.EnvironmentAttributes)
if environment_doc != "Public environment event attributes.":
    raise SystemExit(f"unexpected EnvironmentAttributes docstring: {environment_doc!r}")

issue_doc = inspect.getdoc(logbrew_sdk.IssueAttributes)
if issue_doc != "Public issue event attributes.":
    raise SystemExit(f"unexpected IssueAttributes docstring: {issue_doc!r}")

log_doc = inspect.getdoc(logbrew_sdk.LogAttributes)
if log_doc != "Public log event attributes.":
    raise SystemExit(f"unexpected LogAttributes docstring: {log_doc!r}")

metric_doc = inspect.getdoc(logbrew_sdk.MetricAttributes)
if metric_doc != "Public metric event attributes.":
    raise SystemExit(f"unexpected MetricAttributes docstring: {metric_doc!r}")

span_doc = inspect.getdoc(logbrew_sdk.SpanAttributes)
if span_doc != "Public span event attributes.":
    raise SystemExit(f"unexpected SpanAttributes docstring: {span_doc!r}")

action_doc = inspect.getdoc(logbrew_sdk.ActionAttributes)
if action_doc != "Public action event attributes.":
    raise SystemExit(f"unexpected ActionAttributes docstring: {action_doc!r}")

client_doc = inspect.getdoc(logbrew_sdk.LogBrewClient)
if client_doc != "Buffered public client for validating, previewing, and flushing LogBrew events.":
    raise SystemExit(f"unexpected LogBrewClient docstring: {client_doc!r}")

create_doc = inspect.getdoc(logbrew_sdk.LogBrewClient.create)
if create_doc != "Create a client from public SDK identity, retry, and API key settings.":
    raise SystemExit(f"unexpected LogBrewClient.create docstring: {create_doc!r}")

transport_doc = inspect.getdoc(logbrew_sdk.RecordingTransport)
if transport_doc != "Scripted transport for previewing, accepting, or failing queued event flushes.":
    raise SystemExit(f"unexpected RecordingTransport docstring: {transport_doc!r}")

http_transport_doc = inspect.getdoc(logbrew_sdk.HttpTransport)
if http_transport_doc != "Dependency-free HTTP transport for sending queued batches to LogBrew.":
    raise SystemExit(f"unexpected HttpTransport docstring: {http_transport_doc!r}")

http_transport_send_doc = inspect.getdoc(logbrew_sdk.HttpTransport.send)
if http_transport_send_doc != "POST one serialized event batch and return the HTTP status.":
    raise SystemExit(f"unexpected HttpTransport.send docstring: {http_transport_send_doc!r}")

preview_doc = inspect.getdoc(logbrew_sdk.LogBrewClient.preview_json)
if preview_doc != "Return the queued event batch as stable, pretty-printed JSON.":
    raise SystemExit(f"unexpected LogBrewClient.preview_json docstring: {preview_doc!r}")

flush_doc = inspect.getdoc(logbrew_sdk.LogBrewClient.flush)
if flush_doc != "Flush queued events through a transport while preserving retry semantics.":
    raise SystemExit(f"unexpected LogBrewClient.flush docstring: {flush_doc!r}")

shutdown_doc = inspect.getdoc(logbrew_sdk.LogBrewClient.shutdown)
if shutdown_doc != "Flush queued events, then mark the client closed so later writes fail.":
    raise SystemExit(f"unexpected LogBrewClient.shutdown docstring: {shutdown_doc!r}")

pending_doc = inspect.getdoc(logbrew_sdk.LogBrewClient.pending_events)
if pending_doc != "Return the queued event count currently buffered in memory.":
    raise SystemExit(f"unexpected LogBrewClient.pending_events docstring: {pending_doc!r}")

always_accept_doc = inspect.getdoc(logbrew_sdk.RecordingTransport.always_accept)
if always_accept_doc != "Create a transport that accepts queued flushes with a 202 response.":
    raise SystemExit(f"unexpected RecordingTransport.always_accept docstring: {always_accept_doc!r}")

last_body_doc = inspect.getdoc(logbrew_sdk.RecordingTransport.last_body)
if last_body_doc != "Return the most recent request body sent through this transport.":
    raise SystemExit(f"unexpected RecordingTransport.last_body docstring: {last_body_doc!r}")

response_doc = inspect.getdoc(logbrew_sdk.TransportResponse)
if response_doc != "Stable transport response returned from flush and shutdown operations.":
    raise SystemExit(f"unexpected TransportResponse docstring: {response_doc!r}")

response_hints = get_type_hints(logbrew_sdk.TransportResponse, include_extras=True)
status_hint = response_hints.get("status_code")
if get_origin(status_hint) is not Annotated or get_args(status_hint)[1] != "Final HTTP-like status returned by the transport.":
    raise SystemExit(f"unexpected TransportResponse.status_code metadata: {status_hint!r}")

attempts_hint = response_hints.get("attempts")
if get_origin(attempts_hint) is not Annotated or get_args(attempts_hint)[1] != "Number of transport attempts used for the flush.":
    raise SystemExit(f"unexpected TransportResponse.attempts metadata: {attempts_hint!r}")

transport_hints = get_type_hints(logbrew_sdk.RecordingTransport, include_extras=True)
sent_bodies_hint = transport_hints.get("sent_bodies")
if get_origin(sent_bodies_hint) is not Annotated or get_args(sent_bodies_hint)[1] != "Every request body sent through this transport instance.":
    raise SystemExit(f"unexpected RecordingTransport.sent_bodies metadata: {sent_bodies_hint!r}")

sdk_error_doc = inspect.getdoc(logbrew_sdk.SdkError)
if sdk_error_doc != "Stable public SDK error with parseable code and message fields.":
    raise SystemExit(f"unexpected SdkError docstring: {sdk_error_doc!r}")

transport_error_doc = inspect.getdoc(logbrew_sdk.TransportError)
if transport_error_doc != "Transport failure with a stable public code and retry hint.":
    raise SystemExit(f"unexpected TransportError docstring: {transport_error_doc!r}")

network_doc = inspect.getdoc(logbrew_sdk.TransportError.network)
if network_doc != "Create a retryable network failure that preserves queued events.":
    raise SystemExit(f"unexpected TransportError.network docstring: {network_doc!r}")

transport_protocol_doc = inspect.getdoc(logbrew_sdk.Transport)
if transport_protocol_doc != "Public transport protocol used by client flush, shutdown, and logging helpers.":
    raise SystemExit(f"unexpected Transport docstring: {transport_protocol_doc!r}")

trace_context_doc = inspect.getdoc(logbrew_sdk.TraceparentContext)
if trace_context_doc != "Parsed W3C traceparent context.":
    raise SystemExit(f"unexpected TraceparentContext docstring: {trace_context_doc!r}")

parse_traceparent_doc = inspect.getdoc(logbrew_sdk.parse_traceparent)
if parse_traceparent_doc != "Parse and validate a W3C traceparent header.":
    raise SystemExit(f"unexpected parse_traceparent docstring: {parse_traceparent_doc!r}")

create_traceparent_doc = inspect.getdoc(logbrew_sdk.create_traceparent)
if create_traceparent_doc != "Create a W3C traceparent header from explicit trace and span ids.":
    raise SystemExit(f"unexpected create_traceparent docstring: {create_traceparent_doc!r}")

product_action_doc = inspect.getdoc(logbrew_sdk.create_product_action_attributes)
if product_action_doc != "Build privacy-safe action attributes for app-owned product milestones.":
    raise SystemExit(f"unexpected create_product_action_attributes docstring: {product_action_doc!r}")

network_milestone_doc = inspect.getdoc(logbrew_sdk.create_network_milestone_attributes)
if network_milestone_doc != "Build privacy-safe action attributes for app-owned network milestones.":
    raise SystemExit(f"unexpected create_network_milestone_attributes docstring: {network_milestone_doc!r}")

span_from_traceparent_doc = inspect.getdoc(logbrew_sdk.span_attributes_from_traceparent)
if span_from_traceparent_doc != "Build LogBrew span attributes that continue an incoming W3C traceparent.":
    raise SystemExit(f"unexpected span_attributes_from_traceparent docstring: {span_from_traceparent_doc!r}")

traceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"
context = logbrew_sdk.parse_traceparent(traceparent)
if context.trace_id != "4bf92f3577b34da6a3ce929d0e0e4736":
    raise SystemExit(f"unexpected trace id: {context!r}")
if context.parent_span_id != "00f067aa0ba902b7" or context.sampled is not True:
    raise SystemExit(f"unexpected trace context: {context!r}")
created = logbrew_sdk.create_traceparent(
    trace_id=context.trace_id,
    span_id="b7ad6b7169203331",
    trace_flags="00",
)
if created != "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-00":
    raise SystemExit(f"unexpected created traceparent: {created!r}")
attributes = logbrew_sdk.span_attributes_from_traceparent(
    traceparent,
    name="GET /checkout",
    span_id="b7ad6b7169203331",
    status="ok",
    duration_ms=12.5,
    metadata={"service": "checkout", "skipped": {"nested": True}},
)
if attributes != {
    "name": "GET /checkout",
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "spanId": "b7ad6b7169203331",
    "parentSpanId": "00f067aa0ba902b7",
    "status": "ok",
    "durationMs": 12.5,
    "metadata": {"service": "checkout"},
}:
    raise SystemExit(f"unexpected continued span attributes: {attributes!r}")

product_action = logbrew_sdk.create_product_action_attributes(
    {
        "name": "checkout.submit",
        "status": "running",
        "sessionId": "sess_123",
        "traceId": context.trace_id,
        "routeTemplate": "/checkout/:step?email=private@example.test#payment",
        "metadata": {"service": "checkout", "payload": {"card": "private"}},
    }
)
if product_action.get("metadata") != {
    "source": "product.action",
    "service": "checkout",
    "routeTemplate": "/checkout/:step",
    "sessionId": "sess_123",
    "traceId": context.trace_id,
}:
    raise SystemExit(f"unexpected product action metadata: {product_action!r}")

network_milestone = logbrew_sdk.create_network_milestone_attributes(
    {
        "routeTemplate": "https://api.example.test/payments/:id?card=private#receipt",
        "method": "post",
        "statusCode": 503,
        "durationMs": 12,
        "metadata": {"service": "checkout", "headers": {"authorization": "private"}},
    }
)
if network_milestone != {
    "name": "network.post /payments/:id",
    "status": "failure",
    "metadata": {
        "source": "network.milestone",
        "service": "checkout",
        "routeTemplate": "/payments/:id",
        "method": "POST",
        "statusCode": 503,
        "durationMs": 12.0,
    },
}:
    raise SystemExit(f"unexpected network milestone attributes: {network_milestone!r}")

logging_handler_doc = inspect.getdoc(logbrew_sdk.LogBrewLoggingHandler)
if logging_handler_doc != "Standard-library logging handler that turns LogRecord objects into LogBrew log events.":
    raise SystemExit(f"unexpected LogBrewLoggingHandler docstring: {logging_handler_doc!r}")

logging_emit_doc = inspect.getdoc(logbrew_sdk.LogBrewLoggingHandler.emit)
if logging_emit_doc != "Queue one LogBrew log event from a standard-library log record.":
    raise SystemExit(f"unexpected LogBrewLoggingHandler.emit docstring: {logging_emit_doc!r}")

logging_flush_doc = inspect.getdoc(logbrew_sdk.LogBrewLoggingHandler.flush)
if logging_flush_doc != "Flush queued records when a transport was provided to the handler.":
    raise SystemExit(f"unexpected LogBrewLoggingHandler.flush docstring: {logging_flush_doc!r}")

log_attributes_doc = inspect.getdoc(logbrew_sdk.log_attributes_from_record)
if log_attributes_doc != "Convert a standard-library LogRecord into LogBrew log attributes.":
    raise SystemExit(f"unexpected log_attributes_from_record docstring: {log_attributes_doc!r}")
EOF

python "$tmp_dir/module_doc.py"

cat > "$tmp_dir/typecheck.py" <<'EOF'
import logging
from urllib.request import Request

from logbrew_sdk import (
    ActionAttributes,
    EnvironmentAttributes,
    HttpTransport,
    IssueAttributes,
    LogAttributes,
    LogBrewClient,
    LogBrewLoggingHandler,
    MetricAttributes,
    RecordingTransport,
    ReleaseAttributes,
    SpanAttributes,
    TraceparentContext,
    Transport,
    TransportResponse,
    create_network_milestone_attributes,
    create_product_action_attributes,
    create_traceparent,
    parse_traceparent,
    requests_request_with_logbrew_span,
    span_attributes_from_traceparent,
    urlopen_with_logbrew_span,
)

release: ReleaseAttributes = {
    "version": "1.2.3",
    "commit": "abc123def456",
}
environment: EnvironmentAttributes = {
    "name": "production",
    "region": "global",
}
issue: IssueAttributes = {
    "title": "Checkout timeout",
    "level": "error",
    "message": "Request timed out after retry budget",
}
log: LogAttributes = {
    "message": "worker started",
    "level": "info",
    "logger": "job-runner",
}
metric: MetricAttributes = {
    "name": "queue.depth",
    "kind": "gauge",
    "value": 42,
    "unit": "{items}",
    "temporality": "instant",
    "metadata": {"service": "worker"},
}
span: SpanAttributes = {
    "name": "GET /health",
    "traceId": "trace_001",
    "spanId": "span_001",
    "status": "ok",
    "durationMs": 12.5,
}
trace_context: TraceparentContext = parse_traceparent(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
)
continued_span: SpanAttributes = span_attributes_from_traceparent(
    create_traceparent(
        trace_id=trace_context.trace_id,
        span_id="00f067aa0ba902b7",
        trace_flags="01",
    ),
    name="GET /checkout",
    span_id="b7ad6b7169203331",
    status="ok",
)
action: ActionAttributes = {
    "name": "deploy",
    "status": "success",
}
product_action: ActionAttributes = create_product_action_attributes(
    {
        "name": "checkout.submit",
        "sessionId": "sess_123",
        "traceId": trace_context.trace_id,
        "routeTemplate": "/checkout/:step?email=private@example.test#payment",
        "metadata": {"service": "checkout", "payload": {"card": "private"}},
    }
)
network_milestone: ActionAttributes = create_network_milestone_attributes(
    {
        "routeTemplate": "https://api.example.test/payments/:id?card=private#receipt",
        "method": "post",
        "statusCode": 202,
        "durationMs": 94,
        "metadata": {"service": "checkout", "headers": {"authorization": "private"}},
    }
)

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-types",
    sdk_version="0.1.0",
)
client.release("evt_release_001", "2026-06-02T10:00:00Z", release)
client.environment("evt_environment_001", "2026-06-02T10:00:01Z", environment)
client.issue("evt_issue_001", "2026-06-02T10:00:02Z", issue)
client.log("evt_log_001", "2026-06-02T10:00:03Z", log)
client.span("evt_span_001", "2026-06-02T10:00:04Z", span)
client.span("evt_span_002", "2026-06-02T10:00:04Z", continued_span)
client.action("evt_action_001", "2026-06-02T10:00:05Z", action)
client.action("evt_action_002", "2026-06-02T10:00:05Z", product_action)
client.action("evt_action_003", "2026-06-02T10:00:06Z", network_milestone)
client.metric("evt_metric_001", "2026-06-02T10:00:06Z", metric)
response: TransportResponse = client.flush(RecordingTransport.always_accept())
if response.status_code != 202:
    raise RuntimeError("unexpected status")

logging_transport: Transport = RecordingTransport.always_accept()
http_transport: Transport = HttpTransport(endpoint="http://127.0.0.1:9/v1/events")
urlopen_response = urlopen_with_logbrew_span(
    Request("https://api.example.test/health", method="GET"),
    client=client,
    event_id="evt_urlopen_typecheck",
    timestamp="2026-06-02T10:00:07Z",
    open_url=lambda _request: type("Response", (), {"status": 204})(),
    span_id_factory=lambda: "b7ad6b7169203331",
)
if urlopen_response.status != 204:
    raise RuntimeError("unexpected urlopen status")

requests_response = requests_request_with_logbrew_span(
    "GET",
    "https://api.example.test/health?coupon=summer#fragment",
    client=client,
    event_id="evt_requests_typecheck",
    timestamp="2026-06-02T10:00:07Z",
    request=lambda _method, _url, **_kwargs: type("Response", (), {"status_code": 204})(),
    span_id_factory=lambda: "b7ad6b7169203332",
)
if requests_response.status_code != 204:
    raise RuntimeError("unexpected requests status")
handler = LogBrewLoggingHandler(
    client,
    logging_transport,
    flush_on_emit=True,
    metadata={"service": "checkout"},
)
record = logging.LogRecord(
    name="checkout.worker",
    level=logging.WARNING,
    pathname="worker.py",
    lineno=12,
    msg="typed logging event",
    args=(),
    exc_info=None,
)
handler.emit(record)
EOF

cat > "$tmp_dir/pyproject.toml" <<'EOF'
[tool.mypy]
python_version = "3.13"
strict = true
files = ["typecheck.py"]
EOF

cat > "$tmp_dir/installed_user_test.py" <<'EOF'
import unittest

from logbrew_sdk import LogBrewClient


class InstalledUserTest(unittest.TestCase):
    def test_preview_contains_release(self) -> None:
        client = LogBrewClient.create(
            api_key="LOGBREW_API_KEY",
            sdk_name="smoke-app-test",
            sdk_version="0.1.0",
        )
        client.release(
            "evt_release_test",
            "2026-06-02T10:00:00Z",
            {"version": "1.2.3"},
        )
        payload = client.preview_json()
        self.assertIn('"type": "release"', payload)

    def test_preview_contains_metric(self) -> None:
        client = LogBrewClient.create(
            api_key="LOGBREW_API_KEY",
            sdk_name="smoke-app-test",
            sdk_version="0.1.0",
        )
        client.metric(
            "evt_metric_test",
            "2026-06-02T10:00:06Z",
            {
                "name": "queue.depth",
                "kind": "gauge",
                "value": 42,
                "unit": "{items}",
                "temporality": "instant",
                "metadata": {"service": "worker"},
            },
        )
        payload = client.preview_json()
        self.assertIn('"type": "metric"', payload)
        self.assertIn('"temporality": "instant"', payload)


if __name__ == "__main__":
    unittest.main()
EOF

cat > "$tmp_dir/readme_example.py" <<'EOF'
import json
import sys

from logbrew_sdk import LogBrewClient, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-python",
    sdk_version="0.1.0",
)

client.release(
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    {
        "version": "1.2.3",
        "commit": "abc123def456",
        "notes": "Public release marker",
    },
)
client.environment(
    "evt_environment_001",
    "2026-06-02T10:00:01Z",
    {"name": "production", "region": "global"},
)
client.issue(
    "evt_issue_001",
    "2026-06-02T10:00:02Z",
    {
        "title": "Checkout timeout",
        "level": "error",
        "message": "Request timed out after retry budget",
    },
)
client.log(
    "evt_log_001",
    "2026-06-02T10:00:03Z",
    {"message": "worker started", "level": "info", "logger": "job-runner"},
)
client.span(
    "evt_span_001",
    "2026-06-02T10:00:04Z",
    {
        "name": "GET /health",
        "traceId": "trace_001",
        "spanId": "span_001",
        "status": "ok",
        "durationMs": 12.5,
    },
)
client.action(
    "evt_action_001",
    "2026-06-02T10:00:05Z",
    {"name": "deploy", "status": "success"},
)

print(client.preview_json())

transport = RecordingTransport.always_accept()
response = client.shutdown(transport)
print(
    json.dumps(
        {"ok": True, "status": response.status_code, "attempts": response.attempts, "events": 6}
    ),
    file=sys.stderr,
)
EOF

cat > "$tmp_dir/logging_smoke.py" <<'EOF'
import json
import logging

from logbrew_sdk import LogBrewClient, LogBrewLoggingHandler, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-logging",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
handler = LogBrewLoggingHandler(
    client,
    transport,
    flush_on_emit=True,
    metadata={"service": "checkout"},
)
logger = logging.getLogger("checkout.worker")
old_handlers = list(logger.handlers)
old_level = logger.level
old_propagate = logger.propagate
logger.handlers = []
logger.propagate = False
logger.setLevel(logging.INFO)
logger.addHandler(handler)

try:
    logger.warning(
        "retrying checkout",
        extra={"order_id": "ord_123", "non_primitive": {"ignored": True}},
    )
    try:
        raise RuntimeError("gateway failed")
    except RuntimeError:
        logger.exception("checkout failed")
finally:
    logger.removeHandler(handler)
    logger.handlers = old_handlers
    logger.setLevel(old_level)
    logger.propagate = old_propagate

first = json.loads(transport.sent_bodies[0])["events"][0]
second = json.loads(transport.sent_bodies[1])["events"][0]
first_metadata = first["attributes"]["metadata"]
second_metadata = second["attributes"]["metadata"]
print(
    json.dumps(
        {
            "ok": True,
            "deliveries": len(transport.sent_bodies),
            "exceptionName": second_metadata["exceptionName"],
            "firstLevel": first["attributes"]["level"],
            "hasExceptionText": "exceptionText" in second_metadata,
            "hasPathname": "pathname" in first_metadata,
            "logger": first["attributes"]["logger"],
            "orderId": first_metadata["order_id"],
            "secondLevel": second["attributes"]["level"],
        },
        sort_keys=True,
    )
)
EOF

cat > "$tmp_dir/http_transport_smoke.py" <<'EOF'
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading

from logbrew_sdk import HttpTransport, LogBrewClient

requests: list[dict[str, str]] = []


class IntakeHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        requests.append(
            {
                "authorization": self.headers.get("authorization", ""),
                "body": body,
                "contentType": self.headers.get("content-type", ""),
                "method": self.command,
                "path": self.path,
                "source": self.headers.get("x-logbrew-source", ""),
            }
        )
        self.send_response(503 if len(requests) == 1 else 202)
        self.end_headers()

    def log_message(self, _format: str, *_args: object) -> None:
        return


server = ThreadingHTTPServer(("127.0.0.1", 0), IntakeHandler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

try:
    port = server.server_address[1]
    client = LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="smoke-app-http",
        sdk_version="0.1.0",
        max_retries=1,
    )
    client.log(
        "evt_python_http_transport",
        "2026-06-02T10:00:06Z",
        {"message": "delivery retry", "level": "info", "logger": "worker"},
    )
    transport = HttpTransport(
        endpoint=f"http://127.0.0.1:{port}/v1/events",
        headers={"x-logbrew-source": "python-smoke"},
        timeout=5.0,
    )
    response = client.flush(transport)
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5.0)

if len(requests) != 2:
    raise SystemExit(f"expected two HTTP requests, got {len(requests)}")

first = requests[0]
last = requests[-1]
payload = json.loads(last["body"])
events = payload["events"]
if first["body"] != last["body"]:
    raise SystemExit("expected retry body to stay unchanged")
if last["authorization"] != "Bearer LOGBREW_API_KEY":
    raise SystemExit("expected authorization header")
if last["contentType"] != "application/json":
    raise SystemExit("expected JSON content type")
if last["method"] != "POST":
    raise SystemExit("expected POST method")
if last["path"] != "/v1/events":
    raise SystemExit("expected intake path")
if last["source"] != "python-smoke":
    raise SystemExit("expected custom source header")
if events[0]["id"] != "evt_python_http_transport":
    raise SystemExit("expected HTTP transport event id")

print(
    json.dumps(
        {
            "authorization": last["authorization"],
            "httpAttempts": response.attempts,
            "httpEvents": len(events),
            "ok": True,
            "pending": client.pending_events(),
            "requestCount": len(requests),
            "source": last["source"],
            "status": response.status_code,
        },
        sort_keys=True,
    )
)
EOF

cat > "$tmp_dir/urlopen_span_smoke.py" <<'EOF'
from __future__ import annotations

import json
from urllib.request import Request

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    urlopen_with_logbrew_span,
    use_logbrew_trace,
)


class StubHttpResponse:
    def __init__(self, status: int) -> None:
        self.status = status

    def getcode(self) -> int:
        return self.status


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-urlopen",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
request = Request(
    "https://api.example.test/payments/123?coupon=summer#receipt",
    headers={"traceparent": "spoofed", "x-caller": "checkout"},
    method="GET",
)
captured: dict[str, object] = {}


def open_url(outbound: Request, *, timeout: float | None = None) -> StubHttpResponse:
    active = get_active_logbrew_trace()
    captured["timeout"] = timeout
    captured["traceparent"] = outbound.get_header("Traceparent")
    captured["callerHeader"] = outbound.get_header("X-caller")
    captured["activeSpan"] = active.span_id if active is not None else None
    return StubHttpResponse(202)


with use_logbrew_trace(parent_trace):
    response = urlopen_with_logbrew_span(
        request,
        client=client,
        event_id="evt_python_urlopen_client",
        timestamp="2026-06-19T08:00:00Z",
        open_url=open_url,
        timeout=2.5,
        span_id_factory=lambda: "b7ad6b7169203331",
        clock=iter([10.0, 10.043]).__next__,
        metadata={"service": "checkout", "payload": {"card": "private"}},
    )

payload = json.loads(client.preview_json())
event = payload["events"][0]
metadata = event["attributes"]["metadata"]
if request.get_header("Traceparent") != "spoofed":
    raise SystemExit("caller request was mutated")
if "coupon=summer" in client.preview_json() or "traceparent" in client.preview_json() or "card" in client.preview_json():
    raise SystemExit("urlopen span leaked query, propagation, or payload data")

closed_client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-urlopen",
    sdk_version="0.1.0",
)
closed_client.closed = True
capture_errors: list[str] = []
urlopen_with_logbrew_span(
    "https://api.example.test/health",
    client=closed_client,
    event_id="evt_python_urlopen_capture_failure",
    timestamp="2026-06-19T08:00:01Z",
    open_url=lambda _request, *, timeout=None: StubHttpResponse(204),
    span_id_factory=lambda: "b7ad6b7169203332",
    on_capture_error=lambda error: capture_errors.append(str(error)),
)

print(
    json.dumps(
        {
            "activeSpan": captured["activeSpan"],
            "callerHeader": captured["callerHeader"],
            "captureErrors": len(capture_errors),
            "events": len(payload["events"]),
            "method": metadata["method"],
            "ok": True,
            "routeTemplate": metadata["routeTemplate"],
            "status": response.status,
            "statusCode": metadata["statusCode"],
            "timeout": captured["timeout"],
            "traceparent": captured["traceparent"],
        },
        sort_keys=True,
    )
)
EOF

cat > "$tmp_dir/requests_span_smoke.py" <<'EOF'
from __future__ import annotations

import json

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    requests_request_with_logbrew_span,
    use_logbrew_trace,
)


class StubRequestsResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class StubRequestsSession:
    def __init__(self) -> None:
        self.captured: dict[str, object] = {}

    def request(self, method: str, url: str, **kwargs: object) -> StubRequestsResponse:
        active = get_active_logbrew_trace()
        headers = kwargs.get("headers")
        if not isinstance(headers, dict):
            raise RuntimeError("headers were not cloned into a dict")
        self.captured = {
            "activeSpan": active.span_id if active is not None else None,
            "callerHeader": headers.get("x-caller"),
            "json": kwargs.get("json"),
            "method": method,
            "timeout": kwargs.get("timeout"),
            "traceparent": headers.get("traceparent"),
            "url": url,
        }
        return StubRequestsResponse(201)


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-requests",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
caller_headers = {"Traceparent": "spoofed", "x-caller": "checkout"}
session = StubRequestsSession()

with use_logbrew_trace(parent_trace):
    response = requests_request_with_logbrew_span(
        "post",
        "https://api.example.test/payments/123?coupon=summer#receipt",
        client=client,
        event_id="evt_python_requests_client",
        timestamp="2026-06-19T08:00:03Z",
        session=session,
        timeout=3.5,
        headers=caller_headers,
        json={"card": "private"},
        route_template="/payments/:payment_id",
        span_id_factory=lambda: "b7ad6b7169203334",
        clock=iter([30.0, 30.052]).__next__,
        metadata={"service": "checkout", "payload": {"private": True}},
    )

payload = json.loads(client.preview_json())
event = payload["events"][0]
metadata = event["attributes"]["metadata"]
if caller_headers["Traceparent"] != "spoofed":
    raise SystemExit("caller headers were mutated")
if "coupon=summer" in client.preview_json() or "traceparent" in client.preview_json() or "card" in client.preview_json():
    raise SystemExit("requests span leaked query, propagation, or payload data")

closed_client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-requests",
    sdk_version="0.1.0",
)
closed_client.closed = True
capture_errors: list[str] = []
requests_request_with_logbrew_span(
    "GET",
    "https://api.example.test/health",
    client=closed_client,
    event_id="evt_python_requests_capture_failure",
    timestamp="2026-06-19T08:00:04Z",
    request=lambda _method, _url, **_kwargs: StubRequestsResponse(204),
    span_id_factory=lambda: "b7ad6b7169203335",
    on_capture_error=lambda error: capture_errors.append(str(error)),
)

print(
    json.dumps(
        {
            "activeSpan": session.captured["activeSpan"],
            "callerHeader": session.captured["callerHeader"],
            "captureErrors": len(capture_errors),
            "events": len(payload["events"]),
            "method": metadata["method"],
            "ok": True,
            "routeTemplate": metadata["routeTemplate"],
            "status": response.status_code,
            "statusCode": metadata["statusCode"],
            "timeout": session.captured["timeout"],
            "traceparent": session.captured["traceparent"],
        },
        sort_keys=True,
    )
)
EOF

cat > "$tmp_dir/metadata.py" <<'EOF'
from importlib.metadata import distribution, files, metadata, version
from pathlib import Path
import json
import os
import sys

package_version = os.environ["LOGBREW_PYTHON_PACKAGE_VERSION"]
dist_info_dir = f"logbrew_sdk-{package_version}.dist-info"

if version("logbrew-sdk") != package_version:
    raise SystemExit("unexpected package version")

package_files = {str(path) for path in files("logbrew-sdk") or []}
required = {
    "logbrew_sdk/_http_client.py",
    "logbrew_sdk/_trace_context.py",
    "logbrew_sdk/py.typed",
    "logbrew_sdk/examples/__init__.py",
    "logbrew_sdk/examples/__main__.py",
    "logbrew_sdk/examples/readme_example.py",
    f"{dist_info_dir}/INSTALLER",
    f"{dist_info_dir}/METADATA",
    f"{dist_info_dir}/RECORD",
    f"{dist_info_dir}/direct_url.json",
}
missing = sorted(required - package_files)
if missing:
    raise SystemExit(f"missing installed package files: {missing}")

description = metadata("logbrew-sdk").get_payload()
for needle in (
    "python3 -m pip install logbrew-sdk",
    "LOGBREW_API_KEY",
    "preview_json()",
    "HttpTransport",
    "LogBrewLoggingHandler",
    "requests_request_with_logbrew_span",
    "urlopen_with_logbrew_span",
):
    if needle not in description:
        raise SystemExit(f"missing installed metadata guidance: {needle}")

dist = distribution("logbrew-sdk")
dist_info = Path(dist.locate_file(dist_info_dir))
installer = dist_info.joinpath("INSTALLER").read_text().strip()
if installer != "pip":
    raise SystemExit(f"unexpected installer: {installer!r}")

direct_url = json.loads(dist_info.joinpath("direct_url.json").read_text())
url = direct_url.get("url", "")
expected_suffix = sys.argv[1]
if not url.startswith("file://"):
    raise SystemExit(f"unexpected direct_url scheme: {url!r}")
if not url.endswith(expected_suffix):
    raise SystemExit(f"unexpected direct_url target: {url!r}")
archive_info = direct_url.get("archive_info", {})
hashes = archive_info.get("hashes", {})
sha256 = hashes.get("sha256", "")
if len(sha256) != 64:
    raise SystemExit(f"unexpected direct_url sha256 hash: {sha256!r}")
if archive_info.get("hash") != f"sha256={sha256}":
    raise SystemExit("unexpected direct_url hash summary")

report = json.loads(Path(sys.argv[2]).read_text())
if report.get("version") != "1":
    raise SystemExit(f"unexpected pip report version: {report.get('version')!r}")
install = report.get("install", [])
entry = None
for candidate in install:
    metadata_block = candidate.get("metadata", {})
    if metadata_block.get("name") == "logbrew-sdk":
        entry = candidate
        break
if entry is None:
    raise SystemExit("missing logbrew-sdk entry in pip report")
metadata_block = entry.get("metadata", {})
if metadata_block.get("name") != "logbrew-sdk":
    raise SystemExit(f"unexpected pip report package name: {metadata_block.get('name')!r}")
if metadata_block.get("version") != package_version:
    raise SystemExit(f"unexpected pip report package version: {metadata_block.get('version')!r}")
if entry.get("requested") is not True:
    raise SystemExit(f"unexpected pip report requested flag: {entry.get('requested')!r}")
if entry.get("is_direct") is not True:
    raise SystemExit(f"unexpected pip report direct flag: {entry.get('is_direct')!r}")
download_info = entry.get("download_info", {})
report_url = download_info.get("url", "")
if not report_url.startswith("file://"):
    raise SystemExit(f"unexpected pip report download scheme: {report_url!r}")
if not report_url.endswith(expected_suffix):
    raise SystemExit(f"unexpected pip report download target: {report_url!r}")
report_archive_info = download_info.get("archive_info", {})
report_hashes = report_archive_info.get("hashes", {})
report_sha256 = report_hashes.get("sha256", "")
if len(report_sha256) != 64:
    raise SystemExit(f"unexpected pip report sha256 hash: {report_sha256!r}")
if report_archive_info.get("hash") != f"sha256={report_sha256}":
    raise SystemExit("unexpected pip report hash summary")

inspect_payload = json.loads(Path(sys.argv[3]).read_text())
if inspect_payload.get("version") != "1":
    raise SystemExit(f"unexpected pip inspect version: {inspect_payload.get('version')!r}")
installed = inspect_payload.get("installed", [])
inspect_entry = None
for candidate in installed:
    metadata_block = candidate.get("metadata", {})
    if metadata_block.get("name") == "logbrew-sdk":
        inspect_entry = candidate
        break
if inspect_entry is None:
    raise SystemExit("missing logbrew-sdk entry in pip inspect output")
inspect_metadata = inspect_entry.get("metadata", {})
if inspect_metadata.get("name") != "logbrew-sdk":
    raise SystemExit(f"unexpected pip inspect package name: {inspect_metadata.get('name')!r}")
if inspect_metadata.get("version") != package_version:
    raise SystemExit(f"unexpected pip inspect package version: {inspect_metadata.get('version')!r}")
if inspect_entry.get("requested") is not True:
    raise SystemExit(f"unexpected pip inspect requested flag: {inspect_entry.get('requested')!r}")
if inspect_entry.get("installer") != "pip":
    raise SystemExit(f"unexpected pip inspect installer: {inspect_entry.get('installer')!r}")
inspect_direct_url = inspect_entry.get("direct_url", {})
inspect_url = inspect_direct_url.get("url", "")
if not inspect_url.startswith("file://"):
    raise SystemExit(f"unexpected pip inspect direct_url scheme: {inspect_url!r}")
if not inspect_url.endswith(expected_suffix):
    raise SystemExit(f"unexpected pip inspect direct_url target: {inspect_url!r}")
inspect_archive_info = inspect_direct_url.get("archive_info", {})
inspect_hashes = inspect_archive_info.get("hashes", {})
inspect_sha256 = inspect_hashes.get("sha256", "")
if len(inspect_sha256) != 64:
    raise SystemExit(f"unexpected pip inspect sha256 hash: {inspect_sha256!r}")
if inspect_archive_info.get("hash") != f"sha256={inspect_sha256}":
    raise SystemExit("unexpected pip inspect hash summary")

show_lines = Path(sys.argv[4]).read_text().splitlines()
show_pairs = {}
for line in show_lines:
    if ": " not in line:
        continue
    key, value = line.split(": ", 1)
    show_pairs[key] = value
expected_summary = "Public LogBrew Python SDK for building, validating, and flushing event batches."
if show_pairs.get("Name") != "logbrew-sdk":
    raise SystemExit(f"unexpected pip show package name: {show_pairs.get('Name')!r}")
if show_pairs.get("Version") != package_version:
    raise SystemExit(f"unexpected pip show package version: {show_pairs.get('Version')!r}")
if show_pairs.get("Summary") != expected_summary:
    raise SystemExit(f"unexpected pip show summary: {show_pairs.get('Summary')!r}")
if show_pairs.get("Author") != "LogBrew":
    raise SystemExit(f"unexpected pip show author: {show_pairs.get('Author')!r}")
if show_pairs.get("License-Expression") != "MIT":
    raise SystemExit(f"unexpected pip show license expression: {show_pairs.get('License-Expression')!r}")
location = show_pairs.get("Location", "")
if not location.endswith("/site-packages"):
    raise SystemExit(f"unexpected pip show location: {location!r}")
if show_pairs.get("Requires") != "":
    raise SystemExit(f"unexpected pip show requirements: {show_pairs.get('Requires')!r}")
if show_pairs.get("Required-by") != "":
    raise SystemExit(f"unexpected pip show required-by value: {show_pairs.get('Required-by')!r}")

show_files_lines = Path(sys.argv[5]).read_text().splitlines()
if "Files:" not in show_files_lines:
    raise SystemExit("missing Files section in pip show -f output")
files_index = show_files_lines.index("Files:")
listed_files = {
    line.strip()
    for line in show_files_lines[files_index + 1 :]
    if line.startswith("  ")
}
required_show_files = {
    f"{dist_info_dir}/INSTALLER",
    f"{dist_info_dir}/METADATA",
    f"{dist_info_dir}/RECORD",
    f"{dist_info_dir}/REQUESTED",
    f"{dist_info_dir}/WHEEL",
    f"{dist_info_dir}/direct_url.json",
    f"{dist_info_dir}/top_level.txt",
    "logbrew_sdk/_http_client.py",
    "logbrew_sdk/_trace_context.py",
    "logbrew_sdk/__init__.py",
    "logbrew_sdk/examples/__init__.py",
    "logbrew_sdk/examples/__main__.py",
    "logbrew_sdk/examples/readme_example.py",
    "logbrew_sdk/examples/real_user_smoke.py",
    "logbrew_sdk/py.typed",
}
missing_show_files = sorted(required_show_files - listed_files)
if missing_show_files:
    raise SystemExit(f"missing pip show -f file entries: {missing_show_files}")

pip_list_payload = json.loads(Path(sys.argv[6]).read_text())
if not isinstance(pip_list_payload, list):
    raise SystemExit("unexpected pip list payload")
pip_list_entry = next(
    (item for item in pip_list_payload if item.get("name") == "logbrew-sdk"),
    None,
)
if pip_list_entry is None:
    raise SystemExit("missing logbrew-sdk entry in pip list output")
if pip_list_entry.get("version") != package_version:
    raise SystemExit(f"unexpected pip list package version: {pip_list_entry.get('version')!r}")
EOF

python "$tmp_dir/metadata.py" "$wheel_artifact" "$tmp_dir/pip-install-report.json" "$tmp_dir/pip-inspect.json" "$tmp_dir/pip-show.txt" "$tmp_dir/pip-show-files.txt" "$tmp_dir/pip-list.json"

cat > "$tmp_dir/smoke.py" <<'EOF'
from logbrew_sdk import LogBrewClient, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app",
    sdk_version="0.1.0",
)

client.release(
    "evt_release_001",
    "2026-06-02T10:00:00Z",
    {"version": "1.2.3", "commit": "abc123def456", "notes": "Public release marker"},
)
client.environment(
    "evt_environment_001",
    "2026-06-02T10:00:01Z",
    {"name": "production", "region": "global"},
)
client.issue(
    "evt_issue_001",
    "2026-06-02T10:00:02Z",
    {"title": "Checkout timeout", "level": "error", "message": "Request timed out after retry budget"},
)
client.log(
    "evt_log_001",
    "2026-06-02T10:00:03Z",
    {"message": "worker started", "level": "info", "logger": "job-runner"},
)
client.span(
    "evt_span_001",
    "2026-06-02T10:00:04Z",
    {"name": "GET /health", "traceId": "trace_001", "spanId": "span_001", "status": "ok", "durationMs": 12.5},
)
client.action(
    "evt_action_001",
    "2026-06-02T10:00:05Z",
    {"name": "deploy", "status": "success"},
)

print(client.preview_json())
transport = RecordingTransport.always_accept()
response = client.shutdown(transport)
print(f'{{"ok": true, "status": {response.status_code}, "attempts": {response.attempts}, "events": 6}}', file=__import__("sys").stderr)
EOF

cat > "$tmp_dir/Makefile" <<'EOF'
.PHONY: help smoke-types smoke-test smoke-readme smoke-packaged-example smoke-packaged-smoke smoke-packaged-examples-readme smoke-packaged-examples-agent-timeline smoke-packaged-examples-first-useful-telemetry smoke-packaged-examples-list smoke-packaged-examples-help smoke-packaged-examples smoke-run

help:
	@printf '%s\n' \
		'smoke-types -> make smoke-types' \
		'smoke-test -> make smoke-test' \
		'smoke-readme -> make smoke-readme' \
		'smoke-packaged-example -> make smoke-packaged-example' \
		'smoke-packaged-smoke -> make smoke-packaged-smoke' \
		'smoke-packaged-examples-readme -> make smoke-packaged-examples-readme' \
		'smoke-packaged-examples-agent-timeline -> make smoke-packaged-examples-agent-timeline' \
		'smoke-packaged-examples-first-useful-telemetry -> make smoke-packaged-examples-first-useful-telemetry' \
		'smoke-packaged-examples-list -> make smoke-packaged-examples-list' \
		'smoke-packaged-examples-help -> make smoke-packaged-examples-help' \
		'smoke-packaged-examples (default packaged entrypoint) -> make smoke-packaged-examples' \
		'smoke-run (real-user-smoke) -> make smoke-run'

smoke-types:
	@python -m mypy --config-file pyproject.toml typecheck.py

smoke-test:
	@python -m unittest discover -s . -p 'installed_user_test.py'

smoke-readme:
	@python readme_example.py

smoke-packaged-example:
	@python -m logbrew_sdk.examples.readme_example

smoke-packaged-smoke:
	@python -m logbrew_sdk.examples.real_user_smoke

smoke-packaged-examples-readme:
	@python -m logbrew_sdk.examples readme-example

smoke-packaged-examples-agent-timeline:
	@python -m logbrew_sdk.examples agent-timeline

smoke-packaged-examples-first-useful-telemetry:
	@python -m logbrew_sdk.examples first-useful-telemetry

smoke-packaged-examples-list:
	@python -m logbrew_sdk.examples --list

smoke-packaged-examples-help:
	@python -m logbrew_sdk.examples --help

smoke-packaged-examples:
	@python -m logbrew_sdk.examples

smoke-run:
	@python smoke.py
EOF

grep -q '^\.PHONY: help smoke-types smoke-test smoke-readme smoke-packaged-example smoke-packaged-smoke smoke-packaged-examples-readme smoke-packaged-examples-agent-timeline smoke-packaged-examples-first-useful-telemetry smoke-packaged-examples-list smoke-packaged-examples-help smoke-packaged-examples smoke-run$' "$tmp_dir/Makefile"
grep -q '^help:$' "$tmp_dir/Makefile"
grep -q '^smoke-types:$' "$tmp_dir/Makefile"
grep -q '^smoke-test:$' "$tmp_dir/Makefile"
grep -q '^smoke-readme:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-example:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-smoke:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-examples-readme:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-examples-agent-timeline:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-examples-first-useful-telemetry:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-examples-list:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-examples-help:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-examples:$' "$tmp_dir/Makefile"
grep -q '^smoke-run:$' "$tmp_dir/Makefile"

check_makefile_help "wheel-make-help"
run_make smoke-types >/dev/null
run_make smoke-test >/dev/null
run_readme_example "smoke-readme" "wheel-readme-example"
run_packaged_example_module "smoke-packaged-example" "wheel-packaged-example"
run_packaged_real_user_module "smoke-packaged-smoke" "wheel-packaged-smoke"
run_packaged_example_module "smoke-packaged-examples-readme" "wheel-packaged-examples-readme"
run_agent_timeline_example "smoke-packaged-examples-agent-timeline" "wheel-packaged-examples-agent-timeline"
run_first_useful_telemetry_example "smoke-packaged-examples-first-useful-telemetry" "wheel-packaged-examples-first-useful-telemetry"
check_packaged_examples_listing "smoke-packaged-examples-list" "wheel-packaged-examples-list"
check_packaged_examples_help "smoke-packaged-examples-help" "wheel-packaged-examples-help"
run_packaged_examples_entrypoint "smoke-packaged-examples" "wheel-packaged-examples"
run_smoke_script "smoke-run" "smoke"
run_logging_smoke "wheel-logging"
run_http_transport_smoke "wheel-http-transport"
run_urlopen_span_smoke "wheel-urlopen-span"
run_requests_span_smoke "wheel-requests-span"

python -m pip uninstall -y logbrew-sdk >/dev/null
assert_python_package_removed "$tmp_dir/pip-uninstall-list.json"

python -m pip install --report "$tmp_dir/pip-reinstall-report.json" "$wheel_path" >/dev/null
python -m pip check >/dev/null
python -m pip show logbrew-sdk > "$tmp_dir/pip-reinstall-show.txt"
python -m pip show -f logbrew-sdk > "$tmp_dir/pip-reinstall-show-files.txt"
python -m pip list --format=json > "$tmp_dir/pip-reinstall-list.json"
python -m pip inspect > "$tmp_dir/pip-reinstall-inspect.json"

python "$tmp_dir/module_doc.py"
check_makefile_help "wheel-reinstall-make-help"
run_make smoke-types >/dev/null
run_make smoke-test >/dev/null
python "$tmp_dir/metadata.py" "$wheel_artifact" "$tmp_dir/pip-reinstall-report.json" "$tmp_dir/pip-reinstall-inspect.json" "$tmp_dir/pip-reinstall-show.txt" "$tmp_dir/pip-reinstall-show-files.txt" "$tmp_dir/pip-reinstall-list.json"
run_readme_example "smoke-readme" "wheel-reinstall-readme-example"
run_packaged_example_module "smoke-packaged-example" "wheel-reinstall-packaged-example"
run_packaged_real_user_module "smoke-packaged-smoke" "wheel-reinstall-packaged-smoke"
run_packaged_example_module "smoke-packaged-examples-readme" "wheel-reinstall-packaged-examples-readme"
run_agent_timeline_example "smoke-packaged-examples-agent-timeline" "wheel-reinstall-packaged-examples-agent-timeline"
run_first_useful_telemetry_example "smoke-packaged-examples-first-useful-telemetry" "wheel-reinstall-packaged-examples-first-useful-telemetry"
check_packaged_examples_listing "smoke-packaged-examples-list" "wheel-reinstall-packaged-examples-list"
check_packaged_examples_help "smoke-packaged-examples-help" "wheel-reinstall-packaged-examples-help"
run_packaged_examples_entrypoint "smoke-packaged-examples" "wheel-reinstall-packaged-examples"
run_smoke_script "smoke-run" "smoke-reinstall"
run_logging_smoke "wheel-reinstall-logging"
run_http_transport_smoke "wheel-reinstall-http-transport"
run_urlopen_span_smoke "wheel-reinstall-urlopen-span"
run_requests_span_smoke "wheel-reinstall-requests-span"

deactivate
run_reinstall_from_freeze "$tmp_dir/pip-freeze.txt" "$wheel_artifact" "wheel"
run_reinstall_from_direct_requirement "$tmp_dir/pip-direct-requirements.txt" "$wheel_artifact" "wheel"

python3 -m venv "$tmp_dir/sdist-venv"
source "$tmp_dir/sdist-venv/bin/activate"

python -m pip install --upgrade pip >/dev/null
python -m pip install mypy >/dev/null
python -m pip install --report "$tmp_dir/sdist-pip-install-report.json" "$sdist_path" >/dev/null
python -m pip check >/dev/null
python -m pip show logbrew-sdk > "$tmp_dir/sdist-pip-show.txt"
python -m pip show -f logbrew-sdk > "$tmp_dir/sdist-pip-show-files.txt"
python -m pip list --format=json > "$tmp_dir/sdist-pip-list.json"
python -m pip freeze > "$tmp_dir/sdist-pip-freeze.txt"
grep -q "^logbrew-sdk @ file://.*${sdist_artifact}#sha256=" "$tmp_dir/sdist-pip-freeze.txt"
grep "^logbrew-sdk @ file://.*${sdist_artifact}#sha256=" "$tmp_dir/sdist-pip-freeze.txt" > "$tmp_dir/sdist-direct-requirements.txt"
test "$(wc -l < "$tmp_dir/sdist-direct-requirements.txt" | tr -d ' ')" = "1"
python -m pip inspect > "$tmp_dir/sdist-pip-inspect.json"

python "$tmp_dir/module_doc.py"
check_makefile_help "sdist-make-help"
run_make smoke-types >/dev/null
run_make smoke-test >/dev/null
python "$tmp_dir/metadata.py" "$sdist_artifact" "$tmp_dir/sdist-pip-install-report.json" "$tmp_dir/sdist-pip-inspect.json" "$tmp_dir/sdist-pip-show.txt" "$tmp_dir/sdist-pip-show-files.txt" "$tmp_dir/sdist-pip-list.json"
run_readme_example "smoke-readme" "sdist-readme-example"
run_packaged_example_module "smoke-packaged-example" "sdist-packaged-example"
run_packaged_real_user_module "smoke-packaged-smoke" "sdist-packaged-smoke"
run_packaged_example_module "smoke-packaged-examples-readme" "sdist-packaged-examples-readme"
run_agent_timeline_example "smoke-packaged-examples-agent-timeline" "sdist-packaged-examples-agent-timeline"
run_first_useful_telemetry_example "smoke-packaged-examples-first-useful-telemetry" "sdist-packaged-examples-first-useful-telemetry"
check_packaged_examples_listing "smoke-packaged-examples-list" "sdist-packaged-examples-list"
check_packaged_examples_help "smoke-packaged-examples-help" "sdist-packaged-examples-help"
run_packaged_examples_entrypoint "smoke-packaged-examples" "sdist-packaged-examples"
run_smoke_script "smoke-run" "sdist-smoke"
run_logging_smoke "sdist-logging"
run_http_transport_smoke "sdist-http-transport"
run_urlopen_span_smoke "sdist-urlopen-span"
run_requests_span_smoke "sdist-requests-span"

python -m pip uninstall -y logbrew-sdk >/dev/null
assert_python_package_removed "$tmp_dir/sdist-pip-uninstall-list.json"

python -m pip install --report "$tmp_dir/sdist-pip-reinstall-report.json" "$sdist_path" >/dev/null
python -m pip check >/dev/null
python -m pip show logbrew-sdk > "$tmp_dir/sdist-pip-reinstall-show.txt"
python -m pip show -f logbrew-sdk > "$tmp_dir/sdist-pip-reinstall-show-files.txt"
python -m pip list --format=json > "$tmp_dir/sdist-pip-reinstall-list.json"
python -m pip inspect > "$tmp_dir/sdist-pip-reinstall-inspect.json"

python "$tmp_dir/module_doc.py"
check_makefile_help "sdist-reinstall-make-help"
run_make smoke-types >/dev/null
run_make smoke-test >/dev/null
python "$tmp_dir/metadata.py" "$sdist_artifact" "$tmp_dir/sdist-pip-reinstall-report.json" "$tmp_dir/sdist-pip-reinstall-inspect.json" "$tmp_dir/sdist-pip-reinstall-show.txt" "$tmp_dir/sdist-pip-reinstall-show-files.txt" "$tmp_dir/sdist-pip-reinstall-list.json"
run_readme_example "smoke-readme" "sdist-reinstall-readme-example"
run_packaged_example_module "smoke-packaged-example" "sdist-reinstall-packaged-example"
run_packaged_real_user_module "smoke-packaged-smoke" "sdist-reinstall-packaged-smoke"
run_packaged_example_module "smoke-packaged-examples-readme" "sdist-reinstall-packaged-examples-readme"
run_agent_timeline_example "smoke-packaged-examples-agent-timeline" "sdist-reinstall-packaged-examples-agent-timeline"
run_first_useful_telemetry_example "smoke-packaged-examples-first-useful-telemetry" "sdist-reinstall-packaged-examples-first-useful-telemetry"
check_packaged_examples_listing "smoke-packaged-examples-list" "sdist-reinstall-packaged-examples-list"
check_packaged_examples_help "smoke-packaged-examples-help" "sdist-reinstall-packaged-examples-help"
run_packaged_examples_entrypoint "smoke-packaged-examples" "sdist-reinstall-packaged-examples"
run_smoke_script "smoke-run" "sdist-smoke-reinstall"
run_logging_smoke "sdist-reinstall-logging"
run_http_transport_smoke "sdist-reinstall-http-transport"
run_urlopen_span_smoke "sdist-reinstall-urlopen-span"
run_requests_span_smoke "sdist-reinstall-requests-span"

cat > "$tmp_dir/unauth.py" <<'EOF'
import json

from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app",
    sdk_version="0.1.0",
)
client.release("evt_release_unauth", "2026-06-02T10:00:00Z", {"version": "1.2.3"})

try:
    client.flush(RecordingTransport([{"status_code": 401}]))
    raise SystemExit("expected unauthenticated error")
except SdkError as error:
    print(
        json.dumps(
            {
                "ok": True,
                "code": error.code,
                "message": error.message,
                "pending": client.pending_events(),
            }
        )
    )
EOF

python "$tmp_dir/unauth.py" > "$tmp_dir/unauth.stdout.json"
grep -q '"ok": true' "$tmp_dir/unauth.stdout.json"
grep -q '"code": "unauthenticated"' "$tmp_dir/unauth.stdout.json"
grep -q '"message": "transport rejected the API key"' "$tmp_dir/unauth.stdout.json"
grep -q '"pending": 1' "$tmp_dir/unauth.stdout.json"

cat > "$tmp_dir/retry.py" <<'EOF'
import json

from logbrew_sdk import LogBrewClient, RecordingTransport, TransportError

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app",
    sdk_version="0.1.0",
)
client.release("evt_release_retry", "2026-06-02T10:00:00Z", {"version": "1.2.3"})

response = client.flush(
    RecordingTransport([TransportError.network("temporary outage"), {"status_code": 202}])
)
print(
    json.dumps(
        {
            "ok": True,
            "status": response.status_code,
            "attempts": response.attempts,
            "pending": client.pending_events(),
        }
    )
)
EOF

python "$tmp_dir/retry.py" > "$tmp_dir/retry.stdout.json"
grep -q '"ok": true' "$tmp_dir/retry.stdout.json"
grep -q '"status": 202' "$tmp_dir/retry.stdout.json"
grep -q '"attempts": 2' "$tmp_dir/retry.stdout.json"
grep -q '"pending": 0' "$tmp_dir/retry.stdout.json"

cat > "$tmp_dir/shutdown.py" <<'EOF'
import json

from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app",
    sdk_version="0.1.0",
)
client.release("evt_release_shutdown", "2026-06-02T10:00:00Z", {"version": "1.2.3"})
client.shutdown(RecordingTransport.always_accept())

try:
    client.log(
        "evt_log_shutdown",
        "2026-06-02T10:00:01Z",
        {"message": "should fail", "level": "info"},
    )
    raise SystemExit("expected shutdown error")
except SdkError as error:
    print(
        json.dumps(
            {
                "ok": True,
                "code": error.code,
                "message": error.message,
                "pending": client.pending_events(),
            }
        )
    )
EOF

python "$tmp_dir/shutdown.py" > "$tmp_dir/shutdown.stdout.json"
grep -q '"ok": true' "$tmp_dir/shutdown.stdout.json"
grep -q '"code": "shutdown_error"' "$tmp_dir/shutdown.stdout.json"
grep -q '"message": "client is already shut down"' "$tmp_dir/shutdown.stdout.json"
grep -q '"pending": 0' "$tmp_dir/shutdown.stdout.json"

cat > "$tmp_dir/empty_flush.py" <<'EOF'
import json

from logbrew_sdk import LogBrewClient, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app",
    sdk_version="0.1.0",
)
response = client.flush(RecordingTransport.always_accept())
print(
    json.dumps(
        {
            "ok": True,
            "status": response.status_code,
            "attempts": response.attempts,
            "pending": client.pending_events(),
        }
    )
)
EOF

python "$tmp_dir/empty_flush.py" > "$tmp_dir/empty_flush.stdout.json"
grep -q '"ok": true' "$tmp_dir/empty_flush.stdout.json"
grep -q '"status": 204' "$tmp_dir/empty_flush.stdout.json"
grep -q '"attempts": 0' "$tmp_dir/empty_flush.stdout.json"
grep -q '"pending": 0' "$tmp_dir/empty_flush.stdout.json"

cat > "$tmp_dir/validation.py" <<'EOF'
import json

from logbrew_sdk import LogBrewClient, SdkError

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app",
    sdk_version="0.1.0",
)

try:
    client.log(
        "evt_log_invalid",
        "2026-06-02T10:00:03",
        {"message": "should fail", "level": "info"},
    )
    raise SystemExit("expected validation error")
except SdkError as error:
    print(
        json.dumps(
            {
                "ok": True,
                "code": error.code,
                "message": error.message,
                "pending": client.pending_events(),
            }
        )
    )
EOF

python "$tmp_dir/validation.py" > "$tmp_dir/validation.stdout.json"
grep -q '"ok": true' "$tmp_dir/validation.stdout.json"
grep -q '"code": "validation_error"' "$tmp_dir/validation.stdout.json"
grep -q '"message": "timestamp must include a timezone offset: 2026-06-02T10:00:03"' "$tmp_dir/validation.stdout.json"
grep -q '"pending": 0' "$tmp_dir/validation.stdout.json"

cat > "$tmp_dir/retry_budget.py" <<'EOF'
import json

from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError, TransportError

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app",
    sdk_version="0.1.0",
)
client.release("evt_release_retry_budget", "2026-06-02T10:00:00Z", {"version": "1.2.3"})

try:
    client.flush(
        RecordingTransport(
            [
                TransportError.network("temporary outage"),
                TransportError.network("temporary outage"),
                TransportError.network("temporary outage"),
            ]
        )
    )
    raise SystemExit("expected network failure")
except SdkError as error:
    print(
        json.dumps(
            {
                "ok": True,
                "code": error.code,
                "message": error.message,
                "pending": client.pending_events(),
            }
        )
    )
EOF

python "$tmp_dir/retry_budget.py" > "$tmp_dir/retry_budget.stdout.json"
grep -q '"ok": true' "$tmp_dir/retry_budget.stdout.json"
grep -q '"code": "network_failure"' "$tmp_dir/retry_budget.stdout.json"
grep -q '"message": "temporary outage"' "$tmp_dir/retry_budget.stdout.json"
grep -q '"pending": 1' "$tmp_dir/retry_budget.stdout.json"

cat > "$tmp_dir/transport_status.py" <<'EOF'
import json

from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app",
    sdk_version="0.1.0",
)
client.release("evt_release_transport_status", "2026-06-02T10:00:00Z", {"version": "1.2.3"})

try:
    client.flush(RecordingTransport([{"status_code": 400}]))
    raise SystemExit("expected transport error")
except SdkError as error:
    print(
        json.dumps(
            {
                "ok": True,
                "code": error.code,
                "message": error.message,
                "pending": client.pending_events(),
            }
        )
    )
EOF

python "$tmp_dir/transport_status.py" > "$tmp_dir/transport_status.stdout.json"
grep -q '"ok": true' "$tmp_dir/transport_status.stdout.json"
grep -q '"code": "transport_error"' "$tmp_dir/transport_status.stdout.json"
grep -q '"message": "unexpected transport status 400"' "$tmp_dir/transport_status.stdout.json"
grep -q '"pending": 1' "$tmp_dir/transport_status.stdout.json"

deactivate
run_reinstall_from_freeze "$tmp_dir/sdist-pip-freeze.txt" "$sdist_artifact" "sdist"
run_reinstall_from_direct_requirement "$tmp_dir/sdist-direct-requirements.txt" "$sdist_artifact" "sdist"
