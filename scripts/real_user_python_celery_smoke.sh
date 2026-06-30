#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

on_error() {
    local status=$?
    echo "real_user_python_celery_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
    for diagnostic in "$tmp_dir/output.json" "$tmp_dir/pip-freeze.txt"; do
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
"$tmp_dir/venv/bin/python" -m pip install --upgrade pip setuptools wheel >/dev/null
PIP_CACHE_DIR="$tmp_dir/pip-cache" "$tmp_dir/venv/bin/python" -m pip install "$repo_root/python/logbrew_py" "celery>=5,<6" >/dev/null
"$tmp_dir/venv/bin/python" -m pip freeze > "$tmp_dir/pip-freeze.txt"

cat > "$tmp_dir/celery_smoke.py" <<'PY'
from __future__ import annotations

import json

from celery import Celery

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    RecordingTransport,
    celery_operation_with_logbrew_span,
    create_celery_trace_headers,
    use_logbrew_trace,
)

app = Celery("logbrew_celery_smoke", broker="memory://", backend="cache+memory://")
app.conf.task_always_eager = True
app.conf.task_eager_propagates = True
app.conf.task_store_eager_result = True

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="celery-smoke",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
captured: dict[str, object] = {}


@app.task(bind=True, name="checkout.send_receipt")
def send_receipt(self, order_id: str) -> str:
    captured["taskHeaders"] = dict(self.request.headers or {})
    return celery_operation_with_logbrew_span(
        client=client,
        event_id="evt_python_celery_process",
        timestamp="2026-06-30T12:00:01Z",
        task=self,
        operation=lambda: "processed",
        operation_kind="process",
        queue_name="receipts",
        span_id_factory=lambda: "b7ad6b7169203372",
        metadata={
            "service": "checkout-worker",
            "jobArgs": order_id,
            "headers": "private headers",
        },
    )


with use_logbrew_trace(parent_trace):
    def publish_receipt() -> str:
        headers = create_celery_trace_headers()
        captured["producerHeaders"] = headers
        return send_receipt.apply_async(args=["raw-order-id"], headers=headers).get(timeout=5)

    publish_result = celery_operation_with_logbrew_span(
        client=client,
        event_id="evt_python_celery_publish",
        timestamp="2026-06-30T12:00:00Z",
        task=send_receipt,
        operation=publish_receipt,
        operation_kind="publish",
        queue_name="receipts",
        span_id_factory=lambda: "b7ad6b7169203371",
    )

serialized = client.preview_json()
payload = json.loads(serialized)
events = payload["events"]
if publish_result != "processed":
    raise SystemExit(f"unexpected publish result: {publish_result!r}")
if len(events) != 2:
    raise SystemExit(f"expected two Celery spans, got {len(events)}")

publish_span = next(
    event["attributes"] for event in events if event["attributes"]["name"] == "celery publish checkout.send_receipt"
)
process_span = next(
    event["attributes"] for event in events if event["attributes"]["name"] == "celery process checkout.send_receipt"
)
producer_headers = captured["producerHeaders"]
task_headers = captured["taskHeaders"]
if producer_headers != {
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203371-01"
}:
    raise SystemExit(f"unexpected producer headers: {producer_headers!r}")
if task_headers.get("traceparent") != producer_headers["traceparent"]:
    raise SystemExit(f"Celery did not preserve the traceparent header: {task_headers!r}")
if process_span["traceId"] != publish_span["traceId"]:
    raise SystemExit("process span did not share the publish trace")
if process_span["parentSpanId"] != publish_span["spanId"]:
    raise SystemExit(f"process span did not continue publish span: {process_span!r}")
if process_span["metadata"]["queueSystem"] != "celery":
    raise SystemExit(f"unexpected process metadata: {process_span['metadata']!r}")

for forbidden in (
    "raw-order-id",
    "orderId",
    "private headers",
    '"headers"',
    "memory://",
    "baggage",
    "tracestate",
    "traceparent",
):
    if forbidden in serialized:
        raise SystemExit(f"Celery telemetry leaked private data: {forbidden}")

response = client.shutdown(RecordingTransport.always_accept())
print(
    json.dumps(
        {
            "attempts": response.attempts,
            "celeryProcessParentSpan": process_span["parentSpanId"],
            "events": len(events),
            "ok": True,
            "status": response.status_code,
        },
        sort_keys=True,
    )
)
PY

"$tmp_dir/venv/bin/python" "$tmp_dir/celery_smoke.py" > "$tmp_dir/output.json"
grep -q '"ok": true' "$tmp_dir/output.json"
grep -q '"events": 2' "$tmp_dir/output.json"
grep -q '"celeryProcessParentSpan": "b7ad6b7169203371"' "$tmp_dir/output.json"
grep -q '"status": 202' "$tmp_dir/output.json"

celery_version="$("$tmp_dir/venv/bin/python" -c 'import celery; print(celery.__version__)')"
printf 'python celery real-user smoke passed with celery@%s\n' "$celery_version"
