#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from pathlib import Path, PurePath
from typing import Any


TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
PARENT_SPAN_ID = "bbbbbbbbbbbbbbbb"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def matches(events: list[dict[str, Any]], event_type: str, prefix: str) -> list[dict[str, Any]]:
    return [
        event
        for event in events
        if event.get("type") == event_type and str(event.get("id", "")).startswith(prefix)
    ]


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_dotnet_aspnetcore_issue_payload.py preview.json status.txt")

    payload_text = Path(sys.argv[1]).read_text()
    payload = json.loads(payload_text)
    status = Path(sys.argv[2]).read_text().strip()
    require(status == "500", f"expected ASP.NET Core failure status 500, got {status!r}")

    events = payload.get("events")
    require(isinstance(events, list), "events must be an array")
    issues = matches(events, "issue", "aspnetcore_request_issue_")
    require(len(issues) == 1, f"expected one ASP.NET Core issue, got {len(issues)}")
    issue = issues[0]
    attributes = issue.get("attributes")
    require(isinstance(attributes, dict), "issue attributes must be an object")
    require(attributes.get("title") == "ASP.NET Core request failed", "unexpected issue title")
    require(attributes.get("level") == "error", "unexpected issue level")
    require(
        attributes.get("exception")
        == {
            "type": "System.InvalidOperationException",
            "mechanism": {"type": "aspnetcore.middleware", "handled": False},
        },
        "unexpected ASP.NET Core typed exception diagnostics",
    )

    issue_text = json.dumps(issue, sort_keys=True)
    require("private runtime detail" not in issue_text, "automatic issue leaked the exception message")
    require("message" not in attributes, "automatic issue must not include a raw message")
    require("coupon=dropme" not in issue_text, "automatic issue leaked query text")

    frames = attributes.get("stackFrames")
    require(isinstance(frames, list) and 1 <= len(frames) <= 32, "expected 1-32 issue frames")
    require(
        any("ThrowCheckoutFailure" in str(frame.get("function", "")) for frame in frames),
        "expected application failure frame",
    )
    for frame in frames:
        filename = frame.get("filename")
        require(isinstance(filename, str) and bool(filename), "missing issue frame filename")
        require(PurePath(filename).name == filename, "issue frame filename must be basename-only")
        require(not any(mark in filename for mark in ("/", "\\", "?", "#")), "unsafe issue frame filename")
        require(isinstance(frame.get("line"), int) and frame["line"] >= 1, "invalid issue frame line")
        require(isinstance(frame.get("column"), int) and frame["column"] >= 1, "invalid issue frame column")

    metadata = attributes.get("metadata")
    require(isinstance(metadata, dict), "issue metadata must be an object")
    require(metadata.get("source") == "aspnetcore.request", "issue source mismatch")
    require(metadata.get("method") == "GET", "issue method mismatch")
    require(metadata.get("routeTemplate") == "/checkout/failure", "issue route template mismatch")
    require(metadata.get("statusCode") == 500, "issue status code mismatch")
    require(metadata.get("traceId") == TRACE_ID, "issue trace id mismatch")
    require(metadata.get("parentSpanId") == PARENT_SPAN_ID, "issue parent span mismatch")
    require(metadata.get("traceSampled") is True, "issue sampled state mismatch")

    spans = matches(events, "span", "aspnetcore_request_span_")
    failed_spans = [span for span in spans if span.get("attributes", {}).get("status") == "error"]
    require(len(failed_spans) == 1, f"expected one failed request span, got {len(failed_spans)}")
    require(
        failed_spans[0].get("attributes", {}).get("name") == "GET /checkout/failure",
        "failed span route mismatch",
    )
    require(
        failed_spans[0].get("attributes", {}).get("traceId") == TRACE_ID,
        "failed span trace mismatch",
    )

    print("dotnet ASP.NET Core issue diagnostics payload ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
