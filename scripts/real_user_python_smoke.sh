#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

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

check_packaged_examples_listing() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.txt"
    grep -qx 'readme-example -> python -m logbrew_sdk.examples readme-example' <(sed -n '1p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'real-user-smoke -> python -m logbrew_sdk.examples real-user-smoke' <(sed -n '2p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'default (real-user-smoke) -> python -m logbrew_sdk.examples' <(sed -n '3p' "$tmp_dir/$output_prefix.stdout.txt")
    test "$(wc -l < "$tmp_dir/$output_prefix.stdout.txt" | tr -d ' ')" = "3"
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
    grep -q 'readme-example' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q 'real-user-smoke' "$tmp_dir/$output_prefix.stdout.txt"
    grep -q '^Packaged examples:$' "$tmp_dir/$output_prefix.stdout.txt"
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
    grep -qx 'smoke-packaged-examples-list -> make smoke-packaged-examples-list' <(sed -n '7p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-packaged-examples-help -> make smoke-packaged-examples-help' <(sed -n '8p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-packaged-examples (default packaged entrypoint) -> make smoke-packaged-examples' <(sed -n '9p' "$tmp_dir/$output_prefix.stdout.txt")
    grep -qx 'smoke-run (real-user-smoke) -> make smoke-run' <(sed -n '10p' "$tmp_dir/$output_prefix.stdout.txt")
    test "$(wc -l < "$tmp_dir/$output_prefix.stdout.txt" | tr -d ' ')" = "10"
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
    check_packaged_examples_listing "smoke-packaged-examples-list" "$output_prefix-freeze-packaged-examples-list"
    check_packaged_examples_help "smoke-packaged-examples-help" "$output_prefix-freeze-packaged-examples-help"
    run_packaged_examples_entrypoint "smoke-packaged-examples" "$output_prefix-freeze-packaged-examples"
    run_smoke_script "smoke-run" "$output_prefix-freeze-smoke"
    run_logging_smoke "$output_prefix-freeze-logging"
    run_http_transport_smoke "$output_prefix-freeze-http-transport"

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
    check_packaged_examples_listing "smoke-packaged-examples-list" "$output_prefix-direct-packaged-examples-list"
    check_packaged_examples_help "smoke-packaged-examples-help" "$output_prefix-direct-packaged-examples-help"
    run_packaged_examples_entrypoint "smoke-packaged-examples" "$output_prefix-direct-packaged-examples"
    run_smoke_script "smoke-run" "$output_prefix-direct-smoke"
    run_logging_smoke "$output_prefix-direct-logging"
    run_http_transport_smoke "$output_prefix-direct-http-transport"

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
python3 - <<'PY'
from pathlib import Path
import os
import zipfile

wheel_path = Path(os.environ["LOGBREW_WHEEL_PATH"])
with zipfile.ZipFile(wheel_path) as archive:
    names = set(archive.namelist())
    required = {
        "logbrew_sdk/__init__.py",
        "logbrew_sdk/examples/__init__.py",
        "logbrew_sdk/examples/__main__.py",
        "logbrew_sdk/examples/readme_example.py",
        "logbrew_sdk/examples/real_user_smoke.py",
        "logbrew_sdk/py.typed",
        "logbrew_sdk-0.1.0.dist-info/METADATA",
        "logbrew_sdk-0.1.0.dist-info/WHEEL",
        "logbrew_sdk-0.1.0.dist-info/RECORD",
    }
    missing = sorted(required - names)
    if missing:
        raise SystemExit(f"missing wheel payload files: {missing}")
    metadata = archive.read("logbrew_sdk-0.1.0.dist-info/METADATA").decode("utf-8")
for needle in (
    "Name: logbrew-sdk",
    "Version: 0.1.0",
    "python3 -m pip install logbrew-sdk",
    "LOGBREW_API_KEY",
    "preview_json()",
    "HttpTransport",
    "LogBrewLoggingHandler",
    "parse_traceparent",
    "span_attributes_from_traceparent",
):
    if needle not in metadata:
        raise SystemExit(f"missing wheel metadata guidance: {needle}")
PY
sdist_path="$(find "$tmp_dir/dist" -maxdepth 1 -name 'logbrew_sdk-*.tar.gz' | head -n 1)"
export LOGBREW_SDIST_PATH="$sdist_path"
export LOGBREW_TMP_DIR="$tmp_dir"
python3 - <<'PY'
from pathlib import Path
import os
import tarfile

sdist_path = Path(os.environ["LOGBREW_SDIST_PATH"])
tmp_dir = Path(os.environ["LOGBREW_TMP_DIR"])

with tarfile.open(sdist_path, "r:gz") as archive:
    members = {member.name.lstrip("./"): member for member in archive.getmembers()}
    names = set(members)
    (tmp_dir / "sdist-contents.txt").write_text("\n".join(sorted(names)) + "\n")

    required = {
        "logbrew_sdk-0.1.0/README.md",
        "logbrew_sdk-0.1.0/pyproject.toml",
        "logbrew_sdk-0.1.0/src/logbrew_sdk/py.typed",
        "logbrew_sdk-0.1.0/src/logbrew_sdk/examples/__init__.py",
        "logbrew_sdk-0.1.0/src/logbrew_sdk/examples/__main__.py",
        "logbrew_sdk-0.1.0/src/logbrew_sdk/examples/readme_example.py",
        "logbrew_sdk-0.1.0/src/logbrew_sdk/examples/real_user_smoke.py",
    }
    missing = sorted(required - names)
    if missing:
        raise SystemExit(f"missing sdist payload files: {missing}")

    def read_text(member_name: str) -> str:
        extracted = archive.extractfile(members[member_name])
        if extracted is None:
            raise SystemExit(f"sdist member is not a regular file: {member_name}")
        return extracted.read().decode("utf-8")

    readme = read_text("logbrew_sdk-0.1.0/README.md")
    pyproject = read_text("logbrew_sdk-0.1.0/pyproject.toml")

(tmp_dir / "sdist-README.md").write_text(readme)
(tmp_dir / "sdist-pyproject.toml").write_text(pyproject)

for needle in (
    "python3 -m pip install logbrew-sdk",
    "LOGBREW_API_KEY",
    "preview_json()",
    "HttpTransport",
    "LogBrewLoggingHandler",
    "parse_traceparent",
    "span_attributes_from_traceparent",
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
grep -q '^logbrew-sdk @ file://.*logbrew_sdk-0.1.0-py3-none-any.whl#sha256=' "$tmp_dir/pip-freeze.txt"
grep '^logbrew-sdk @ file://.*logbrew_sdk-0.1.0-py3-none-any.whl#sha256=' "$tmp_dir/pip-freeze.txt" > "$tmp_dir/pip-direct-requirements.txt"
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

from logbrew_sdk import (
    ActionAttributes,
    EnvironmentAttributes,
    HttpTransport,
    IssueAttributes,
    LogAttributes,
    LogBrewClient,
    LogBrewLoggingHandler,
    RecordingTransport,
    ReleaseAttributes,
    SpanAttributes,
    TraceparentContext,
    Transport,
    TransportResponse,
    create_traceparent,
    parse_traceparent,
    span_attributes_from_traceparent,
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
response: TransportResponse = client.flush(RecordingTransport.always_accept())
if response.status_code != 202:
    raise RuntimeError("unexpected status")

logging_transport: Transport = RecordingTransport.always_accept()
http_transport: Transport = HttpTransport(endpoint="http://127.0.0.1:9/v1/events")
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

cat > "$tmp_dir/metadata.py" <<'EOF'
from importlib.metadata import distribution, files, metadata, version
from pathlib import Path
import json
import sys

if version("logbrew-sdk") != "0.1.0":
    raise SystemExit("unexpected package version")

package_files = {str(path) for path in files("logbrew-sdk") or []}
required = {
    "logbrew_sdk/py.typed",
    "logbrew_sdk/examples/__init__.py",
    "logbrew_sdk/examples/__main__.py",
    "logbrew_sdk/examples/readme_example.py",
    "logbrew_sdk-0.1.0.dist-info/INSTALLER",
    "logbrew_sdk-0.1.0.dist-info/METADATA",
    "logbrew_sdk-0.1.0.dist-info/RECORD",
    "logbrew_sdk-0.1.0.dist-info/direct_url.json",
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
):
    if needle not in description:
        raise SystemExit(f"missing installed metadata guidance: {needle}")

dist = distribution("logbrew-sdk")
dist_info = Path(dist.locate_file("logbrew_sdk-0.1.0.dist-info"))
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
if metadata_block.get("version") != "0.1.0":
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
if inspect_metadata.get("version") != "0.1.0":
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
if show_pairs.get("Version") != "0.1.0":
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
    "logbrew_sdk-0.1.0.dist-info/INSTALLER",
    "logbrew_sdk-0.1.0.dist-info/METADATA",
    "logbrew_sdk-0.1.0.dist-info/RECORD",
    "logbrew_sdk-0.1.0.dist-info/REQUESTED",
    "logbrew_sdk-0.1.0.dist-info/WHEEL",
    "logbrew_sdk-0.1.0.dist-info/direct_url.json",
    "logbrew_sdk-0.1.0.dist-info/top_level.txt",
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
if pip_list_entry.get("version") != "0.1.0":
    raise SystemExit(f"unexpected pip list package version: {pip_list_entry.get('version')!r}")
EOF

python "$tmp_dir/metadata.py" "logbrew_sdk-0.1.0-py3-none-any.whl" "$tmp_dir/pip-install-report.json" "$tmp_dir/pip-inspect.json" "$tmp_dir/pip-show.txt" "$tmp_dir/pip-show-files.txt" "$tmp_dir/pip-list.json"

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
.PHONY: help smoke-types smoke-test smoke-readme smoke-packaged-example smoke-packaged-smoke smoke-packaged-examples-readme smoke-packaged-examples-list smoke-packaged-examples-help smoke-packaged-examples smoke-run

help:
	@printf '%s\n' \
		'smoke-types -> make smoke-types' \
		'smoke-test -> make smoke-test' \
		'smoke-readme -> make smoke-readme' \
		'smoke-packaged-example -> make smoke-packaged-example' \
		'smoke-packaged-smoke -> make smoke-packaged-smoke' \
		'smoke-packaged-examples-readme -> make smoke-packaged-examples-readme' \
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

smoke-packaged-examples-list:
	@python -m logbrew_sdk.examples --list

smoke-packaged-examples-help:
	@python -m logbrew_sdk.examples --help

smoke-packaged-examples:
	@python -m logbrew_sdk.examples

smoke-run:
	@python smoke.py
EOF

grep -q '^\.PHONY: help smoke-types smoke-test smoke-readme smoke-packaged-example smoke-packaged-smoke smoke-packaged-examples-readme smoke-packaged-examples-list smoke-packaged-examples-help smoke-packaged-examples smoke-run$' "$tmp_dir/Makefile"
grep -q '^help:$' "$tmp_dir/Makefile"
grep -q '^smoke-types:$' "$tmp_dir/Makefile"
grep -q '^smoke-test:$' "$tmp_dir/Makefile"
grep -q '^smoke-readme:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-example:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-smoke:$' "$tmp_dir/Makefile"
grep -q '^smoke-packaged-examples-readme:$' "$tmp_dir/Makefile"
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
check_packaged_examples_listing "smoke-packaged-examples-list" "wheel-packaged-examples-list"
check_packaged_examples_help "smoke-packaged-examples-help" "wheel-packaged-examples-help"
run_packaged_examples_entrypoint "smoke-packaged-examples" "wheel-packaged-examples"
run_smoke_script "smoke-run" "smoke"
run_logging_smoke "wheel-logging"
run_http_transport_smoke "wheel-http-transport"

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
python "$tmp_dir/metadata.py" "logbrew_sdk-0.1.0-py3-none-any.whl" "$tmp_dir/pip-reinstall-report.json" "$tmp_dir/pip-reinstall-inspect.json" "$tmp_dir/pip-reinstall-show.txt" "$tmp_dir/pip-reinstall-show-files.txt" "$tmp_dir/pip-reinstall-list.json"
run_readme_example "smoke-readme" "wheel-reinstall-readme-example"
run_packaged_example_module "smoke-packaged-example" "wheel-reinstall-packaged-example"
run_packaged_real_user_module "smoke-packaged-smoke" "wheel-reinstall-packaged-smoke"
run_packaged_example_module "smoke-packaged-examples-readme" "wheel-reinstall-packaged-examples-readme"
check_packaged_examples_listing "smoke-packaged-examples-list" "wheel-reinstall-packaged-examples-list"
check_packaged_examples_help "smoke-packaged-examples-help" "wheel-reinstall-packaged-examples-help"
run_packaged_examples_entrypoint "smoke-packaged-examples" "wheel-reinstall-packaged-examples"
run_smoke_script "smoke-run" "smoke-reinstall"
run_logging_smoke "wheel-reinstall-logging"
run_http_transport_smoke "wheel-reinstall-http-transport"

deactivate
run_reinstall_from_freeze "$tmp_dir/pip-freeze.txt" "logbrew_sdk-0.1.0-py3-none-any.whl" "wheel"
run_reinstall_from_direct_requirement "$tmp_dir/pip-direct-requirements.txt" "logbrew_sdk-0.1.0-py3-none-any.whl" "wheel"

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
grep -q '^logbrew-sdk @ file://.*logbrew_sdk-0.1.0.tar.gz#sha256=' "$tmp_dir/sdist-pip-freeze.txt"
grep '^logbrew-sdk @ file://.*logbrew_sdk-0.1.0.tar.gz#sha256=' "$tmp_dir/sdist-pip-freeze.txt" > "$tmp_dir/sdist-direct-requirements.txt"
test "$(wc -l < "$tmp_dir/sdist-direct-requirements.txt" | tr -d ' ')" = "1"
python -m pip inspect > "$tmp_dir/sdist-pip-inspect.json"

python "$tmp_dir/module_doc.py"
check_makefile_help "sdist-make-help"
run_make smoke-types >/dev/null
run_make smoke-test >/dev/null
python "$tmp_dir/metadata.py" "logbrew_sdk-0.1.0.tar.gz" "$tmp_dir/sdist-pip-install-report.json" "$tmp_dir/sdist-pip-inspect.json" "$tmp_dir/sdist-pip-show.txt" "$tmp_dir/sdist-pip-show-files.txt" "$tmp_dir/sdist-pip-list.json"
run_readme_example "smoke-readme" "sdist-readme-example"
run_packaged_example_module "smoke-packaged-example" "sdist-packaged-example"
run_packaged_real_user_module "smoke-packaged-smoke" "sdist-packaged-smoke"
run_packaged_example_module "smoke-packaged-examples-readme" "sdist-packaged-examples-readme"
check_packaged_examples_listing "smoke-packaged-examples-list" "sdist-packaged-examples-list"
check_packaged_examples_help "smoke-packaged-examples-help" "sdist-packaged-examples-help"
run_packaged_examples_entrypoint "smoke-packaged-examples" "sdist-packaged-examples"
run_smoke_script "smoke-run" "sdist-smoke"
run_logging_smoke "sdist-logging"
run_http_transport_smoke "sdist-http-transport"

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
python "$tmp_dir/metadata.py" "logbrew_sdk-0.1.0.tar.gz" "$tmp_dir/sdist-pip-reinstall-report.json" "$tmp_dir/sdist-pip-reinstall-inspect.json" "$tmp_dir/sdist-pip-reinstall-show.txt" "$tmp_dir/sdist-pip-reinstall-show-files.txt" "$tmp_dir/sdist-pip-reinstall-list.json"
run_readme_example "smoke-readme" "sdist-reinstall-readme-example"
run_packaged_example_module "smoke-packaged-example" "sdist-reinstall-packaged-example"
run_packaged_real_user_module "smoke-packaged-smoke" "sdist-reinstall-packaged-smoke"
run_packaged_example_module "smoke-packaged-examples-readme" "sdist-reinstall-packaged-examples-readme"
check_packaged_examples_listing "smoke-packaged-examples-list" "sdist-reinstall-packaged-examples-list"
check_packaged_examples_help "smoke-packaged-examples-help" "sdist-reinstall-packaged-examples-help"
run_packaged_examples_entrypoint "smoke-packaged-examples" "sdist-reinstall-packaged-examples"
run_smoke_script "smoke-run" "sdist-smoke-reinstall"
run_logging_smoke "sdist-reinstall-logging"
run_http_transport_smoke "sdist-reinstall-http-transport"

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
run_reinstall_from_freeze "$tmp_dir/sdist-pip-freeze.txt" "logbrew_sdk-0.1.0.tar.gz" "sdist"
run_reinstall_from_direct_requirement "$tmp_dir/sdist-direct-requirements.txt" "logbrew_sdk-0.1.0.tar.gz" "sdist"
