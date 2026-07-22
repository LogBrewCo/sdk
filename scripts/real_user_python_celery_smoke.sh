#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
load_tasks="${LOGBREW_CELERY_LOAD_TASKS:-25}"
python_package_version="$(
    python3 - "$repo_root/python/logbrew_py/pyproject.toml" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    print(tomllib.load(handle)["project"]["version"])
PY
)"
wheel_artifact="logbrew_sdk-${python_package_version}-py3-none-any.whl"

if [[ ! "$load_tasks" =~ ^[0-9]+$ ]] || (( load_tasks < 1 || load_tasks > 2000 )); then
    echo "LOGBREW_CELERY_LOAD_TASKS must be an integer from 1 through 2000" >&2
    exit 2
fi

on_error() {
    local status=$?
    echo "real_user_python_celery_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
    for diagnostic in "$tmp_dir/build.log" "$tmp_dir/output.json" "$tmp_dir/pip-freeze.txt"; do
        if [[ -f "$diagnostic" ]]; then
            echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
            sed -n '1,120p' "$diagnostic" >&2
        fi
    done
    exit "$status"
}

trap 'rm -rf "$tmp_dir"' EXIT
trap on_error ERR

python3 -m venv "$tmp_dir/venv"
# shellcheck source=/dev/null
source "$tmp_dir/venv/bin/activate"
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_CACHE_DIR="$tmp_dir/pip-cache"

python -m pip install --upgrade pip build >/dev/null
cp -R "$repo_root/python/logbrew_py" "$tmp_dir/logbrew_py"
rm -rf \
    "$tmp_dir/logbrew_py/build" \
    "$tmp_dir/logbrew_py/dist" \
    "$tmp_dir/logbrew_py/src/logbrew_sdk.egg-info"
find "$tmp_dir/logbrew_py" -type d -name __pycache__ -prune -exec rm -rf {} +
python -m build "$tmp_dir/logbrew_py" --wheel --outdir "$tmp_dir/dist" > "$tmp_dir/build.log"
python -m pip install "$tmp_dir/dist/${wheel_artifact}[celery]" "celery==5.6.3" >/dev/null
python -m pip check >/dev/null
python -m pip uninstall -y logbrew-sdk >/dev/null
if python -c 'import logbrew_sdk' 2>/dev/null; then
    echo "expected logbrew-sdk to be removed by pip uninstall" >&2
    exit 1
fi
python -m pip install "$tmp_dir/dist/${wheel_artifact}[celery]" "celery==5.6.3" >/dev/null
python -m pip check >/dev/null
python -m pip freeze > "$tmp_dir/pip-freeze.txt"

LOGBREW_CELERY_LOAD_TASKS="$load_tasks" python - <<'PY' > "$tmp_dir/output.json"
from __future__ import annotations

import importlib.metadata
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from celery import Celery
from celery.contrib.testing.worker import start_worker
from celery.result import allow_join_result
from packaging.requirements import Requirement

from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    get_active_logbrew_trace,
    instrument_celery_app_with_logbrew_spans,
    parse_traceparent,
)

load_tasks = int(os.environ["LOGBREW_CELERY_LOAD_TASKS"])
client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="python-celery-installed-smoke",
    sdk_version="0.1.0",
    max_retries=2,
    max_queue_size=512,
)
app = Celery("logbrew_celery_smoke", broker="memory://", backend="cache+memory://")
app.conf.update(
    task_always_eager=False,
    task_default_queue="critical",
    task_store_eager_result=True,
    task_track_started=False,
    result_expires=60,
)


@app.task(bind=True, name="checkout.trace_probe")
def trace_probe(self: Any, value: int) -> dict[str, Any]:
    trace = get_active_logbrew_trace()
    if trace is None:
        raise RuntimeError("LogBrew worker trace was not active")
    incoming = parse_traceparent(self.request.headers["traceparent"])
    return {
        "parentMatchesCarrier": trace.parent_span_id == incoming.parent_span_id,
        "traceMatchesCarrier": trace.trace_id == incoming.trace_id,
        "value": value + 1,
    }


@app.task(name="checkout.load_probe")
def load_probe(value: int) -> int:
    return value + 1


instrumentation = instrument_celery_app_with_logbrew_spans(
    app,
    client=client,
    metadata={
        "service": "checkout-worker",
        "headers": "must-not-be-captured",
    },
)

with start_worker(
    app,
    pool="solo",
    concurrency=1,
    loglevel="CRITICAL",
    perform_ping_check=False,
):
    probe_result = trace_probe.apply_async(
        args=[41],
        queue="critical",
        headers={
            "x-app-context": "must-not-be-captured",
            "baggage": "must-not-be-captured",
            "tracestate": "must-not-be-captured",
        },
    )
    with allow_join_result():
        probe = probe_result.get(timeout=15)
    if probe != {
        "parentMatchesCarrier": True,
        "traceMatchesCarrier": True,
        "value": 42,
    }:
        raise SystemExit(f"unexpected propagated worker trace result: {probe!r}")

    results = [
        load_probe.apply_async(args=[index], queue="critical")
        for index in range(load_tasks)
    ]
    with allow_join_result():
        values = [result.get(timeout=30) for result in results]

if values != [index + 1 for index in range(load_tasks)]:
    raise SystemExit("Celery load task results changed under instrumentation")
if instrumentation.in_flight_tasks != 0:
    raise SystemExit(f"Celery instrumentation retained {instrumentation.in_flight_tasks} task spans")
instrumentation.uninstall()
if instrumentation.installed:
    raise SystemExit("Celery instrumentation did not uninstall")

attempted_spans = (load_tasks + 1) * 2
if client.pending_events() + client.dropped_events() != attempted_spans:
    raise SystemExit(
        "Celery instrumentation did not account for every producer and worker span: "
        f"pending={client.pending_events()} dropped={client.dropped_events()} expected={attempted_spans}"
    )

payload = client.preview_json()
events = json.loads(payload)["events"]
probe_publish = next(
    event for event in events if event["attributes"]["name"] == "celery publish checkout.trace_probe"
)
probe_process = next(
    event for event in events if event["attributes"]["name"] == "celery process checkout.trace_probe"
)
if probe_process["attributes"]["parentSpanId"] != probe_publish["attributes"]["spanId"]:
    raise SystemExit("installed Celery worker span did not continue the emitted producer span")
if probe_process["attributes"]["metadata"]["taskState"] != "success":
    raise SystemExit("installed Celery worker span did not capture successful completion")
if probe_process["attributes"]["metadata"]["queueName"] != "critical":
    raise SystemExit("installed Celery worker span did not capture the safe routing key")

for forbidden in (
    "must-not-be-captured",
    "traceparent",
    "tracestate",
    "baggage",
    "memory://",
    "task_id",
    "worker_node",
):
    if forbidden in payload:
        raise SystemExit(f"Celery telemetry leaked private runtime data: {forbidden}")


class IntakeHandler(BaseHTTPRequestHandler):
    bodies: list[bytes] = []
    statuses = [503, 202]

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        self.__class__.bodies.append(self.rfile.read(length))
        status = self.__class__.statuses.pop(0)
        self.send_response(status)
        self.end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return


server = ThreadingHTTPServer(("127.0.0.1", 0), IntakeHandler)
server_thread = threading.Thread(target=server.serve_forever, daemon=True)
server_thread.start()
try:
    response = client.flush(
        HttpTransport(
            endpoint=f"http://127.0.0.1:{server.server_port}/v1/events",
            timeout=2,
        )
    )
finally:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=5)

if response.status_code != 202 or response.attempts != 2:
    raise SystemExit(f"unexpected Celery fake-intake retry response: {response!r}")
if len(IntakeHandler.bodies) != 2 or IntakeHandler.bodies[0] != IntakeHandler.bodies[1]:
    raise SystemExit("Celery fake-intake retry did not preserve a byte-identical batch")
shutdown = client.shutdown(HttpTransport(endpoint="http://127.0.0.1:1/v1/events"))
if shutdown.status_code != 204 or shutdown.attempts != 0:
    raise SystemExit(f"unexpected empty Celery shutdown response: {shutdown!r}")

requirements = importlib.metadata.requires("logbrew-sdk") or []
parsed_requirements = [Requirement(requirement) for requirement in requirements]
if not any(
    requirement.name.lower() == "celery"
    and requirement.marker is not None
    and requirement.marker.evaluate({"extra": "celery"})
    and not requirement.marker.evaluate({"extra": ""})
    for requirement in parsed_requirements
):
    raise SystemExit("installed wheel does not expose the celery extra")

print(
    json.dumps(
        {
            "attemptedSpans": attempted_spans,
            "droppedSpans": client.dropped_events(),
            "fakeIntakeAttempts": response.attempts,
            "installedExtra": True,
            "loadTasks": load_tasks,
            "ok": True,
            "queuedSpans": len(events),
            "shutdownStatus": shutdown.status_code,
        },
        sort_keys=True,
    )
)
PY

grep -q '"ok": true' "$tmp_dir/output.json"
grep -q '"installedExtra": true' "$tmp_dir/output.json"
grep -q '"fakeIntakeAttempts": 2' "$tmp_dir/output.json"
grep -q '"shutdownStatus": 204' "$tmp_dir/output.json"
grep -q "\"loadTasks\": $load_tasks" "$tmp_dir/output.json"

celery_version="$(python -c 'import celery; print(celery.__version__)')"
printf 'python celery installed-artifact smoke passed with celery@%s (%s tasks)\n' "$celery_version" "$load_tasks"
