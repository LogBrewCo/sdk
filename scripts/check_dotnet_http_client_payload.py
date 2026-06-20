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


def event_by_id(events, event_id):
    for event in events:
        if event.get("id") == event_id:
            return event
    raise SystemExit(f"missing event {event_id}")


def metadata(event):
    value = event.get("attributes", {}).get("metadata", {})
    require(isinstance(value, dict), f"metadata is not an object for {event.get('id')}")
    return value


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_dotnet_http_client_payload.py stdout.json stderr.json")

    payload_text = Path(sys.argv[1]).read_text()
    summary = json.loads(Path(sys.argv[2]).read_text())
    payload = json.loads(payload_text)
    events = payload.get("events", [])

    require(summary.get("ok") is True, "summary ok flag missing")
    require(summary.get("events") == 4, "summary event count mismatch")
    require(summary.get("status") == 202, "summary status mismatch")
    require(summary.get("attempts") == 1, "summary attempts mismatch")
    require(HEX_16.match(summary.get("logbrewSpanId", "")), "invalid LogBrew span id")
    require(
        summary.get("outgoingTraceparent") == f"00-{TRACE_ID}-{summary['logbrewSpanId']}-01",
        "outgoing traceparent mismatch",
    )
    require(len(events) == 4, f"expected 4 events, got {len(events)}")

    for blocked in (
        "traceparent",
        "payments.example",
        "card=sample",
        "Authorization",
        "Bearer",
        '"headers"',
        '"body"',
        '"url"',
        "ignored",
    ):
        require(blocked not in payload_text, f"unsafe outbound HTTP payload text leaked: {blocked}")

    log_event = event_by_id(events, "dotnet_http_client_1")
    span_event = event_by_id(events, f"dotnet_http_client_span_{summary['logbrewSpanId']}")
    span_attrs = span_event["attributes"]

    require(span_attrs["name"] == "HTTP POST /v1/payments/:id", "span route name mismatch")
    require(span_attrs["traceId"] == TRACE_ID, "span trace id mismatch")
    require(span_attrs["spanId"] == summary["logbrewSpanId"], "span id mismatch")
    require(span_attrs["parentSpanId"] == PARENT_SPAN_ID, "span parent id mismatch")
    require(span_attrs["status"] == "ok", "span status mismatch")
    require(span_attrs["durationMs"] >= 0, "span duration must be non-negative")

    span_meta = metadata(span_event)
    require(span_meta.get("source") == "http.client", "span source mismatch")
    require(span_meta.get("method") == "POST", "span method mismatch")
    require(span_meta.get("routeTemplate") == "/v1/payments/:id", "span route metadata mismatch")
    require(span_meta.get("statusCode") == 202, "span status code mismatch")
    require(span_meta.get("provider") == "payments", "safe metadata missing")
    require(span_meta.get("sampled") is True, "sampled metadata missing")

    log_meta = metadata(log_event)
    require(log_meta.get("traceId") == TRACE_ID, "logger trace id mismatch")
    require(log_meta.get("spanId") == summary["logbrewSpanId"], "logger span id mismatch")
    require(log_meta.get("parentSpanId") == PARENT_SPAN_ID, "logger parent span mismatch")
    require(log_meta.get("dotnetCategory") == "CheckoutHttpClient", "logger category missing")
    require(log_meta.get("StatusCode") == 202, "logger structured status missing")


if __name__ == "__main__":
    main()
