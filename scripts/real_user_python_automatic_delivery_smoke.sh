#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

python3 -m venv "$tmp_dir/build-venv"
cp -R "$repo_root/python/logbrew_py" "$tmp_dir/logbrew_py"
find "$tmp_dir/logbrew_py" -type d \( \
  -name __pycache__ -o \
  -name build -o \
  -name dist -o \
  -name '*.egg-info' \
\) -prune -exec rm -rf {} +
if ! "$tmp_dir/build-venv/bin/python" -m pip install \
  --disable-pip-version-check \
  --quiet \
  pip==26.1.2 \
  build==1.5.1 \
  >"$tmp_dir/build-install.log" 2>&1; then
  printf '%s\n' "python automatic delivery smoke failed"
  exit 1
fi
if ! "$tmp_dir/build-venv/bin/python" -m build \
  --wheel \
  --outdir "$tmp_dir/dist" \
  "$tmp_dir/logbrew_py" \
  >"$tmp_dir/build.log" 2>&1; then
  printf '%s\n' "python automatic delivery smoke failed"
  exit 1
fi

wheel_path="$(find "$tmp_dir/dist" -maxdepth 1 -type f -name '*.whl' -print -quit)"
if [[ -z "$wheel_path" ]]; then
  printf '%s\n' "python automatic delivery smoke failed"
  exit 1
fi

python3 -m venv "$tmp_dir/consumer-venv"
if ! "$tmp_dir/consumer-venv/bin/python" -m pip install \
  --disable-pip-version-check \
  --quiet \
  --no-index \
  "$wheel_path" \
  >"$tmp_dir/consumer-install.log" 2>&1; then
  printf '%s\n' "python automatic delivery smoke failed"
  exit 1
fi

cat >"$tmp_dir/consumer.py" <<'PY'
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from logbrew_sdk import HttpTransport, LogBrewClient


class IntakeHandler(BaseHTTPRequestHandler):
    bodies: list[bytes] = []

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        type(self).bodies.append(self.rfile.read(length))
        self.send_response(503 if len(type(self).bodies) == 1 else 202)
        if len(type(self).bodies) == 1:
            self.send_header("retry-after-ms", "20")
        self.end_headers()

    def log_message(self, _format: str, *args: object) -> None:
        return


server = ThreadingHTTPServer(("127.0.0.1", 0), IntakeHandler)
server_thread = threading.Thread(target=server.serve_forever, daemon=True)
server_thread.start()
client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="installed-python-automatic",
    sdk_version="0.1.3",
    transport=HttpTransport(endpoint=f"http://127.0.0.1:{server.server_port}/events"),
    automatic_delivery=True,
    delivery_interval_seconds=60,
    delivery_queue_threshold=1,
    max_retries=0,
)
client.log(
    "evt_installed_automatic",
    "2026-07-20T08:00:00Z",
    {"message": "installed automatic delivery", "level": "info", "logger": "installed-smoke"},
)

deadline = time.monotonic() + 5
while len(IntakeHandler.bodies) < 2 and time.monotonic() < deadline:
    time.sleep(0.01)
if len(IntakeHandler.bodies) != 2 or IntakeHandler.bodies[0] != IntakeHandler.bodies[1]:
    raise SystemExit("installed automatic delivery assertion failed")

health = client.delivery_health()
if health.pending_events != 0 or health.accepted_events != 1 or health.delivery_attempts != 2:
    raise SystemExit("installed automatic delivery assertion failed")
if set(health.__dataclass_fields__) != {
    "lifecycle",
    "automatic_delivery",
    "pending_events",
    "pending_event_bytes",
    "dropped_events",
    "delivery_in_flight",
    "wake_coalesced",
    "last_outcome",
    "pause_reason",
    "consecutive_failures",
    "retry_delay_ms",
    "delivery_attempts",
    "accepted_events",
}:
    raise SystemExit("installed automatic delivery assertion failed")

response = client.shutdown()
server.shutdown()
server.server_close()
server_thread.join(timeout=2)
if server_thread.is_alive() or response.status_code != 204:
    raise SystemExit("installed automatic delivery assertion failed")

print(json.dumps({"status": "passed", "requests": 2, "accepted_events": 1}, separators=(",", ":")))
PY

cat >"$tmp_dir/supervisor.py" <<'PY'
from __future__ import annotations

import json
import subprocess
import sys

try:
    completed = subprocess.run(
        [sys.argv[1], sys.argv[2]],
        capture_output=True,
        check=False,
        text=True,
        timeout=30,
    )
except subprocess.TimeoutExpired:
    raise SystemExit("python automatic delivery smoke failed") from None
expected = {"status": "passed", "requests": 2, "accepted_events": 1}
try:
    payload = json.loads(completed.stdout)
except (json.JSONDecodeError, TypeError):
    payload = None
if completed.returncode != 0 or completed.stderr or payload != expected:
    raise SystemExit("python automatic delivery smoke failed")
PY

"$tmp_dir/consumer-venv/bin/python" "$tmp_dir/supervisor.py" \
  "$tmp_dir/consumer-venv/bin/python" \
  "$tmp_dir/consumer.py"

wheel_version="$("$tmp_dir/consumer-venv/bin/python" -c 'import importlib.metadata; print(importlib.metadata.version("logbrew-sdk"))')"
wheel_digest="$(shasum -a 256 "$wheel_path" | awk '{print $1}')"
printf '%s\n' "python automatic delivery installed smoke ok version=$wheel_version sha256=$wheel_digest requests=2 accepted_events=1"
