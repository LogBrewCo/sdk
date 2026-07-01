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
    echo "real_user_python_opentelemetry_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
    for diagnostic in \
        "$tmp_dir/build.log" \
        "$tmp_dir/pip-freeze.txt" \
        "$tmp_dir/no-otel.stdout.json" \
        "$tmp_dir/otel.stdout.json"; do
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
python -m build "$repo_root/python/logbrew_py" --wheel --outdir "$tmp_dir/dist" > "$tmp_dir/build.log"
python -m pip install "$tmp_dir/dist/$wheel_artifact" >/dev/null

python - <<'PY' > "$tmp_dir/no-otel.stdout.json"
import json

from logbrew_sdk import logbrew_trace_context_from_current_open_telemetry_span

print(json.dumps({"ok": logbrew_trace_context_from_current_open_telemetry_span() is None}))
PY
grep -q '"ok": true' "$tmp_dir/no-otel.stdout.json"

python -m pip install "opentelemetry-api>=1,<2" >/dev/null

python - <<'PY' > "$tmp_dir/otel.stdout.json"
import json
from datetime import UTC, datetime

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    create_traceparent_headers,
    logbrew_trace_context_from_current_open_telemetry_span,
    span_attributes_from_trace_context,
    trace_metadata,
    use_logbrew_trace,
)
from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags, TraceState

otel_parent = NonRecordingSpan(
    SpanContext(
        trace_id=int("4bf92f3577b34da6a3ce929d0e0e4736", 16),
        span_id=int("00f067aa0ba902b7", 16),
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
        trace_state=TraceState.get_default(),
    )
)

client = LogBrewClient.create(api_key="LOGBREW_API_KEY", sdk_name="checkout-api", sdk_version="0.1.2")
timestamp = datetime(2026, 6, 15, 12, 0, tzinfo=UTC).isoformat().replace("+00:00", "Z")

with trace.use_span(otel_parent, end_on_exit=False):
    child = logbrew_trace_context_from_current_open_telemetry_span(span_id="b7ad6b7169203331")
    if child != LogBrewTraceContext(
        trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
        span_id="b7ad6b7169203331",
        parent_span_id="00f067aa0ba902b7",
        sampled=True,
    ):
        raise SystemExit("unexpected LogBrew child trace copied from OpenTelemetry")

    with use_logbrew_trace(child):
        metadata = trace_metadata()
        client.log(
            "evt_log_otel_bridge",
            timestamp,
            {
                "message": "otel bridge copied",
                "level": "info",
                "logger": "checkout.otel",
                "metadata": metadata,
            },
        )
        client.span(
            "evt_span_otel_child",
            timestamp,
            span_attributes_from_trace_context(
                child,
                name="otel.child",
                status="ok",
                duration_ms=4.2,
                metadata={"service": "checkout", "framework": "opentelemetry"},
            ),
        )

payload = json.loads(client.preview_json())
log_metadata = payload["events"][0]["attributes"]["metadata"]
span_attributes = payload["events"][1]["attributes"]
headers = create_traceparent_headers(
    trace_id=child.trace_id,
    span_id=child.span_id,
    trace_flags="01",
)

print(
    json.dumps(
        {
            "ok": True,
            "events": len(payload["events"]),
            "logTraceId": log_metadata["traceId"],
            "logParentSpanId": log_metadata["parentSpanId"],
            "spanTraceId": span_attributes["traceId"],
            "spanParentSpanId": span_attributes["parentSpanId"],
            "sampled": log_metadata["sampled"],
            "traceparent": headers["traceparent"],
        },
        sort_keys=True,
    )
)
PY

python -m pip freeze > "$tmp_dir/pip-freeze.txt"
grep -q '^opentelemetry-api==' "$tmp_dir/pip-freeze.txt"
grep -q '"ok": true' "$tmp_dir/otel.stdout.json"
grep -q '"events": 2' "$tmp_dir/otel.stdout.json"
grep -q '"logTraceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/otel.stdout.json"
grep -q '"spanTraceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/otel.stdout.json"
grep -q '"logParentSpanId": "00f067aa0ba902b7"' "$tmp_dir/otel.stdout.json"
grep -q '"spanParentSpanId": "00f067aa0ba902b7"' "$tmp_dir/otel.stdout.json"
grep -q '"sampled": true' "$tmp_dir/otel.stdout.json"
grep -q '"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"' "$tmp_dir/otel.stdout.json"

echo "Python OpenTelemetry installed-artifact smoke passed"
