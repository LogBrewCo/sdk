# Copyright (c) 2026 LogBrew contributors
"""Exercise installed Python packages and return observations to the native checker."""

import json
import sqlite3
import sys
from importlib import metadata

import rq
from fastapi import FastAPI
from flask import Flask, Response, request
from logbrew_django import configure_logbrew
from logbrew_fastapi import add_logbrew_middleware as add_fastapi_middleware
from logbrew_flask import add_logbrew_middleware as add_flask_middleware
from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    RecordingTransport,
    connect_dbapi_connection_with_logbrew_spans,
    create_logbrew_open_telemetry_span_exporter,
    span_attributes_from_trace_context,
)

versions = {
    name: metadata.version(name)
    for name in ("logbrew-sdk", "logbrew-fastapi", "logbrew-flask", "logbrew-django")
}
versions["rq"] = rq.__version__
arq_enabled, dramatiq_enabled, celery_enabled = sys.argv[1:]
if arq_enabled == "1":
    import arq

    versions["arq"] = arq.__version__
if celery_enabled == "1":
    import celery

    versions["celery"] = celery.__version__

client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="python-public-pypi-smoke",
    sdk_version=versions["logbrew-sdk"],
    max_retries=1,
)
if dramatiq_enabled == "1":
    import dramatiq
    from dramatiq.brokers.stub import StubBroker
    from logbrew_sdk import instrument_dramatiq_broker_with_logbrew_spans

    versions["dramatiq"] = dramatiq.__version__
    instrumentation = instrument_dramatiq_broker_with_logbrew_spans(
        StubBroker(),
        client=client,
    )
    instrumentation.uninstall()

client.log(
    "evt_public_pypi_smoke",
    "2026-07-01T00:00:00Z",
    {"message": "public PyPI smoke", "level": "info"},
)
trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
client.span(
    "evt_public_pypi_trace_context",
    "2026-07-01T00:00:01Z",
    span_attributes_from_trace_context(
        trace,
        name="public-pypi.trace-context",
        status="ok",
        duration_ms=2.5,
        metadata={"source": "public-pypi-smoke"},
    ),
)
client.span(
    "evt_public_pypi_span_links",
    "2026-07-01T00:00:02Z",
    {
        "name": "public-pypi.span-links",
        "traceId": trace.trace_id,
        "spanId": "b7ad6b7169203331",
        "status": "ok",
        "links": [
            {
                "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "spanId": "bbbbbbbbbbbbbbbb",
                "sampled": True,
                "metadata": {
                    "relation": "fan_in",
                    "payload": {"email": "blocked@example.test"},
                },
            },
        ],
    },
)

connection = connect_dbapi_connection_with_logbrew_spans(
    sqlite3.connect,
    client=client,
    system="sqlite",
    connect_args=(":memory:",),
    trace_fetch_methods=True,
    timestamp="2026-07-01T00:00:03Z",
    trace=trace,
    db_name="public-smoke",
    metadata={"connection": "blocked", "safe": "public-pypi"},
)
cursor = connection.cursor()
cursor.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT)")
cursor.execute("INSERT INTO events (name) VALUES (?)", ("checkout",))
connection.commit()
cursor.execute("SELECT name FROM events")
rows = cursor.fetchall()
connection.close()

exporter = create_logbrew_open_telemetry_span_exporter(client=client)
export_result = exporter.export([])
exporter.shutdown()
transport = RecordingTransport()
response = client.flush(transport)
pending_after_flush = client.pending_events()

app = FastAPI()
add_fastapi_middleware(app, client=client, transport=RecordingTransport())
flask_client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="python-public-flask-smoke",
    sdk_version=versions["logbrew-flask"],
    max_retries=1,
)
flask_transport = RecordingTransport()
flask_app = Flask(__name__)
flask_order_calls: list[int] = []


@flask_app.before_request
def flask_reject_request() -> Response | None:
    """Return a handled rejection before the application view executes.

    Returns
    -------
    Response | None
        A forbidden response for the selected request, otherwise continue.

    """
    return (
        Response(status=403) if request.headers.get("X-Smoke-Reject") == "1" else None
    )


add_flask_middleware(
    flask_app,
    client=flask_client,
    transport=flask_transport,
    capture_request_metrics=True,
    span_id_factory=lambda: "b7ad6b7169203331",
)


@flask_app.get("/orders/<int:order_id>")
def flask_order(order_id: int) -> dict[str, int]:
    """Return the order ID from the request.

    Returns
    -------
    dict[str, int]
        The requested order ID.

    """
    flask_order_calls.append(order_id)
    return {"orderId": order_id}


@flask_app.get("/failure")
def flask_failure() -> None:
    """Exercise an unhandled request failure for the native evidence checker.

    Raises
    ------
    RuntimeError
        Always, to exercise failure capture.

    """
    message = "private-error-marker"
    raise RuntimeError(message)


flask_response = flask_app.test_client().get("/orders/42?proof_marker=excluded")
flask_blocked_response = flask_app.test_client().get(
    "/orders/42?proof_marker=excluded", headers={"X-Smoke-Reject": "1"}
)
flask_error_response = flask_app.test_client().get("/failure")
flask_client.shutdown(flask_transport)
django_config = configure_logbrew(client=client, transport=RecordingTransport())
client.log(
    "evt_public_pypi_shutdown",
    "2026-07-01T00:00:04Z",
    {"message": "shutdown delivery", "level": "info"},
)
shutdown_transport = RecordingTransport()
shutdown_response = client.shutdown(shutdown_transport)
sys.stdout.write(
    json.dumps(
        {
            "optimized": not __debug__,
            "versions": versions,
            "requirements": {
                name: metadata.requires(name) or []
                for name in ("logbrew-sdk", "logbrew-fastapi")
            },
            "flush_status": response.status_code,
            "flush_attempts": response.attempts,
            "recorded_bodies": len(transport.sent_bodies),
            "pending_events": pending_after_flush,
            "shutdown_status": shutdown_response.status_code,
            "shutdown_attempts": shutdown_response.attempts,
            "shutdown_accepted_events": shutdown_response.accepted_events,
            "shutdown_recorded_bodies": len(shutdown_transport.sent_bodies),
            "shutdown_closed": client.closed,
            "body": transport.sent_bodies[0] if transport.sent_bodies else "",
            "db_rows": rows,
            "otel_exporter_result": getattr(export_result, "name", str(export_result)),
            "fastapi_middleware_count": len(app.user_middleware),
            "flask_status": flask_response.status_code,
            "flask_error_status": flask_error_response.status_code,
            "flask_blocked_status": flask_blocked_response.status_code,
            "flask_order_calls": flask_order_calls,
            "flask_closed": flask_client.closed,
            "flask_pending_events": flask_client.pending_events(),
            "flask_response": flask_response.get_json(),
            "flask_recorded_bodies": len(flask_transport.sent_bodies),
            "flask_body": flask_transport.sent_bodies[0]
            if flask_transport.sent_bodies
            else "",
            "flask_error_body": flask_transport.sent_bodies[-1]
            if flask_transport.sent_bodies
            else "",
            "flask_blocked_body": flask_transport.sent_bodies[1]
            if len(flask_transport.sent_bodies) > 1
            else "",
            "django_config_type": type(django_config).__name__,
        },
        sort_keys=True,
    )
    + "\n",
)
