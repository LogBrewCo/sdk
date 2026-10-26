# Copyright (c) 2026 LogBrew
"""Shared configuration and recorded output for the installed Flask examples."""

from __future__ import annotations

import json
import sys
from typing import TYPE_CHECKING, cast

from flask import Flask
from logbrew_sdk import RecordingTransport

from logbrew_flask import init_logbrew

if TYPE_CHECKING:
    from typing import Any

    from logbrew_sdk import LogBrewClient, SpanAttributes


def example_app(name: str) -> tuple[Flask, LogBrewClient, RecordingTransport]:
    """Configure the example with the installed integration and no network IO.

    Returns:
        The Flask app, initialized client, and local recording transport.

    """
    app = Flask(name)
    transport = RecordingTransport.always_accept()
    config = init_logbrew(
        app,
        api_key="LOGBREW_API_KEY",
        transport=transport,
        flush_on_response=True,
        span_id_factory=lambda: "b7ad6b7169203331",
    )
    return app, config.client, transport


def recorded_events(transport: RecordingTransport) -> list[dict[str, Any]]:
    """Combine the batches emitted by one installed example.

    Returns:
        Recorded SDK events in their original batch order.

    """
    return [
        event for body in transport.sent_bodies for event in cast("list[dict[str, Any]]", json.loads(body)["events"])
    ]


def write_result(client: LogBrewClient, events: list[dict[str, Any]], summary: dict[str, object]) -> None:
    """Write recorded events to stdout and the request summary to stderr."""
    for value, stream in (({"sdk": client.sdk, "events": events}, sys.stdout), (summary, sys.stderr)):
        json.dump(value, stream, indent=2)
        stream.write("\n")


def named_spans(events: list[dict[str, Any]]) -> dict[str, SpanAttributes]:
    """Index this example's validated SDK spans by operation name.

    Returns:
        Captured spans using the core SDK's declared attribute contract.

    """
    spans = (cast("SpanAttributes", event["attributes"]) for event in events if event["type"] == "span")
    return {span["name"]: span for span in spans}
