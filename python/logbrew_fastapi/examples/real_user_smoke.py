from __future__ import annotations

import json
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient
from logbrew_fastapi import init_logbrew
from logbrew_sdk import RecordingTransport

transport = RecordingTransport.always_accept()
app = FastAPI()
runtime = init_logbrew(
    app,
    api_key="LOGBREW_API_KEY",
    transport=transport,
    automatic_delivery=False,
    span_id_factory=lambda: "b7ad6b7169203331",
)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/boom")
def boom() -> dict[str, bool]:
    raise RuntimeError("broken handler")


with TestClient(app, raise_server_exceptions=False) as http:
    health_response = http.get(
        "/health?debug=true",
        headers={"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"},
    )
    boom_response = http.get("/boom")

events = []
for body in transport.sent_bodies:
    events.extend(json.loads(body)["events"])
first_span = events[0]["attributes"]

print(json.dumps({"sdk": runtime.client.sdk, "events": events}, indent=2))
print(
    json.dumps(
        {
            "ok": health_response.status_code == 200 and boom_response.status_code == 500,
            "requests": 2,
            "sentBodies": len(transport.sent_bodies),
            "events": len(events),
            "pending": runtime.client.pending_events(),
            "traceId": first_span["traceId"],
            "parentSpanId": first_span["parentSpanId"],
            "spanId": first_span["spanId"],
            "path": first_span["metadata"]["path"],
        }
    ),
    file=sys.stderr,
)
