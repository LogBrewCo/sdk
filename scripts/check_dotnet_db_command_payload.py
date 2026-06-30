#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path


TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "b7ad6b7169203331"
HEX_16 = re.compile(r"^[0-9a-f]{16}$")


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def event_by_name(events, name):
    for event in events:
        if event.get("attributes", {}).get("name") == name:
            return event
    raise SystemExit(f"missing span {name}")


def metadata(event):
    value = event.get("attributes", {}).get("metadata", {})
    require(isinstance(value, dict), f"metadata is not an object for {event.get('id')}")
    return value


def assert_command_span(event, operation, operation_kind):
    attrs = event.get("attributes", {})
    meta = metadata(event)
    require(attrs.get("traceId") == TRACE_ID, f"{operation} trace id mismatch")
    require(HEX_16.match(attrs.get("spanId", "")), f"{operation} span id invalid")
    require(attrs.get("parentSpanId") == PARENT_SPAN_ID, f"{operation} parent span mismatch")
    require(attrs.get("durationMs") >= 0, f"{operation} duration must be non-negative")
    require(meta.get("source") == "database.command", f"{operation} source mismatch")
    require(meta.get("framework") == "ado.net", f"{operation} framework mismatch")
    require(meta.get("dbOperation") == operation, f"{operation} operation mismatch")
    require(meta.get("dbOperationKind") == operation_kind, f"{operation} operation kind mismatch")
    require(meta.get("sampled") is True, f"{operation} sampled flag missing")


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_dotnet_db_command_payload.py stdout.json stderr.json")

    payload_text = Path(sys.argv[1]).read_text()
    summary = json.loads(Path(sys.argv[2]).read_text())
    payload = json.loads(payload_text)
    events = payload.get("events", [])

    require(summary.get("ok") is True, "summary ok flag missing")
    require(summary.get("events") == 3, "summary event count mismatch")
    require(summary.get("status") == 202, "summary status mismatch")
    require(summary.get("attempts") == 1, "summary attempts mismatch")
    require(len(events) == 3, f"expected 3 events, got {len(events)}")

    for blocked in (
        "UPDATE orders",
        "SELECT COUNT",
        "INSERT INTO payments",
        "card_number",
        "database provider error",
        "Server=example",
        "connection_string",
        "\"sql\"",
    ):
        require(blocked not in payload_text, f"unsafe DbCommand data leaked: {blocked}")

    update = event_by_name(events, "database.command:orders.update")
    count = event_by_name(events, "database.command:orders.count")
    failing = event_by_name(events, "database.command:payments.insert")

    assert_command_span(update, "orders.update", "execute_non_query")
    update_meta = metadata(update)
    require(update.get("attributes", {}).get("status") == "ok", "update status mismatch")
    require(update_meta.get("dbSystem") == "sqlserver", "update DB system mismatch")
    require(update_meta.get("dbCommandType") == "text", "update command type mismatch")
    require(update_meta.get("dbName") == "checkout", "update DB name mismatch")
    require(update_meta.get("rowCount") == 4, "update row count mismatch")
    require(update_meta.get("feature") == "checkout", "safe caller metadata missing")

    assert_command_span(count, "orders.count", "execute_scalar")
    require(count.get("attributes", {}).get("status") == "ok", "count status mismatch")
    require(metadata(count).get("rowCount") is None, "scalar should not infer row count")

    assert_command_span(failing, "payments.insert", "execute_non_query")
    failing_attrs = failing.get("attributes", {})
    failing_meta = metadata(failing)
    require(failing_attrs.get("status") == "error", "failing status mismatch")
    require(failing_meta.get("dbSystem") == "sqlserver", "failing DB system mismatch")
    require(failing_meta.get("errorType") == "System.InvalidOperationException", "failing error type mismatch")
    span_events = failing_attrs.get("events", [])
    require(isinstance(span_events, list), "failing span events must be a list")
    require(len(span_events) == 1, "expected one exception span event")
    exception_event = span_events[0]
    require(exception_event.get("name") == "exception", "exception event name mismatch")
    exception_meta = exception_event.get("metadata", {})
    require(exception_meta.get("exceptionType") == "System.InvalidOperationException", "exception event type mismatch")
    require(exception_meta.get("exceptionEscaped") is True, "exception escaped flag mismatch")


if __name__ == "__main__":
    main()
