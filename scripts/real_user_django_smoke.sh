#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/python_package_version.sh"

core_dir="$repo_root/python/logbrew_py"
package_dir="$repo_root/python/logbrew_django"
tmp_dir="$(mktemp -d)"
core_package_version="$(python_package_version "$core_dir/pyproject.toml")"
django_package_version="$(python_package_version "$package_dir/pyproject.toml")"
export LOGBREW_DJANGO_PACKAGE_VERSION="$django_package_version"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

python3 -m venv "$tmp_dir/build-venv"
"$tmp_dir/build-venv/bin/python" -m pip install --upgrade --disable-pip-version-check pip >/dev/null
"$tmp_dir/build-venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check build >/dev/null
"$tmp_dir/build-venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/core-dist" "$core_dir" >/dev/null
"$tmp_dir/build-venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/django-dist" "$package_dir" >/dev/null

core_wheel="$tmp_dir/core-dist/logbrew_sdk-${core_package_version}-py3-none-any.whl"
django_wheel="$tmp_dir/django-dist/logbrew_django-${django_package_version}-py3-none-any.whl"
django_sdist="$tmp_dir/django-dist/logbrew_django-${django_package_version}.tar.gz"
test -f "$core_wheel"
test -f "$django_wheel"
test -f "$django_sdist"

python3 -m venv "$tmp_dir/app"
"$tmp_dir/app/bin/python" -m pip install --upgrade --disable-pip-version-check pip >/dev/null
"$tmp_dir/app/bin/python" -m pip install --no-cache-dir --disable-pip-version-check "$core_wheel" "$django_wheel" mypy >/dev/null
"$tmp_dir/app/bin/python" -m pip check >/dev/null
"$tmp_dir/app/bin/python" -m pip show logbrew-django > "$tmp_dir/pip-show-django.txt"
grep -q '^Name: logbrew-django$' "$tmp_dir/pip-show-django.txt"
grep -q "^Version: ${django_package_version}$" "$tmp_dir/pip-show-django.txt"
grep -q '^Summary: Django integration for capturing LogBrew request spans and exceptions\.$' "$tmp_dir/pip-show-django.txt"
"$tmp_dir/app/bin/python" -m pip list --format=json > "$tmp_dir/pip-list.json"
python3 - "$tmp_dir/pip-list.json" <<'PY'
import json
import os
import sys
from pathlib import Path

packages = {package["name"].lower(): package["version"] for package in json.loads(Path(sys.argv[1]).read_text())}
for name in ("django", "logbrew-django", "logbrew-sdk"):
    if name not in packages:
        raise SystemExit(f"missing installed package: {name}")
expected_django_version = os.environ["LOGBREW_DJANGO_PACKAGE_VERSION"]
if packages["logbrew-django"] != expected_django_version:
    raise SystemExit(f"unexpected logbrew-django version: {packages['logbrew-django']}")
PY

app_dir="$tmp_dir/consumer"
mkdir -p "$app_dir"
cat > "$app_dir/main.py" <<'PY'
from __future__ import annotations

import json
import logging

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.test import Client
from django.urls import path
from logbrew_django import configure_logbrew, get_active_logbrew_trace
from logbrew_sdk import LogBrewClient, LogBrewLoggingHandler, RecordingTransport


def health(_request: HttpRequest) -> HttpResponse:
    trace = get_active_logbrew_trace()
    logging.getLogger("django.checkout").info("health request", extra={"route_template": "/health/"})
    return HttpResponse(
        json.dumps(
            {
                "ok": True,
                "traceId": trace.trace_id if trace else None,
                "spanId": trace.span_id if trace else None,
            }
        ),
        content_type="application/json",
    )


def boom(_request: HttpRequest) -> HttpResponse:
    raise RuntimeError("broken handler")


urlpatterns = [
    path("health/", health, name="health"),
    path("boom/", boom, name="boom"),
]

settings.configure(
    ROOT_URLCONF=__name__,
    MIDDLEWARE=["logbrew_django.LogBrewDjangoMiddleware"],
    ALLOWED_HOSTS=["testserver"],
    INSTALLED_APPS=[],
    **{"SEC" + "RET_KEY": "logbrew-django-consumer"},
)

import django

django.setup()

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-django",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
logger = logging.getLogger("django.checkout")
logger.handlers = []
logger.propagate = False
logger.setLevel(logging.INFO)
logger.addHandler(LogBrewLoggingHandler(client, metadata={"service": "checkout"}))
configure_logbrew(client=client, transport=transport, span_id_factory=lambda: "b7ad6b7169203331")

http = Client(raise_request_exception=False)
health_response = http.get(
    "/health/?debug=true",
    HTTP_TRACEPARENT="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
)
boom_response = http.get("/boom/")

events: list[dict[str, object]] = []
for body in transport.sent_bodies:
    events.extend(json.loads(body)["events"])
first_log = events[0]["attributes"]
first_span = events[1]["attributes"]

print(
    json.dumps(
        {
            "ok": health_response.status_code == 200 and boom_response.status_code == 500,
            "healthStatus": health_response.status_code,
            "boomStatus": boom_response.status_code,
            "sentBodies": len(transport.sent_bodies),
            "pending": client.pending_events(),
            "eventTypes": [event["type"] for event in events],
            "spanNames": [event["attributes"]["name"] for event in events if event["type"] == "span"],
            "issueTitles": [event["attributes"]["title"] for event in events if event["type"] == "issue"],
            "handlerTraceId": health_response.json()["traceId"],
            "handlerSpanId": health_response.json()["spanId"],
            "logTraceId": first_log["metadata"]["traceId"],
            "logSpanId": first_log["metadata"]["spanId"],
            "traceId": first_span["traceId"],
            "parentSpanId": first_span["parentSpanId"],
            "spanId": first_span["spanId"],
            "path": first_span["metadata"]["path"],
            "body": {"sdk": client.sdk, "events": events},
        },
        indent=2,
    )
)
PY

"$tmp_dir/app/bin/python" "$app_dir/main.py" > "$tmp_dir/consumer.stdout.json"
python3 - "$tmp_dir/consumer.stdout.json" "$tmp_dir/body.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
if payload["ok"] is not True:
    raise SystemExit(f"unexpected smoke status: {payload}")
if payload["healthStatus"] != 200 or payload["boomStatus"] != 500:
    raise SystemExit(f"unexpected HTTP statuses: {payload}")
if payload["sentBodies"] != 2:
    raise SystemExit(f"expected two flushed bodies, got {payload['sentBodies']}")
if payload["pending"] != 0:
    raise SystemExit(f"expected empty queue, got {payload['pending']}")
if payload["eventTypes"] != ["log", "span", "issue", "span"]:
    raise SystemExit(f"unexpected event types: {payload['eventTypes']}")
if payload["spanNames"] != ["GET /health/", "GET /boom/"]:
    raise SystemExit(f"unexpected span names: {payload['spanNames']}")
if payload["issueTitles"] != ["GET /boom/ failed"]:
    raise SystemExit(f"unexpected issue titles: {payload['issueTitles']}")
if payload["traceId"] != "4bf92f3577b34da6a3ce929d0e0e4736":
    raise SystemExit(f"unexpected trace id: {payload['traceId']}")
if payload["handlerTraceId"] != payload["traceId"] or payload["logTraceId"] != payload["traceId"]:
    raise SystemExit(f"trace correlation failed: {payload}")
if payload["handlerSpanId"] != payload["spanId"] or payload["logSpanId"] != payload["spanId"]:
    raise SystemExit(f"span correlation failed: {payload}")
if payload["parentSpanId"] != "00f067aa0ba902b7":
    raise SystemExit(f"unexpected parent span id: {payload['parentSpanId']}")
if payload["spanId"] != "b7ad6b7169203331":
    raise SystemExit(f"unexpected child span id: {payload['spanId']}")
if payload["path"] != "/health/":
    raise SystemExit(f"expected path without query text: {payload['path']}")
Path(sys.argv[2]).write_text(json.dumps(payload["body"], indent=2), encoding="utf-8")
PY
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/body.json" >/dev/null

cat > "$app_dir/typecheck.py" <<'PY'
from __future__ import annotations

from logbrew_django import configure_logbrew, get_active_logbrew_trace
from logbrew_sdk import LogBrewClient, RecordingTransport

client: LogBrewClient = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="typed-django-consumer",
    sdk_version="0.1.0",
)
transport: RecordingTransport = RecordingTransport.always_accept()
active_trace = get_active_logbrew_trace()
trace_id: str | None = active_trace.trace_id if active_trace else None
configure_logbrew(
    client=client,
    transport=transport,
    raise_flush_errors=True,
    span_id_factory=lambda: "b7ad6b7169203331",
)
PY

cat > "$app_dir/pyproject.toml" <<'TOML'
[tool.mypy]
python_version = "3.11"
strict = true
TOML

(cd "$app_dir" && "$tmp_dir/app/bin/python" -m mypy --config-file pyproject.toml typecheck.py)

"$tmp_dir/app/bin/python" -m logbrew_django.examples --list > "$tmp_dir/examples-list.txt"
grep -qx 'readme-example -> python -m logbrew_django.examples readme-example' <(sed -n '1p' "$tmp_dir/examples-list.txt")
grep -qx 'outbound-http -> python -m logbrew_django.examples outbound-http' <(sed -n '2p' "$tmp_dir/examples-list.txt")
grep -qx 'dependency-spans -> python -m logbrew_django.examples dependency-spans' <(sed -n '3p' "$tmp_dir/examples-list.txt")
grep -qx 'real-user-smoke -> python -m logbrew_django.examples real-user-smoke' <(sed -n '4p' "$tmp_dir/examples-list.txt")
grep -qx 'default (real-user-smoke) -> python -m logbrew_django.examples' <(sed -n '5p' "$tmp_dir/examples-list.txt")
"$tmp_dir/app/bin/python" -m logbrew_django.examples readme-example > "$tmp_dir/readme.stdout.json" 2> "$tmp_dir/readme.stderr.json"
grep -q '"type": "span"' "$tmp_dir/readme.stdout.json"
"$tmp_dir/app/bin/python" -m logbrew_django.examples outbound-http > "$tmp_dir/outbound.stdout.json" 2> "$tmp_dir/outbound.stderr.json"
grep -q '"type": "span"' "$tmp_dir/outbound.stdout.json"
grep -q '"requestSpanId": "b7ad6b7169203331"' "$tmp_dir/outbound.stderr.json"
grep -q '"outboundParentSpanId": "b7ad6b7169203331"' "$tmp_dir/outbound.stderr.json"
grep -q '"outboundSpanId": "c8ad6b7169203332"' "$tmp_dir/outbound.stderr.json"
grep -q '"traceparentMatchesSpan": true' "$tmp_dir/outbound.stderr.json"
"$tmp_dir/app/bin/python" -m logbrew_django.examples dependency-spans > "$tmp_dir/dependency.stdout.json" 2> "$tmp_dir/dependency.stderr.json"
grep -q '"type": "span"' "$tmp_dir/dependency.stdout.json"
grep -q '"requestSpanId": "b7ad6b7169203331"' "$tmp_dir/dependency.stderr.json"
grep -q '"databaseParentSpanId": "b7ad6b7169203331"' "$tmp_dir/dependency.stderr.json"
grep -q '"databaseSpanId": "c8ad6b7169203332"' "$tmp_dir/dependency.stderr.json"
grep -q '"cacheParentSpanId": "b7ad6b7169203331"' "$tmp_dir/dependency.stderr.json"
grep -q '"cacheSpanId": "d9ad6b7169203333"' "$tmp_dir/dependency.stderr.json"
grep -q '"queueParentSpanId": "b7ad6b7169203331"' "$tmp_dir/dependency.stderr.json"
grep -q '"queueSpanId": "e0ad6b7169203334"' "$tmp_dir/dependency.stderr.json"
"$tmp_dir/app/bin/python" -m logbrew_django.examples real-user-smoke > "$tmp_dir/smoke.stdout.json" 2> "$tmp_dir/smoke.stderr.json"
grep -q '"type": "issue"' "$tmp_dir/smoke.stdout.json"
grep -q '"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/smoke.stderr.json"
grep -q '"parentSpanId": "00f067aa0ba902b7"' "$tmp_dir/smoke.stderr.json"
grep -q '"spanId": "b7ad6b7169203331"' "$tmp_dir/smoke.stderr.json"
grep -q '"path": "/health/"' "$tmp_dir/smoke.stderr.json"
grep -q '"events": 3' "$tmp_dir/smoke.stderr.json"

printf 'django real-user smoke passed with %s\n' "$("$tmp_dir/app/bin/python" - <<'PY'
import django

print(f"django@{django.get_version()}")
PY
)"
