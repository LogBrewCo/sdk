#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-python-public-pypi.XXXXXX")"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"

manifest_path=""
artifact_root=""
legacy_args=()
index_url="https://pypi.org/simple"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --manifest)
            [[ $# -ge 2 ]] || { printf '%s\n' "--manifest requires a path" >&2; exit 2; }
            manifest_path="$2"
            shift 2
            ;;
        --artifact-root)
            [[ $# -ge 2 ]] || { printf '%s\n' "--artifact-root requires a path" >&2; exit 2; }
            artifact_root="$2"
            shift 2
            ;;
        *)
            legacy_args+=("$1")
            shift
            ;;
    esac
done

if [[ -n "$artifact_root" && -z "$manifest_path" ]]; then
    printf '%s\n' "--artifact-root requires --manifest" >&2
    exit 2
fi
if [[ -n "$manifest_path" && ${#legacy_args[@]} -gt 0 ]]; then
    printf '%s\n' "version arguments cannot be combined with --manifest" >&2
    exit 2
fi

if [[ -n "$manifest_path" ]]; then
    IFS=$'\t' read -r sdk_version fastapi_version flask_version django_version < <(
        python3 - "$manifest_path" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
versions = {package["id"]: package["version"] for package in payload["packages"]}
print(
    versions["logbrew-sdk"],
    versions["logbrew-fastapi"],
    versions["logbrew-flask"],
    versions["logbrew-django"],
    sep="\t",
)
PY
    )
else
    sdk_version="${legacy_args[0]:-${LOGBREW_PYPI_SDK_VERSION:-0.1.4}}"
    fastapi_version="${legacy_args[1]:-${LOGBREW_PYPI_FASTAPI_VERSION:-0.1.3}}"
    django_version="${legacy_args[2]:-${LOGBREW_PYPI_DJANGO_VERSION:-0.1.3}}"
    flask_version="${legacy_args[3]:-${LOGBREW_PYPI_FLASK_VERSION:-0.1.1}}"
fi

on_error() {
    local status=$?
    if [[ "$receipt_mode" == "1" ]]; then
        echo "Python release receipt failed" >&2
        exit "$status"
    fi
    echo "real_user_python_public_pypi_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
    for diagnostic in \
        "$tmp_dir/pip-check.txt" \
        "$tmp_dir/pip-freeze.txt" \
        "$tmp_dir/pip-list.json" \
        "$tmp_dir/logbrew-sdk.show.txt" \
        "$tmp_dir/logbrew-fastapi.show.txt" \
        "$tmp_dir/logbrew-flask.show.txt" \
        "$tmp_dir/logbrew-django.show.txt" \
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

cd "$repo_root"

run_receipt_smoke() {
    local bound="$tmp_dir/receipt-artifacts"
    local metadata="$tmp_dir/receipt-metadata.json"
    python3 "$repo_root/scripts/release_artifact_receipt.py" bind \
        --family "pypi" --output-dir "$bound" --metadata "$metadata" \
        >"$tmp_dir/receipt-bind.out" 2>"$tmp_dir/receipt-bind.err"
    local install_dir="$tmp_dir/receipt-wheels"
    mkdir -p "$install_dir"
    ln "$bound/0.whl" "$install_dir/logbrew_sdk-${sdk_version}-py3-none-any.whl"
    ln "$bound/1.whl" "$install_dir/logbrew_fastapi-${fastapi_version}-py3-none-any.whl"
    ln "$bound/2.whl" "$install_dir/logbrew_flask-${flask_version}-py3-none-any.whl"
    ln "$bound/3.whl" "$install_dir/logbrew_django-${django_version}-py3-none-any.whl"
    python3 -m venv "$tmp_dir/receipt-venv"
    "$tmp_dir/receipt-venv/bin/python" -m pip install \
        --disable-pip-version-check --no-cache-dir \
        "$install_dir/logbrew_sdk-${sdk_version}-py3-none-any.whl" \
        "$install_dir/logbrew_fastapi-${fastapi_version}-py3-none-any.whl" \
        "$install_dir/logbrew_flask-${flask_version}-py3-none-any.whl" \
        "$install_dir/logbrew_django-${django_version}-py3-none-any.whl" \
        >"$tmp_dir/receipt-install.out" 2>"$tmp_dir/receipt-install.err"
    EXPECTED_LOGBREW_SDK_VERSION="$sdk_version" \
    EXPECTED_LOGBREW_FASTAPI_VERSION="$fastapi_version" \
    EXPECTED_LOGBREW_FLASK_VERSION="$flask_version" \
    EXPECTED_LOGBREW_DJANGO_VERSION="$django_version" \
        "$tmp_dir/receipt-venv/bin/python" >"$tmp_dir/receipt-run.out" \
        2>"$tmp_dir/receipt-run.err" <<'PY'
import importlib.metadata as metadata

from logbrew_sdk import LogBrewClient, RecordingTransport
import logbrew_django
import logbrew_fastapi
import logbrew_flask
import os

expected = {
    "logbrew-sdk": os.environ["EXPECTED_LOGBREW_SDK_VERSION"],
    "logbrew-fastapi": os.environ["EXPECTED_LOGBREW_FASTAPI_VERSION"],
    "logbrew-flask": os.environ["EXPECTED_LOGBREW_FLASK_VERSION"],
    "logbrew-django": os.environ["EXPECTED_LOGBREW_DJANGO_VERSION"],
}
if any(metadata.version(name) != version for name, version in expected.items()):
    raise SystemExit(1)
if not all((logbrew_fastapi, logbrew_flask, logbrew_django)):
    raise SystemExit(1)
client = LogBrewClient(
    api_key="key",
    sdk={"name": "receipt", "version": "0.1.0"},
    max_retries=1,
)
client.log("event", "2026-01-01T00:00:00Z", {"message": "ok", "level": "info"})
response = client.shutdown(RecordingTransport())
if response.status_code != 202:
    raise SystemExit(1)
PY
    python3 "$repo_root/scripts/release_artifact_receipt.py" attest \
        --family "pypi" --metadata "$metadata"
}

if [[ "$receipt_mode" == "1" ]]; then
    [[ -n "${LOGBREW_PYPI_SDK_VERSION:-}" \
        && -n "${LOGBREW_PYPI_FASTAPI_VERSION:-}" \
        && -n "${LOGBREW_PYPI_FLASK_VERSION:-}" \
        && -n "${LOGBREW_PYPI_DJANGO_VERSION:-}" ]] || exit 1
    run_receipt_smoke
    exit 0
fi

python3 -m venv "$tmp_dir/venv"
export PATH="$tmp_dir/venv/bin:$PATH"

python -m pip install --disable-pip-version-check --upgrade pip >/dev/null

if [[ -n "$manifest_path" ]]; then
    if [[ -z "$artifact_root" ]]; then
        artifact_root="$tmp_dir/public-artifacts"
        python3 - "$manifest_path" "$artifact_root" <<'PY'
from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

MAX_METADATA_BYTES = 2 * 1024 * 1024
MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
EXPECTED_PACKAGES = (
    ("logbrew-sdk", "logbrew_py", "logbrew_sdk"),
    ("logbrew-fastapi", "logbrew_fastapi", "logbrew_fastapi"),
    ("logbrew-flask", "logbrew_flask", "logbrew_flask"),
    ("logbrew-django", "logbrew_django", "logbrew_django"),
)
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?")
DIGEST = re.compile(r"[0-9a-f]{64}")
SOURCE_COMMIT = re.compile(r"[0-9a-f]{40}")
manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
output = Path(sys.argv[2])

packages = manifest.get("packages")
if (
    manifest.get("schemaVersion") != 1
    or SOURCE_COMMIT.fullmatch(str(manifest.get("sourceCommit", ""))) is None
    or not isinstance(packages, list)
):
    raise SystemExit("invalid Python release manifest")

if [entry.get("id") for entry in packages if isinstance(entry, dict)] != [
    package_id for package_id, _, _ in EXPECTED_PACKAGES
]:
    raise SystemExit("invalid Python release manifest package order")

for package, (expected_id, directory, filename_name) in zip(
    packages,
    EXPECTED_PACKAGES,
):
    package_id = package.get("id")
    version = package.get("version")
    if (
        package_id != expected_id
        or not isinstance(version, str)
        or VERSION.fullmatch(version) is None
    ):
        raise SystemExit("invalid Python release manifest package")
    api_url = f"https://pypi.org/pypi/{urllib.parse.quote(package_id, safe='')}/{urllib.parse.quote(version, safe='')}/json"
    request = urllib.request.Request(api_url, headers={"User-Agent": "LogBrew public package verifier"})
    with urllib.request.urlopen(request, timeout=30) as response:
        raw_metadata = response.read(MAX_METADATA_BYTES + 1)
    if len(raw_metadata) > MAX_METADATA_BYTES:
        raise SystemExit("Python registry metadata exceeds the fixed limit")
    metadata = json.loads(raw_metadata)
    files = {entry.get("filename"): entry for entry in metadata.get("urls", []) if isinstance(entry, dict)}

    for kind in ("wheel", "sdist"):
        artifact = package.get(kind)
        if not isinstance(artifact, dict):
            raise SystemExit("invalid Python release manifest artifact")
        relative = PurePosixPath(str(artifact.get("file", "")))
        expected_digest = artifact.get("sha256")
        suffix = "-py3-none-any.whl" if kind == "wheel" else ".tar.gz"
        expected_file = PurePosixPath(directory) / f"{filename_name}-{version}{suffix}"
        if relative != expected_file or DIGEST.fullmatch(str(expected_digest)) is None:
            raise SystemExit("invalid Python release artifact path")
        entry = files.get(relative.name)
        if not isinstance(entry, dict) or entry.get("digests", {}).get("sha256") != expected_digest:
            raise SystemExit("Python registry artifact digest does not match the release manifest")
        url = entry.get("url")
        parsed = urllib.parse.urlparse(url if isinstance(url, str) else "")
        if parsed.scheme != "https" or parsed.hostname != "files.pythonhosted.org":
            raise SystemExit("Python registry artifact location is not allowed")
        artifact_request = urllib.request.Request(url, headers={"User-Agent": "LogBrew public package verifier"})
        with urllib.request.urlopen(artifact_request, timeout=60) as response:
            final_url = urllib.parse.urlparse(response.geturl())
            if final_url.scheme != "https" or final_url.hostname != "files.pythonhosted.org":
                raise SystemExit("Python registry artifact redirect is not allowed")
            body = response.read(MAX_ARTIFACT_BYTES + 1)
        if len(body) > MAX_ARTIFACT_BYTES:
            raise SystemExit("Python registry artifact exceeds the fixed limit")
        if hashlib.sha256(body).hexdigest() != expected_digest:
            raise SystemExit("Python registry artifact bytes do not match the release manifest")
        destination = output.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)
PY
    fi
    python3 scripts/check_python_release_artifacts.py verify \
        --directory "$artifact_root" \
        --manifest "$manifest_path"
    packages=()
    while IFS= read -r wheel_path; do
        packages+=("$artifact_root/$wheel_path")
    done < <(
        python3 - "$manifest_path" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
for package in payload["packages"]:
    print(package["wheel"]["file"])
PY
    )
else
    packages=(
        "logbrew-sdk==$sdk_version"
        "logbrew-fastapi==$fastapi_version"
        "logbrew-flask==$flask_version"
        "logbrew-django==$django_version"
    )
fi

python -m pip install \
    --disable-pip-version-check \
    --no-cache-dir \
    --index-url "$index_url" \
    "${packages[@]}"
python -m pip check > "$tmp_dir/pip-check.txt"
python -m pip show logbrew-sdk > "$tmp_dir/logbrew-sdk.show.txt"
python -m pip show logbrew-fastapi > "$tmp_dir/logbrew-fastapi.show.txt"
python -m pip show logbrew-flask > "$tmp_dir/logbrew-flask.show.txt"
python -m pip show logbrew-django > "$tmp_dir/logbrew-django.show.txt"
python -m pip list --format=json > "$tmp_dir/pip-list.json"
python -m pip freeze > "$tmp_dir/pip-freeze.txt"

export EXPECTED_LOGBREW_SDK_VERSION="$sdk_version"
export EXPECTED_LOGBREW_FASTAPI_VERSION="$fastapi_version"
export EXPECTED_LOGBREW_FLASK_VERSION="$flask_version"
export EXPECTED_LOGBREW_DJANGO_VERSION="$django_version"

cat > "$tmp_dir/prove_public_pypi_install.py" <<'PY'
from __future__ import annotations

import importlib.metadata as metadata
import json
import os
import sqlite3

from fastapi import FastAPI
from flask import Flask
from logbrew_django import configure_logbrew
from logbrew_fastapi import add_logbrew_middleware as add_fastapi_middleware
from logbrew_flask import add_logbrew_middleware as add_flask_middleware
from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    RecordingTransport,
    connect_dbapi_connection_with_logbrew_spans,
    create_logbrew_open_telemetry_span_exporter,
    span_attributes_from_trace_context,
)


def require_distribution_version(distribution: str, expected: str) -> str:
    resolved = metadata.version(distribution)
    if resolved != expected:
        raise AssertionError(f"{distribution} resolved {resolved}, expected {expected}")
    return resolved


sdk_version = os.environ["EXPECTED_LOGBREW_SDK_VERSION"]
fastapi_version = os.environ["EXPECTED_LOGBREW_FASTAPI_VERSION"]
flask_version = os.environ["EXPECTED_LOGBREW_FLASK_VERSION"]
django_version = os.environ["EXPECTED_LOGBREW_DJANGO_VERSION"]

versions = {
    "logbrew-sdk": require_distribution_version("logbrew-sdk", sdk_version),
    "logbrew-fastapi": require_distribution_version("logbrew-fastapi", fastapi_version),
    "logbrew-flask": require_distribution_version("logbrew-flask", flask_version),
    "logbrew-django": require_distribution_version("logbrew-django", django_version),
}

client = LogBrewClient(
    api_key="LOGBREW_API_KEY",
    sdk={"name": "python-public-pypi-smoke", "version": sdk_version},
    max_retries=1,
)
client.log(
    "evt_public_pypi_smoke",
    "2026-07-01T00:00:00Z",
    {"message": "public PyPI smoke", "level": "info"},
)
trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
client.span(
    "evt_public_pypi_trace_context",
    "2026-07-01T00:00:01Z",
    span_attributes_from_trace_context(
        trace,
        name="public-pypi.trace-context",
        status="ok",
        duration_ms=2.5,
        metadata={"source": "public-pypi-smoke"},
    ),
)
client.span(
    "evt_public_pypi_span_links",
    "2026-07-01T00:00:02Z",
    {
        "name": "public-pypi.span-links",
        "traceId": trace.trace_id,
        "spanId": "b7ad6b7169203331",
        "status": "ok",
        "links": [
            {
                "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "spanId": "bbbbbbbbbbbbbbbb",
                "sampled": True,
                "metadata": {
                    "relation": "fan_in",
                    "payload": {"email": "blocked@example.test"},
                },
            }
        ],
    },
)

db_connection = connect_dbapi_connection_with_logbrew_spans(
    sqlite3.connect,
    client=client,
    system="sqlite",
    connect_args=(":memory:",),
    trace_fetch_methods=True,
    timestamp="2026-07-01T00:00:03Z",
    trace=trace,
    db_name="public-smoke",
    metadata={"connection": "blocked", "safe": "public-pypi"},
)
db_cursor = db_connection.cursor()
db_cursor.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT)")
db_cursor.execute("INSERT INTO events (name) VALUES (?)", ("checkout",))
db_connection.commit()
db_cursor.execute("SELECT name FROM events")
rows = db_cursor.fetchall()
if rows != [("checkout",)]:
    raise AssertionError(f"unexpected DB-API rows: {rows!r}")

otel_exporter = create_logbrew_open_telemetry_span_exporter(client=client)
otel_exporter_result = otel_exporter.export([])
otel_exporter.shutdown()

transport = RecordingTransport()
response = client.flush(transport)
if response.status_code != 202:
    raise AssertionError(f"expected local RecordingTransport 202, got {response.status_code}")
if response.attempts != 1:
    raise AssertionError(f"expected one flush attempt, got {response.attempts}")
if len(transport.sent_bodies) != 1:
    raise AssertionError(f"expected one recorded body, got {len(transport.sent_bodies)}")
if client.pending_events() != 0:
    raise AssertionError(f"expected empty queue after flush, got {client.pending_events()}")
request_body = transport.sent_bodies[0]
payload = json.loads(request_body)
dbapi_spans = [
    event
    for event in payload["events"]
    if event["type"] == "span"
    and event["attributes"].get("metadata", {}).get("framework") == "dbapi"
]
span_links = next(
    event["attributes"]["links"]
    for event in payload["events"]
    if event["id"] == "evt_public_pypi_span_links"
)
if len(dbapi_spans) < 5:
    raise AssertionError(f"expected at least five DB-API spans, got {len(dbapi_spans)}")
if span_links != [
    {
        "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "spanId": "bbbbbbbbbbbbbbbb",
        "sampled": True,
        "metadata": {"relation": "fan_in"},
    }
]:
    raise AssertionError(f"unexpected span link summary: {span_links!r}")
for blocked in (
    "blocked@example.test",
    "payload",
    "connection",
    ":memory:",
    "CREATE TABLE",
    "INSERT INTO",
    "SELECT name",
):
    if blocked in request_body:
        raise AssertionError(f"expected public PyPI smoke body to omit {blocked!r}")

app = FastAPI()
add_fastapi_middleware(app, client=client, transport=RecordingTransport())
if not app.user_middleware:
    raise AssertionError("expected FastAPI middleware to be registered")

flask_client = LogBrewClient(
    api_key="LOGBREW_API_KEY",
    sdk={"name": "python-public-flask-smoke", "version": flask_version},
    max_retries=1,
)
flask_transport = RecordingTransport()
flask_app = Flask(__name__)
add_flask_middleware(
    flask_app,
    client=flask_client,
    transport=flask_transport,
    span_id_factory=lambda: "b7ad6b7169203331",
)


@flask_app.get("/orders/<int:order_id>")
def flask_order(order_id: int) -> dict[str, int]:
    return {"orderId": order_id}


flask_response = flask_app.test_client().get("/orders/42?proof_marker=excluded")
if flask_response.status_code != 200 or flask_response.get_json() != {"orderId": 42}:
    raise AssertionError("expected installed Flask middleware to preserve the response")
if len(flask_transport.sent_bodies) != 1:
    raise AssertionError("expected one installed Flask request span body")
flask_body = flask_transport.sent_bodies[0]
if "/orders/42" in flask_body or "proof_marker" in flask_body or "excluded" in flask_body:
    raise AssertionError("expected installed Flask middleware to omit concrete request data")

django_config = configure_logbrew(client=client, transport=RecordingTransport())
if type(django_config).__name__ != "LogBrewDjangoConfig":
    raise AssertionError(f"unexpected Django config type: {type(django_config).__name__}")

print(
    json.dumps(
        {
            "versions": versions,
            "flush_status": response.status_code,
            "flush_attempts": response.attempts,
            "recorded_bodies": len(transport.sent_bodies),
            "dbapi_spans": len(dbapi_spans),
            "otel_exporter_result": getattr(otel_exporter_result, "name", str(otel_exporter_result)),
            "span_links": len(span_links),
            "fastapi_middleware_count": len(app.user_middleware),
            "flask_status": flask_response.status_code,
            "flask_recorded_bodies": len(flask_transport.sent_bodies),
            "django_config_type": type(django_config).__name__,
        },
        sort_keys=True,
    )
)
PY

python "$tmp_dir/prove_public_pypi_install.py" | tee "$tmp_dir/proof.json"

python - "$tmp_dir/proof.json" <<'PY'
from __future__ import annotations

import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.loads(handle.read())

if payload["flush_status"] != 202:
    raise SystemExit("expected local flush status 202")
if payload["flush_attempts"] != 1:
    raise SystemExit("expected one local flush attempt")
if payload["recorded_bodies"] != 1:
    raise SystemExit("expected one recorded local request body")
if payload["dbapi_spans"] < 5:
    raise SystemExit("expected DB-API spans from public PyPI package")
if payload["otel_exporter_result"] != "SUCCESS":
    raise SystemExit("expected dependency-optional OpenTelemetry exporter success result")
if payload["span_links"] != 1:
    raise SystemExit("expected one privacy-bounded span link")
if payload["fastapi_middleware_count"] < 1:
    raise SystemExit("expected FastAPI middleware registration")
if payload["flask_status"] != 200:
    raise SystemExit("expected installed Flask response status 200")
if payload["flask_recorded_bodies"] != 1:
    raise SystemExit("expected one installed Flask request span body")
if payload["django_config_type"] != "LogBrewDjangoConfig":
    raise SystemExit("expected Django integration config")
PY

echo "python public PyPI install smoke passed"
