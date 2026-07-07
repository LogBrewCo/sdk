from __future__ import annotations

import json
import sys

from flask import Flask
from logbrew_sdk import LogBrewClient, RecordingTransport

from logbrew_flask import add_logbrew_middleware

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="logbrew-flask",
    sdk_version="0.1.0",
)
transport = RecordingTransport.always_accept()
app = Flask(__name__)
add_logbrew_middleware(app, client=client, transport=transport)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


response = app.test_client().get("/health")
print(json.dumps({"status": response.status_code, "events": client.pending_events()}), file=sys.stderr)
print(transport.sent_bodies[-1])
