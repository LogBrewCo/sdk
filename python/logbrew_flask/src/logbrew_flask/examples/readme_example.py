from __future__ import annotations

import json
import sys

from flask import Flask
from logbrew_sdk import RecordingTransport

from logbrew_flask import init_logbrew

transport = RecordingTransport.always_accept()
app = Flask(__name__)
config = init_logbrew(
    app,
    api_key="LOGBREW_API_KEY",
    transport=transport,
    flush_on_response=True,
)
client = config.client


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


response = app.test_client().get("/health")
print(json.dumps({"status": response.status_code, "events": client.pending_events()}), file=sys.stderr)
print(transport.sent_bodies[-1])
