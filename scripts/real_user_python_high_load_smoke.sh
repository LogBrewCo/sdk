#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
export PIP_CACHE_DIR="$tmp_dir/pip-cache"

cleanup() {
  rm -rf "$tmp_dir" \
    "$repo_root/python/logbrew_py/build" \
    "$repo_root/python/logbrew_py/src/logbrew_sdk.egg-info"
}

trap cleanup EXIT

python3 -m venv "$tmp_dir/build-venv"
"$tmp_dir/build-venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check build >/dev/null
"$tmp_dir/build-venv/bin/python" -m build "$repo_root/python/logbrew_py" --wheel --outdir "$tmp_dir/dist" >/dev/null
wheel_path="$(find "$tmp_dir/dist" -maxdepth 1 -name 'logbrew_sdk-*.whl' -print -quit)"
test -f "$wheel_path"

python3 -m venv "$tmp_dir/venv"
python_bin="$tmp_dir/venv/bin/python"
pip_bin="$tmp_dir/venv/bin/pip"

"$pip_bin" install --disable-pip-version-check --no-index "$wheel_path" >/dev/null
"$python_bin" -c 'import logbrew_sdk' >/dev/null
"$pip_bin" uninstall --yes logbrew-sdk >/dev/null
if "$python_bin" -c 'import logbrew_sdk' >/dev/null 2>&1; then
  echo "logbrew-sdk import survived uninstall" >&2
  exit 1
fi
"$pip_bin" install --disable-pip-version-check --no-index "$wheel_path" >/dev/null

cat > "$tmp_dir/high_load_smoke.py" <<'PY'
from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    LogBrewLoggingHandler,
    RecordingTransport,
    SdkError,
    create_logbrew_trace_context,
    create_traceparent,
    use_logbrew_trace,
)

API_KEY = "lbw_ingest_python_high_load_fake"
HIGH_VOLUME_LOGS = 1500
MAX_QUEUE_SIZE = 1000
MAX_BATCH_EVENTS = 100
MAX_BATCH_BYTES = 256 * 1024
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


def main() -> None:
    client = LogBrewClient.create(
        api_key=API_KEY,
        sdk_name="python-high-load-smoke",
        sdk_version="0.1.0",
        max_retries=1,
        max_queue_size=MAX_QUEUE_SIZE,
        max_batch_events=MAX_BATCH_EVENTS,
        max_batch_bytes=MAX_BATCH_BYTES,
    )
    client.release(
        "evt_python_high_load_release",
        "2026-06-02T10:00:00Z",
        {"version": "checkout@1.2.3"},
    )
    client.environment(
        "evt_python_high_load_environment",
        "2026-06-02T10:00:01Z",
        {"name": "production"},
    )
    client.span(
        "evt_python_high_load_request_span",
        "2026-06-02T10:00:02Z",
        {
            "name": "POST /checkout/:cart_id",
            "traceId": TRACE_ID,
            "spanId": "b7ad6b7169203331",
            "parentSpanId": PARENT_SPAN_ID,
            "status": "ok",
            "durationMs": 42.5,
            "metadata": {
                "service": "checkout-api",
                "routeTemplate": "/checkout/:cart_id",
            },
        },
    )
    client.action(
        "evt_python_high_load_action",
        "2026-06-02T10:00:03Z",
        {
            "name": "checkout.submit",
            "status": "success",
            "metadata": {"release": "checkout@1.2.3", "environment": "production"},
        },
    )

    logger = logging.getLogger("checkout.high_load")
    logger.handlers = []
    logger.propagate = False
    logger.setLevel(logging.INFO)
    handler = LogBrewLoggingHandler(
        client,
        metadata={
            "service": "checkout-api",
            "release": "checkout@1.2.3",
            "environment": "production",
        },
    )
    logger.addHandler(handler)

    trace_context = create_logbrew_trace_context(
        create_traceparent(trace_id=TRACE_ID, span_id=PARENT_SPAN_ID),
        span_id="b7ad6b7169203332",
    )
    try:
        with use_logbrew_trace(trace_context):
            for index in range(HIGH_VOLUME_LOGS):
                logger.log(
                    logging.WARNING if index % 10 == 0 else logging.INFO,
                    "checkout queue heartbeat",
                    extra={
                        "sequence": index,
                        "routeTemplate": "/checkout/:cart_id",
                        "unsafePayload": {"ignored": True},
                    },
                )
    finally:
        logger.removeHandler(handler)

    expected_drops = 4 + HIGH_VOLUME_LOGS - MAX_QUEUE_SIZE
    assert_equal(client.pending_events(), MAX_QUEUE_SIZE, "bounded queue size")
    assert_equal(client.dropped_events(), expected_drops, "dropped event count")

    preview = json.loads(client.preview_json())
    preview_ids = [event["id"] for event in preview["events"]]
    assert_equal(len(preview_ids), MAX_QUEUE_SIZE, "preview event count")
    assert_equal(
        [event["id"] for event in preview["events"][:4]],
        [
            "evt_python_high_load_release",
            "evt_python_high_load_environment",
            "evt_python_high_load_request_span",
            "evt_python_high_load_action",
        ],
        "context event order",
    )
    assert_equal(count_events(preview, "log"), MAX_QUEUE_SIZE - 4, "queued log count")

    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeIntakeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        response = client.flush(
            HttpTransport(
                endpoint=f"http://127.0.0.1:{server.server_port}/v1/events",
                headers={"x-logbrew-source": "python-high-load-smoke"},
                timeout=5.0,
            )
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)

    assert_equal(response.status_code, 202, "flush status")
    assert_equal(response.attempts, 11, "aggregate flush attempts")
    assert_equal(response.batches, 10, "accepted flush batches")
    assert_equal(response.accepted_events, MAX_QUEUE_SIZE, "accepted flush events")
    assert_equal(len(IntakeState.bodies), 11, "fake intake request count")
    assert_equal(IntakeState.bodies[0], IntakeState.bodies[1], "failed retry body")
    assert_equal(client.pending_events(), 0, "queue after flush")
    assert_equal(len(IntakeState.authorizations), 11, "authorization header count")
    for authorization in IntakeState.authorizations:
        if authorization != f"Bearer {API_KEY}":
            raise AssertionError("fake intake authorization header mismatch")
    assert_equal(len(IntakeState.sources), 11, "source header count")
    for source in IntakeState.sources:
        assert_equal(source, "python-high-load-smoke", "source header")

    accepted_events: list[dict[str, Any]] = []
    successful_payloads: list[dict[str, Any]] = []
    for request_index, body_text in enumerate(IntakeState.bodies):
        body_size = len(body_text.encode("utf-8"))
        if body_size > MAX_BATCH_BYTES:
            raise AssertionError(
                f"request {request_index} exceeded byte bound: {body_size}"
            )
        request_payload = json.loads(body_text)
        request_events = request_payload["events"]
        if not isinstance(request_events, list):
            raise AssertionError(f"request {request_index} events were not a list")
        if len(request_events) > MAX_BATCH_EVENTS:
            raise AssertionError(
                f"request {request_index} exceeded event bound: {len(request_events)}"
            )
        assert_equal(
            request_payload["sdk"]["name"],
            "python-high-load-smoke",
            f"request {request_index} sdk name",
        )
        for unsafe in [API_KEY, "coupon=private", "authorization", "unsafePayload"]:
            if unsafe in body_text:
                raise AssertionError(
                    f"request {request_index} included unsafe content marker: {unsafe}"
                )
        if request_index > 0:
            successful_payloads.append(request_payload)
            accepted_events.extend(request_events)

    assert_equal(len(successful_payloads), response.batches, "successful request count")
    assert_equal(len(accepted_events), response.accepted_events, "accepted event count")
    assert_equal(accepted_events, preview["events"], "accepted event sequence")
    accepted_ids = [event["id"] for event in accepted_events]
    assert_equal(accepted_ids, preview_ids, "accepted event order")

    payload = {"sdk": successful_payloads[0]["sdk"], "events": accepted_events}
    assert_equal(payload["sdk"]["name"], "python-high-load-smoke", "sdk name")
    assert_equal(len(payload["events"]), MAX_QUEUE_SIZE, "flushed event count")
    assert_equal(count_events(payload, "log"), MAX_QUEUE_SIZE - 4, "flushed log count")
    assert_equal(payload["events"][0]["type"], "release", "first event type")
    assert_equal(payload["events"][1]["type"], "environment", "second event type")
    assert_equal(payload["events"][2]["attributes"]["traceId"], TRACE_ID, "span trace id")
    first_log = next(event for event in payload["events"] if event["type"] == "log")
    log_metadata = first_log["attributes"]["metadata"]
    assert_equal(first_log["attributes"]["level"], "warning", "canonical warning level")
    assert_equal(log_metadata["traceId"], TRACE_ID, "log trace id")
    assert_equal(log_metadata["parentSpanId"], PARENT_SPAN_ID, "log parent span id")
    assert_equal(log_metadata["service"], "checkout-api", "log service")
    assert_equal(log_metadata["environment"], "production", "log environment")
    assert_equal(log_metadata["release"], "checkout@1.2.3", "log release")
    assert_equal(log_metadata["sequence"], 0, "first log sequence")
    assert "unsafePayload" not in log_metadata

    shutdown_client = LogBrewClient.create(
        api_key=API_KEY,
        sdk_name="python-high-load-shutdown-smoke",
        sdk_version="0.1.0",
    )
    shutdown_client.log(
        "evt_python_shutdown_001",
        "2026-06-02T10:30:00Z",
        {"message": "shutdown flush", "level": "info"},
    )
    shutdown_response = shutdown_client.shutdown(RecordingTransport.always_accept())
    assert_equal(shutdown_response.status_code, 202, "shutdown status")
    try:
        shutdown_client.log(
            "evt_python_shutdown_after_001",
            "2026-06-02T10:30:01Z",
            {"message": "after shutdown", "level": "info"},
        )
    except SdkError as error:
        assert_equal(error.code, "shutdown_error", "post-shutdown error code")
    else:
        raise AssertionError("expected post-shutdown log to raise SdkError")

    print(
        json.dumps(
            {
                "ok": True,
                "droppedEvents": client.dropped_events(),
                "flushedEvents": len(payload["events"]),
                "highVolumeLogs": HIGH_VOLUME_LOGS,
                "pendingEvents": client.pending_events(),
                "retryAttempts": response.attempts,
                "shutdownStatus": shutdown_response.status_code,
            },
            sort_keys=True,
        )
    )


def count_events(payload: dict[str, Any], event_type: str) -> int:
    return sum(1 for event in payload["events"] if event["type"] == event_type)


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


if __name__ == "__main__":
    main()
PY

"$python_bin" "$tmp_dir/high_load_smoke.py" > "$tmp_dir/high-load.stdout.json"
grep -q '"ok": true' "$tmp_dir/high-load.stdout.json"
grep -q '"highVolumeLogs": 1500' "$tmp_dir/high-load.stdout.json"
grep -q '"flushedEvents": 1000' "$tmp_dir/high-load.stdout.json"
grep -q '"droppedEvents": 504' "$tmp_dir/high-load.stdout.json"
grep -q '"retryAttempts": 11' "$tmp_dir/high-load.stdout.json"
grep -q '"shutdownStatus": 202' "$tmp_dir/high-load.stdout.json"
cat "$tmp_dir/high-load.stdout.json"
