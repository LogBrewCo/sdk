#!/usr/bin/env python3

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


def fail(message: str) -> None:
    raise SystemExit(f"C rich telemetry payload check failed: {message}")


def all_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for entry in value for item in all_strings(entry)]
    if isinstance(value, dict):
        return [item for entry in value.values() for item in all_strings(entry)]
    return []


def main() -> int:
    if len(sys.argv) != 2:
        fail("expected one payload path")
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    events = payload.get("events")
    expected_types = ["issue", "span", "release", "environment", "log", "action", "metric"]
    if not isinstance(events, list) or [event.get("type") for event in events] != expected_types:
        fail("expected one ordered event for every signal type")
    if any(not isinstance(event.get("attributes", {}).get("context"), dict) for event in events):
        fail("every signal must include typed context")

    issue = events[0]["attributes"]
    context = issue["context"]
    resource = context.get("resource", {})
    if resource.get("runtime") != {"name": "c", "version": "c99"}:
        fail("automatic C runtime context is missing")
    if resource.get("service") != {"name": "checkout-api", "version": "2.4.0"}:
        fail("client service context is missing")
    if resource.get("deployment") != {
        "environment": "production",
        "release": "checkout@2.4.0",
    }:
        fail("deployment context is incomplete")
    if context.get("session") != {
        "id": "session_opaque_02",
        "previousId": "session_opaque_01",
    }:
        fail("scoped session context is missing")
    if context.get("subject") != {"id": "subject_sha256_abc123", "kind": "user"}:
        fail("per-event opaque subject context is missing")
    if context.get("tags") != {
        "region": "eu-north",
        "tier": "payments",
        "feature.checkout": "v2",
        "failure.domain": "payment",
    }:
        fail("tag precedence or merge is incorrect")
    trace = context.get("trace", {})
    if not re.fullmatch(r"[0-9a-f]{32}", trace.get("traceId", "")):
        fail("canonical trace ID is missing")
    if not re.fullmatch(r"[0-9a-f]{16}", trace.get("spanId", "")):
        fail("canonical span ID is missing")
    if trace.get("parentSpanId") != "00f067aa0ba902b7" or trace.get("sampled") is not True:
        fail("active trace evidence is incomplete")

    if issue.get("exception") != {
        "type": "PaymentDeclined",
        "mechanism": {"type": "signal", "handled": False},
    }:
        fail("exception mechanism and handled state are incomplete")
    frames = issue.get("stackFrames")
    if not isinstance(frames, list) or len(frames) != 2:
        fail("expected two structured stack frames")
    if frames[0] != {
        "filename": "checkout.c",
        "line": 413,
        "column": 9,
        "function": "authorize_payment",
        "module": "checkout.payment",
        "inApp": True,
    }:
        fail("sanitized primary frame is incorrect")
    breadcrumbs = issue.get("breadcrumbs")
    if not isinstance(breadcrumbs, list) or len(breadcrumbs) != 64:
        fail("newest 64 breadcrumbs were not retained")
    if issue.get("breadcrumbsTruncated") is not True:
        fail("breadcrumb truncation is not explicit")
    if breadcrumbs[-1].get("category") != "payment.request":
        fail("explicit terminal breadcrumb is not the newest evidence")
    if issue.get("metadata") != {
        "retryStage": "authorization",
        "retryable": False,
        "upstreamCode": None,
    }:
        fail("primitive issue metadata is incorrect")

    span = events[1]["attributes"]
    if span.get("events") != [
        {
            "name": "payment.authorization.rejected",
            "timestamp": "2026-08-06T10:01:05.900Z",
            "metadata": {"route": "/checkout/{id}", "attempt": 2},
        }
    ]:
        fail("span event evidence is incorrect")
    if span.get("links") != [
        {
            "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "spanId": "bbbbbbbbbbbbbbbb",
            "sampled": False,
        }
    ]:
        fail("span link evidence is incorrect")

    serialized_strings = "\n".join(all_strings(payload))
    for forbidden in (
        "/workspace/source",
        "source/checkout.c",
        "redaction_canary=value",
        "LOGBREW_API_KEY",
    ):
        if forbidden in serialized_strings:
            fail(f"private value leaked: {forbidden}")
    print("C rich telemetry payload ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
