from __future__ import annotations

import json
import sys

from fastapi import FastAPI
from fastapi.testclient import TestClient
from logbrew_sdk import LogBrewClient, RecordingTransport

from logbrew_fastapi import add_logbrew_middleware

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-fastapi",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
app = FastAPI()
add_logbrew_middleware(app, client=client, transport=transport)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


with TestClient(app) as http:
    response = http.get("/health")
    print(json.dumps({"ok": response.status_code == 200, "status": response.status_code}), file=sys.stderr)

print(transport.sent_bodies[-1])
