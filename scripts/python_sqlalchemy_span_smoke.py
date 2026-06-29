from __future__ import annotations

import json

from sqlalchemy import create_engine, text

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    get_active_logbrew_trace,
    instrument_sqlalchemy_engine_with_logbrew_spans,
    use_logbrew_trace,
)


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-sqlalchemy",
    sdk_version="0.1.0",
)
engine = create_engine("sqlite:///:memory:")
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
event_ids = iter(
    [
        "evt_python_sqlalchemy_create",
        "evt_python_sqlalchemy_insert",
        "evt_python_sqlalchemy_select",
        "evt_python_sqlalchemy_error",
    ]
)
span_ids = iter(
    [
        "b7ad6b7169203371",
        "b7ad6b7169203372",
        "b7ad6b7169203373",
        "b7ad6b7169203374",
    ]
)
clock_values = iter([200.0, 200.004, 210.0, 210.006, 220.0, 220.008, 230.0, 230.005])
captured: dict[str, object] = {}

with use_logbrew_trace(parent_trace):
    instrumentation = instrument_sqlalchemy_engine_with_logbrew_spans(
        engine,
        client=client,
        event_id_factory=lambda: next(event_ids),
        timestamp="2026-06-29T08:00:00Z",
        db_name="checkout",
        span_id_factory=lambda: next(span_ids),
        clock=lambda: next(clock_values),
        metadata={"service": "checkout", "queryParams": {"email": "private@example.test"}},
    )
    duplicate = instrument_sqlalchemy_engine_with_logbrew_spans(engine, client=client)

    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE users (id integer primary key, email text)"))
        connection.execute(text("INSERT INTO users (email) VALUES (:email)"), {"email": "private@example.test"})
        rows = connection.execute(
            text("SELECT id, email FROM users WHERE email = :email"),
            {"email": "private@example.test"},
        ).fetchall()
        active = get_active_logbrew_trace()
        captured["activeAfterQuery"] = active.span_id if active is not None else None

    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT * FROM missing_users WHERE email = :email"), {"email": "private@example.test"})
    except Exception as error:
        captured["errorType"] = type(error).__name__

    captured["parentSpanAfterQueries"] = get_active_logbrew_trace().span_id
    captured["duplicateSame"] = duplicate is instrumentation

instrumentation.uninstall()
with engine.connect() as connection:
    connection.execute(text("SELECT 1")).fetchall()

serialized = client.preview_json()
for forbidden in (
    "private@example.test",
    "queryParams",
    "SELECT id, email",
    "missing_users",
    "sqlite://",
):
    if forbidden in serialized:
        raise SystemExit(f"SQLAlchemy span leaked private data: {forbidden}")

payload = json.loads(serialized)
metadata = [event["attributes"]["metadata"] for event in payload["events"]]
names = [event["attributes"]["name"] for event in payload["events"]]
statuses = [event["attributes"]["status"] for event in payload["events"]]

print(
    json.dumps(
        {
            "activeAfterQuery": captured["activeAfterQuery"],
            "dbName": metadata[0]["dbName"],
            "dbSystem": metadata[0]["dbSystem"],
            "duplicateSame": captured["duplicateSame"],
            "errorStatus": statuses[-1],
            "errorType": metadata[-1]["errorType"],
            "events": len(payload["events"]),
            "framework": metadata[0]["framework"],
            "ok": True,
            "operations": [item["dbOperation"] for item in metadata],
            "queryRows": len(rows),
            "parentSpanAfterQueries": captured["parentSpanAfterQueries"],
            "spanNames": names,
        },
        sort_keys=True,
    )
)
