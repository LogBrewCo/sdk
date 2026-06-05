from __future__ import annotations

import json
import sys

from logbrew_sdk import LogBrewClient, RecordingTransport


def main() -> int:
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
