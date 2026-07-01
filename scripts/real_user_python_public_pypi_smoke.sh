#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-python-public-pypi.XXXXXX")"

sdk_version="${1:-${LOGBREW_PYPI_SDK_VERSION:-0.1.0}}"
fastapi_version="${2:-${LOGBREW_PYPI_FASTAPI_VERSION:-0.1.0}}"
django_version="${3:-${LOGBREW_PYPI_DJANGO_VERSION:-0.1.0}}"
index_url="https://pypi.org/simple"

on_error() {
    local status=$?
    echo "real_user_python_public_pypi_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
    for diagnostic in \
        "$tmp_dir/pip-check.txt" \
        "$tmp_dir/pip-freeze.txt" \
        "$tmp_dir/pip-list.json" \
        "$tmp_dir/logbrew-sdk.show.txt" \
        "$tmp_dir/logbrew-fastapi.show.txt" \
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

python3 -m venv "$tmp_dir/venv"
export PATH="$tmp_dir/venv/bin:$PATH"

python -m pip install --disable-pip-version-check --upgrade pip >/dev/null

packages=(
    "logbrew-sdk==$sdk_version"
    "logbrew-fastapi==$fastapi_version"
    "logbrew-django==$django_version"
)

python -m pip install \
    --disable-pip-version-check \
    --no-cache-dir \
    --index-url "$index_url" \
    "${packages[@]}"
python -m pip check > "$tmp_dir/pip-check.txt"
python -m pip show logbrew-sdk > "$tmp_dir/logbrew-sdk.show.txt"
python -m pip show logbrew-fastapi > "$tmp_dir/logbrew-fastapi.show.txt"
python -m pip show logbrew-django > "$tmp_dir/logbrew-django.show.txt"
python -m pip list --format=json > "$tmp_dir/pip-list.json"
python -m pip freeze > "$tmp_dir/pip-freeze.txt"

export EXPECTED_LOGBREW_SDK_VERSION="$sdk_version"
export EXPECTED_LOGBREW_FASTAPI_VERSION="$fastapi_version"
export EXPECTED_LOGBREW_DJANGO_VERSION="$django_version"

cat > "$tmp_dir/prove_public_pypi_install.py" <<'PY'
from __future__ import annotations

import importlib.metadata as metadata
import json
import os

from fastapi import FastAPI
from logbrew_django import configure_logbrew
from logbrew_fastapi import add_logbrew_middleware
from logbrew_sdk import LogBrewClient, RecordingTransport


def require_distribution_version(distribution: str, expected: str) -> str:
    resolved = metadata.version(distribution)
    if resolved != expected:
        raise AssertionError(f"{distribution} resolved {resolved}, expected {expected}")
    return resolved


sdk_version = os.environ["EXPECTED_LOGBREW_SDK_VERSION"]
fastapi_version = os.environ["EXPECTED_LOGBREW_FASTAPI_VERSION"]
django_version = os.environ["EXPECTED_LOGBREW_DJANGO_VERSION"]

versions = {
    "logbrew-sdk": require_distribution_version("logbrew-sdk", sdk_version),
    "logbrew-fastapi": require_distribution_version("logbrew-fastapi", fastapi_version),
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

app = FastAPI()
add_logbrew_middleware(app, client=client, transport=RecordingTransport())
if not app.user_middleware:
    raise AssertionError("expected FastAPI middleware to be registered")

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
            "fastapi_middleware_count": len(app.user_middleware),
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
if payload["fastapi_middleware_count"] < 1:
    raise SystemExit("expected FastAPI middleware registration")
if payload["django_config_type"] != "LogBrewDjangoConfig":
    raise SystemExit("expected Django integration config")
PY

echo "python public PyPI install smoke passed"
