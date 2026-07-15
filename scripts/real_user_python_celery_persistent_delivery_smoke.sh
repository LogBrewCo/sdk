#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
tmp_dir="$(cd "$tmp_dir" && pwd -P)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

python3 -m venv "$tmp_dir/venv"
python="$tmp_dir/venv/bin/python"
export PIP_CACHE_DIR="$tmp_dir/pip-cache"
export PIP_DISABLE_PIP_VERSION_CHECK=1

"$python" -m pip install --quiet "pip==26.1.2" "build==1.5.1"
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
"$python" -m pip install --quiet "${wheel_path}[celery,persistence]" "celery==5.6.3" "cryptography==49.0.0"
"$python" -m pip check >/dev/null
rm -rf "$tmp_dir/logbrew_py"

mkdir -m 700 "$tmp_dir/queues"
mkdir -p "$tmp_dir/intake"
"$python" - "$tmp_dir/intake" >"$tmp_dir/intake.log" 2>&1 <<'PY' &
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

intake_dir = Path(sys.argv[1])
request_index = 0


class IntakeHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        global request_index
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        contract_ok = (
            self.path == "/v1/events"
            and self.headers.get("authorization") == "Bearer LOGBREW_API_KEY"
            and self.headers.get("content-type") == "application/json"
        )
        status = (503 if request_index == 0 else 202) if contract_ok else 422
        prefix = f"request-{request_index:03d}"
        request_index += 1
        body_tmp = intake_dir / f".{prefix}.body.tmp"
        body_path = intake_dir / f"{prefix}.body"
        meta_tmp = intake_dir / f".{prefix}.json.tmp"
        meta_path = intake_dir / f"{prefix}.json"
        body_tmp.write_bytes(body)
        os.replace(body_tmp, body_path)
        meta_tmp.write_text(json.dumps({"status": status}), encoding="utf-8")
        os.replace(meta_tmp, meta_path)
        self.send_response(status)
        self.end_headers()

    def log_message(self, _format: str, *_args: Any) -> None:
        return


server = HTTPServer(("127.0.0.1", 0), IntakeHandler)
server.timeout = 0.1
(intake_dir / "endpoint.txt").write_text(
    f"http://127.0.0.1:{server.server_port}/v1/events",
    encoding="utf-8",
)
while not (intake_dir / "stop").exists():
    server.handle_request()
server.server_close()
PY
server_pid=$!

for _ in {1..100}; do
  if [[ -s "$tmp_dir/intake/endpoint.txt" ]]; then
    break
  fi
  sleep 0.05
done
test -s "$tmp_dir/intake/endpoint.txt"

mkdir -p "$tmp_dir/worker-app"
cat >"$tmp_dir/worker-app/persistent_worker.py" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from celery import Celery

from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    celery_worker_persistent_queue_directory,
    instrument_celery_worker_processes_with_logbrew,
)

runtime = Path(os.environ["LOGBREW_CELERY_RUNTIME"])
queue_root = Path(os.environ["LOGBREW_CELERY_QUEUE_ROOT"])
broker = runtime / "broker"
processed = runtime / "processed"
control = runtime / "control"
for directory in (broker, processed, control):
    directory.mkdir(parents=True, exist_ok=True)

app = Celery("logbrew_persistent_worker", broker="filesystem://")
app.conf.update(
    broker_transport_options={
        "data_folder_in": str(broker),
        "data_folder_out": str(broker),
        "processed_folder": str(processed),
        "control_folder": str(control),
        "store_processed": True,
    },
    task_default_queue="persistent",
    task_serializer="json",
    accept_content=["json"],
    worker_prefetch_multiplier=1,
    task_acks_late=False,
)


def _write_marker(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


@app.task(name="delivery.capture_and_crash")
def capture_and_crash() -> None:
    slot = Path(celery_worker_persistent_queue_directory(queue_root)).name
    ready = runtime / f"ready-{slot}"
    ready.touch()
    deadline = time.monotonic() + 20
    while len(list(runtime.glob("ready-worker-*"))) < 2:
        if time.monotonic() >= deadline:
            os._exit(19)
        time.sleep(0.05)

    client = worker_lifecycle.current_client
    if client is None:
        os._exit(20)
    for index in range(1250):
        client.log(
            f"evt_{slot}_{index:04d}",
            "2026-07-14T10:00:00Z",
            {"message": "persistent delivery load", "level": "info", "logger": "celery-worker"},
        )
    recovered_events = json.loads(client.preview_json())["events"]
    recovered_sha256 = hashlib.sha256(
        json.dumps(recovered_events, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    _write_marker(
        runtime / f"crashed-{slot}.json",
        {
            "dropped": client.dropped_events(),
            "pending": client.pending_events(),
            "sha256": recovered_sha256,
        },
    )
    os._exit(17)


def create_worker_client() -> LogBrewClient:
    slot_directory = celery_worker_persistent_queue_directory(queue_root)
    persistence_key = bytes.fromhex(os.environ["LOGBREW_CELERY_PERSISTENCE_KEY_HEX"])
    client = LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="python-celery-persistent-delivery",
        sdk_version="0.1.0",
        max_retries=1,
        max_queue_size=1000,
        max_queue_bytes=4 * 1024 * 1024,
        max_batch_events=100,
        max_batch_bytes=256 * 1024,
        persistent_queue_directory=slot_directory,
        persistent_queue_encryption_key=persistence_key,
    )
    with (runtime / "factory.log").open("a", encoding="utf-8") as handle:
        handle.write(f"{Path(slot_directory).name}\n")
    return client


worker_lifecycle = instrument_celery_worker_processes_with_logbrew(
    app,
    client_factory=create_worker_client,
    transport_factory=lambda: HttpTransport(
        endpoint=os.environ["LOGBREW_CELERY_ENDPOINT"],
        timeout=3,
    ),
)
PY

persistence_key_hex="$("$python" -c 'import os; print(os.urandom(32).hex())')"
LOGBREW_CELERY_RUNTIME="$tmp_dir/runtime" \
LOGBREW_CELERY_QUEUE_ROOT="$tmp_dir/queues" \
LOGBREW_CELERY_ENDPOINT="$(<"$tmp_dir/intake/endpoint.txt")" \
LOGBREW_CELERY_APP_DIR="$tmp_dir/worker-app" \
LOGBREW_CELERY_PERSISTENCE_KEY_HEX="$persistence_key_hex" \
"$python" - <<'PY' >"$tmp_dir/result.json"
from __future__ import annotations

import importlib.metadata
import json
import os
import signal
import sqlite3
import stat
import subprocess
import sys
import time
from pathlib import Path

from celery import Celery

import logbrew_sdk

runtime = Path(os.environ["LOGBREW_CELERY_RUNTIME"])
queue_root = Path(os.environ["LOGBREW_CELERY_QUEUE_ROOT"])
endpoint = os.environ["LOGBREW_CELERY_ENDPOINT"]
worker_app_dir = Path(os.environ["LOGBREW_CELERY_APP_DIR"])
persistence_key = bytes.fromhex(os.environ["LOGBREW_CELERY_PERSISTENCE_KEY_HEX"])
broker = runtime / "broker"
processed = runtime / "processed"
control = runtime / "control"
for directory in (broker, processed, control):
    directory.mkdir(parents=True, exist_ok=True)

if "site-packages" not in str(Path(logbrew_sdk.__file__)):
    raise SystemExit("LogBrew was not imported from the installed wheel")
if importlib.metadata.version("logbrew-sdk") != "0.1.3":
    raise SystemExit("installed wheel version changed")
requirements = importlib.metadata.requires("logbrew-sdk") or []
if not any("cryptography<50,>=49" in requirement and "persistence" in requirement for requirement in requirements):
    raise SystemExit("installed wheel persistence extra metadata changed")
for public_name in (
    "celery_worker_persistent_queue_directory",
    "instrument_celery_worker_processes_with_logbrew",
):
    if not callable(getattr(logbrew_sdk, public_name, None)):
        raise SystemExit("installed wheel is missing persistent delivery APIs")

producer = Celery("logbrew_persistent_producer", broker="filesystem://")
producer.conf.update(
    broker_transport_options={
        "data_folder_in": str(broker),
        "data_folder_out": str(broker),
        "processed_folder": str(processed),
        "control_folder": str(control),
        "store_processed": True,
    },
    task_default_queue="persistent",
    task_serializer="json",
    accept_content=["json"],
)

environment = os.environ.copy()
environment["PYTHONPATH"] = str(worker_app_dir)
command = [
    sys.executable,
    "-m",
    "celery",
    "-A",
    "persistent_worker:app",
    "worker",
    "--pool=prefork",
    "--concurrency=2",
    "--loglevel=CRITICAL",
    "--without-gossip",
    "--without-mingle",
    "--without-heartbeat",
]
worker_log = runtime / "worker.log"
with worker_log.open("wb") as output:
    worker = subprocess.Popen(command, env=environment, stdout=output, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 30
        while True:
            lines = (runtime / "factory.log").read_text(encoding="utf-8").splitlines() if (runtime / "factory.log").exists() else []
            if len(lines) >= 2 and len(set(lines)) == 2:
                break
            if worker.poll() is not None or time.monotonic() >= deadline:
                raise SystemExit("initial Celery children did not initialize")
            time.sleep(0.1)

        producer.send_task("delivery.capture_and_crash", queue="persistent")
        producer.send_task("delivery.capture_and_crash", queue="persistent")

        deadline = time.monotonic() + 45
        while len(list(runtime.glob("crashed-worker-*.json"))) < 2:
            if worker.poll() is not None or time.monotonic() >= deadline:
                raise SystemExit("Celery children did not commit bounded queues before hard exit")
            time.sleep(0.1)

        crashed = [json.loads(path.read_text(encoding="utf-8")) for path in runtime.glob("crashed-worker-*.json")]
        if len(crashed) != 2 or any(
            marker.get("dropped") != 250
            or marker.get("pending") != 1000
            or len(marker.get("sha256", "")) != 64
            for marker in crashed
        ):
            raise SystemExit("hard-exit queue bounds changed")

        initial_slots = set(lines)
        deadline = time.monotonic() + 45
        while True:
            lines = (runtime / "factory.log").read_text(encoding="utf-8").splitlines()
            if all(lines.count(slot) >= 2 for slot in initial_slots):
                break
            if worker.poll() is not None or time.monotonic() >= deadline:
                raise SystemExit("replacement Celery children did not recover stable slots")
            time.sleep(0.1)

        queue_directories = sorted(queue_root.glob("worker-*"))
        if len(queue_directories) != 2:
            raise SystemExit("persistent delivery did not isolate two worker slots")
        for directory in queue_directories:
            if stat.S_IMODE(directory.stat().st_mode) != 0o700:
                raise SystemExit("persistent queue directory mode changed")
            if {path.name for path in directory.iterdir()} != {".lock", "events.sqlite3"}:
                raise SystemExit("persistent queue file set changed")
            for name in (".lock", "events.sqlite3"):
                if stat.S_IMODE((directory / name).stat().st_mode) != 0o600:
                    raise SystemExit("persistent queue file mode changed")
            database = directory / "events.sqlite3"
            stored = database.read_bytes()
            for forbidden in (
                persistence_key,
                os.environ["LOGBREW_CELERY_PERSISTENCE_KEY_HEX"].encode("ascii"),
                b"LOGBREW_API_KEY",
                b"python-celery-persistent-delivery",
                b"persistent delivery load",
                b"evt_worker-",
                b"authorization",
                b"api.logbrew",
                str(runtime).encode("utf-8"),
                str(queue_root).encode("utf-8"),
            ):
                if forbidden in stored:
                    raise SystemExit("encrypted queue stored a sensitive plaintext field")
            connection = sqlite3.connect(database)
            try:
                event_columns = [row[1] for row in connection.execute("PRAGMA table_info(events)")]
                rows = connection.execute("SELECT nonce, ciphertext FROM events").fetchall()
                state_rows = connection.execute("SELECT COUNT(*) FROM queue_state").fetchone()[0]
            finally:
                connection.close()
            if event_columns != ["sequence", "nonce", "ciphertext"]:
                raise SystemExit("encrypted event schema changed")
            if len(rows) != 1000 or len({nonce for nonce, _ in rows}) != 1000:
                raise SystemExit("encrypted queue bounds or nonce uniqueness changed")
            if state_rows != 1 or any(len(nonce) != 12 or not ciphertext for nonce, ciphertext in rows):
                raise SystemExit("encrypted queue state changed")
    finally:
        if worker.poll() is None:
            worker.send_signal(signal.SIGTERM)
            try:
                worker.wait(timeout=45)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait(timeout=5)
                raise SystemExit("Celery worker did not shut down in time")

if worker.returncode != 0:
    raise SystemExit("Celery worker returned a nonzero status")

queue_directories = sorted(queue_root.glob("worker-*"))
if len(queue_directories) != 2:
    raise SystemExit("persistent delivery did not isolate two worker slots")
for directory in queue_directories:
    if stat.S_IMODE(directory.stat().st_mode) != 0o700:
        raise SystemExit("persistent queue directory mode changed")
    if {path.name for path in directory.iterdir()} != {".lock", "events.sqlite3"}:
        raise SystemExit("persistent queue file set changed")
    for name in (".lock", "events.sqlite3"):
        if stat.S_IMODE((directory / name).stat().st_mode) != 0o600:
            raise SystemExit("persistent queue file mode changed")
    connection = sqlite3.connect(directory / "events.sqlite3")
    remaining = connection.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    connection.close()
    if remaining != 0:
        raise SystemExit("replacement child did not drain its durable queue")

print(
    json.dumps(
        {
            "celeryVersion": importlib.metadata.version("celery"),
            "committed": 2000,
            "cryptographyVersion": importlib.metadata.version("cryptography"),
            "dropped": 500,
            "ok": True,
            "slots": 2,
        },
        sort_keys=True,
    )
)
PY

touch "$tmp_dir/intake/stop"
wait "$server_pid"
server_pid=""

"$python" - "$tmp_dir/intake" "$tmp_dir/queues" "$tmp_dir/runtime" <<'PY'
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

intake = Path(sys.argv[1])
queue_root = Path(sys.argv[2])
runtime = Path(sys.argv[3])
requests = []
for metadata_path in sorted(intake.glob("request-*.json")):
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    body = metadata_path.with_suffix(".body").read_bytes()
    requests.append((metadata["status"], body))

if [status for status, _ in requests].count(503) != 1:
    raise SystemExit("fake intake did not exercise one retryable failure")
accepted = [body for status, body in requests if status == 202]
if len(accepted) != 20 or len(requests) != 21:
    raise SystemExit("persistent delivery request count changed")
failed_body = next(body for status, body in requests if status == 503)
if failed_body not in accepted:
    raise SystemExit("retry did not reuse the exact failed body")

event_ids = []
events_by_slot = {}
for body in accepted:
    if len(body) > 256 * 1024:
        raise SystemExit("request exceeded the configured byte bound")
    payload = json.loads(body)
    if len(payload["events"]) != 100:
        raise SystemExit("accepted prefix did not use the configured event bound")
    batch_ids = [event["id"] for event in payload["events"]]
    event_ids.extend(batch_ids)
    slot = batch_ids[0].removeprefix("evt_").rsplit("_", 1)[0]
    events_by_slot.setdefault(slot, []).extend(payload["events"])

if len(event_ids) != 2000 or len(set(event_ids)) != 2000:
    raise SystemExit("accepted durable events were missing or duplicated")
for marker_path in sorted(runtime.glob("crashed-worker-*.json")):
    slot = marker_path.stem.removeprefix("crashed-")
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    events = events_by_slot.get(slot)
    if events is None:
        raise SystemExit("recovered slot events were missing")
    expected_ids = [f"evt_{slot}_{index:04d}" for index in range(1000)]
    if [event["id"] for event in events] != expected_ids:
        raise SystemExit("recovered stable event ID order changed")
    recovered_sha256 = hashlib.sha256(
        json.dumps(events, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if recovered_sha256 != marker["sha256"]:
        raise SystemExit("pre-halt and recovered event bytes changed")
serialized = b"\n".join(body for _, body in requests)
for forbidden in (
    b"LOGBREW_API_KEY",
    b"authorization",
    b"traceparent",
    b"tracestate",
    b"baggage",
    str(queue_root).encode("utf-8"),
):
    if forbidden in serialized:
        raise SystemExit("persistent delivery payload leaked excluded process data")
PY

grep -q '"ok": true' "$tmp_dir/result.json"
grep -q '"celeryVersion": "5.6.3"' "$tmp_dir/result.json"
grep -q '"cryptographyVersion": "49.0.0"' "$tmp_dir/result.json"
grep -q '"committed": 2000' "$tmp_dir/result.json"
grep -q '"dropped": 500' "$tmp_dir/result.json"

printf '%s\n' "python celery encrypted persistence smoke passed (wheel ${wheel_sha256}, 2 slots, 2000 committed, 500 bounded drops)"
