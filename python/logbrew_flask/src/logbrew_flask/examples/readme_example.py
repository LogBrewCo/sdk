# Copyright (c) 2026 LogBrew
"""Capture a healthy request with an app-owned recording transport."""

from __future__ import annotations

from logbrew_flask.examples._support import example_app, recorded_events, write_result

app, client, transport = example_app(__name__)


@app.get("/health")
def health() -> dict[str, bool]:
    """Return the application's health response.

    Returns:
        A successful health result.

    """
    return {"ok": True}


response = app.test_client().get("/health")
write_result(client, recorded_events(transport), {"status": response.status_code, "events": client.pending_events()})
