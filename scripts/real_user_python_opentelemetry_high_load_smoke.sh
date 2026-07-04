#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
python_package_version="$(
    python3 - "$repo_root/python/logbrew_py/pyproject.toml" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    print(tomllib.load(handle)["project"]["version"])
PY
)"
wheel_artifact="logbrew_sdk-${python_package_version}-py3-none-any.whl"

on_error() {
    local status=$?
    echo "real_user_python_opentelemetry_high_load_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
    for diagnostic in \
        "$tmp_dir/build.log" \
        "$tmp_dir/pip-freeze.txt" \
        "$tmp_dir/high-load.stdout.json"; do
        if [[ -f "$diagnostic" ]]; then
            echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
            sed -n '1,160p' "$diagnostic" >&2
        fi
    done
    exit "$status"
}

cleanup() {
    rm -rf "$tmp_dir" \
        "$repo_root/python/logbrew_py/build" \
        "$repo_root/python/logbrew_py/src/logbrew_sdk.egg-info"
}

trap cleanup EXIT
trap on_error ERR

python3 -m venv "$tmp_dir/build-venv"
"$tmp_dir/build-venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check build >/dev/null
"$tmp_dir/build-venv/bin/python" -m build "$repo_root/python/logbrew_py" --wheel --outdir "$tmp_dir/dist" > "$tmp_dir/build.log"

python3 -m venv "$tmp_dir/venv"
# shellcheck source=/dev/null
source "$tmp_dir/venv/bin/activate"
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_CACHE_DIR="$tmp_dir/pip-cache"

python -m pip install --no-index "$tmp_dir/dist/$wheel_artifact" >/dev/null
python -m pip install "opentelemetry-sdk>=1,<2" >/dev/null

python - <<'PY' > "$tmp_dir/high-load.stdout.json"
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    create_logbrew_open_telemetry_span_exporter,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import (
    NonRecordingSpan,
    SpanContext,
    SpanKind,
    Status,
    StatusCode,
    TraceFlags,
    TraceState,
    use_span,
)

API_KEY = "lbw_ingest_python_otel_high_load_fake"
HIGH_VOLUME_OTEL_SPANS = 1500
MAX_QUEUE_SIZE = 1000
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"


class IntakeState:
    bodies: list[str] = []
    sources: list[str | None] = []
    authorizations: list[str | None] = []


class FakeIntakeHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/v1/events":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        IntakeState.bodies.append(body)
        IntakeState.sources.append(self.headers.get("x-logbrew-source"))
        IntakeState.authorizations.append(self.headers.get("authorization"))
        self.send_response(503 if len(IntakeState.bodies) == 1 else 202)
        self.end_headers()
        self.wfile.write(b"accepted")

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


client = LogBrewClient.create(
    api_key=API_KEY,
    sdk_name="python-opentelemetry-high-load-smoke",
    sdk_version="0.1.0",
    max_retries=1,
    max_queue_size=MAX_QUEUE_SIZE,
)
provider = TracerProvider(
    resource=Resource.create(
        {
            "service.name": "checkout-api",
            "service.version": "2026.07.04",
            "deployment.environment": "production",
            "cloud.account.id": "blocked-account",
        }
    )
)
exporter = create_logbrew_open_telemetry_span_exporter(
    client=client,
    event_id_prefix="otel_high_load",
    metadata={"release": "checkout@2026.07.04"},
)
provider.add_span_processor(
    BatchSpanProcessor(
        exporter,
        max_queue_size=2048,
        max_export_batch_size=128,
        schedule_delay_millis=60_000,
    )
)
tracer = provider.get_tracer("checkout-otel-high-load", "0.1.0")
parent = NonRecordingSpan(
    SpanContext(
        trace_id=int(TRACE_ID, 16),
        span_id=int(PARENT_SPAN_ID, 16),
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
        trace_state=TraceState.get_default(),
    )
)

with use_span(parent, end_on_exit=False):
    for index in range(HIGH_VOLUME_OTEL_SPANS):
        with tracer.start_as_current_span(
            f"db SELECT {index:04d}",
            kind=SpanKind.CLIENT,
            attributes={
                "db.system": "postgresql",
                "db.operation.name": "SELECT",
                "db.statement": f"SELECT * FROM users WHERE id = {index}",
                "http.url": f"https://api.example.test/users/{index}?marker=blocked",
            },
        ) as span:
            if index == 0:
                span.add_event(
                    "exception",
                    {
                        "exception.type": "RuntimeError",
                        "exception.message": "blocked high-load failure",
                        "exception.stacktrace": "blocked stack",
                        "exception.escaped": True,
                    },
                )
                span.set_status(Status(StatusCode.ERROR))

if provider.force_flush() is not True:
    raise SystemExit("OpenTelemetry provider did not force-flush high-load spans")

assert_equal(client.pending_events(), MAX_QUEUE_SIZE, "bounded LogBrew queue size")
assert_equal(client.dropped_events(), HIGH_VOLUME_OTEL_SPANS - MAX_QUEUE_SIZE, "dropped LogBrew event count")

preview = json.loads(client.preview_json())
assert_equal(len(preview["events"]), MAX_QUEUE_SIZE, "queued event count")
first_span = preview["events"][0]["attributes"]
last_span = preview["events"][-1]["attributes"]
assert_equal(first_span["traceId"], TRACE_ID, "first span trace id")
assert_equal(first_span["parentSpanId"], PARENT_SPAN_ID, "first span parent span id")
assert_equal(first_span["status"], "error", "first span status")
assert_equal(first_span["events"][0]["name"], "exception", "exception event name")
assert_equal(first_span["events"][0]["metadata"]["exception.type"], "RuntimeError", "exception type")
assert_equal(first_span["events"][0]["metadata"]["exception.escaped"], True, "exception escaped")
assert_equal(last_span["traceId"], TRACE_ID, "last queued span trace id")
assert_equal(last_span["metadata"]["service.name"], "checkout-api", "service metadata")
assert_equal(last_span["metadata"]["deployment.environment"], "production", "environment metadata")
assert_equal(last_span["metadata"]["db.system"], "postgresql", "db system metadata")

serialized_preview = json.dumps(preview)
for blocked in [
    API_KEY,
    "blocked-account",
    "blocked high-load failure",
    "blocked stack",
    "db.statement",
    "http.url",
    "marker=blocked",
]:
    if blocked in serialized_preview:
        raise AssertionError(f"queued payload leaked blocked value: {blocked}")

server = ThreadingHTTPServer(("127.0.0.1", 0), FakeIntakeHandler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    response = client.flush(
        HttpTransport(
            endpoint=f"http://127.0.0.1:{server.server_port}/v1/events",
            headers={"x-logbrew-source": "python-otel-high-load-smoke"},
            timeout=5.0,
        )
    )
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5.0)

assert_equal(response.status_code, 202, "flush status")
assert_equal(response.attempts, 2, "retryAttempts")
assert_equal(len(IntakeState.bodies), 2, "fake intake retry count")
assert_equal(client.pending_events(), 0, "queue after flush")
for authorization in IntakeState.authorizations:
    assert_equal(authorization, f"Bearer {API_KEY}", "authorization header")
for source in IntakeState.sources:
    assert_equal(source, "python-otel-high-load-smoke", "source header")

flushed_payload = json.loads(IntakeState.bodies[-1])
assert_equal(flushed_payload["sdk"]["name"], "python-opentelemetry-high-load-smoke", "sdk name")
assert_equal(len(flushed_payload["events"]), MAX_QUEUE_SIZE, "flushed event count")

provider.shutdown()
after_shutdown_result = exporter.export(())
assert_equal(getattr(after_shutdown_result, "name", str(after_shutdown_result)), "FAILURE", "export after shutdown")

print(
    json.dumps(
        {
            "ok": True,
            "droppedEvents": client.dropped_events(),
            "flushedEvents": len(flushed_payload["events"]),
            "highVolumeOtelSpans": HIGH_VOLUME_OTEL_SPANS,
            "maxQueueSize": MAX_QUEUE_SIZE,
            "retryAttempts": response.attempts,
            "shutdownExportResult": getattr(after_shutdown_result, "name", str(after_shutdown_result)),
            "traceId": first_span["traceId"],
        },
        sort_keys=True,
    )
)
PY

python -m pip freeze > "$tmp_dir/pip-freeze.txt"
grep -q '^opentelemetry-api==' "$tmp_dir/pip-freeze.txt"
grep -q '^opentelemetry-sdk==' "$tmp_dir/pip-freeze.txt"
grep -q '"ok": true' "$tmp_dir/high-load.stdout.json"
grep -q '"highVolumeOtelSpans": 1500' "$tmp_dir/high-load.stdout.json"
grep -q '"maxQueueSize": 1000' "$tmp_dir/high-load.stdout.json"
grep -q '"droppedEvents": 500' "$tmp_dir/high-load.stdout.json"
grep -q '"flushedEvents": 1000' "$tmp_dir/high-load.stdout.json"
grep -q '"retryAttempts": 2' "$tmp_dir/high-load.stdout.json"
grep -q '"shutdownExportResult": "FAILURE"' "$tmp_dir/high-load.stdout.json"
grep -q '"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/high-load.stdout.json"

echo "Python OpenTelemetry high-load installed-artifact smoke passed"
