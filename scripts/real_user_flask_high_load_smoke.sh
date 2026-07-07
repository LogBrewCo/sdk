#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/python_package_version.sh"

core_dir="$repo_root/python/logbrew_py"
package_dir="$repo_root/python/logbrew_flask"
tmp_dir="$(mktemp -d)"
core_package_version="$(python_package_version "$core_dir/pyproject.toml")"
flask_package_version="$(python_package_version "$package_dir/pyproject.toml")"
export PIP_CACHE_DIR="$tmp_dir/pip-cache"

on_error() {
  local status=$?
  echo "real_user_flask_high_load_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
  for diagnostic in \
    "$tmp_dir/build-core.log" \
    "$tmp_dir/build-flask.log" \
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
    "$repo_root/python/logbrew_py/src/logbrew_sdk.egg-info" \
    "$repo_root/python/logbrew_flask/build" \
    "$repo_root/python/logbrew_flask/src/logbrew_flask.egg-info"
}

trap cleanup EXIT
trap on_error ERR

python3 -m venv "$tmp_dir/build-venv"
"$tmp_dir/build-venv/bin/python" -m pip install --upgrade --disable-pip-version-check pip >/dev/null
"$tmp_dir/build-venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check build >/dev/null
"$tmp_dir/build-venv/bin/python" -m build --wheel --outdir "$tmp_dir/core-dist" "$repo_root/python/logbrew_py" > "$tmp_dir/build-core.log"
"$tmp_dir/build-venv/bin/python" -m build --wheel --outdir "$tmp_dir/flask-dist" "$repo_root/python/logbrew_flask" > "$tmp_dir/build-flask.log"

core_wheel="$tmp_dir/core-dist/logbrew_sdk-${core_package_version}-py3-none-any.whl"
flask_wheel="$tmp_dir/flask-dist/logbrew_flask-${flask_package_version}-py3-none-any.whl"
test -f "$core_wheel"
test -f "$flask_wheel"

python3 -m venv "$tmp_dir/app"
python_bin="$tmp_dir/app/bin/python"
"$python_bin" -m pip install --upgrade --disable-pip-version-check pip >/dev/null
"$python_bin" -m pip install --no-cache-dir --disable-pip-version-check "$core_wheel" "$flask_wheel" >/dev/null
"$python_bin" -m pip check >/dev/null
"$python_bin" -m pip freeze > "$tmp_dir/pip-freeze.txt"
"$python_bin" -m pip show logbrew-flask > "$tmp_dir/pip-show-flask.txt"
"$python_bin" -m pip show logbrew-sdk > "$tmp_dir/pip-show-core.txt"
grep -q '^Flask==' "$tmp_dir/pip-freeze.txt"
grep -q "^Name: logbrew-flask$" "$tmp_dir/pip-show-flask.txt"
grep -q "^Version: ${flask_package_version}$" "$tmp_dir/pip-show-flask.txt"
grep -q "^Name: logbrew-sdk$" "$tmp_dir/pip-show-core.txt"
grep -q "^Version: ${core_package_version}$" "$tmp_dir/pip-show-core.txt"

cat > "$tmp_dir/flask_high_load_smoke.py" <<'PY'
from __future__ import annotations

import json
import logging
import threading
from importlib.metadata import version
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from flask import Flask
from logbrew_flask import add_logbrew_middleware, get_active_logbrew_trace
from logbrew_sdk import (
    HttpTransport,
    LogBrewClient,
    LogBrewLoggingHandler,
    RecordingTransport,
    SdkError,
)

API_KEY = "lbw_ingest_flask_high_load_fake"
HIGH_VOLUME_FLASK_REQUESTS = 600
MAX_QUEUE_SIZE = 1000
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
TRACEPARENT = f"00-{TRACE_ID}-{PARENT_SPAN_ID}-01"


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
        sdk_name="logbrew-flask",
        sdk_version="0.1.0",
        max_retries=1,
        max_queue_size=MAX_QUEUE_SIZE,
    )
    logger = logging.getLogger("flask.checkout.high_load")
    logger.handlers = []
    logger.propagate = False
    logger.setLevel(logging.INFO)
    logger.addHandler(
        LogBrewLoggingHandler(
            client,
            metadata={
                "service": "checkout-web",
                "release": "checkout@2026.07.07",
                "environment": "production",
            },
        )
    )

    next_span_id = deterministic_span_id_factory()
    app = Flask(__name__)
    add_logbrew_middleware(
        app,
        client=client,
        capture_request_metrics=True,
        flush_on_response=False,
        span_id_factory=next_span_id,
    )

    @app.get("/checkout/<order_id>")
    def checkout(order_id: str) -> dict[str, object]:
        trace = get_active_logbrew_trace()
        request_index = int(order_id.removeprefix("cart-"))
        logger.info(
            "checkout request accepted",
            extra={
                "requestIndex": request_index,
                "routeTemplate": "/checkout/<order_id>",
                "unsafePayload": {"ignored": True},
            },
        )
        return {
            "ok": True,
            "traceId": trace.trace_id if trace else None,
            "spanId": trace.span_id if trace else None,
        }

    http = app.test_client()
    first_response: Any | None = None
    for index in range(HIGH_VOLUME_FLASK_REQUESTS):
        response = http.get(
            f"/checkout/cart-{index}?coupon=private",
            headers={"traceparent": TRACEPARENT},
        )
        if response.status_code != 200:
            raise AssertionError(f"unexpected Flask response status: {response.status_code}")
        if first_response is None:
            first_response = response.json

    attempted_events = HIGH_VOLUME_FLASK_REQUESTS * 3
    assert_equal(client.pending_events(), MAX_QUEUE_SIZE, "bounded queue size")
    assert_equal(client.dropped_events(), attempted_events - MAX_QUEUE_SIZE, "dropped event count")

    preview = json.loads(client.preview_json())
    assert_equal(preview["sdk"]["name"], "logbrew-flask", "sdk name")
    assert_equal(len(preview["events"]), MAX_QUEUE_SIZE, "queued event count")
    assert_equal([event["type"] for event in preview["events"][:3]], ["log", "span", "metric"], "first request events")
    first_log = preview["events"][0]["attributes"]
    first_span = preview["events"][1]["attributes"]
    first_metric = preview["events"][2]["attributes"]

    assert_equal(first_response["traceId"], TRACE_ID, "handler trace id")
    assert_equal(first_response["spanId"], "b7ad6b7169203331", "handler span id")
    assert_equal(first_log["level"], "info", "log level")
    assert_equal(first_log["metadata"]["traceId"], TRACE_ID, "log trace id")
    assert_equal(first_log["metadata"]["spanId"], "b7ad6b7169203331", "log span id")
    assert_equal(first_log["metadata"]["parentSpanId"], PARENT_SPAN_ID, "log parent span id")
    assert_equal(first_log["metadata"]["service"], "checkout-web", "log service")
    assert_equal(first_log["metadata"]["release"], "checkout@2026.07.07", "log release")
    assert_equal(first_log["metadata"]["environment"], "production", "log environment")
    assert_equal(first_log["metadata"]["requestIndex"], 0, "log request index")
    if "unsafePayload" in first_log["metadata"]:
        raise AssertionError("non-primitive logging metadata was captured")
    assert_equal(first_span["name"], "GET /checkout/<order_id>", "request span name")
    assert_equal(first_span["traceId"], TRACE_ID, "request span trace id")
    assert_equal(first_span["spanId"], "b7ad6b7169203331", "request span id")
    assert_equal(first_span["parentSpanId"], PARENT_SPAN_ID, "request parent span id")
    assert_equal(first_span["metadata"]["routeTemplate"], "/checkout/<order_id>", "span route template")
    if "path" in first_span["metadata"]:
        raise AssertionError("concrete dynamic path was captured for a templated Flask route")
    assert_equal(first_metric["name"], "http.server.duration", "metric name")
    assert_equal(first_metric["metadata"]["routeTemplate"], "/checkout/<order_id>", "metric route template")
    assert_equal(first_metric["metadata"]["statusCodeClass"], "2xx", "metric status class")

    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeIntakeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        response = client.flush(
            HttpTransport(
                endpoint=f"http://127.0.0.1:{server.server_port}/v1/events",
                headers={"x-logbrew-source": "flask-high-load-smoke"},
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
        assert_equal(source, "flask-high-load-smoke", "source header")

    flushed_payload = json.loads(IntakeState.bodies[-1])
    assert_equal(len(flushed_payload["events"]), MAX_QUEUE_SIZE, "flushed event count")
    assert_equal(flushed_payload["events"][1]["attributes"]["spanId"], "b7ad6b7169203331", "flushed first span id")
    body_text = IntakeState.bodies[-1]
    for unsafe in [
        API_KEY,
        "coupon=private",
        "cart-0",
        "unsafePayload",
        "authorization",
    ]:
        if unsafe in body_text:
            raise AssertionError(f"payload included unsafe content marker: {unsafe}")

    auth_client = LogBrewClient.create(
        api_key="lbw_ingest_flask_high_load_invalid",
        sdk_name="logbrew-flask",
        sdk_version="0.1.0",
    )
    auth_client.log(
        "evt_flask_auth_failure_001",
        "2026-07-07T10:00:00Z",
        {"message": "auth failure stays queued", "level": "info"},
    )
    try:
        auth_client.flush(RecordingTransport([{"status_code": 401}]))
    except SdkError as error:
        assert_equal(error.code, "unauthenticated", "auth failure code")
    else:
        raise AssertionError("expected 401 to raise unauthenticated")
    assert_equal(auth_client.pending_events(), 1, "auth failure preserves queued event")

    try:
        LogBrewClient.create(
            api_key="lbw_ingest_flask_validation_fake",
            sdk_name="logbrew-flask",
            sdk_version="0.1.0",
            max_queue_size=0,
        )
    except SdkError as error:
        assert_equal(error.code, "configuration_error", "validation failure code")
    else:
        raise AssertionError("expected invalid max_queue_size to raise configuration_error")

    shutdown_client = LogBrewClient.create(
        api_key=API_KEY,
        sdk_name="logbrew-flask-shutdown-smoke",
        sdk_version="0.1.0",
    )
    shutdown_client.log(
        "evt_flask_shutdown_001",
        "2026-07-07T10:30:00Z",
        {"message": "shutdown flush", "level": "info"},
    )
    shutdown_response = shutdown_client.shutdown(RecordingTransport.always_accept())
    assert_equal(shutdown_response.status_code, 202, "shutdown status")
    try:
        shutdown_client.log(
            "evt_flask_shutdown_after_001",
            "2026-07-07T10:30:01Z",
            {"message": "after shutdown", "level": "info"},
        )
    except SdkError as error:
        assert_equal(error.code, "shutdown_error", "post-shutdown error code")
    else:
        raise AssertionError("expected post-shutdown log to raise shutdown_error")

    Path(__import__("sys").argv[1]).write_text(json.dumps(flushed_payload, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": True,
                "droppedEvents": client.dropped_events(),
                "flaskVersion": version("flask"),
                "flushedEvents": len(flushed_payload["events"]),
                "highVolumeFlaskRequests": HIGH_VOLUME_FLASK_REQUESTS,
                "maxQueueSize": MAX_QUEUE_SIZE,
                "pendingEvents": client.pending_events(),
                "retryAttempts": response.attempts,
                "shutdownStatus": shutdown_response.status_code,
                "traceId": first_span["traceId"],
                "validationError": "configuration_error",
                "authError": "unauthenticated",
            },
            sort_keys=True,
        )
    )


def deterministic_span_id_factory() -> Any:
    value = int("b7ad6b7169203330", 16)

    def next_span_id() -> str:
        nonlocal value
        value += 1
        return f"{value:016x}"[-16:]

    return next_span_id


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


if __name__ == "__main__":
    main()
PY

"$python_bin" "$tmp_dir/flask_high_load_smoke.py" "$tmp_dir/flushed-body.json" > "$tmp_dir/high-load.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/flushed-body.json" >/dev/null
grep -q '"ok": true' "$tmp_dir/high-load.stdout.json"
grep -q '"highVolumeFlaskRequests": 600' "$tmp_dir/high-load.stdout.json"
grep -q '"maxQueueSize": 1000' "$tmp_dir/high-load.stdout.json"
grep -q '"flushedEvents": 1000' "$tmp_dir/high-load.stdout.json"
grep -q '"droppedEvents": 800' "$tmp_dir/high-load.stdout.json"
grep -q '"retryAttempts": 2' "$tmp_dir/high-load.stdout.json"
grep -q '"shutdownStatus": 202' "$tmp_dir/high-load.stdout.json"
grep -q '"validationError": "configuration_error"' "$tmp_dir/high-load.stdout.json"
grep -q '"authError": "unauthenticated"' "$tmp_dir/high-load.stdout.json"
grep -q '"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/high-load.stdout.json"
cat "$tmp_dir/high-load.stdout.json"
