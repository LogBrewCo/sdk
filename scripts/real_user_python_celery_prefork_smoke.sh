#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
load_tasks="${LOGBREW_CELERY_PREFORK_TASKS:-80}"
server_pid=""

if [[ ! "$load_tasks" =~ ^[0-9]+$ ]] || ((load_tasks < 64 || load_tasks > 500)); then
  printf '%s\n' "LOGBREW_CELERY_PREFORK_TASKS must be an integer from 64 through 500" >&2
  exit 2
fi

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
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_CACHE_DIR="$tmp_dir/pip-cache"

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

"$python" -m pip install --quiet "${wheel_path}[celery]" "celery==5.6.3"
"$python" -m pip check >/dev/null
"$python" -m pip uninstall --yes logbrew-sdk >/dev/null
if "$python" -c 'import logbrew_sdk' 2>/dev/null; then
  printf '%s\n' "removed logbrew-sdk remained importable" >&2
  exit 1
fi
"$python" -m pip install --quiet "${wheel_path}[celery]" "celery==5.6.3"
"$python" -m pip check >/dev/null

mkdir -p "$tmp_dir/intake"
"$python" - "$tmp_dir/intake" >"$tmp_dir/intake-server.log" 2>&1 <<'PY' &
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

intake_dir = Path(sys.argv[1])
request_index = 0
failed_worker_once = False


class IntakeHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        global failed_worker_once, request_index

        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        source = self.headers.get("x-logbrew-source", "")
        if source == "worker" and not failed_worker_once:
            failed_worker_once = True
            status = 503
        else:
            status = 202

        prefix = f"request-{request_index:03d}"
        request_index += 1
        body_tmp = intake_dir / f".{prefix}.body.tmp"
        body_path = intake_dir / f"{prefix}.body"
        meta_tmp = intake_dir / f".{prefix}.json.tmp"
        meta_path = intake_dir / f"{prefix}.json"
        body_tmp.write_bytes(body)
        os.replace(body_tmp, body_path)
        meta_tmp.write_text(
            json.dumps({"source": source, "status": status}, sort_keys=True),
            encoding="utf-8",
        )
        os.replace(meta_tmp, meta_path)

        self.send_response(status)
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
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
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  sleep 0.05
done
if [[ ! -s "$tmp_dir/intake/endpoint.txt" ]]; then
  printf '%s\n' "local fake intake did not start" >&2
  exit 1
fi

mkdir -p "$tmp_dir/worker-app"
cat >"$tmp_dir/worker-app/prefork_worker.py" <<'PY'
from __future__ import annotations

import importlib.metadata
import os
from pathlib import Path
from typing import Any

from celery import Celery

from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    get_active_logbrew_trace,
    instrument_celery_worker_processes_with_logbrew,
    parse_traceparent,
)

runtime_dir = Path(os.environ["LOGBREW_CELERY_PREFORK_TMP"])
broker_dir = runtime_dir / "broker"
processed_dir = runtime_dir / "processed"
control_dir = runtime_dir / "control"
result_dir = runtime_dir / "results"
for directory in (broker_dir, processed_dir, control_dir, result_dir):
    directory.mkdir(parents=True, exist_ok=True)

transport_options = {
    "data_folder_in": str(broker_dir),
    "data_folder_out": str(broker_dir),
    "processed_folder": str(processed_dir),
    "control_folder": str(control_dir),
    "store_processed": True,
}

app = Celery("logbrew_prefork_worker", broker="filesystem://", backend=f"file://{result_dir}")
app.conf.update(
    broker_transport_options=transport_options,
    result_backend=f"file://{result_dir}",
    task_default_queue="critical",
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    worker_prefetch_multiplier=1,
    task_acks_late=False,
)


@app.task(bind=True, name="checkout.prefork_trace")
def prefork_trace(self: Any, value: str) -> dict[str, Any]:
    trace = get_active_logbrew_trace()
    if trace is None:
        raise RuntimeError("LogBrew worker trace was not active")
    incoming = parse_traceparent(self.request.headers["traceparent"])
    return {
        "parentMatchesCarrier": trace.parent_span_id == incoming.parent_span_id,
        "traceMatchesCarrier": trace.trace_id == incoming.trace_id,
        "value": value,
    }


@app.task(name="checkout.prefork_load")
def prefork_load(value: int) -> int:
    return value + 1


factory_log = runtime_dir / "factory.log"
error_log = runtime_dir / "errors.log"
package_version = importlib.metadata.version("logbrew-sdk")


def create_worker_client() -> LogBrewClient:
    with factory_log.open("a", encoding="utf-8") as handle:
        handle.write("client\n")
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="python-celery-prefork-worker",
        sdk_version=package_version,
        max_retries=1,
        max_queue_size=32,
    )


def create_worker_transport() -> HttpTransport:
    with factory_log.open("a", encoding="utf-8") as handle:
        handle.write("transport\n")
    return HttpTransport(
        endpoint=os.environ["LOGBREW_CELERY_PREFORK_ENDPOINT"],
        headers={"x-logbrew-source": "worker"},
        timeout=3,
    )


def record_worker_error(error: Exception) -> None:
    with error_log.open("a", encoding="utf-8") as handle:
        handle.write(f"{type(error).__name__}\n")


worker_lifecycle = instrument_celery_worker_processes_with_logbrew(
    app,
    client_factory=create_worker_client,
    transport_factory=create_worker_transport,
    metadata={
        "service": "checkout-worker",
        "headers": "must-not-be-captured",
    },
    on_capture_error=record_worker_error,
)
PY

LOGBREW_CELERY_PREFORK_TASKS="$load_tasks" \
LOGBREW_CELERY_PREFORK_TMP="$tmp_dir/runtime" \
LOGBREW_CELERY_PREFORK_ENDPOINT="$(<"$tmp_dir/intake/endpoint.txt")" \
LOGBREW_CELERY_PREFORK_INTAKE="$tmp_dir/intake" \
LOGBREW_CELERY_PREFORK_APP_DIR="$tmp_dir/worker-app" \
"$python" - <<'PY' >"$tmp_dir/result.json"
from __future__ import annotations

import importlib.metadata
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from celery import Celery
from celery.result import allow_join_result

from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    instrument_celery_app_with_logbrew_spans,
)

load_tasks = int(os.environ["LOGBREW_CELERY_PREFORK_TASKS"])
runtime_dir = Path(os.environ["LOGBREW_CELERY_PREFORK_TMP"])
endpoint = os.environ["LOGBREW_CELERY_PREFORK_ENDPOINT"]
intake_dir = Path(os.environ["LOGBREW_CELERY_PREFORK_INTAKE"])
worker_app_dir = Path(os.environ["LOGBREW_CELERY_PREFORK_APP_DIR"])
broker_dir = runtime_dir / "broker"
processed_dir = runtime_dir / "processed"
control_dir = runtime_dir / "control"
result_dir = runtime_dir / "results"
for directory in (broker_dir, processed_dir, control_dir, result_dir):
    directory.mkdir(parents=True, exist_ok=True)

broker_url = "filesystem://"
backend_url = f"file://{result_dir}"
transport_options = {
    "data_folder_in": str(broker_dir),
    "data_folder_out": str(broker_dir),
    "processed_folder": str(processed_dir),
    "control_folder": str(control_dir),
    "store_processed": True,
}


def configure(app: Celery) -> None:
    app.conf.update(
        broker_transport_options=transport_options,
        result_backend=backend_url,
        task_default_queue="critical",
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        worker_prefetch_multiplier=1,
        task_acks_late=False,
    )


factory_log = runtime_dir / "factory.log"
error_log = runtime_dir / "errors.log"
package_version = importlib.metadata.version("logbrew-sdk")

producer_app = Celery("logbrew_prefork_producer", broker=broker_url, backend=backend_url)
configure(producer_app)
producer_client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="python-celery-prefork-producer",
    sdk_version=package_version,
    max_retries=1,
    max_queue_size=128,
)
producer_instrumentation = instrument_celery_app_with_logbrew_spans(
    producer_app,
    client=producer_client,
    metadata={"service": "checkout-api"},
)
producer_response = None
worker_environment = os.environ.copy()
worker_environment["PYTHONPATH"] = os.pathsep.join(
    value
    for value in (str(worker_app_dir), worker_environment.get("PYTHONPATH", ""))
    if value
)
worker_command = [
    sys.executable,
    "-m",
    "celery",
    "-A",
    "prefork_worker:app",
    "worker",
    "--pool=prefork",
    "--concurrency=2",
    "--loglevel=CRITICAL",
    "--without-gossip",
    "--without-mingle",
    "--without-heartbeat",
]

with (runtime_dir / "worker.log").open("wb") as worker_output:
    worker_process = subprocess.Popen(
        worker_command,
        env=worker_environment,
        stdout=worker_output,
        stderr=subprocess.STDOUT,
    )
    try:
        startup_deadline = time.monotonic() + 30
        while True:
            factory_lines = (
                factory_log.read_text(encoding="utf-8").splitlines()
                if factory_log.exists()
                else []
            )
            if factory_lines.count("client") == 2 and factory_lines.count("transport") == 2:
                break
            if worker_process.poll() is not None:
                raise SystemExit("Celery prefork worker exited before its child factories ran")
            if time.monotonic() >= startup_deadline:
                raise SystemExit("Celery prefork worker child initialization timed out")
            time.sleep(0.1)

        probe_result = producer_app.send_task(
            "checkout.prefork_trace",
            args=["excluded-order-value"],
            queue="critical",
            headers={
                "x-app-context": "must-not-be-captured",
                "baggage": "must-not-be-captured",
                "tracestate": "must-not-be-captured",
            },
        )
        load_results = [
            producer_app.send_task("checkout.prefork_load", args=[index], queue="critical")
            for index in range(load_tasks)
        ]
        with allow_join_result():
            probe = probe_result.get(timeout=45)
            values = [result.get(timeout=45) for result in load_results]

        if probe != {
            "parentMatchesCarrier": True,
            "traceMatchesCarrier": True,
            "value": "excluded-order-value",
        }:
            raise SystemExit(f"unexpected prefork trace result: {probe!r}")
        if values != [index + 1 for index in range(load_tasks)]:
            raise SystemExit("prefork task results changed under instrumentation")

        producer_response = producer_client.shutdown(
            HttpTransport(
                endpoint=endpoint,
                headers={"x-logbrew-source": "producer"},
                timeout=3,
            )
        )
    finally:
        producer_instrumentation.uninstall()
        if worker_process.poll() is None:
            worker_process.send_signal(signal.SIGTERM)
            try:
                worker_process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                worker_process.kill()
                worker_process.wait(timeout=5)
                raise SystemExit("Celery prefork worker did not shut down in time")

if worker_process.returncode != 0:
    raise SystemExit(f"Celery prefork worker exited with status {worker_process.returncode}")

if producer_response is None or producer_response.status_code != 202 or producer_response.attempts != 1:
    raise SystemExit(f"unexpected producer delivery response: {producer_response!r}")
factory_lines = factory_log.read_text(encoding="utf-8").splitlines()
if factory_lines.count("client") != 2 or factory_lines.count("transport") != 2:
    raise SystemExit(f"worker factories did not run exactly once in two children: {factory_lines!r}")
if error_log.exists():
    raise SystemExit(f"worker lifecycle reported errors: {error_log.read_text(encoding='utf-8')!r}")

requests = []
for meta_path in sorted(intake_dir.glob("request-*.json")):
    metadata = json.loads(meta_path.read_text(encoding="utf-8"))
    requests.append(
        {
            "body": meta_path.with_suffix(".body").read_bytes(),
            "source": metadata["source"],
            "status": metadata["status"],
        }
    )

producer_requests = [request for request in requests if request["source"] == "producer"]
worker_requests = [request for request in requests if request["source"] == "worker"]
if len(producer_requests) != 1 or producer_requests[0]["status"] != 202:
    raise SystemExit("producer did not send exactly one accepted batch")
if not any(request["status"] == 503 for request in worker_requests):
    raise SystemExit("worker shutdown did not exercise retryable delivery")

worker_bodies = [request["body"] for request in worker_requests]
unique_worker_bodies = list(dict.fromkeys(worker_bodies))
if len(unique_worker_bodies) != 2:
    raise SystemExit(f"expected one batch from each worker child, got {len(unique_worker_bodies)}")
if len(worker_bodies) != 3 or not any(worker_bodies.count(body) == 2 for body in unique_worker_bodies):
    raise SystemExit("worker shutdown retry did not preserve one byte-identical body")

producer_payload = json.loads(producer_requests[0]["body"])
worker_payloads = [json.loads(body) for body in unique_worker_bodies]
worker_events = [event for payload in worker_payloads for event in payload["events"]]
if len(producer_payload["events"]) != load_tasks + 1:
    raise SystemExit("producer span count changed")
if not 33 <= len(worker_events) <= 64:
    raise SystemExit(f"worker child queues were not bounded: {len(worker_events)}")
if any(len(payload["events"]) > 32 for payload in worker_payloads):
    raise SystemExit("a worker child exceeded its configured queue bound")
if not any(len(payload["events"]) == 32 for payload in worker_payloads):
    raise SystemExit("prefork load did not fill either worker child queue")

probe_publish = next(
    event
    for event in producer_payload["events"]
    if event["attributes"]["name"] == "celery publish checkout.prefork_trace"
)
probe_process = next(
    event
    for event in worker_events
    if event["attributes"]["name"] == "celery process checkout.prefork_trace"
)
if probe_process["attributes"]["traceId"] != probe_publish["attributes"]["traceId"]:
    raise SystemExit("prefork producer and worker trace IDs differ")
if probe_process["attributes"]["parentSpanId"] != probe_publish["attributes"]["spanId"]:
    raise SystemExit("prefork worker did not use the injected producer span as parent")

serialized = b"\n".join([producer_requests[0]["body"], *unique_worker_bodies]).decode("utf-8")
for forbidden in (
    "LOGBREW_API_KEY",
    "excluded-order-value",
    "must-not-be-captured",
    "traceparent",
    "tracestate",
    "baggage",
    str(runtime_dir),
    "filesystem://",
    "task_id",
    "worker_node",
):
    if forbidden in serialized:
        raise SystemExit(f"prefork telemetry leaked excluded runtime data: {forbidden}")

print(
    json.dumps(
        {
            "celeryVersion": importlib.metadata.version("celery"),
            "childClients": factory_lines.count("client"),
            "loadTasks": load_tasks,
            "ok": True,
            "packageVersion": package_version,
            "producerEvents": len(producer_payload["events"]),
            "workerEvents": len(worker_events),
            "workerRetryRequests": len(worker_requests),
        },
        sort_keys=True,
    )
)
PY

touch "$tmp_dir/intake/stop"
wait "$server_pid"
server_pid=""

grep -q '"ok": true' "$tmp_dir/result.json"
grep -q '"celeryVersion": "5.6.3"' "$tmp_dir/result.json"
grep -q '"childClients": 2' "$tmp_dir/result.json"
grep -q '"workerRetryRequests": 3' "$tmp_dir/result.json"
grep -q "\"loadTasks\": $load_tasks" "$tmp_dir/result.json"

printf 'python celery prefork installed-artifact smoke passed (%d tasks, two child clients)\n' "$load_tasks"
