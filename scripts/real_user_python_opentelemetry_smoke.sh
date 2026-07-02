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
        "$tmp_dir/otel.stdout.json" \
        "$tmp_dir/processor.stdout.json" \
        "$tmp_dir/exporter.stdout.json"; do
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

python -m pip install "opentelemetry-sdk>=1,<2" >/dev/null

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

python - <<'PY' > "$tmp_dir/processor.stdout.json"
import json

from logbrew_sdk import (
    LogBrewClient,
    create_logbrew_open_telemetry_span_processor,
)
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import Link, SpanContext, SpanKind, Status, StatusCode, TraceFlags, TraceState

client = LogBrewClient.create(api_key="LOGBREW_API_KEY", sdk_name="checkout-api", sdk_version="0.1.2")
provider = TracerProvider(
    resource=Resource.create(
        {
            "service.name": "checkout-api",
            "service.version": "2026.07.01",
            "deployment.environment": "production",
            "cloud.account.id": "blocked-account",
        }
    )
)
processor = create_logbrew_open_telemetry_span_processor(
    client=client,
    include_trace_summary=True,
    link_attribute_keys=["messaging.operation.name"],
    metadata={"release": "2026.07.01"},
)
provider.add_span_processor(processor)
tracer = provider.get_tracer("checkout-smoke", "0.1.0")
linked_context = SpanContext(
    trace_id=int("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 16),
    span_id=int("bbbbbbbbbbbbbbbb", 16),
    is_remote=True,
    trace_flags=TraceFlags(TraceFlags.SAMPLED),
    trace_state=TraceState.get_default(),
)

with tracer.start_as_current_span(
    "GET /checkout",
    kind=SpanKind.SERVER,
    attributes={
        "http.method": "GET",
        "http.route": "/checkout",
        "http.url": "https://api.example.test/checkout?debug=blocked",
    },
) as root_span:
    root_span.add_event(
        "exception",
        {
            "exception.type": "ValueError",
            "exception.message": "blocked card failed",
            "exception.stacktrace": "blocked stack",
        },
    )
    root_span.set_status(Status(StatusCode.ERROR))
    with tracer.start_as_current_span(
        "redis GET",
        kind=SpanKind.CLIENT,
        links=[
            Link(
                linked_context,
                attributes={
                    "messaging.operation.name": "receive",
                    "messaging.message.id": "blocked-message-id",
                },
            )
        ],
        attributes={
            "db.system": "redis",
            "db.operation.name": "GET",
            "db.statement": "GET blocked-key",
        },
    ):
        pass

if provider.force_flush() is not True:
    raise SystemExit("OpenTelemetry provider did not force-flush")

payload = json.loads(client.preview_json())
events = payload["events"]
serialized = json.dumps(payload)
blocked_values = [
    "blocked-account",
    "debug=blocked",
    "blocked card",
    "blocked stack",
    "GET blocked-key",
    "http.url",
    "db.statement",
    "blocked-message-id",
    "messaging.message.id",
]
leaked = [value for value in blocked_values if value in serialized]
if leaked:
    raise SystemExit(f"OpenTelemetry payload leaked blocked values: {leaked}")

detail_spans = [event for event in events if event["id"].startswith("otel_") and "_trace_" not in event["id"]]
summary_spans = [event for event in events if "_trace_" in event["id"]]
if len(detail_spans) != 2 or len(summary_spans) != 1:
    raise SystemExit(f"unexpected span counts: detail={len(detail_spans)} summary={len(summary_spans)}")

summary = summary_spans[0]["attributes"]
root = next(event["attributes"] for event in detail_spans if event["attributes"]["name"] == "GET /checkout")
dependency = next(event["attributes"] for event in detail_spans if event["attributes"]["name"] == "redis GET")
dependency_links = dependency.get("links", [])
print(
    json.dumps(
        {
            "ok": True,
            "events": len(events),
            "rootTraceId": root["traceId"],
            "dependencyParentSpanId": dependency["parentSpanId"],
            "rootStatus": root["status"],
            "summaryName": summary["name"],
            "summaryStatus": summary["status"],
            "summarySpanCount": summary["metadata"]["otel.trace.span_count"],
            "summaryErrorSpanCount": summary["metadata"]["otel.trace.error_span_count"],
            "dependencyLinkCount": len(dependency_links),
            "dependencyLinkTraceId": dependency_links[0]["traceId"],
            "dependencyLinkOperation": dependency_links[0]["metadata"]["messaging.operation.name"],
            "service": summary["metadata"]["service.name"],
            "environment": summary["metadata"]["deployment.environment"],
            "route": summary["metadata"]["http.route"],
            "dependencySystem": summary["metadata"]["db.system"],
        },
        sort_keys=True,
    )
)
PY

python - <<'PY' > "$tmp_dir/exporter.stdout.json"
import json

from logbrew_sdk import (
    LogBrewClient,
    create_logbrew_open_telemetry_span_exporter,
)
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.trace import Link, SpanContext, SpanKind, Status, StatusCode, TraceFlags, TraceState

client = LogBrewClient.create(api_key="LOGBREW_API_KEY", sdk_name="checkout-api", sdk_version="0.1.2")
provider = TracerProvider(
    resource=Resource.create(
        {
            "service.name": "checkout-api",
            "service.version": "2026.07.02",
            "deployment.environment": "production",
            "cloud.account.id": "blocked-account",
        }
    )
)
exporter = create_logbrew_open_telemetry_span_exporter(
    client=client,
    include_trace_summary=True,
    link_attribute_keys=["messaging.operation.name"],
    metadata={"release": "2026.07.02"},
)
provider.add_span_processor(SimpleSpanProcessor(exporter))
tracer = provider.get_tracer("checkout-exporter-smoke", "0.1.0")
linked_context = SpanContext(
    trace_id=int("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 16),
    span_id=int("bbbbbbbbbbbbbbbb", 16),
    is_remote=True,
    trace_flags=TraceFlags(TraceFlags.SAMPLED),
    trace_state=TraceState.get_default(),
)
empty_result = exporter.export(())
if empty_result is not SpanExportResult.SUCCESS:
    raise SystemExit(f"unexpected empty export result: {empty_result!r}")

with tracer.start_as_current_span(
    "GET /checkout/exporter",
    kind=SpanKind.SERVER,
    attributes={
        "http.method": "GET",
        "http.route": "/checkout/exporter",
        "http.url": "https://api.example.test/checkout/exporter?debug=blocked",
    },
) as root_span:
    root_span.add_event(
        "exception",
        {
            "exception.type": "RuntimeError",
            "exception.message": "blocked exporter failure",
            "exception.stacktrace": "blocked stack",
        },
    )
    root_span.set_status(Status(StatusCode.ERROR))
    with tracer.start_as_current_span(
        "postgres SELECT",
        kind=SpanKind.CLIENT,
        links=[
            Link(
                linked_context,
                attributes={
                    "messaging.operation.name": "receive",
                    "messaging.message.id": "blocked-message-id",
                },
            )
        ],
        attributes={
            "db.system": "postgresql",
            "db.operation.name": "SELECT",
            "db.statement": "SELECT * FROM users WHERE email = 'blocked@example.test'",
        },
    ):
        pass

if exporter.force_flush() is not True:
    raise SystemExit("LogBrew OpenTelemetry exporter did not force-flush")
provider.shutdown()
payload = json.loads(client.preview_json())
events = payload["events"]
serialized = json.dumps(payload)
blocked_values = [
    "blocked-account",
    "debug=blocked",
    "blocked exporter failure",
    "blocked stack",
    "blocked@example.test",
    "http.url",
    "db.statement",
    "blocked-message-id",
    "messaging.message.id",
]
leaked = [value for value in blocked_values if value in serialized]
if leaked:
    raise SystemExit(f"OpenTelemetry exporter payload leaked blocked values: {leaked}")

detail_spans = [event for event in events if event["id"].startswith("otel_export_") and "_trace_" not in event["id"]]
summary_spans = [event for event in events if "_trace_" in event["id"]]
if len(detail_spans) != 2 or len(summary_spans) != 1:
    raise SystemExit(f"unexpected exporter span counts: detail={len(detail_spans)} summary={len(summary_spans)}")

summary = summary_spans[0]["attributes"]
root = next(event["attributes"] for event in detail_spans if event["attributes"]["name"] == "GET /checkout/exporter")
dependency = next(event["attributes"] for event in detail_spans if event["attributes"]["name"] == "postgres SELECT")
dependency_links = dependency.get("links", [])
print(
    json.dumps(
        {
            "ok": True,
            "events": len(events),
            "emptyExportResult": empty_result.name,
            "rootTraceId": root["traceId"],
            "dependencyParentSpanId": dependency["parentSpanId"],
            "rootStatus": root["status"],
            "summaryName": summary["name"],
            "summaryStatus": summary["status"],
            "summarySpanCount": summary["metadata"]["otel.trace.span_count"],
            "summaryErrorSpanCount": summary["metadata"]["otel.trace.error_span_count"],
            "dependencyLinkCount": len(dependency_links),
            "dependencyLinkTraceId": dependency_links[0]["traceId"],
            "dependencyLinkOperation": dependency_links[0]["metadata"]["messaging.operation.name"],
            "service": summary["metadata"]["service.name"],
            "environment": summary["metadata"]["deployment.environment"],
            "route": summary["metadata"]["http.route"],
            "dependencySystem": summary["metadata"]["db.system"],
        },
        sort_keys=True,
    )
)
PY

python -m pip freeze > "$tmp_dir/pip-freeze.txt"
grep -q '^opentelemetry-api==' "$tmp_dir/pip-freeze.txt"
grep -q '^opentelemetry-sdk==' "$tmp_dir/pip-freeze.txt"
grep -q '"ok": true' "$tmp_dir/otel.stdout.json"
grep -q '"events": 2' "$tmp_dir/otel.stdout.json"
grep -q '"logTraceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/otel.stdout.json"
grep -q '"spanTraceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/otel.stdout.json"
grep -q '"logParentSpanId": "00f067aa0ba902b7"' "$tmp_dir/otel.stdout.json"
grep -q '"spanParentSpanId": "00f067aa0ba902b7"' "$tmp_dir/otel.stdout.json"
grep -q '"sampled": true' "$tmp_dir/otel.stdout.json"
grep -q '"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"' "$tmp_dir/otel.stdout.json"
grep -q '"ok": true' "$tmp_dir/processor.stdout.json"
grep -q '"events": 3' "$tmp_dir/processor.stdout.json"
grep -q '"rootStatus": "error"' "$tmp_dir/processor.stdout.json"
grep -q '"summaryName": "opentelemetry.trace:GET /checkout"' "$tmp_dir/processor.stdout.json"
grep -q '"summaryStatus": "error"' "$tmp_dir/processor.stdout.json"
grep -q '"summarySpanCount": 2' "$tmp_dir/processor.stdout.json"
grep -q '"summaryErrorSpanCount": 1' "$tmp_dir/processor.stdout.json"
grep -q '"dependencyLinkCount": 1' "$tmp_dir/processor.stdout.json"
grep -q '"dependencyLinkTraceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$tmp_dir/processor.stdout.json"
grep -q '"dependencyLinkOperation": "receive"' "$tmp_dir/processor.stdout.json"
grep -q '"service": "checkout-api"' "$tmp_dir/processor.stdout.json"
grep -q '"environment": "production"' "$tmp_dir/processor.stdout.json"
grep -q '"route": "/checkout"' "$tmp_dir/processor.stdout.json"
grep -q '"dependencySystem": "redis"' "$tmp_dir/processor.stdout.json"
grep -q '"ok": true' "$tmp_dir/exporter.stdout.json"
grep -q '"events": 3' "$tmp_dir/exporter.stdout.json"
grep -q '"emptyExportResult": "SUCCESS"' "$tmp_dir/exporter.stdout.json"
grep -q '"rootStatus": "error"' "$tmp_dir/exporter.stdout.json"
grep -q '"summaryName": "opentelemetry.trace:GET /checkout/exporter"' "$tmp_dir/exporter.stdout.json"
grep -q '"summaryStatus": "error"' "$tmp_dir/exporter.stdout.json"
grep -q '"summarySpanCount": 2' "$tmp_dir/exporter.stdout.json"
grep -q '"summaryErrorSpanCount": 1' "$tmp_dir/exporter.stdout.json"
grep -q '"dependencyLinkCount": 1' "$tmp_dir/exporter.stdout.json"
grep -q '"dependencyLinkTraceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$tmp_dir/exporter.stdout.json"
grep -q '"dependencyLinkOperation": "receive"' "$tmp_dir/exporter.stdout.json"
grep -q '"service": "checkout-api"' "$tmp_dir/exporter.stdout.json"
grep -q '"environment": "production"' "$tmp_dir/exporter.stdout.json"
grep -q '"route": "/checkout/exporter"' "$tmp_dir/exporter.stdout.json"
grep -q '"dependencySystem": "postgresql"' "$tmp_dir/exporter.stdout.json"

echo "Python OpenTelemetry installed-artifact smoke passed"
