from __future__ import annotations

import json
import sqlite3

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    instrument_dbapi_connection_with_logbrew_spans,
    use_logbrew_trace,
)


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-dbapi",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
raw_connection = sqlite3.connect(":memory:")
raw_connection.execute("CREATE TABLE checkout_order (id INTEGER PRIMARY KEY, email TEXT, status TEXT)")
raw_connection.execute(
    "INSERT INTO checkout_order (email, status) VALUES (?, ?)",
    ("sensitive@example.test", "pending"),
)
raw_connection.commit()

event_ids = iter(
    [
        "evt_python_dbapi_update",
        "evt_python_dbapi_commit",
        "evt_python_dbapi_select",
        "evt_python_dbapi_rollback",
        "evt_python_dbapi_error",
    ]
)
span_ids = iter(
    [
        "b7ad6b7169203391",
        "b7ad6b7169203392",
        "b7ad6b7169203393",
        "b7ad6b7169203394",
        "b7ad6b7169203395",
    ]
)
clock_values = iter([10.0, 10.005, 20.0, 20.003, 30.0, 30.004, 40.0, 40.002, 50.0, 50.002])

connection = instrument_dbapi_connection_with_logbrew_spans(
    raw_connection,
    client=client,
    system="sqlite",
    db_name="checkout",
    event_id_factory=lambda: next(event_ids),
    timestamp="2026-06-29T20:00:00Z",
    span_id_factory=lambda: next(span_ids),
    clock=lambda: next(clock_values),
    metadata={
        "service": "checkout",
        "statement": "SELECT * FROM checkout_order WHERE email = ?",
        "parameters": "sensitive@example.test",
    },
)

with use_logbrew_trace(parent_trace):
    update_cursor = connection.cursor()
    update_result = update_cursor.execute(
        "UPDATE checkout_order SET status = ? WHERE id = ?",
        ("paid", 1),
    )
    connection.commit()
    select_cursor = connection.execute(
        "SELECT id, status FROM checkout_order WHERE email = ?",
        ("sensitive@example.test",),
    )
    selected_rows = select_cursor.fetchall()
    connection.rollback()
    try:
        connection.cursor().execute(
            "SELECT * FROM missing_checkout WHERE email = ?",
            ("sensitive@example.test",),
        )
    except sqlite3.OperationalError:
        pass

raw_after_uninstall = connection.uninstall()
connection.cursor().execute(
    "UPDATE checkout_order SET status = ? WHERE id = ?",
    ("settled", 1),
)

if raw_after_uninstall is not raw_connection:
    raise SystemExit("DB-API uninstall did not return the original connection")
if update_result is not update_cursor:
    raise SystemExit("DB-API execute did not preserve cursor chaining")
if selected_rows != [(1, "paid")]:
    raise SystemExit(f"unexpected DB-API selected rows: {selected_rows!r}")

serialized = client.preview_json()
for forbidden in (
    "checkout_order",
    "missing_checkout",
    "sensitive@example.test",
    '"parameters"',
    '"statement"',
):
    if forbidden in serialized:
        raise SystemExit(f"DB-API span leaked private data: {forbidden}")

payload = json.loads(serialized)
if len(payload["events"]) != 5:
    raise SystemExit(f"expected five DB-API spans, got {len(payload['events'])}")

update_attributes = payload["events"][0]["attributes"]
commit_attributes = payload["events"][1]["attributes"]
select_attributes = payload["events"][2]["attributes"]
rollback_attributes = payload["events"][3]["attributes"]
error_attributes = payload["events"][4]["attributes"]
update_metadata = update_attributes["metadata"]
commit_metadata = commit_attributes["metadata"]
select_metadata = select_attributes["metadata"]
rollback_metadata = rollback_attributes["metadata"]
error_metadata = error_attributes["metadata"]

if update_attributes["name"] != "sqlite UPDATE":
    raise SystemExit(f"unexpected DB-API update span name: {update_attributes['name']!r}")
if commit_attributes["name"] != "sqlite COMMIT":
    raise SystemExit(f"unexpected DB-API commit span name: {commit_attributes['name']!r}")
if select_attributes["name"] != "sqlite SELECT":
    raise SystemExit(f"unexpected DB-API select span name: {select_attributes['name']!r}")
if rollback_attributes["name"] != "sqlite ROLLBACK":
    raise SystemExit(f"unexpected DB-API rollback span name: {rollback_attributes['name']!r}")
if error_attributes["name"] != "sqlite SELECT":
    raise SystemExit(f"unexpected DB-API error span name: {error_attributes['name']!r}")
if error_attributes["status"] != "error":
    raise SystemExit(f"unexpected DB-API error status: {error_attributes['status']!r}")
if error_metadata.get("errorType") != "OperationalError":
    raise SystemExit(f"unexpected DB-API error type: {error_metadata.get('errorType')!r}")

print(
    json.dumps(
        {
            "commitMethod": commit_metadata["dbMethod"],
            "dbMethod": update_metadata["dbMethod"],
            "dbSystem": update_metadata["dbSystem"],
            "errorStatus": error_attributes["status"],
            "errorType": error_metadata["errorType"],
            "events": len(payload["events"]),
            "framework": update_metadata["framework"],
            "ok": True,
            "parentSpanAfterDbapi": update_attributes["parentSpanId"],
            "rollbackMethod": rollback_metadata["dbMethod"],
            "selectMethod": select_metadata["dbMethod"],
            "selectRows": len(selected_rows),
            "spanId": update_attributes["spanId"],
            "updateRowCount": update_metadata["rowCount"],
        },
        sort_keys=True,
    )
)
