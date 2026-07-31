#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/python_package_version.sh"

core_dir="$repo_root/python/logbrew_py"
package_dir="$repo_root/python/logbrew_fastapi"
tmp_dir="$(mktemp -d)"
core_package_version="$(python_package_version "$core_dir/pyproject.toml")"
fastapi_package_version="$(python_package_version "$package_dir/pyproject.toml")"
export LOGBREW_FASTAPI_PACKAGE_VERSION="$fastapi_package_version"
export LOGBREW_FASTAPI_FRAMEWORK_VERSION="${LOGBREW_FASTAPI_FRAMEWORK_VERSION:-}"
export LOGBREW_FASTAPI_HTTPX_VERSION="${LOGBREW_FASTAPI_HTTPX_VERSION:-}"

if [[ -n "$LOGBREW_FASTAPI_FRAMEWORK_VERSION" ]] &&
  [[ ! "$LOGBREW_FASTAPI_FRAMEWORK_VERSION" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then
  printf 'LOGBREW_FASTAPI_FRAMEWORK_VERSION must be a numeric release version\n' >&2
  exit 2
fi
if [[ -n "$LOGBREW_FASTAPI_HTTPX_VERSION" ]] &&
  [[ ! "$LOGBREW_FASTAPI_HTTPX_VERSION" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then
  printf 'LOGBREW_FASTAPI_HTTPX_VERSION must be a numeric release version\n' >&2
  exit 2
fi
if [[ -n "$LOGBREW_FASTAPI_HTTPX_VERSION" && -z "$LOGBREW_FASTAPI_FRAMEWORK_VERSION" ]]; then
  printf 'LOGBREW_FASTAPI_HTTPX_VERSION requires LOGBREW_FASTAPI_FRAMEWORK_VERSION\n' >&2
  exit 2
fi

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

check_json() {
  python3 "$repo_root/scripts/check_python_package_json.py" "$@"
}

trap remove_tmp_dir EXIT

python3 -m venv "$tmp_dir/build-venv"
"$tmp_dir/build-venv/bin/python" -m pip install --upgrade --disable-pip-version-check pip >/dev/null
"$tmp_dir/build-venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check build >/dev/null
"$tmp_dir/build-venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/core-dist" "$core_dir" >/dev/null
"$tmp_dir/build-venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/fastapi-dist" "$package_dir" >/dev/null

core_wheel="$tmp_dir/core-dist/logbrew_sdk-${core_package_version}-py3-none-any.whl"
fastapi_wheel="$tmp_dir/fastapi-dist/logbrew_fastapi-${fastapi_package_version}-py3-none-any.whl"
fastapi_sdist="$tmp_dir/fastapi-dist/logbrew_fastapi-${fastapi_package_version}.tar.gz"
test -f "$core_wheel"
test -f "$fastapi_wheel"
test -f "$fastapi_sdist"

python3 -m venv "$tmp_dir/app"
"$tmp_dir/app/bin/python" -m pip install --upgrade --disable-pip-version-check pip >/dev/null
test_client_requirement="httpx2==2.3.0"
if [[ -n "$LOGBREW_FASTAPI_HTTPX_VERSION" ]]; then
  test_client_requirement="httpx==${LOGBREW_FASTAPI_HTTPX_VERSION}"
fi
app_dependencies=("$core_wheel" "$fastapi_wheel[celery]" mypy "$test_client_requirement")
if [[ -n "$LOGBREW_FASTAPI_FRAMEWORK_VERSION" ]]; then
  app_dependencies=("fastapi==${LOGBREW_FASTAPI_FRAMEWORK_VERSION}" "${app_dependencies[@]}")
fi
"$tmp_dir/app/bin/python" -m pip install --no-cache-dir --disable-pip-version-check \
  "${app_dependencies[@]}" >/dev/null
"$tmp_dir/app/bin/python" -m pip check >/dev/null
"$tmp_dir/app/bin/python" -m pip show logbrew-fastapi > "$tmp_dir/pip-show-fastapi.txt"
grep -q '^Name: logbrew-fastapi$' "$tmp_dir/pip-show-fastapi.txt"
grep -q "^Version: ${fastapi_package_version}$" "$tmp_dir/pip-show-fastapi.txt"
grep -q '^Summary: FastAPI integration for capturing LogBrew request spans and exceptions\.$' "$tmp_dir/pip-show-fastapi.txt"
"$tmp_dir/app/bin/python" -m pip list --format=json > "$tmp_dir/pip-list.json"
"$tmp_dir/app/bin/python" - "$tmp_dir/pip-list.json" <<'PY'
import importlib.metadata
import json
import os
import sys
from pathlib import Path

packages = {package["name"].lower(): package["version"] for package in json.loads(Path(sys.argv[1]).read_text())}
for name in ("celery", "fastapi", "logbrew-fastapi", "logbrew-sdk", "starlette"):
    if name not in packages:
        raise SystemExit(f"missing installed package: {name}")
expected_fastapi_version = os.environ["LOGBREW_FASTAPI_PACKAGE_VERSION"]
if packages["logbrew-fastapi"] != expected_fastapi_version:
    raise SystemExit(f"unexpected logbrew-fastapi version: {packages['logbrew-fastapi']}")
expected_framework_version = os.environ["LOGBREW_FASTAPI_FRAMEWORK_VERSION"]
if expected_framework_version and packages["fastapi"] != expected_framework_version:
    raise SystemExit(f"unexpected FastAPI version: {packages['fastapi']}")
expected_httpx_version = os.environ["LOGBREW_FASTAPI_HTTPX_VERSION"]
if expected_httpx_version:
    if packages.get("httpx") != expected_httpx_version:
        raise SystemExit(f"unexpected httpx version: {packages.get('httpx')}")
    if "httpx2" in packages:
        raise SystemExit("legacy httpx compatibility lane unexpectedly installed httpx2")
elif packages.get("httpx2") != "2.3.0":
    raise SystemExit(f"unexpected httpx2 version: {packages.get('httpx2')}")
requirements = importlib.metadata.requires("logbrew-fastapi") or []
if not any("logbrew-sdk[celery]" in requirement and "extra == \"celery\"" in requirement for requirement in requirements):
    raise SystemExit("installed FastAPI wheel does not expose the celery extra")
PY

app_dir="$tmp_dir/consumer"
mkdir -p "$app_dir"
cat > "$app_dir/main.py" <<'PY'
from __future__ import annotations

import json
import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient
from logbrew_fastapi import get_active_logbrew_trace, init_logbrew
from logbrew_sdk import RecordingTransport

transport = RecordingTransport.always_accept()
app = FastAPI()
runtime = init_logbrew(
    app,
    api_key="LOGBREW_API_KEY",
    service_name="checkout",
    transport=transport,
    automatic_delivery=False,
    span_id_factory=lambda: "b7ad6b7169203331",
)
logger = logging.getLogger("fastapi.checkout")
logger.handlers = []
logger.propagate = False
logger.setLevel(logging.INFO)
logger.addHandler(runtime.logging_handler)


@app.get("/health")
def health() -> dict[str, object]:
    trace = get_active_logbrew_trace()
    logger.info("health request", extra={"route_template": "/health"})
    return {
        "ok": True,
        "traceId": trace.trace_id if trace else None,
        "spanId": trace.span_id if trace else None,
    }


@app.get("/boom")
def boom() -> dict[str, bool]:
    raise RuntimeError("broken handler")


with TestClient(app, raise_server_exceptions=False) as http:
    health_response = http.get(
        "/health?debug=true",
        headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
    )
    boom_response = http.get("/boom")

events: list[dict[str, object]] = []
for body in transport.sent_bodies:
    events.extend(json.loads(body)["events"])
first_log = events[0]["attributes"]
first_span = events[1]["attributes"]

print(
    json.dumps(
        {
            "ok": health_response.status_code == 200 and boom_response.status_code == 500,
            "healthStatus": health_response.status_code,
            "boomStatus": boom_response.status_code,
            "sentBodies": len(transport.sent_bodies),
            "pending": runtime.client.pending_events(),
            "eventTypes": [event["type"] for event in events],
            "spanNames": [event["attributes"]["name"] for event in events if event["type"] == "span"],
            "issueTitles": [event["attributes"]["title"] for event in events if event["type"] == "issue"],
            "handlerTraceId": health_response.json()["traceId"],
            "handlerSpanId": health_response.json()["spanId"],
            "logTraceId": first_log["metadata"]["traceId"],
            "logSpanId": first_log["metadata"]["spanId"],
            "traceId": first_span["traceId"],
            "parentSpanId": first_span["parentSpanId"],
            "spanId": first_span["spanId"],
            "path": first_span["metadata"]["path"],
            "body": {"sdk": runtime.client.sdk, "events": events},
        },
        indent=2,
    )
)
PY

"$tmp_dir/app/bin/python" "$app_dir/main.py" > "$tmp_dir/consumer.stdout.json"
python3 - "$tmp_dir/consumer.stdout.json" "$tmp_dir/body.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
if payload["ok"] is not True:
    raise SystemExit(f"unexpected smoke status: {payload}")
if payload["healthStatus"] != 200 or payload["boomStatus"] != 500:
    raise SystemExit(f"unexpected HTTP statuses: {payload}")
if payload["sentBodies"] != 1:
    raise SystemExit(f"expected one final flushed body, got {payload['sentBodies']}")
if payload["pending"] != 0:
    raise SystemExit(f"expected empty queue, got {payload['pending']}")
if payload["eventTypes"] != ["log", "span", "issue", "span"]:
    raise SystemExit(f"unexpected event types: {payload['eventTypes']}")
if payload["spanNames"] != ["GET /health", "GET /boom"]:
    raise SystemExit(f"unexpected span names: {payload['spanNames']}")
if payload["issueTitles"] != ["GET /boom failed"]:
    raise SystemExit(f"unexpected issue titles: {payload['issueTitles']}")
if payload["traceId"] != "4bf92f3577b34da6a3ce929d0e0e4736":
    raise SystemExit(f"unexpected trace id: {payload['traceId']}")
if payload["handlerTraceId"] != payload["traceId"] or payload["logTraceId"] != payload["traceId"]:
    raise SystemExit(f"trace correlation failed: {payload}")
if payload["handlerSpanId"] != payload["spanId"] or payload["logSpanId"] != payload["spanId"]:
    raise SystemExit(f"span correlation failed: {payload}")
if payload["parentSpanId"] != "00f067aa0ba902b7":
    raise SystemExit(f"unexpected parent span id: {payload['parentSpanId']}")
if payload["spanId"] != "b7ad6b7169203331":
    raise SystemExit(f"unexpected child span id: {payload['spanId']}")
if payload["path"] != "/health":
    raise SystemExit(f"expected path without query text: {payload['path']}")
Path(sys.argv[2]).write_text(json.dumps(payload["body"], indent=2), encoding="utf-8")
PY
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/body.json" >/dev/null

cat > "$app_dir/typecheck.py" <<'PY'
from __future__ import annotations

from fastapi import FastAPI
from logbrew_fastapi import add_logbrew_middleware, get_active_logbrew_trace, init_logbrew
from logbrew_sdk import HttpTransport, LogBrewClient, RecordingTransport

transport: RecordingTransport = RecordingTransport.always_accept()
app: FastAPI = FastAPI()
runtime = init_logbrew(
    app,
    api_key="LOGBREW_API_KEY",
    service_name="typed-fastapi-consumer",
    transport=transport,
    automatic_delivery=False,
    span_id_factory=lambda: "b7ad6b7169203331",
)
client: LogBrewClient = runtime.client
active_trace = get_active_logbrew_trace()
trace_id: str | None = active_trace.trace_id if active_trace else None
pending_events: int = runtime.delivery_health().pending_events
low_level_app: FastAPI = FastAPI()
http_transport: HttpTransport = HttpTransport()
add_logbrew_middleware(low_level_app, client=client, transport=http_transport)
PY

cat > "$app_dir/pyproject.toml" <<'TOML'
[tool.mypy]
python_version = "3.11"
strict = true
TOML

(cd "$app_dir" && "$tmp_dir/app/bin/python" -m mypy --config-file pyproject.toml typecheck.py)

"$tmp_dir/app/bin/python" -m logbrew_fastapi.examples --list > "$tmp_dir/examples-list.txt"
grep -qx 'readme-example -> python -m logbrew_fastapi.examples readme-example' <(sed -n '1p' "$tmp_dir/examples-list.txt")
grep -qx 'outbound-http -> python -m logbrew_fastapi.examples outbound-http' <(sed -n '2p' "$tmp_dir/examples-list.txt")
grep -qx 'dependency-spans -> python -m logbrew_fastapi.examples dependency-spans' <(sed -n '3p' "$tmp_dir/examples-list.txt")
grep -qx 'real-user-smoke -> python -m logbrew_fastapi.examples real-user-smoke' <(sed -n '4p' "$tmp_dir/examples-list.txt")
grep -qx 'default (real-user-smoke) -> python -m logbrew_fastapi.examples' <(sed -n '5p' "$tmp_dir/examples-list.txt")
"$tmp_dir/app/bin/python" -m logbrew_fastapi.examples readme-example > "$tmp_dir/readme.stdout.json" 2> "$tmp_dir/readme.stderr.json"
check_json event-kinds span "$tmp_dir/readme.stdout.json"
"$tmp_dir/app/bin/python" -m logbrew_fastapi.examples outbound-http > "$tmp_dir/outbound.stdout.json" 2> "$tmp_dir/outbound.stderr.json"
check_json event-kinds span "$tmp_dir/outbound.stdout.json"
check_json fields \
  'requestSpanId="b7ad6b7169203331"' \
  'outboundParentSpanId="b7ad6b7169203331"' \
  'outboundSpanId="c8ad6b7169203332"' \
  'traceparentMatchesSpan=true' \
  "$tmp_dir/outbound.stderr.json"
"$tmp_dir/app/bin/python" -m logbrew_fastapi.examples dependency-spans > "$tmp_dir/dependency.stdout.json" 2> "$tmp_dir/dependency.stderr.json"
check_json event-kinds span "$tmp_dir/dependency.stdout.json"
check_json fields \
  'requestSpanId="b7ad6b7169203331"' \
  'databaseParentSpanId="b7ad6b7169203331"' \
  'databaseSpanId="c8ad6b7169203332"' \
  'cacheParentSpanId="b7ad6b7169203331"' \
  'cacheSpanId="d9ad6b7169203333"' \
  'queueParentSpanId="b7ad6b7169203331"' \
  'queueSpanId="e0ad6b7169203334"' \
  "$tmp_dir/dependency.stderr.json"
"$tmp_dir/app/bin/python" -m logbrew_fastapi.examples real-user-smoke > "$tmp_dir/smoke.stdout.json" 2> "$tmp_dir/smoke.stderr.json"
check_json event-kinds span issue "$tmp_dir/smoke.stdout.json"
check_json fields \
  'traceId="4bf92f3577b34da6a3ce929d0e0e4736"' \
  'parentSpanId="00f067aa0ba902b7"' \
  'spanId="b7ad6b7169203331"' \
  'path="/health"' \
  'events=3' \
  "$tmp_dir/smoke.stderr.json"

printf 'fastapi real-user smoke passed with %s\n' "$("$tmp_dir/app/bin/python" - <<'PY'
import fastapi

print(f"fastapi@{fastapi.__version__}")
PY
)"
