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


def assert_redis_span(event, command, operation_kind):
    attrs = event.get("attributes", {})
    meta = metadata(event)
    require(attrs.get("traceId") == TRACE_ID, f"{command} trace id mismatch")
    require(HEX_16.match(attrs.get("spanId", "")), f"{command} span id invalid")
    require(attrs.get("parentSpanId") == PARENT_SPAN_ID, f"{command} parent span mismatch")
    require(attrs.get("durationMs") >= 0, f"{command} duration must be non-negative")
    require(meta.get("source") == "stackexchange_redis.command", f"{command} source mismatch")
    require(meta.get("framework") == "stackexchange.redis", f"{command} framework mismatch")
    require(meta.get("cacheSystem") == "redis", f"{command} cache system mismatch")
    require(meta.get("cacheOperation") == command, f"{command} operation mismatch")
    require(meta.get("cacheOperationKind") == operation_kind, f"{command} operation kind mismatch")
    require(meta.get("redisDatabaseIndex") == 4, f"{command} database index mismatch")
    require(meta.get("sampled") is True, f"{command} sampled flag missing")


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_dotnet_stackexchange_redis_payload.py stdout.json stderr.json")

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
        "cart:private",
        "account:private",
        "private:key",
        "cached-cart",
        "cached-account",
        "redis failure with",
        '"key"',
        '"command"',
        '"host"',
    ):
        require(blocked not in payload_text, f"unsafe Redis data leaked: {blocked}")

    get = event_by_name(events, "stackexchange_redis.command:GET")
    mget = event_by_name(events, "stackexchange_redis.command:MGET")
    failing = event_by_name(events, "stackexchange_redis.command:SET")

    assert_redis_span(get, "GET", "read")
    get_meta = metadata(get)
    require(get.get("attributes", {}).get("status") == "ok", "GET status mismatch")
    require(get_meta.get("cacheName") == "checkout-cache", "GET cache name mismatch")
    require(get_meta.get("cacheHit") is True, "GET hit missing")
    require(get_meta.get("resultSizeBytes") == 11, "GET size mismatch")
    require(get_meta.get("feature") == "checkout", "safe caller metadata missing")

    assert_redis_span(mget, "MGET", "read")
    mget_meta = metadata(mget)
    require(mget.get("attributes", {}).get("status") == "ok", "MGET status mismatch")
    require(mget_meta.get("cacheName") == "account-cache", "MGET cache name mismatch")
    require(mget_meta.get("cacheHit") is True, "MGET hit missing")
    require(mget_meta.get("resultSizeBytes") == 14, "MGET size mismatch")

    assert_redis_span(failing, "SET", "write")
    failing_attrs = failing.get("attributes", {})
    failing_meta = metadata(failing)
    require(failing_attrs.get("status") == "error", "failing status mismatch")
    require(failing_meta.get("cacheName") == "checkout-cache", "failing cache name mismatch")
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
