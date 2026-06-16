#!/usr/bin/env python3
import json
import sys
from pathlib import Path


TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def load_json_object(text, label):
    start = text.find("{")
    require(start >= 0, f"{label} does not contain JSON")
    decoder = json.JSONDecoder()
    value, _ = decoder.raw_decode(text[start:])
    require(isinstance(value, dict), f"{label} JSON is not an object")
    return value


def event_by_id(events, event_id):
    for event in events:
        if event.get("id") == event_id:
            return event
    raise SystemExit(f"missing event {event_id}")


def metadata(event):
    value = event.get("attributes", {}).get("metadata", {})
    require(isinstance(value, dict), f"metadata for {event.get('id')} is not an object")
    return value


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_ruby_http_trace_payload.py stdout.json stderr.json")

    payload_text = Path(sys.argv[1]).read_text()
    summary_text = Path(sys.argv[2]).read_text()
    payload = load_json_object(payload_text, "payload")
    summary = load_json_object(summary_text, "summary")
    events = payload.get("events", [])
    require(len(events) == 7, f"expected 7 events, got {len(events)}")
    require(summary["ok"] is True, "summary ok mismatch")
    require(summary["status"] == 202, "summary status mismatch")
    require(summary["attempts"] == 1, "summary attempts mismatch")
    require(summary["events"] == 7, "summary event count mismatch")
    require("traceparent" not in payload_text.lower(), "raw traceparent must not be serialized")
    require("coupon=sample" not in payload_text, "query string must not be serialized")
    require("ignored" not in payload_text, "non-primitive metadata must be omitted")

    log_event = event_by_id(events, "ruby_http_trace_1")
    issue_event = event_by_id(events, "evt_issue_checkout_trace")
    action_event = event_by_id(events, "evt_action_checkout_trace")
    metric_event = event_by_id(events, "evt_metric_checkout_trace")
    span_event = event_by_id(events, "ruby_http_trace_span_1")
    span_attrs = span_event["attributes"]
    span_id = span_attrs["spanId"]

    require(span_attrs["traceId"] == TRACE_ID, "span trace id mismatch")
    require(span_attrs["parentSpanId"] == PARENT_SPAN_ID, "span parent id mismatch")
    require(span_attrs["name"] == "POST /checkout/:cart_id", "span route name mismatch")
    require(span_attrs["status"] == "ok", "request span status mismatch")
    require(span_attrs["durationMs"] >= 0, "span duration must be non-negative")
    require(summary["outgoingTraceparent"] == f"00-{TRACE_ID}-{span_id}-01", "outgoing traceparent mismatch")

    for event, label in (
        (log_event, "logger"),
        (issue_event, "issue"),
        (action_event, "action"),
        (metric_event, "metric"),
        (span_event, "span metadata"),
    ):
        meta = metadata(event)
        require(meta.get("traceId") == TRACE_ID, f"{label} trace id mismatch")
        require(meta.get("spanId") == span_id, f"{label} span id mismatch")
        require(meta.get("parentSpanId") == PARENT_SPAN_ID, f"{label} parent span id mismatch")
        require(meta.get("traceFlags") == "01", f"{label} trace flags mismatch")
        require(meta.get("traceSampled") is True, f"{label} sampled flag mismatch")

    require(metadata(log_event).get("rubySeverity") == "WARN", "Ruby logger severity missing")
    require(metadata(issue_event).get("routeTemplate") == "/checkout/:cart_id", "issue route metadata missing")
    require(action_event["attributes"]["metadata"]["routeTemplate"] == "/checkout/:cart_id", "action route must be sanitized")
    require(metric_event["attributes"]["name"] == "http.server.duration", "metric name mismatch")
    require(metadata(metric_event).get("statusCode") == 202, "metric status metadata missing")


if __name__ == "__main__":
    main()
