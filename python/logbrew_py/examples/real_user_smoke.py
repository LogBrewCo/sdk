from __future__ import annotations

import json
import sys

from logbrew_sdk import LogBrewClient, RecordingTransport, create_traceparent_headers


def main() -> int:
    outgoing_headers = create_traceparent_headers(
        trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
        span_id="b7ad6b7169203331",
        trace_flags="01",
    )
    if outgoing_headers["traceparent"] != "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01":
        raise RuntimeError("create_traceparent_headers produced an unexpected carrier")

    client = LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
    )

    client.release(
        "evt_release_001",
        "2026-06-02T10:00:00Z",
        {
            "version": "1.2.3",
            "commit": "abc123def456",
            "notes": "Public release marker",
        },
    )
    client.environment(
        "evt_environment_001",
        "2026-06-02T10:00:01Z",
        {"name": "production", "region": "global"},
    )
    client.issue(
        "evt_issue_001",
        "2026-06-02T10:00:02Z",
        {
            "title": "Checkout timeout",
            "level": "error",
            "message": "Request timed out after retry budget",
        },
    )
    client.log(
        "evt_log_001",
        "2026-06-02T10:00:03Z",
        {"message": "worker started", "level": "info", "logger": "job-runner"},
    )
    client.span(
        "evt_span_001",
        "2026-06-02T10:00:04Z",
        {
            "name": "GET /health",
            "traceId": "trace_001",
            "spanId": "span_001",
            "status": "ok",
            "durationMs": 12.5,
        },
    )
    client.action(
        "evt_action_001",
        "2026-06-02T10:00:05Z",
        {"name": "deploy", "status": "success"},
    )

    print(client.preview_json())
    transport = RecordingTransport.always_accept()
    response = client.shutdown(transport)
    print(
        json.dumps(
            {
                "ok": True,
                "status": response.status_code,
                "attempts": response.attempts,
                "events": 6,
            }
        ),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
