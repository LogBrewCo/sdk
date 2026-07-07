#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/python_package_version.sh"

core_dir="$repo_root/python/logbrew_py"
package_dir="$repo_root/python/logbrew_flask"
tmp_dir="$(mktemp -d)"
core_package_version="$(python_package_version "$core_dir/pyproject.toml")"
flask_package_version="$(python_package_version "$package_dir/pyproject.toml")"
export LOGBREW_FLASK_PACKAGE_VERSION="$flask_package_version"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

python3 -m venv "$tmp_dir/build-venv"
"$tmp_dir/build-venv/bin/python" -m pip install --upgrade --disable-pip-version-check pip >/dev/null
"$tmp_dir/build-venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check build >/dev/null
"$tmp_dir/build-venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/core-dist" "$core_dir" >/dev/null
"$tmp_dir/build-venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/flask-dist" "$package_dir" >/dev/null

core_wheel="$tmp_dir/core-dist/logbrew_sdk-${core_package_version}-py3-none-any.whl"
flask_wheel="$tmp_dir/flask-dist/logbrew_flask-${flask_package_version}-py3-none-any.whl"
flask_sdist="$tmp_dir/flask-dist/logbrew_flask-${flask_package_version}.tar.gz"
test -f "$core_wheel"
test -f "$flask_wheel"
test -f "$flask_sdist"

python3 -m venv "$tmp_dir/app"
"$tmp_dir/app/bin/python" -m pip install --upgrade --disable-pip-version-check pip >/dev/null
"$tmp_dir/app/bin/python" -m pip install --no-cache-dir --disable-pip-version-check "$core_wheel" "$flask_wheel" mypy >/dev/null
"$tmp_dir/app/bin/python" -m pip check >/dev/null
"$tmp_dir/app/bin/python" -m pip show logbrew-flask > "$tmp_dir/pip-show-flask.txt"
grep -q '^Name: logbrew-flask$' "$tmp_dir/pip-show-flask.txt"
grep -q "^Version: ${flask_package_version}$" "$tmp_dir/pip-show-flask.txt"
grep -q '^Summary: Flask integration for capturing LogBrew request spans and exceptions\.$' "$tmp_dir/pip-show-flask.txt"
"$tmp_dir/app/bin/python" -m pip list --format=json > "$tmp_dir/pip-list.json"
python3 - "$tmp_dir/pip-list.json" <<'PY'
import json
import os
import sys
from pathlib import Path

packages = {package["name"].lower(): package["version"] for package in json.loads(Path(sys.argv[1]).read_text())}
for name in ("flask", "logbrew-flask", "logbrew-sdk", "werkzeug"):
    if name not in packages:
        raise SystemExit(f"missing installed package: {name}")
expected_flask_version = os.environ["LOGBREW_FLASK_PACKAGE_VERSION"]
if packages["logbrew-flask"] != expected_flask_version:
    raise SystemExit(f"unexpected logbrew-flask version: {packages['logbrew-flask']}")
PY

app_dir="$tmp_dir/consumer"
mkdir -p "$app_dir"
cat > "$app_dir/main.py" <<'PY'
from __future__ import annotations

import json
import logging

from flask import Flask
from logbrew_flask import add_logbrew_middleware, get_active_logbrew_trace
from logbrew_sdk import LogBrewClient, LogBrewLoggingHandler, RecordingTransport

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-flask",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
logger = logging.getLogger("flask.checkout")
logger.handlers = []
logger.propagate = False
logger.setLevel(logging.INFO)
logger.addHandler(LogBrewLoggingHandler(client, metadata={"service": "checkout"}))
app = Flask(__name__)
add_logbrew_middleware(app, client=client, transport=transport, span_id_factory=lambda: "b7ad6b7169203331")


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


http = app.test_client()
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
            "pending": client.pending_events(),
            "eventTypes": [event["type"] for event in events],
            "spanNames": [event["attributes"]["name"] for event in events if event["type"] == "span"],
            "issueTitles": [event["attributes"]["title"] for event in events if event["type"] == "issue"],
            "handlerTraceId": health_response.json["traceId"],
            "handlerSpanId": health_response.json["spanId"],
            "logTraceId": first_log["metadata"]["traceId"],
            "logSpanId": first_log["metadata"]["spanId"],
            "traceId": first_span["traceId"],
            "parentSpanId": first_span["parentSpanId"],
            "spanId": first_span["spanId"],
            "path": first_span["metadata"]["path"],
            "body": {"sdk": client.sdk, "events": events},
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
if payload["sentBodies"] != 2:
    raise SystemExit(f"expected two flushed bodies, got {payload['sentBodies']}")
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

from flask import Flask
from logbrew_flask import add_logbrew_middleware, get_active_logbrew_trace
from logbrew_sdk import LogBrewClient, RecordingTransport

client: LogBrewClient = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="typed-flask-consumer",
    sdk_version="0.1.0",
)
transport: RecordingTransport = RecordingTransport.always_accept()
app: Flask = Flask(__name__)
active_trace = get_active_logbrew_trace()
trace_id: str | None = active_trace.trace_id if active_trace else None
add_logbrew_middleware(
    app,
    client=client,
    transport=transport,
    raise_flush_errors=True,
    span_id_factory=lambda: "b7ad6b7169203331",
)
PY

cat > "$app_dir/pyproject.toml" <<'TOML'
[tool.mypy]
python_version = "3.11"
strict = true
TOML

(cd "$app_dir" && "$tmp_dir/app/bin/python" -m mypy --config-file pyproject.toml typecheck.py)

"$tmp_dir/app/bin/python" -m logbrew_flask.examples --list > "$tmp_dir/examples-list.txt"
grep -qx 'readme-example -> python -m logbrew_flask.examples readme-example' <(sed -n '1p' "$tmp_dir/examples-list.txt")
grep -qx 'real-user-smoke -> python -m logbrew_flask.examples real-user-smoke' <(sed -n '2p' "$tmp_dir/examples-list.txt")
grep -qx 'default (real-user-smoke) -> python -m logbrew_flask.examples' <(sed -n '3p' "$tmp_dir/examples-list.txt")
"$tmp_dir/app/bin/python" -m logbrew_flask.examples readme-example > "$tmp_dir/readme.stdout.json" 2> "$tmp_dir/readme.stderr.json"
grep -q '"type": "span"' "$tmp_dir/readme.stdout.json"
"$tmp_dir/app/bin/python" -m logbrew_flask.examples real-user-smoke > "$tmp_dir/smoke.stdout.json" 2> "$tmp_dir/smoke.stderr.json"
grep -q '"type": "issue"' "$tmp_dir/smoke.stdout.json"
grep -q '"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/smoke.stderr.json"
grep -q '"parentSpanId": "00f067aa0ba902b7"' "$tmp_dir/smoke.stderr.json"
grep -q '"spanId": "b7ad6b7169203331"' "$tmp_dir/smoke.stderr.json"
grep -q '"path": "/health"' "$tmp_dir/smoke.stderr.json"
grep -q '"events": 4' "$tmp_dir/smoke.stderr.json"

printf 'flask real-user smoke passed with %s\n' "$("$tmp_dir/app/bin/python" - <<'PY'
from importlib.metadata import version

print(f"flask@{version('flask')}")
PY
)"
