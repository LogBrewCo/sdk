from __future__ import annotations

import json
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient
from logbrew_fastapi import init_logbrew
from logbrew_sdk import RecordingTransport

transport = RecordingTransport.always_accept()
app = FastAPI()
init_logbrew(
    app,
    api_key="LOGBREW_API_KEY",
    transport=transport,
    automatic_delivery=False,
)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


with TestClient(app) as http:
    response = http.get("/health")
    print(json.dumps({"ok": response.status_code == 200, "status": response.status_code}), file=sys.stderr)

print(transport.sent_bodies[-1])
