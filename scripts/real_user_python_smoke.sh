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

check_base_event_parity() {
    local input_path="$1"
    local projection_path="${input_path%.json}.base-parity.json"

    python3 - "$input_path" "$projection_path" <<'PY'
import json
from pathlib import Path
import sys

input_path = Path(sys.argv[1])
projection_path = Path(sys.argv[2])
payload = json.loads(input_path.read_text(encoding="utf-8"))
events = payload.get("events")
if not isinstance(events, list) or not events:
    raise SystemExit("runtime-enriched parity input must include events")
for event in events:
    attributes = event.get("attributes")
    if not isinstance(attributes, dict):
        raise SystemExit("runtime-enriched parity event must include attributes")
    context = attributes.get("context")
    if not isinstance(context, dict) or context.get("schemaVersion") != 1:
        raise SystemExit(f"missing telemetry context for {event.get('type')}")
    resource = context.get("resource")
    runtime = resource.get("runtime") if isinstance(resource, dict) else None
    if not isinstance(runtime, dict) or not isinstance(runtime.get("name"), str):
        raise SystemExit(f"missing runtime identity for {event.get('type')}")
    attributes.pop("context")
projection_path.write_text(
    json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
    python3 "$repo_root/scripts/check_sdk_parity.py" \
        --allow-additive-investigation-evidence \
        "$repo_root/fixtures/valid-batch.json" \
        "$projection_path" \
        >/dev/null
}

run_readme_example() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.json" 2> "$tmp_dir/$output_prefix.stderr.json"
    check_json event-kinds release environment issue log span action \
        "$tmp_dir/$output_prefix.stdout.json"
    python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    check_base_event_parity "$tmp_dir/$output_prefix.stdout.json"
    check_json fields 'events=6' 'ok=true' "$tmp_dir/$output_prefix.stderr.json"
}

run_agent_timeline_example() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.json" 2> "$tmp_dir/$output_prefix.stderr.json"
    check_json event-kinds action "$tmp_dir/$output_prefix.stdout.json"
    check_json event-fields 'attributes.metadata.source="product.action"' \
        'attributes.metadata.source="network.milestone"' 'attributes.metadata.routeTemplate="/checkout/:step"' \
        'attributes.metadata.routeTemplate="/payments/:id"' 'attributes.metadata.method="POST"' \
        'attributes.metadata.statusCode=202' 'attributes.metadata.durationMs=94.0' \
        "$tmp_dir/$output_prefix.stdout.json"
    for forbidden in 'private@example.test' '"card"' '"authorization"'; do
        if grep -q "$forbidden" "$tmp_dir/$output_prefix.stdout.json"; then
            echo "agent timeline leaked private data: $forbidden" >&2
            exit 1
        fi
    done
    check_json fields 'events=2' 'ok=true' \
        'traceparent="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"' \
        "$tmp_dir/$output_prefix.stderr.json"
}

run_first_useful_telemetry_example() {
    local make_target="$1"
    local output_prefix="$2"

    run_make "$make_target" > "$tmp_dir/$output_prefix.stdout.json" 2> "$tmp_dir/$output_prefix.stderr.json"
    check_json event-kinds release environment log action metric span \
        "$tmp_dir/$output_prefix.stdout.json"
    python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/$output_prefix.stdout.json" >/dev/null
    check_json fields 'events=7' 'ok=true' 'requestSpan="evt_span_checkout_request"' \
        "$tmp_dir/$output_prefix.stderr.json"
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

check_json() {
    python3 "$repo_root/scripts/check_python_package_json.py" "$@"
}

run_json_smoke() {
    local script_path="$1"
    local output_prefix="$2"
    shift 2

    python "$script_path" > "$tmp_dir/$output_prefix.stdout.json"
    check_json fields "$@" "$tmp_dir/$output_prefix.stdout.json"
}

run_runtime_context_smoke() {
    local output_prefix="$1"

    python "$tmp_dir/runtime_context_smoke.py" > "$tmp_dir/$output_prefix.stdout.json"
    python3 - "$tmp_dir/$output_prefix.stdout.json" <<'PY'
import json
from pathlib import Path
import sys

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
expected = {
    "explicitMerge": True,
    "ok": True,
    "optOut": True,
    "privacyBounded": True,
    "signals": 7,
    "validation": True,
}
if payload != expected:
    raise SystemExit(f"unexpected runtime context smoke result: {payload!r}")
PY
}

run_requirement_reinstalls() {
    local freeze_file="$1"
    local direct_requirements="$2"
    local expected_suffix="$3"
    local output_prefix="$4"
    local venv_path="$tmp_dir/receipt-venv"
    local direct_report="$tmp_dir/$output_prefix-direct-pip-install-report.json"
    local freeze_report="$tmp_dir/$output_prefix-freeze-pip-install-report.json"

    source "$venv_path/bin/activate"

    python -m pip uninstall -y logbrew-sdk >/dev/null
    assert_python_package_removed
    python -m pip install --no-deps --require-hashes --report "$direct_report" -r "$direct_requirements" >/dev/null
    python -m pip check >/dev/null
    python -m pip freeze > "$tmp_dir/$output_prefix-direct-pip-freeze.txt"
    grep -q "^logbrew-sdk @ file://.*${expected_suffix}#sha256=" "$tmp_dir/$output_prefix-direct-pip-freeze.txt"
    verify_direct_install "$expected_suffix" "$direct_report"

    python -m pip uninstall -y logbrew-sdk >/dev/null
    assert_python_package_removed
    python -m pip install --report "$freeze_report" -r "$freeze_file" >/dev/null
    python -m pip check >/dev/null
    verify_direct_install "$expected_suffix" "$freeze_report"

    deactivate
}

assert_python_package_removed() {
    python - <<'EOF'
import importlib.util
from importlib.metadata import PackageNotFoundError, version

if importlib.util.find_spec("logbrew_sdk") is not None:
    raise SystemExit("expected logbrew_sdk module to be absent after uninstall")
try:
    version("logbrew-sdk")
except PackageNotFoundError:
    pass
else:
    raise SystemExit("expected logbrew-sdk distribution to be absent after uninstall")
EOF
}

verify_direct_install() {
    local expected_suffix="$1"
    local report_path="$2"

    python - "$expected_suffix" "$report_path" <<'PY'
import json
from importlib.metadata import distribution, version
import os
from pathlib import Path
import sys

import logbrew_sdk

expected_suffix, report_path = sys.argv[1:]
package_version = os.environ["LOGBREW_PYTHON_PACKAGE_VERSION"]
if version("logbrew-sdk") != package_version:
    raise SystemExit("installed package version does not match release metadata")
if not Path(logbrew_sdk.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()):
    raise SystemExit("logbrew_sdk was not imported from the isolated environment")

direct_url = json.loads(
    Path(distribution("logbrew-sdk").locate_file(
        f"logbrew_sdk-{package_version}.dist-info/direct_url.json"
    )).read_text()
)
report = json.loads(Path(report_path).read_text())
entry = next(
    item for item in report.get("install", [])
    if item.get("metadata", {}).get("name") == "logbrew-sdk"
)
for label, source in (("direct_url", direct_url), ("pip report", entry.get("download_info", {}))):
    url = source.get("url", "")
    sha256 = source.get("archive_info", {}).get("hashes", {}).get("sha256", "")
    if not url.startswith("file://") or not url.endswith(expected_suffix):
        raise SystemExit(f"unexpected {label} target: {url!r}")
    if len(sha256) != 64:
        raise SystemExit(f"unexpected {label} sha256: {sha256!r}")
PY
}

run_sdist_install_checks() {
    python3 -m venv "$tmp_dir/sdist-venv"
    source "$tmp_dir/sdist-venv/bin/activate"

    python -m pip install --report "$tmp_dir/sdist-pip-install-report.json" "$sdist_path" >/dev/null
    python -m pip check >/dev/null
    python -m pip freeze > "$tmp_dir/sdist-pip-freeze.txt"
    grep -q "^logbrew-sdk @ file://.*${sdist_artifact}#sha256=" "$tmp_dir/sdist-pip-freeze.txt"
    grep "^logbrew-sdk @ file://.*${sdist_artifact}#sha256=" "$tmp_dir/sdist-pip-freeze.txt" > "$tmp_dir/sdist-direct-requirements.txt"
    test "$(wc -l < "$tmp_dir/sdist-direct-requirements.txt" | tr -d ' ')" = "1"
    python "$tmp_dir/module_doc.py"
    run_make smoke-test >/dev/null
    verify_direct_install "$sdist_artifact" "$tmp_dir/sdist-pip-install-report.json"
    deactivate
}

smoke_seed="${LOGBREW_PYTHON_SMOKE_SEED:-${LOGBREW_PYTHON_STATIC_ENV:-${XDG_DATA_HOME:-$HOME/.local/share}/logbrew-tools/python-static/ruff-0.15.15-mypy-2.1.0}}"
if [[ "$(uname -s)" == "Darwin" && -x "$smoke_seed/bin/python" ]]; then
    LOGBREW_PYTHON_STATIC_ENV="$smoke_seed" bash "$repo_root/scripts/check_python_static.sh" >/dev/null
    export PIP_NO_INDEX=1 PIP_FIND_LINKS="$smoke_seed/wheelhouse"
    python3 -m venv --without-pip "$tmp_dir/venv"
    seed_site=("$smoke_seed"/lib/python*/site-packages)
    venv_site="$tmp_dir/venv${seed_site[0]#"$smoke_seed"}"
    printf '%s\n' "${seed_site[0]}" > "$venv_site/logbrew-smoke-seed.pth"
else
    python3 -m venv "$tmp_dir/venv"
    "$tmp_dir/venv/bin/python" -m pip install \
        build \
        "setuptools>=80" \
        mypy \
        aiohttp \
        "SQLAlchemy>=2,<3" \
        "Django>=5,<7" \
        "Flask-Caching>=2,<3" \
        "pymemcache>=4,<5" \
        "redis>=5,<7" \
        "fakeredis==2.31.3" \
        "arq==0.28.0" \
        "dramatiq==2.2.1" \
        "rq==2.12.0" \
        >/dev/null
fi
export PATH="$tmp_dir/venv/bin:$PATH"
python -m build --no-isolation --wheel --sdist --outdir "$tmp_dir/dist" "$repo_root/python/logbrew_py" > "$tmp_dir/build.log" 2>&1
wheel_path="$(find "$tmp_dir/dist" -maxdepth 1 -name 'logbrew_sdk-*.whl' | head -n 1)"
export LOGBREW_WHEEL_PATH="$wheel_path"
export LOGBREW_PYTHON_DIST_INFO_DIR="$dist_info_dir"
sdist_path="$(find "$tmp_dir/dist" -maxdepth 1 -name 'logbrew_sdk-*.tar.gz' | head -n 1)"
export LOGBREW_SDIST_PATH="$sdist_path"
export LOGBREW_TMP_DIR="$tmp_dir"
export LOGBREW_PYTHON_SDIST_ROOT="$sdist_root"
cat > "$tmp_dir/artifact_contract.py" <<'PY'
PACKAGE_FILES = {
    "logbrew_sdk/__init__.py",
    "logbrew_sdk/_arq_client.py",
    "logbrew_sdk/_cache_client.py",
    "logbrew_sdk/_celery_client.py",
    "logbrew_sdk/_db_client.py",
    "logbrew_sdk/_dbapi_client.py",
    "logbrew_sdk/_django_cache_client.py",
    "logbrew_sdk/_dramatiq_client.py",
    "logbrew_sdk/_flask_cache_client.py",
    "logbrew_sdk/_framework_cache_client.py",
    "logbrew_sdk/_http_client.py",
    "logbrew_sdk/_instrumentation.py",
    "logbrew_sdk/_pymemcache_client.py",
    "logbrew_sdk/_queue_client.py",
    "logbrew_sdk/_redis_client.py",
    "logbrew_sdk/_rq_client.py",
    "logbrew_sdk/_sqlalchemy_client.py",
    "logbrew_sdk/_support_ticket.py",
    "logbrew_sdk/_timeline.py",
    "logbrew_sdk/_trace_context.py",
    "logbrew_sdk/examples/__init__.py",
    "logbrew_sdk/examples/__main__.py",
    "logbrew_sdk/examples/agent_timeline.py",
    "logbrew_sdk/examples/first_useful_telemetry.py",
    "logbrew_sdk/examples/readme_example.py",
    "logbrew_sdk/examples/real_user_smoke.py",
    "logbrew_sdk/py.typed",
}
README_GUIDANCE = (
    "python3 -m pip install logbrew-sdk",
    "LOGBREW_API_KEY",
    "preview_json()",
    "HttpTransport",
    "LogBrewAiohttpClientSessionInstrumentation",
    "LogBrewDjangoCacheInstrumentation",
    "LogBrewFlaskCacheInstrumentation",
    "LogBrewHttpxClientInstrumentation",
    "LogBrewLoggingHandler",
    "LogBrewPymemcacheInstrumentation",
    "LogBrewRequestsSessionInstrumentation",
    "aiohttp_request_with_logbrew_span",
    "async_cache_operation_with_logbrew_span",
    "async_database_operation_with_logbrew_span",
    "async_httpx_request_with_logbrew_span",
    "async_queue_operation_with_logbrew_span",
    "cache_operation_with_logbrew_span",
    "celery_operation_with_logbrew_span",
    "connect_dbapi_connection_with_logbrew_spans",
    "create_celery_trace_headers",
    "create_network_milestone_attributes",
    "create_product_action_attributes",
    "create_support_ticket_draft",
    "database_operation_with_logbrew_span",
    "first-useful-telemetry",
    "httpx_request_with_logbrew_span",
    "instrument_aiohttp_client_session_with_logbrew_spans",
    "instrument_arq_pool_with_logbrew_spans",
    "instrument_arq_worker_with_logbrew_spans",
    "instrument_dbapi_connection_with_logbrew_spans",
    "instrument_django_cache_with_logbrew_spans",
    "instrument_dramatiq_broker_with_logbrew_spans",
    "instrument_flask_cache_with_logbrew_spans",
    "instrument_httpx_client_with_logbrew_spans",
    "instrument_pymemcache_client_with_logbrew_spans",
    "instrument_redis_client_with_logbrew_spans",
    "instrument_requests_session_with_logbrew_spans",
    "instrument_rq_queue_with_logbrew_spans",
    "instrument_rq_worker_processes_with_logbrew",
    "instrument_sqlalchemy_engine_with_logbrew_spans",
    "logbrew_trace_context_from_celery_headers",
    "parse_traceparent",
    "queue_operation_with_logbrew_span",
    "requests_request_with_logbrew_span",
    "rq_operation_with_logbrew_span",
    "span_attributes_from_traceparent",
    "urlopen_with_logbrew_span",
)
PY
python3 - <<'PY'
from pathlib import Path
import os
import sys
import tarfile
import zipfile

sys.path.insert(0, os.environ["LOGBREW_TMP_DIR"])
from artifact_contract import PACKAGE_FILES, README_GUIDANCE

wheel_path = Path(os.environ["LOGBREW_WHEEL_PATH"])
dist_info_dir = os.environ["LOGBREW_PYTHON_DIST_INFO_DIR"]
package_version = os.environ["LOGBREW_PYTHON_PACKAGE_VERSION"]
sdist_path = Path(os.environ["LOGBREW_SDIST_PATH"])
tmp_dir = Path(os.environ["LOGBREW_TMP_DIR"])
sdist_root = os.environ["LOGBREW_PYTHON_SDIST_ROOT"]
with zipfile.ZipFile(wheel_path) as archive:
    required = PACKAGE_FILES | {
        f"{dist_info_dir}/METADATA",
        f"{dist_info_dir}/WHEEL",
        f"{dist_info_dir}/RECORD",
    }
    missing = sorted(required - set(archive.namelist()))
    if missing:
        raise SystemExit(f"missing wheel payload files: {missing}")
    metadata = archive.read(f"{dist_info_dir}/METADATA").decode("utf-8")

for needle in (
    "Name: logbrew-sdk",
    f"Version: {package_version}",
    "License-Expression: MIT",
    "Requires-Dist: certifi>=2026.7.22",
    "Requires-Dist: truststore<1,>=0.10.4",
):
    if needle not in metadata:
        raise SystemExit(f"missing wheel metadata guidance: {needle}")

with tarfile.open(sdist_path, "r:gz") as archive:
    members = {member.name.lstrip("./"): member for member in archive.getmembers()}
    names = set(members)
    (tmp_dir / "sdist-contents.txt").write_text("\n".join(sorted(names)) + "\n")
    required = {f"{sdist_root}/src/{name}" for name in PACKAGE_FILES} | {
        f"{sdist_root}/README.md",
        f"{sdist_root}/pyproject.toml",
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
for label, content in (("wheel metadata", metadata), ("sdist README", readme)):
    for needle in README_GUIDANCE:
        if needle not in content:
            raise SystemExit(f"missing {label} guidance: {needle}")

for needle in (
    'readme = "README.md"',
    'name = "logbrew-sdk"',
):
    if needle not in pyproject.splitlines():
        raise SystemExit(f"missing sdist pyproject metadata: {needle}")
PY

python -m pip install "$wheel_path" >/dev/null
python3 -m venv "$tmp_dir/receipt-venv"
receipt_python="$tmp_dir/receipt-venv/bin/python"
"$receipt_python" -m pip install --report "$tmp_dir/pip-install-report.json" "$wheel_path" >/dev/null
"$receipt_python" -m pip check >/dev/null
"$receipt_python" -m pip show logbrew-sdk > "$tmp_dir/pip-show.txt"
"$receipt_python" -m pip show -f logbrew-sdk > "$tmp_dir/pip-show-files.txt"
"$receipt_python" -m pip list --format=json > "$tmp_dir/pip-list.json"
"$receipt_python" -m pip freeze > "$tmp_dir/pip-freeze.txt"
grep -q "^logbrew-sdk @ file://.*${wheel_artifact}#sha256=" "$tmp_dir/pip-freeze.txt"
grep "^logbrew-sdk @ file://.*${wheel_artifact}#sha256=" "$tmp_dir/pip-freeze.txt" > "$tmp_dir/pip-direct-requirements.txt"
test "$(wc -l < "$tmp_dir/pip-direct-requirements.txt" | tr -d ' ')" = "1"
"$receipt_python" -m pip inspect > "$tmp_dir/pip-inspect.json"

cat > "$tmp_dir/module_doc.py" <<'EOF'
import inspect
from typing import Annotated, get_args, get_origin, get_type_hints
import logbrew_sdk

expected_docs = (
    ("module", logbrew_sdk, "Public Python client for building, validating, previewing, and flushing LogBrew event batches."),
    ("ReleaseAttributes", logbrew_sdk.ReleaseAttributes, "Public release event attributes."),
    ("EnvironmentAttributes", logbrew_sdk.EnvironmentAttributes, "Public environment event attributes."),
    ("IssueAttributes", logbrew_sdk.IssueAttributes, "Public issue event attributes."),
    ("LogAttributes", logbrew_sdk.LogAttributes, "Public log event attributes."),
    ("MetricAttributes", logbrew_sdk.MetricAttributes, "Public metric event attributes."),
    ("SpanAttributes", logbrew_sdk.SpanAttributes, "Public span event attributes."),
    ("ActionAttributes", logbrew_sdk.ActionAttributes, "Public action event attributes."),
    ("LogBrewClient", logbrew_sdk.LogBrewClient, "Buffered public client for validating, previewing, and flushing LogBrew events."),
    ("LogBrewClient.create", logbrew_sdk.LogBrewClient.create, "Create a client from public SDK identity, retry, and API key settings."),
    ("RecordingTransport", logbrew_sdk.RecordingTransport, "Scripted transport for previewing, accepting, or failing queued event flushes."),
    ("HttpTransport", logbrew_sdk.HttpTransport, "HTTP transport for sending queued batches with portable TLS verification."),
    ("HttpTransport.send", logbrew_sdk.HttpTransport.send, "POST one serialized event batch and return the HTTP status."),
    ("LogBrewClient.preview_json", logbrew_sdk.LogBrewClient.preview_json, "Return the queued event batch as stable, pretty-printed JSON."),
    ("LogBrewClient.flush", logbrew_sdk.LogBrewClient.flush, "Flush queued events through a transport while preserving retry semantics."),
    ("LogBrewClient.shutdown", logbrew_sdk.LogBrewClient.shutdown, "Flush queued events, then mark the client closed so later writes fail."),
    ("LogBrewClient.pending_events", logbrew_sdk.LogBrewClient.pending_events, "Return the queued event count currently buffered locally."),
    ("RecordingTransport.always_accept", logbrew_sdk.RecordingTransport.always_accept, "Create a transport that accepts queued flushes with a 202 response."),
    ("RecordingTransport.last_body", logbrew_sdk.RecordingTransport.last_body, "Return the most recent request body sent through this transport."),
    ("TransportResponse", logbrew_sdk.TransportResponse, "Stable transport response returned from flush and shutdown operations."),
    ("SdkError", logbrew_sdk.SdkError, "Stable public SDK error with parseable code and message fields."),
    ("TransportError", logbrew_sdk.TransportError, "Transport failure with a stable public code and retry hint."),
    ("TransportError.network", logbrew_sdk.TransportError.network, "Create a retryable network failure that preserves queued events."),
    ("Transport", logbrew_sdk.Transport, "Public transport protocol used by client flush, shutdown, and logging helpers."),
    ("TraceparentContext", logbrew_sdk.TraceparentContext, "Parsed W3C traceparent context."),
    ("parse_traceparent", logbrew_sdk.parse_traceparent, "Parse and validate a W3C traceparent header."),
    ("create_traceparent", logbrew_sdk.create_traceparent, "Create a W3C traceparent header from explicit trace and span ids."),
    ("create_product_action_attributes", logbrew_sdk.create_product_action_attributes, "Build privacy-safe action attributes for app-owned product milestones."),
    ("create_network_milestone_attributes", logbrew_sdk.create_network_milestone_attributes, "Build privacy-safe action attributes for app-owned network milestones."),
    ("span_attributes_from_traceparent", logbrew_sdk.span_attributes_from_traceparent, "Build LogBrew span attributes that continue an incoming W3C traceparent."),
    ("LogBrewLoggingHandler", logbrew_sdk.LogBrewLoggingHandler, "Standard-library logging handler that turns LogRecord objects into LogBrew log events."),
    ("LogBrewLoggingHandler.emit", logbrew_sdk.LogBrewLoggingHandler.emit, "Queue one LogBrew log event from a standard-library log record."),
    ("LogBrewLoggingHandler.flush", logbrew_sdk.LogBrewLoggingHandler.flush, "Flush queued records when a transport was provided to the handler."),
    ("log_attributes_from_record", logbrew_sdk.log_attributes_from_record, "Convert a standard-library LogRecord into LogBrew log attributes."),
)
for label, target, expected in expected_docs:
    if (observed := inspect.getdoc(target)) != expected:
        raise SystemExit(f"unexpected {label} docstring: {observed!r}")

for owner, field, expected in (
    (logbrew_sdk.TransportResponse, "status_code", "Final HTTP-like status returned by the transport."),
    (logbrew_sdk.TransportResponse, "attempts", "Number of transport attempts used for the flush."),
    (logbrew_sdk.RecordingTransport, "sent_bodies", "Every request body sent through this transport instance."),
):
    hint = get_type_hints(owner, include_extras=True).get(field)
    if get_origin(hint) is not Annotated or get_args(hint)[1] != expected:
        raise SystemExit(f"unexpected {owner.__name__}.{field} metadata: {hint!r}")

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
    "analyticsSchemaVersion": 1,
    "analyticsKind": "interaction",
    "analyticsSurface": "/checkout/:step",
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

EOF

python "$tmp_dir/module_doc.py"

cat > "$tmp_dir/typecheck.py" <<'EOF'
import asyncio
import logging
from urllib.request import Request

from logbrew_sdk import (
    ActionAttributes,
    EnvironmentAttributes,
    HttpTransport,
    IssueAttributes,
    IssueDiagnosticEvidence,
    LogAttributes,
    LogBrewAiohttpClientSessionInstrumentation,
    LogBrewClient,
    LogBrewTraceContext,
    LogBrewDbapiConnection,
    LogBrewDbapiCursor,
    LogBrewFlaskCacheInstrumentation,
    LogBrewHttpxClientInstrumentation,
    LogBrewLoggingHandler,
    LogBrewRqQueueInstrumentation,
    LogBrewRqWorkerInstrumentation,
    LogBrewPymemcacheInstrumentation,
    LogBrewRedisInstrumentation,
    LogBrewRequestsSessionInstrumentation,
    MetricAttributes,
    RecordingTransport,
    ReleaseAttributes,
    SpanAttributes,
    SupportTicketDraft,
    TraceparentContext,
    Transport,
    TransportResponse,
    aiohttp_request_with_logbrew_span,
    async_cache_operation_with_logbrew_span,
    async_database_operation_with_logbrew_span,
    async_httpx_request_with_logbrew_span,
    async_queue_operation_with_logbrew_span,
    cache_operation_with_logbrew_span,
    celery_operation_with_logbrew_span,
    create_network_milestone_attributes,
    create_product_action_attributes,
    create_support_ticket_draft,
    create_celery_trace_headers,
    create_traceparent,
    connect_dbapi_connection_with_logbrew_spans,
    database_operation_with_logbrew_span,
    httpx_request_with_logbrew_span,
    instrument_aiohttp_client_session_with_logbrew_spans,
    instrument_dbapi_connection_with_logbrew_spans,
    instrument_flask_cache_with_logbrew_spans,
    instrument_httpx_client_with_logbrew_spans,
    instrument_pymemcache_client_with_logbrew_spans,
    instrument_redis_client_with_logbrew_spans,
    instrument_requests_session_with_logbrew_spans,
    instrument_rq_queue_with_logbrew_spans,
    instrument_rq_worker_processes_with_logbrew,
    logbrew_trace_context_from_celery_headers,
    parse_traceparent,
    queue_operation_with_logbrew_span,
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
issue_evidence: IssueDiagnosticEvidence = {
    "likelyRootCause": "The provider exhausted its retry budget.",
    "likelyFixArea": {"file": "src/payments/gateway.py", "line": 42},
    "redactedFields": ["provider.message"],
}
issue: IssueAttributes = {
    "title": "Checkout timeout",
    "level": "error",
    "message": "Request timed out after retry budget",
    "evidence": issue_evidence,
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
support_ticket: SupportTicketDraft = create_support_ticket_draft(
    source="sdk",
    category="sdk_install_failure",
    title="Python install failed",
    description="Installed package cannot be imported",
    environment="production",
    runtime="python 3.13",
    framework="fastapi",
    sdk_package="logbrew-sdk",
    sdk_version="0.1.2",
    trace_id=trace_context.trace_id,
    diagnostics={
        "endpoint": "https://api.example.test/v1/events?debug=true",
        "authorization": "Bearer hidden",
        "local_path": "/tmp/logbrew-example/service/app.py",
        "error": RuntimeError("private failure message"),
    },
)
if support_ticket["diagnostics"]["endpoint"] != "[redacted-url]/v1/events":
    raise RuntimeError("support ticket draft did not redact URL origin")

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

httpx_response = httpx_request_with_logbrew_span(
    "GET",
    "https://api.example.test/health?coupon=summer#fragment",
    client=client,
    event_id="evt_httpx_typecheck",
    timestamp="2026-06-02T10:00:08Z",
    request=lambda _method, _url, **_kwargs: type("Response", (), {"status_code": 202})(),
    span_id_factory=lambda: "b7ad6b7169203333",
)
if httpx_response.status_code != 202:
    raise RuntimeError("unexpected httpx status")


async def async_httpx_request(_method: str, _url: str, **_kwargs: object) -> object:
    return type("Response", (), {"status_code": 204})()


async def run_async_httpx_typecheck() -> None:
    async_httpx_response = await async_httpx_request_with_logbrew_span(
        "GET",
        "https://api.example.test/health?coupon=summer#fragment",
        client=client,
        event_id="evt_httpx_async_typecheck",
        timestamp="2026-06-02T10:00:09Z",
        request=async_httpx_request,
        span_id_factory=lambda: "b7ad6b7169203334",
    )
    if async_httpx_response.status_code != 204:
        raise RuntimeError("unexpected async httpx status")


asyncio.run(run_async_httpx_typecheck())


async def aiohttp_request(_method: str, _url: str, **_kwargs: object) -> object:
    return type("Response", (), {"status": 206})()


async def run_aiohttp_typecheck() -> None:
    aiohttp_response = await aiohttp_request_with_logbrew_span(
        "GET",
        "https://api.example.test/health?coupon=summer#fragment",
        client=client,
        event_id="evt_aiohttp_typecheck",
        timestamp="2026-06-02T10:00:10Z",
        request=aiohttp_request,
        span_id_factory=lambda: "b7ad6b7169203335",
    )
    if aiohttp_response.status != 206:
        raise RuntimeError("unexpected aiohttp status")


asyncio.run(run_aiohttp_typecheck())


class TypecheckRequestsSession:
    def request(self, _method: str, _url: str, **_kwargs: object) -> object:
        return type("Response", (), {"status_code": 204})()


class TypecheckHttpxClient:
    def request(self, _method: str, _url: str, **_kwargs: object) -> object:
        return type("Response", (), {"status_code": 204})()


class TypecheckAiohttpClientSession:
    async def _request(self, _method: str, _url: str, **_kwargs: object) -> object:
        return type("Response", (), {"status": 206})()


requests_instrumentation: LogBrewRequestsSessionInstrumentation = instrument_requests_session_with_logbrew_spans(
    TypecheckRequestsSession(),
    client=client,
)
httpx_instrumentation: LogBrewHttpxClientInstrumentation = instrument_httpx_client_with_logbrew_spans(
    TypecheckHttpxClient(),
    client=client,
)
aiohttp_instrumentation: LogBrewAiohttpClientSessionInstrumentation = instrument_aiohttp_client_session_with_logbrew_spans(
    TypecheckAiohttpClientSession(),
    client=client,
)
requests_instrumentation.uninstall()
httpx_instrumentation.uninstall()
aiohttp_instrumentation.uninstall()


class TypecheckRows:
    rowcount = 1


database_result = database_operation_with_logbrew_span(
    "SELECT health",
    client=client,
    event_id="evt_database_typecheck",
    timestamp="2026-06-02T10:00:10Z",
    operation=TypecheckRows,
    system="sqlite",
    row_count_from_result=lambda rows: rows.rowcount,
    span_id_factory=lambda: "b7ad6b7169203335",
)
if database_result.rowcount != 1:
    raise RuntimeError("unexpected database row count")


async def async_database_operation() -> TypecheckRows:
    rows = TypecheckRows()
    rows.rowcount = 2
    return rows


async def run_async_database_typecheck() -> None:
    async_database_result = await async_database_operation_with_logbrew_span(
        "SELECT async_health",
        client=client,
        event_id="evt_database_async_typecheck",
        timestamp="2026-06-02T10:00:11Z",
        operation=async_database_operation,
        system="sqlite",
        row_count_from_result=lambda rows: rows.rowcount,
        span_id_factory=lambda: "b7ad6b7169203336",
    )
    if async_database_result.rowcount != 2:
        raise RuntimeError("unexpected async database row count")


asyncio.run(run_async_database_typecheck())


class TypecheckDbapiCursor:
    rowcount = -1

    def execute(self, _operation: object, _parameters: object | None = None) -> object:
        self.rowcount = 1
        return self


class TypecheckDbapiConnection:
    def __init__(self) -> None:
        self.cursor_instance = TypecheckDbapiCursor()

    def cursor(self) -> TypecheckDbapiCursor:
        return self.cursor_instance


dbapi_connection = TypecheckDbapiConnection()
dbapi_connected: LogBrewDbapiConnection = connect_dbapi_connection_with_logbrew_spans(
    lambda: TypecheckDbapiConnection(),
    client=client,
    system="sqlite",
    event_id_factory=lambda: "evt_dbapi_connect_typecheck",
    timestamp="2026-06-02T10:00:10Z",
    db_name="health",
    span_id_factory=lambda: "b7ad6b7169203340",
)
if dbapi_connected.uninstall().__class__ is not TypecheckDbapiConnection:
    raise RuntimeError("unexpected DB-API connect helper result")
dbapi_instrumentation: LogBrewDbapiConnection = instrument_dbapi_connection_with_logbrew_spans(
    dbapi_connection,
    client=client,
    system="sqlite",
    event_id_factory=lambda: "evt_dbapi_typecheck",
    timestamp="2026-06-02T10:00:11Z",
    db_name="health",
    span_id_factory=lambda: "b7ad6b7169203342",
)
dbapi_cursor: LogBrewDbapiCursor = dbapi_instrumentation.cursor()
if dbapi_cursor.execute("SELECT * FROM health WHERE email = ?", ("private@example.test",)) is not dbapi_cursor:
    raise RuntimeError("unexpected DB-API cursor result")
if dbapi_instrumentation.uninstall() is not dbapi_connection:
    raise RuntimeError("unexpected DB-API uninstall result")

cache_result = cache_operation_with_logbrew_span(
    "GET health",
    client=client,
    event_id="evt_cache_typecheck",
    timestamp="2026-06-02T10:00:12Z",
    operation=lambda: b"ok",
    system="redis",
    cache_hit=True,
    item_size_bytes=2,
    item_count=1,
    span_id_factory=lambda: "b7ad6b7169203337",
)
if cache_result != b"ok":
    raise RuntimeError("unexpected cache result")


async def async_cache_operation() -> str:
    return "stored"


async def run_async_cache_typecheck() -> None:
    async_cache_result = await async_cache_operation_with_logbrew_span(
        "SET health",
        client=client,
        event_id="evt_cache_async_typecheck",
        timestamp="2026-06-02T10:00:13Z",
        operation=async_cache_operation,
        system="memcached",
        cache_hit=False,
        item_size_bytes=6,
        span_id_factory=lambda: "b7ad6b7169203338",
    )
    if async_cache_result != "stored":
        raise RuntimeError("unexpected async cache result")


asyncio.run(run_async_cache_typecheck())


class TypecheckRedisClient:
    def execute_command(self, *_args: object, **_kwargs: object) -> bytes:
        return b"ok"


redis_client = TypecheckRedisClient()
redis_instrumentation: LogBrewRedisInstrumentation = instrument_redis_client_with_logbrew_spans(
    redis_client,
    client=client,
    event_id_factory=lambda: "evt_redis_typecheck",
    timestamp="2026-06-02T10:00:13Z",
    cache_name="health",
    span_id_factory=lambda: "b7ad6b7169203341",
)
if redis_client.execute_command("GET", "private:user:42") != b"ok":
    raise RuntimeError("unexpected redis result")
redis_instrumentation.uninstall()


class TypecheckPymemcacheClient:
    def get(self, *_args: object, **_kwargs: object) -> bytes:
        return b"ok"


pymemcache_client = TypecheckPymemcacheClient()
pymemcache_instrumentation: LogBrewPymemcacheInstrumentation = instrument_pymemcache_client_with_logbrew_spans(
    pymemcache_client,
    client=client,
    event_id_factory=lambda: "evt_pymemcache_typecheck",
    timestamp="2026-06-02T10:00:13Z",
    cache_name="health",
    span_id_factory=lambda: "b7ad6b7169203342",
)
if pymemcache_client.get(b"private:user:42") != b"ok":
    raise RuntimeError("unexpected pymemcache result")
pymemcache_instrumentation.uninstall()


class TypecheckFlaskCache:
    def get(self, *_args: object, **_kwargs: object) -> bytes:
        return b"ok"


flask_cache_client = TypecheckFlaskCache()
flask_cache_instrumentation: LogBrewFlaskCacheInstrumentation = instrument_flask_cache_with_logbrew_spans(
    flask_cache_client,
    client=client,
    event_id_factory=lambda: "evt_flask_cache_typecheck",
    timestamp="2026-06-02T10:00:13Z",
    cache_name="health",
    span_id_factory=lambda: "b7ad6b7169203343",
)
if flask_cache_client.get("private:user:42") != b"ok":
    raise RuntimeError("unexpected flask cache result")
flask_cache_instrumentation.uninstall()

queue_result = queue_operation_with_logbrew_span(
    "publish health",
    client=client,
    event_id="evt_queue_typecheck",
    timestamp="2026-06-02T10:00:14Z",
    operation=lambda: "queued",
    system="celery",
    operation_kind="publish",
    queue_name="health",
    task_name="health.check",
    message_count=1,
    span_id_factory=lambda: "b7ad6b7169203339",
)
if queue_result != "queued":
    raise RuntimeError("unexpected queue result")

celery_headers = create_celery_trace_headers(LogBrewTraceContext(
    trace_id=trace_context.trace_id,
    span_id="b7ad6b7169203339",
    sampled=True,
))
celery_parent_trace = logbrew_trace_context_from_celery_headers(celery_headers)
if celery_parent_trace is None:
    raise RuntimeError("expected Celery parent trace")
celery_task = type(
    "TypecheckCeleryTask",
    (),
    {
        "name": "health.check",
        "request": {
            "headers": celery_headers,
            "delivery_info": {"routing_key": "health"},
        },
    },
)()
celery_result = celery_operation_with_logbrew_span(
    client=client,
    event_id="evt_celery_typecheck",
    timestamp="2026-06-02T10:00:14Z",
    task=celery_task,
    operation=lambda: "celery processed",
    operation_kind="process",
    span_id_factory=lambda: "b7ad6b7169203343",
)
if celery_result != "celery processed":
    raise RuntimeError("unexpected Celery result")


async def async_queue_operation() -> str:
    return "processed"


async def run_async_queue_typecheck() -> None:
    async_queue_result = await async_queue_operation_with_logbrew_span(
        "process health",
        client=client,
        event_id="evt_queue_async_typecheck",
        timestamp="2026-06-02T10:00:15Z",
        operation=async_queue_operation,
        system="rq",
        operation_kind="process",
        queue_name="health",
        task_name="health.check",
        attempt=1,
        span_id_factory=lambda: "b7ad6b7169203340",
    )
    if async_queue_result != "processed":
        raise RuntimeError("unexpected async queue result")


asyncio.run(run_async_queue_typecheck())
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

from logbrew_sdk import LogBrewClient, create_support_ticket_draft


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

    def test_support_ticket_draft_is_local_and_redacted(self) -> None:
        draft = create_support_ticket_draft(
            source="sdk",
            category="sdk_install_failure",
            title="Python install failed",
            description="Installed package cannot be imported",
            environment="production",
            runtime="python 3.13",
            sdk_package="logbrew-sdk",
            sdk_version="0.1.2",
            diagnostics={
                "endpoint": "https://api.example.test/v1/events?debug=true",
                "authorization": "Bearer hidden",
                "local_path": "/tmp/logbrew-example/service/app.py",
                "error": RuntimeError("private failure message"),
            },
        )
        self.assertEqual(draft["diagnostics"]["endpoint"], "[redacted-url]/v1/events")
        serialized = str(draft)
        self.assertNotIn("api.example.test", serialized)
        self.assertNotIn("/tmp/logbrew-example", serialized)
        self.assertNotIn("private failure", serialized)
        self.assertNotIn("Bearer hidden", serialized)


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
import os
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
                "userAgent": self.headers.get("user-agent", ""),
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
expected_user_agent = (
    f"logbrew-sdk-python/{os.environ['LOGBREW_PYTHON_PACKAGE_VERSION']}"
)
if last["userAgent"] != expected_user_agent:
    raise SystemExit(
        f"expected installed package user agent {expected_user_agent!r}, "
        f"got {last['userAgent']!r}"
    )
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
            "userAgent": last["userAgent"],
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

from artifact_contract import PACKAGE_FILES, README_GUIDANCE

package_version = os.environ["LOGBREW_PYTHON_PACKAGE_VERSION"]
dist_info_dir = f"logbrew_sdk-{package_version}.dist-info"

if version("logbrew-sdk") != package_version:
    raise SystemExit("unexpected package version")

package_files = {str(path) for path in files("logbrew-sdk") or []}
required = PACKAGE_FILES | {
    f"{dist_info_dir}/{name}" for name in ("INSTALLER", "METADATA", "RECORD", "direct_url.json")
}
missing = sorted(required - package_files)
if missing:
    raise SystemExit(f"missing installed package files: {missing}")

package_metadata = metadata("logbrew-sdk")
description = package_metadata.get_payload()
requires_dist = set(package_metadata.get_all("Requires-Dist") or [])
required_transport_dependencies = {
    "certifi>=2026.7.22",
    "truststore<1,>=0.10.4",
}
if not required_transport_dependencies.issubset(requires_dist):
    raise SystemExit(
        "missing installed transport dependencies: "
        f"{sorted(required_transport_dependencies - requires_dist)}"
    )
if not any("rq<3,>=2" in requirement and 'extra == "rq"' in requirement for requirement in requires_dist):
    raise SystemExit("missing installed RQ extra metadata")
if not any("arq<1,>=0.28" in requirement and 'extra == "arq"' in requirement for requirement in requires_dist):
    raise SystemExit("missing installed ARQ extra metadata")
if not any("dramatiq<3,>=2.2.1" in requirement and 'extra == "dramatiq"' in requirement for requirement in requires_dist):
    raise SystemExit("missing installed Dramatiq extra metadata")
for needle in README_GUIDANCE:
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
location = show_pairs.get("Location", "")
if not location.endswith("/site-packages"):
    raise SystemExit(f"unexpected pip show location: {location!r}")
show_requirements = {
    value.strip()
    for value in show_pairs.get("Requires", "").split(",")
    if value.strip()
}
if show_requirements != {"certifi", "truststore"}:
    raise SystemExit(f"unexpected pip show requirements: {sorted(show_requirements)!r}")
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
required_show_files = PACKAGE_FILES | {
    f"{dist_info_dir}/{name}"
    for name in ("INSTALLER", "METADATA", "RECORD", "REQUESTED", "WHEEL", "direct_url.json", "top_level.txt")
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

"$receipt_python" "$tmp_dir/metadata.py" "$wheel_artifact" "$tmp_dir/pip-install-report.json" "$tmp_dir/pip-inspect.json" "$tmp_dir/pip-show.txt" "$tmp_dir/pip-show-files.txt" "$tmp_dir/pip-list.json"

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

cat > "$tmp_dir/runtime_context_smoke.py" <<'EOF'
import json
import os
import platform

from logbrew_sdk import LogBrewClient, SdkError, TelemetryContext, create_issue_attributes_from_exception

TIMESTAMP = "2026-08-03T00:00:00Z"


def create_client(**options):
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="runtime-context-smoke",
        sdk_version="0.1.0",
        automatic_delivery=False,
        **options,
    )


def bounded(value):
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized or len(normalized) > 256:
        return None
    if any(ord(character) <= 31 or 127 <= ord(character) <= 159 for character in normalized):
        return None
    return normalized


def expected_runtime_context():
    runtime = {"name": bounded(platform.python_implementation()) or "python"}
    runtime_version = bounded(platform.python_version())
    if runtime_version is not None:
        runtime["version"] = runtime_version

    resource = {"runtime": runtime}
    operating_system_name = bounded(platform.system())
    if operating_system_name is not None:
        operating_system = {"name": operating_system_name}
        operating_system_version = bounded(platform.release())
        if operating_system_version is not None:
            operating_system["version"] = operating_system_version
        resource["operatingSystem"] = operating_system
    architecture = bounded(platform.machine())
    if architecture is not None:
        resource["device"] = {"architecture": architecture}
    return {"schemaVersion": 1, "resource": resource}


def capture_log_context(client, context=None):
    attributes = {"message": "runtime context", "level": "info"}
    if context is not None:
        attributes["context"] = context
    client.log("runtime-log", TIMESTAMP, attributes)
    return json.loads(client.preview_json())["events"][0]["attributes"].get("context")


private_marker_name = "LOGBREW_RUNTIME_CONTEXT_PRIVATE_MARKER"
private_marker_value = "must-not-enter-telemetry"
os.environ[private_marker_name] = private_marker_value
try:
    default_client = create_client()
finally:
    del os.environ[private_marker_name]

default_client.release("runtime-release", TIMESTAMP, {"version": "1.0.0"})
default_client.environment("runtime-environment", TIMESTAMP, {"name": "test"})
default_client.issue("runtime-issue", TIMESTAMP, {"title": "Runtime issue", "level": "error"})
default_client.log("runtime-log", TIMESTAMP, {"message": "runtime log", "level": "info"})
default_client.span(
    "runtime-span",
    TIMESTAMP,
    {
        "name": "runtime span",
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
        "spanId": "00f067aa0ba902b7",
        "status": "ok",
    },
)
default_client.action("runtime-action", TIMESTAMP, {"name": "runtime action", "status": "success"})
default_client.metric(
    "runtime-metric",
    TIMESTAMP,
    {
        "name": "runtime.context",
        "kind": "gauge",
        "value": 1,
        "unit": "1",
        "temporality": "instant",
    },
)
default_payload = json.loads(default_client.preview_json())
expected_default = expected_runtime_context()
if len(default_payload["events"]) != 7:
    raise SystemExit("expected all seven telemetry signals")
for event in default_payload["events"]:
    if event["attributes"].get("context") != expected_default:
        raise SystemExit(f"unexpected default context for {event['type']}")
serialized_default = json.dumps(default_payload)
if private_marker_name in serialized_default or private_marker_value in serialized_default:
    raise SystemExit("automatic context leaked an environment marker")

client_context: TelemetryContext = {
    "schemaVersion": 1,
    "resource": {
        "service": {"name": "checkout-api", "version": "1.4.0"},
        "runtime": {"name": "custom-python", "version": "9.9"},
        "device": {"model": "container"},
    },
    "tags": {"plan": "team"},
}
event_context: TelemetryContext = {
    "schemaVersion": 1,
    "resource": {
        "device": {"architecture": "logical"},
        "application": {"name": "checkout-worker", "build": "20260803.1"},
    },
    "trace": {"traceId": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
    "tags": {"operation": "checkout", "plan": "enterprise"},
}
explicit_client = create_client(context=client_context)
explicit_context = capture_log_context(explicit_client, event_context)
if explicit_context["resource"]["runtime"] != {"name": "custom-python", "version": "9.9"}:
    raise SystemExit("explicit runtime did not override the automatic default")
if explicit_context["resource"]["service"] != {"name": "checkout-api", "version": "1.4.0"}:
    raise SystemExit("explicit service context was not retained")
if explicit_context["resource"]["device"] != {"model": "container", "architecture": "logical"}:
    raise SystemExit("device context did not merge at field level")
if explicit_context["tags"] != {"operation": "checkout", "plan": "enterprise"}:
    raise SystemExit("event tags did not override client tags")
if explicit_context["trace"]["traceId"] != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":
    raise SystemExit("trace context was not normalized")

opt_out_client = create_client(capture_runtime_context=False)
if capture_log_context(opt_out_client) is not None:
    raise SystemExit("runtime context opt-out still captured context")
explicit_opt_out_context: TelemetryContext = {"schemaVersion": 1, "tags": {"plan": "team"}}
explicit_opt_out_client = create_client(
    capture_runtime_context=False,
    context=explicit_opt_out_context,
)
if capture_log_context(explicit_opt_out_client) != explicit_opt_out_context:
    raise SystemExit("runtime context opt-out changed explicit context")

issue_context: TelemetryContext = {
    "schemaVersion": 1,
    "resource": {"application": {"name": "checkout-worker"}},
}
issue_attributes = create_issue_attributes_from_exception(
    RuntimeError("inventory unavailable"),
    context=issue_context,
    evidence={
        "likelyFixArea": {"file": "src/inventory/reader.py", "line": 42},
        "missingFields": ["inventory.snapshot_id"],
    },
    include_stack_frames=False,
)
if issue_attributes.get("context") != issue_context:
    raise SystemExit("exception helper did not preserve context")
if issue_attributes.get("evidence", {}).get("likelyFixArea", {}).get("file") != "src/inventory/reader.py":
    raise SystemExit("exception helper did not preserve diagnostic evidence")

validation_checks = 0
try:
    create_client(capture_runtime_context="yes")
except SdkError as error:
    if error.code != "configuration_error" or "must be a boolean" not in error.message:
        raise
    validation_checks += 1
else:
    raise SystemExit("expected invalid runtime context option to fail")

try:
    create_client(capture_runtime_context=False, context={"resource": {"runtime": {"name": "python"}}})
except SdkError as error:
    if error.code != "validation_error" or "schemaVersion must be 1" not in error.message:
        raise
    validation_checks += 1
else:
    raise SystemExit("expected malformed telemetry context to fail")

print(
    json.dumps(
        {
            "ok": True,
            "signals": len(default_payload["events"]),
            "explicitMerge": True,
            "optOut": True,
            "privacyBounded": True,
            "validation": validation_checks == 2,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
)
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
while IFS= read -r target; do
    grep -q "^${target}:$" "$tmp_dir/Makefile"
done < <(sed -n 's/^\.PHONY: //p' "$tmp_dir/Makefile" | tr ' ' '\n')

run_requirement_reinstalls "$tmp_dir/pip-freeze.txt" "$tmp_dir/pip-direct-requirements.txt" "$wheel_artifact" "wheel" &
requirements_pid=$!
run_sdist_install_checks &
sdist_checks_pid=$!

check_makefile_help "wheel-make-help"
run_make smoke-types >/dev/null
run_make smoke-test >/dev/null
run_readme_example "smoke-readme" "wheel-readme-example"
run_readme_example "smoke-packaged-example" "wheel-packaged-example"
run_readme_example "smoke-packaged-smoke" "wheel-packaged-smoke"
run_readme_example "smoke-packaged-examples-readme" "wheel-packaged-examples-readme"
run_agent_timeline_example "smoke-packaged-examples-agent-timeline" "wheel-packaged-examples-agent-timeline"
run_first_useful_telemetry_example "smoke-packaged-examples-first-useful-telemetry" "wheel-packaged-examples-first-useful-telemetry"
check_packaged_examples_listing "smoke-packaged-examples-list" "wheel-packaged-examples-list"
check_packaged_examples_help "smoke-packaged-examples-help" "wheel-packaged-examples-help"
run_readme_example "smoke-packaged-examples" "wheel-packaged-examples"
run_readme_example "smoke-run" "smoke"
run_json_smoke "$tmp_dir/logging_smoke.py" "wheel-logging" \
    'ok=true' 'deliveries=2' 'firstLevel="warning"' 'secondLevel="error"' \
    'logger="checkout.worker"' 'orderId="ord_123"' 'exceptionName="RuntimeError"' \
    'hasPathname=false' 'hasExceptionText=false'
run_runtime_context_smoke "wheel-runtime-context"
run_json_smoke "$tmp_dir/http_transport_smoke.py" "wheel-http-transport" \
    'ok=true' 'httpAttempts=2' 'httpEvents=1' 'status=202' 'pending=0' \
    'requestCount=2' 'authorization="Bearer LOGBREW_API_KEY"' 'source="python-smoke"'
run_json_smoke "$repo_root/scripts/python_database_span_smoke.py" "wheel-database-span" \
    'ok=true' 'events=3' 'activeSpan="b7ad6b7169203341"' \
    'asyncActiveSpan="b7ad6b7169203342"' 'dbSystem="postgresql"' 'asyncDbSystem="mysql"' \
    'rowCount=3' 'asyncRowCount=2' 'errorType="StubDatabaseError"' 'captureErrors=1'
run_json_smoke "$repo_root/scripts/python_dbapi_span_smoke.py" "wheel-dbapi-span" \
    'ok=true' 'events=7' 'framework="dbapi"' 'dbSystem="sqlite"' 'dbMethod="execute"' \
    'connectMethod="connect"' 'commitMethod="commit"' 'fetchMethod="fetchall"' 'fetchRows=1' \
    'selectMethod="execute"' 'rollbackMethod="rollback"' 'updateRowCount=1' 'selectRows=1' \
    'errorStatus="error"' 'errorType="OperationalError"' 'parentSpanAfterDbapi="00f067aa0ba902b7"'
run_json_smoke "$repo_root/scripts/python_sqlalchemy_span_smoke.py" "wheel-sqlalchemy-span" \
    'ok=true' 'events=4' 'dbSystem="sqlite"' 'dbName="checkout"' 'framework="sqlalchemy"' \
    'duplicateSame=true' 'parentSpanAfterQueries="00f067aa0ba902b7"' 'queryRows=1' \
    'errorStatus="error"' 'operations=["CREATE","INSERT","SELECT","SELECT"]'
run_json_smoke "$repo_root/scripts/python_cache_span_smoke.py" "wheel-cache-span" \
    'ok=true' 'events=3' 'activeSpan="b7ad6b7169203351"' \
    'asyncActiveSpan="b7ad6b7169203352"' 'cacheSystem="redis"' 'asyncCacheSystem="memcached"' \
    'cacheHit=true' 'itemSizeBytes=14' 'asyncItemSizeBytes=64' 'itemCount=1' \
    'errorType="StubCacheError"' 'captureErrors=1'
run_json_smoke "$repo_root/scripts/python_django_cache_span_smoke.py" "wheel-django-cache-span" \
    'ok=true' 'events=3' 'framework="django-cache"' 'duplicateSame=true' \
    'operations=["SET","GET","GET_MANY"]' 'cacheName="profiles"' 'getHit=true' \
    'getItemSizeBytes=17' 'manyHit=true' 'manyItemCount=1' \
    'parentSpanAfterCache="00f067aa0ba902b7"' 'setKind="write"' 'uninstallStoppedTracing=true'
run_json_smoke "$repo_root/scripts/python_flask_cache_span_smoke.py" "wheel-flask-cache-span" \
    'ok=true' 'events=4' 'framework="flask-caching"' 'duplicateSame=true' \
    'operations=["SET","GET","GET_MANY","DELETE_MANY"]' 'cacheName="profiles"' \
    'getHit=true' 'getItemSizeBytes=17' 'manyHit=true' 'manyItemCount=1' 'deleteManyCount=2' \
    'parentSpanAfterCache="00f067aa0ba902b7"' 'setKind="write"' 'uninstallStoppedTracing=true'
run_json_smoke "$repo_root/scripts/python_pymemcache_span_smoke.py" "wheel-pymemcache-span" \
    'ok=true' 'events=4' 'framework="pymemcache"' 'duplicateSame=true' \
    'operations=["GET","GETS","GET_MANY","SET"]' 'cacheName="profiles"' \
    'getActiveSpan="b7ad6b7169203401"' 'getHit=true' 'getItemSizeBytes=14' \
    'getsActiveSpan="b7ad6b7169203402"' 'getsHit=false' \
    'manyActiveSpan="b7ad6b7169203403"' 'manyHit=true' 'manyItemCount=1' \
    'parentSpanAfterCache="00f067aa0ba902b7"' 'setActiveSpan="b7ad6b7169203404"' \
    'setKind="write"' 'uninstallStoppedTracing=true'
run_json_smoke "$repo_root/scripts/python_redis_span_smoke.py" "wheel-redis-span" \
    'ok=true' 'events=4' 'framework="redis-py"' 'duplicateSame=true' \
    'parentSpanAfterRedis="00f067aa0ba902b7"' 'syncActiveSpan="b7ad6b7169203381"' \
    'pipelineActiveSpan="b7ad6b7169203385"' 'pipelineLength=2' 'pipelineOperations="GET,SET"' \
    'pipelineResultCount=2' 'asyncActiveSpan="b7ad6b7169203382"' \
    'cacheOperationKind="read"' 'cacheHit=true' 'asyncCacheHit=true' \
    'itemCount=1' 'asyncItemCount=2' 'errorStatus="error"' 'errorType="StubRedisError"'
run_json_smoke "$repo_root/scripts/python_queue_span_smoke.py" "wheel-queue-span" \
    'ok=true' 'events=6' 'activeSpan="b7ad6b7169203361"' \
    'asyncActiveSpan="b7ad6b7169203362"' 'celeryOperation="publish checkout.send_receipt"' \
    'celeryProcessParentSpan="b7ad6b7169203371"' 'celeryProcessResult="celery processed"' \
    'celeryQueueName="receipts"' 'celeryResult="celery published"' \
    'celeryTaskName="checkout.send_receipt"' \
    'celeryTraceparent="00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203371-01"' \
    'queueSystem="celery"' 'syncOperationKind="publish"' 'queueName="email"' \
    'taskName="checkout.email"' 'rqOperation="publish checkout.send_email"' \
    'rqQueueName="email"' 'rqResult="rq queued"' 'rqTaskName="checkout.send_email"' \
    'messageCount=1' 'errorType="StubQueueError"' 'captureErrors=1'
PYTHONPATH="$repo_root/python/logbrew_py/tests" python -m unittest \
    test_sdk test_http_client test_arq_client test_rq_client

cat > "$tmp_dir/failure_modes.py" <<'EOF'
import json

from logbrew_sdk import LogBrewClient, RecordingTransport, SdkError, TransportError


def client():
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY", sdk_name="smoke-app", sdk_version="0.1.0"
    )


def release(mode):
    instance = client()
    instance.release(f"evt_release_{mode}", "2026-06-02T10:00:00Z", {"version": "1.2.3"})
    return instance


def error_result(instance, operation):
    try:
        operation()
    except SdkError as error:
        return {"code": error.code, "message": error.message, "pending": instance.pending_events()}
    raise SystemExit("expected SDK error")


unauth = release("unauth")
results = {
    "unauth": error_result(unauth, lambda: unauth.flush(RecordingTransport([{"status_code": 401}]))),
}
retry = release("retry")
response = retry.flush(RecordingTransport([TransportError.network("temporary outage"), {"status_code": 202}]))
results["retry"] = {"status": response.status_code, "attempts": response.attempts, "pending": retry.pending_events()}
shutdown = release("shutdown")
shutdown.shutdown(RecordingTransport.always_accept())
results["shutdown"] = error_result(
    shutdown,
    lambda: shutdown.log(
        "evt_log_shutdown", "2026-06-02T10:00:01Z", {"message": "should fail", "level": "info"}
    ),
)
empty = client()
response = empty.flush(RecordingTransport.always_accept())
results["empty"] = {"status": response.status_code, "attempts": response.attempts, "pending": empty.pending_events()}
invalid = client()
results["validation"] = error_result(
    invalid,
    lambda: invalid.log(
        "evt_log_invalid", "2026-06-02T10:00:03", {"message": "should fail", "level": "info"}
    ),
)
budget = release("retry_budget")
results["retry_budget"] = error_result(
    budget,
    lambda: budget.flush(RecordingTransport([TransportError.network("temporary outage")] * 3)),
)
status = release("transport_status")
results["transport_status"] = error_result(
    status, lambda: status.flush(RecordingTransport([{"status_code": 400}]))
)

expected = {
    "unauth": {"code": "unauthenticated", "message": "transport rejected the API key", "pending": 1},
    "retry": {"status": 202, "attempts": 2, "pending": 0},
    "shutdown": {"code": "shutdown_error", "message": "client is already shut down", "pending": 0},
    "empty": {"status": 204, "attempts": 0, "pending": 0},
    "validation": {
        "code": "validation_error",
        "message": "timestamp must include a timezone offset: 2026-06-02T10:00:03",
        "pending": 0,
    },
    "retry_budget": {"code": "network_failure", "message": "temporary outage", "pending": 1},
    "transport_status": {"code": "transport_error", "message": "unexpected transport status 400", "pending": 1},
}
if results != expected:
    raise SystemExit(f"failure-mode receipt mismatch: {results!r}")
print(json.dumps({"ok": True, "scenarios": len(results)}))
EOF

python "$tmp_dir/failure_modes.py" > "$tmp_dir/failure_modes.stdout.json"
grep -q '"ok": true' "$tmp_dir/failure_modes.stdout.json"
grep -q '"scenarios": 7' "$tmp_dir/failure_modes.stdout.json"

wait "$requirements_pid"
wait "$sdist_checks_pid"
