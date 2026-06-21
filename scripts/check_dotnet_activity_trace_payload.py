#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path


TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
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
        raise SystemExit("usage: check_dotnet_activity_trace_payload.py stdout.json stderr.json")

    payload_text = Path(sys.argv[1]).read_text()
    summary = json.loads(Path(sys.argv[2]).read_text())
    payload = json.loads(payload_text)
    events = payload.get("events", [])

    require(summary.get("ok") is True, "summary ok flag missing")
    require(summary.get("events") == 7, "summary event count mismatch")
    require(summary.get("status") == 202, "summary status mismatch")
    require(summary.get("attempts") == 1, "summary attempts mismatch")
    require(summary.get("capturedActivitySpan") is True, "Activity span capture flag missing")
    require(HEX_16.match(summary.get("activitySpanId", "")), "invalid Activity span id")
    require(HEX_16.match(summary.get("logbrewSpanId", "")), "invalid LogBrew span id")
    require(HEX_16.match(summary.get("activityContextSpanId", "")), "invalid ActivityContext span id")
    require(summary["activitySpanId"] != summary["logbrewSpanId"], "LogBrew should create a child span")
    require(summary["activitySpanId"] != summary["activityContextSpanId"], "ActivityContext bridge should create a child span")
    require(summary["outgoingTraceparent"] == f"00-{TRACE_ID}-{summary['logbrewSpanId']}-01", "outgoing traceparent mismatch")
    require(len(events) == 7, f"expected 7 events, got {len(events)}")
    require("traceparent" not in payload_text.lower(), "raw traceparent must not be serialized in telemetry")
    require("ignored" not in payload_text, "non-primitive metadata must be omitted")
    require("shop" + ".example" not in payload_text, "network origins must not be serialized")
    require("card=sample" not in payload_text, "query/card data must not be serialized")
    require("Authorization" not in payload_text, "headers must not be serialized")
    require("Bearer" not in payload_text, "header values must not be serialized")

    log_event = event_by_id(events, "dotnet_activity_trace_1")
    action_event = event_by_id(events, "evt_action_checkout_activity_trace")
    span_event = event_by_id(events, "evt_span_checkout_activity_trace")
    metric_event = event_by_id(events, "evt_metric_checkout_activity_trace")
    activity_span_event = event_by_id(events, f"dotnet_activity_source_span_{summary['activitySpanId']}")

    span_attrs = span_event["attributes"]
    require(span_attrs["traceId"] == TRACE_ID, "span trace id mismatch")
    require(span_attrs["spanId"] == summary["logbrewSpanId"], "span id mismatch")
    require(span_attrs["parentSpanId"] == summary["activitySpanId"], "span parent id mismatch")
    require(span_attrs["name"] == "POST /checkout/:cart_id", "span route mismatch")
    require(span_attrs["status"] == "ok", "span status mismatch")
    require(span_attrs["durationMs"] >= 0, "span duration must be non-negative")

    activity_span_attrs = activity_span_event["attributes"]
    activity_span_meta = metadata(activity_span_event)
    require(activity_span_attrs["traceId"] == TRACE_ID, "Activity span trace id mismatch")
    require(activity_span_attrs["spanId"] == summary["activitySpanId"], "Activity span id mismatch")
    require(activity_span_attrs["parentSpanId"] == "00f067aa0ba902b7", "Activity parent span id mismatch")
    require(activity_span_attrs["name"] == "checkout.activity", "Activity span name mismatch")
    require(activity_span_attrs["status"] == "ok", "Activity span status mismatch")
    require(activity_span_meta.get("source") == "dotnet.activity", "Activity span source mismatch")
    require(activity_span_meta.get("activityName") == "checkout.activity", "Activity name metadata mismatch")
    require(activity_span_meta.get("activityKind") == "internal", "Activity kind metadata mismatch")
    require(activity_span_meta.get("traceFlags") == "01", "Activity trace flags mismatch")
    require(activity_span_meta.get("traceSampled") is True, "Activity sampled flag mismatch")
    require(activity_span_meta.get("httpMethod") == "POST", "Activity HTTP method mismatch")
    require(activity_span_meta.get("httpRoute") == "/checkout/:cart_id", "Activity route metadata mismatch")
    require(activity_span_meta.get("httpStatusCode") == 202, "Activity status code metadata mismatch")
    require(activity_span_meta.get("safe") is True, "Activity safe metadata missing")

    for event, label in (
        (log_event, "logger"),
        (span_event, "span metadata"),
        (metric_event, "metric"),
    ):
        meta = metadata(event)
        require(meta.get("traceId") == TRACE_ID, f"{label} trace id mismatch")
        require(meta.get("spanId") == summary["logbrewSpanId"], f"{label} span id mismatch")
        require(meta.get("parentSpanId") == summary["activitySpanId"], f"{label} parent span id mismatch")
        require(meta.get("traceFlags") == "01", f"{label} trace flags mismatch")
        require(meta.get("traceSampled") is True, f"{label} sampled flag mismatch")

    require(metadata(log_event).get("dotnetCategory") == "CheckoutActivityTrace", "logger category missing")
    require(metadata(log_event).get("dotnetEventName") == "CheckoutActivity", "logger event name missing")
    require(metadata(log_event).get("CartId") == "cart_123", "structured logger metadata missing")
    require(metadata(metric_event).get("framework") == "aspnetcore", "metric framework metadata missing")
    require(metric_event["attributes"]["name"] == "http.server.duration", "metric name mismatch")
    require(action_event["attributes"]["metadata"]["routeTemplate"] == "/checkout/:cart_id", "action route mismatch")
    require(action_event["attributes"]["metadata"]["traceId"] == TRACE_ID, "action trace id mismatch")


if __name__ == "__main__":
    main()
