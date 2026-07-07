from __future__ import annotations

import json
import logging
import sys
from typing import Any, cast

from flask import Flask
from logbrew_sdk import LogBrewClient, LogBrewLoggingHandler, RecordingTransport

from logbrew_flask import add_logbrew_middleware, get_active_logbrew_trace

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-flask",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
logger = logging.getLogger("flask.checkout.example")
logger.handlers = []
logger.propagate = False
logger.setLevel(logging.INFO)
logger.addHandler(LogBrewLoggingHandler(client, metadata={"service": "checkout"}))
app = Flask(__name__)
add_logbrew_middleware(app, client=client, transport=transport, span_id_factory=lambda: "b7ad6b7169203331")


@app.get("/health")
def health() -> dict[str, object]:
    trace = get_active_logbrew_trace()
    logger.info("health request", extra={"route_template": "/health"})
    return {
        "ok": True,
        "traceId": trace.trace_id if trace else None,
        "spanId": trace.span_id if trace else None,
    }


@app.get("/boom")
def boom() -> dict[str, bool]:
    raise RuntimeError("broken handler")


http = app.test_client()
health_response = http.get(
    "/health?debug=true",
    headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
)
boom_response = http.get("/boom")

events: list[dict[str, Any]] = []
for body in transport.sent_bodies:
    payload = cast(dict[str, Any], json.loads(body))
    events.extend(cast(list[dict[str, Any]], payload["events"]))
health_payload = cast(dict[str, Any], health_response.get_json())
first_span_attributes = cast(dict[str, Any], events[1]["attributes"])
first_span_metadata = cast(dict[str, Any], first_span_attributes["metadata"])

print(json.dumps({"sdk": client.sdk, "events": events}, indent=2))
print(
    json.dumps(
        {
            "healthStatus": health_response.status_code,
            "boomStatus": boom_response.status_code,
            "events": len(events),
            "traceId": health_payload["traceId"],
            "spanId": health_payload["spanId"],
            "parentSpanId": first_span_attributes["parentSpanId"],
            "path": first_span_metadata["path"],
        },
        indent=2,
    ),
    file=sys.stderr,
)
