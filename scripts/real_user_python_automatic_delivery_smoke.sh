#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

python3 -m venv "$tmp_dir/venv"
python="$tmp_dir/venv/bin/python"
export PIP_CACHE_DIR="$tmp_dir/pip-cache"
export PIP_DISABLE_PIP_VERSION_CHECK=1

"$python" -m pip install --quiet "pip==26.1.2" "build==1.4.0"
cp -R "$repo_root/python/logbrew_py" "$tmp_dir/logbrew_py"
rm -rf \
  "$tmp_dir/logbrew_py/build" \
  "$tmp_dir/logbrew_py/dist" \
  "$tmp_dir/logbrew_py/src/logbrew_sdk.egg-info"
find "$tmp_dir/logbrew_py" -type d -name __pycache__ -prune -exec rm -rf {} +
"$python" -m build "$tmp_dir/logbrew_py" --wheel --outdir "$tmp_dir/dist" >"$tmp_dir/build.log"
wheel_path="$(find "$tmp_dir/dist" -maxdepth 1 -type f -name 'logbrew_sdk-*.whl' -print -quit)"
test -n "$wheel_path"
wheel_sha256="$(shasum -a 256 "$wheel_path" | awk '{print $1}')"
"$python" -m pip install --quiet --no-index "$wheel_path"
"$python" -m pip check >/dev/null
rm -rf "$tmp_dir/logbrew_py"

cat >"$tmp_dir/app.py" <<'PY'
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from logbrew_sdk import HttpTransport, LogBrewClient


class IntakeState:
    bodies: list[bytes] = []
    paths: list[str] = []
    authorizations: list[str | None] = []
    statuses = [503, 202, 202, 429, 202, 202]


class IntakeHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        IntakeState.bodies.append(self.rfile.read(length))
        IntakeState.paths.append(self.path)
        IntakeState.authorizations.append(self.headers.get("authorization"))
        request_index = len(IntakeState.bodies) - 1
        self.send_response(IntakeState.statuses[request_index])
        self.end_headers()

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def wait_for_requests(count: int, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while len(IntakeState.bodies) < count:
        if time.monotonic() >= deadline:
            raise AssertionError(f"expected {count} intake requests")
        time.sleep(0.01)


server = ThreadingHTTPServer(("127.0.0.1", 0), IntakeHandler)
server_thread = threading.Thread(target=server.serve_forever, daemon=True)
server_thread.start()
try:
    endpoint = f"http://127.0.0.1:{server.server_port}/v1/events"
    client = LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="python-automatic-delivery-smoke",
        sdk_version="0.1.0",
        max_retries=0,
        transport=HttpTransport(endpoint=endpoint, timeout=2),
        delivery_interval_seconds=0.1,
        delivery_queue_threshold=1,
    )
    client.log(
        "evt_automatic_delivery",
        "2026-07-16T10:00:00Z",
        {"message": "automatic delivery", "level": "info", "logger": "installed-smoke"},
    )
    wait_for_requests(2)
    deadline = time.monotonic() + 5
    while client.pending_events() != 0:
        if time.monotonic() >= deadline:
            raise AssertionError("automatic retry did not accept the retained event")
        time.sleep(0.01)

    health = client.delivery_health()
    expected_keys = {
        "accepted_events",
        "attempts",
        "automatic_delivery",
        "batches",
        "coalesced",
        "consecutive_failures",
        "dropped_events",
        "failures",
        "flushes",
        "in_flight",
        "last_outcome",
        "lifecycle",
        "paused_reason",
        "queue_bytes",
        "queue_events",
        "retry_delay_ms",
        "scheduled",
    }
    if set(health) != expected_keys:
        raise AssertionError("delivery health keys changed")
    if health["last_outcome"] != "accepted" or health["failures"] != 1:
        raise AssertionError("delivery health outcome mismatch")
    if health["attempts"] != 2 or health["batches"] != 1 or health["accepted_events"] != 1:
        raise AssertionError("delivery health counters mismatch")
    serialized_health = json.dumps(health, sort_keys=True)
    for forbidden in (
        "LOGBREW_API_KEY",
        "evt_automatic_delivery",
        "automatic delivery",
        endpoint,
        "/v1/events",
        "503",
    ):
        if forbidden in serialized_health:
            raise AssertionError("delivery health exposed request content")

    if IntakeState.bodies[0] != IntakeState.bodies[1]:
        raise AssertionError("automatic retry changed the serialized request")
    if IntakeState.paths != ["/v1/events", "/v1/events"]:
        raise AssertionError("automatic delivery path mismatch")
    if IntakeState.authorizations != ["Bearer LOGBREW_API_KEY", "Bearer LOGBREW_API_KEY"]:
        raise AssertionError("automatic delivery authorization mismatch")
    payload = json.loads(IntakeState.bodies[-1])
    if [event["id"] for event in payload["events"]] != ["evt_automatic_delivery"]:
        raise AssertionError("automatic delivery event order mismatch")

    client.shutdown()
    if any(thread.name == "logbrew-delivery" and thread.is_alive() for thread in threading.enumerate()):
        raise AssertionError("client scheduler survived shutdown")

    manual = LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="python-manual-delivery-smoke",
        sdk_version="0.1.0",
        transport=HttpTransport(endpoint=endpoint, timeout=2),
        automatic_delivery=False,
    )
    manual.log(
        "evt_manual_delivery",
        "2026-07-16T10:00:01Z",
        {"message": "manual delivery", "level": "info", "logger": "installed-smoke"},
    )
    time.sleep(0.15)
    if len(IntakeState.bodies) != 2:
        raise AssertionError("manual delivery opt-out sent automatically")
    manual.flush()
    manual.shutdown()

    paused = LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="python-paused-delivery-smoke",
        sdk_version="0.1.0",
        max_retries=0,
        transport=HttpTransport(endpoint=endpoint, timeout=2),
        delivery_interval_seconds=0.1,
        delivery_queue_threshold=1,
    )
    paused.log(
        "evt_paused_delivery",
        "2026-07-16T10:00:02Z",
        {"message": "paused delivery", "level": "info", "logger": "installed-smoke"},
    )
    wait_for_requests(4)
    deadline = time.monotonic() + 5
    while paused.delivery_health()["paused_reason"] != "rate_limit":
        if time.monotonic() >= deadline:
            raise AssertionError("terminal rate-limit pause was not reported")
        time.sleep(0.01)
    paused.log(
        "evt_paused_later",
        "2026-07-16T10:00:03Z",
        {"message": "paused later", "level": "info", "logger": "installed-smoke"},
    )
    time.sleep(0.15)
    if len(IntakeState.bodies) != 4:
        raise AssertionError("terminal pause repeated automatic delivery")
    paused.flush()
    wait_for_requests(6)
    if IntakeState.bodies[3] != IntakeState.bodies[4]:
        raise AssertionError("manual recovery changed the retained failed request")
    if [event["id"] for event in json.loads(IntakeState.bodies[5])["events"]] != [
        "evt_paused_later"
    ]:
        raise AssertionError("terminal pause did not retain later work")
    paused_health = paused.delivery_health()
    if paused_health["paused_reason"] != "none" or paused_health["accepted_events"] != 2:
        raise AssertionError("manual recovery did not restore automatic delivery")
    paused.shutdown()

    if IntakeState.paths != ["/v1/events"] * 6:
        raise AssertionError("automatic delivery path sequence mismatch")
    if IntakeState.authorizations != ["Bearer LOGBREW_API_KEY"] * 6:
        raise AssertionError("automatic delivery authorization sequence mismatch")
    print(json.dumps({"health": "bounded", "requests": 6, "status": "accepted"}, sort_keys=True))
finally:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=2)
PY

"$python" - "$tmp_dir/app.py" "$wheel_sha256" <<'PY'
from __future__ import annotations

import importlib.metadata
import json
import subprocess
import sys

completed = subprocess.run(
    [sys.executable, sys.argv[1]],
    check=True,
    capture_output=True,
    text=True,
    timeout=20,
)
result = json.loads(completed.stdout)
if result != {"health": "bounded", "requests": 6, "status": "accepted"}:
    raise AssertionError("installed automatic delivery result mismatch")
print(
    "python automatic delivery smoke ok "
    f"version={importlib.metadata.version('logbrew-sdk')} "
    f"sha256={sys.argv[2]} requests={result['requests']}"
)
PY
