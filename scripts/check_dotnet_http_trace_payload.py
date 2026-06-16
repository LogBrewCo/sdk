#!/usr/bin/env python3
import json
import sys
from pathlib import Path


TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"


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
        raise SystemExit("usage: check_dotnet_http_trace_payload.py stdout.json stderr.json")

    payload_text = Path(sys.argv[1]).read_text()
    summary_text = Path(sys.argv[2]).read_text()
    payload = json.loads(payload_text)
    summary = json.loads(summary_text)
    events = payload.get("events", [])
    require(summary == {
        "ok": True,
        "events": 7,
        "status": 202,
        "attempts": 1,
        "outgoingTraceparent": summary.get("outgoingTraceparent"),
    }, "unexpected summary envelope")
    require(len(events) == 7, f"expected 7 events, got {len(events)}")
    require("traceparent" not in payload_text.lower(), "raw traceparent must not be serialized in telemetry")
    require("coupon=sample" not in payload_text, "query string must not be serialized")
    require("ignored" not in payload_text, "non-primitive metadata must be omitted")

    log_event = event_by_id(events, "dotnet_http_trace_1")
    issue_event = event_by_id(events, "evt_issue_checkout_trace")
    action_event = event_by_id(events, "evt_action_checkout_trace")
    span_event = event_by_id(events, "evt_span_checkout_trace")
    metric_event = event_by_id(events, "evt_metric_checkout_trace")

    span_attrs = span_event["attributes"]
    span_id = span_attrs["spanId"]
    require(summary["outgoingTraceparent"] == f"00-{TRACE_ID}-{span_id}-01", "outgoing traceparent must use the request span")
    require(span_attrs["traceId"] == TRACE_ID, "span trace id mismatch")
    require(span_attrs["parentSpanId"] == PARENT_SPAN_ID, "span parent id mismatch")
    require(span_attrs["name"] == "POST /checkout/:cart_id", "span route name must be sanitized")
    require(span_attrs["status"] == "error", "5xx request span should be error")
    require(span_attrs["durationMs"] >= 0, "span duration must be non-negative")

    for event, label in (
        (log_event, "logger"),
        (issue_event, "issue"),
        (span_event, "span metadata"),
        (metric_event, "metric"),
    ):
        meta = metadata(event)
        require(meta.get("traceId") == TRACE_ID, f"{label} trace id mismatch")
        require(meta.get("spanId") == span_id, f"{label} span id mismatch")
        require(meta.get("traceFlags") == "01", f"{label} trace flags mismatch")
        require(meta.get("traceSampled") is True, f"{label} sampled flag mismatch")

    require(metadata(log_event).get("dotnetCategory") == "CheckoutTrace", "logger category missing")
    require(metadata(log_event).get("dotnetEventName") == "CheckoutSlow", "logger event name missing")
    require(metadata(log_event).get("CartId") == "cart_123", "structured logger metadata missing")
    require(metadata(issue_event).get("exceptionMessage") == "payment provider failed", "issue error metadata missing")
    require(metadata(issue_event).get("routeTemplate") == "/checkout/:cart_id", "issue route metadata missing")
    require(metadata(metric_event).get("routeTemplate") == "/checkout/:cart_id", "metric route metadata missing")
    require(metadata(metric_event).get("statusCode") == 503, "metric status metadata missing")
    require(metric_event["attributes"]["name"] == "http.server.duration", "metric name mismatch")
    require(action_event["attributes"]["metadata"]["routeTemplate"] == "/checkout/:cart_id", "action route must be sanitized")
    require(action_event["attributes"]["metadata"]["traceId"] == TRACE_ID, "action trace id mismatch")


if __name__ == "__main__":
    main()
