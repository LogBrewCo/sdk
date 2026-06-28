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


def assert_span(event, source):
    attrs = event.get("attributes", {})
    meta = metadata(event)
    require(attrs.get("traceId") == TRACE_ID, f"{source} trace id mismatch")
    require(HEX_16.match(attrs.get("spanId", "")), f"{source} span id invalid")
    require(attrs.get("parentSpanId") == PARENT_SPAN_ID, f"{source} parent span mismatch")
    require(attrs.get("status") == "ok", f"{source} status mismatch")
    require(attrs.get("durationMs") >= 0, f"{source} duration must be non-negative")
    require(meta.get("source") == source, f"{source} metadata source mismatch")
    require(meta.get("feature") == "checkout", f"{source} feature metadata missing")
    require(meta.get("sampled") is True, f"{source} sampled flag missing")


def assert_error_span(event, source):
    attrs = event.get("attributes", {})
    meta = metadata(event)
    require(attrs.get("traceId") == TRACE_ID, f"{source} trace id mismatch")
    require(HEX_16.match(attrs.get("spanId", "")), f"{source} span id invalid")
    require(attrs.get("parentSpanId") == PARENT_SPAN_ID, f"{source} parent span mismatch")
    require(attrs.get("status") == "error", f"{source} error status mismatch")
    require(meta.get("source") == source, f"{source} metadata source mismatch")
    require(meta.get("feature") == "checkout", f"{source} feature metadata missing")
    require(meta.get("errorType") == "System.InvalidOperationException", f"{source} error type mismatch")
    span_events = attrs.get("events", [])
    require(isinstance(span_events, list), f"{source} span events must be a list")
    require(len(span_events) == 1, f"{source} expected one exception span event")
    exception_event = span_events[0]
    require(exception_event.get("name") == "exception", f"{source} exception event name mismatch")
    exception_meta = exception_event.get("metadata", {})
    require(isinstance(exception_meta, dict), f"{source} exception event metadata must be an object")
    require(exception_meta.get("exceptionType") == "System.InvalidOperationException", f"{source} exception event type mismatch")
    require(exception_meta.get("exceptionEscaped") is True, f"{source} exception escaped flag mismatch")


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_dotnet_dependency_spans_payload.py stdout.json stderr.json")

    payload_text = Path(sys.argv[1]).read_text()
    summary = json.loads(Path(sys.argv[2]).read_text())
    payload = json.loads(payload_text)
    events = payload.get("events", [])

    require(summary.get("ok") is True, "summary ok flag missing")
    require(summary.get("events") == 4, "summary event count mismatch")
    require(summary.get("status") == 202, "summary status mismatch")
    require(summary.get("attempts") == 1, "summary attempts mismatch")
    require(len(events) == 4, f"expected 4 events, got {len(events)}")

    for blocked in (
        "cart:sample",
        "sample payload",
        "database failed with sample payload details",
        "Server=example",
        "id = 'sample'",
        "query",
        "connection_string",
        "cache-key",
        "messageBody",
    ):
        require(blocked not in payload_text, f"unsafe dependency data leaked: {blocked}")

    db = event_by_name(events, "database:orders.select")
    cache = event_by_name(events, "cache:cart.get")
    queue = event_by_name(events, "queue:invoice.publish")
    failing_db = event_by_name(events, "database:orders.fail")

    assert_span(db, "database.operation")
    db_meta = metadata(db)
    require(db_meta.get("dbSystem") == "sqlserver", "DB system mismatch")
    require(db_meta.get("dbOperation") == "orders.select", "DB operation mismatch")
    require(db_meta.get("dbOperationKind") == "select", "DB operation kind mismatch")
    require(db_meta.get("dbName") == "checkout", "DB name mismatch")
    require(db_meta.get("dbStatementTemplate") == "SELECT * FROM orders WHERE id = ?", "DB template mismatch")
    require(db_meta.get("rowCount") == 1, "DB row count mismatch")

    assert_span(cache, "cache.operation")
    cache_meta = metadata(cache)
    require(cache_meta.get("cacheSystem") == "redis", "cache system mismatch")
    require(cache_meta.get("cacheOperation") == "cart.get", "cache operation mismatch")
    require(cache_meta.get("cacheOperationKind") == "get", "cache operation kind mismatch")
    require(cache_meta.get("cacheName") == "cart", "cache name mismatch")
    require(cache_meta.get("cacheHit") is True, "cache hit mismatch")
    require(cache_meta.get("itemCount") == 1, "cache item count mismatch")

    assert_span(queue, "queue.operation")
    queue_meta = metadata(queue)
    require(queue_meta.get("queueSystem") == "kafka", "queue system mismatch")
    require(queue_meta.get("queueOperation") == "invoice.publish", "queue operation mismatch")
    require(queue_meta.get("queueOperationKind") == "publish", "queue operation kind mismatch")
    require(queue_meta.get("queueName") == "invoices", "queue name mismatch")
    require(queue_meta.get("taskName") == "invoice.created", "queue task name mismatch")
    require(queue_meta.get("messageCount") == 1, "queue message count mismatch")

    assert_error_span(failing_db, "database.operation")


if __name__ == "__main__":
    main()
