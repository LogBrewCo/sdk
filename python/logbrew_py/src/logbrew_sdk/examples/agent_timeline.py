"""Packaged agent-readable timeline example for installed SDK users."""

from __future__ import annotations

import json
import sys

from logbrew_sdk import (
    LogBrewClient,
    RecordingTransport,
    create_network_milestone_attributes,
    create_product_action_attributes,
    create_traceparent_headers,
)


def main() -> int:
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
    headers = create_traceparent_headers(trace_id=trace_id, span_id="00f067aa0ba902b7")
    client = LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="checkout-agent-timeline",
        sdk_version="0.1.0",
    )

    client.action(
        "evt_checkout_submit",
        "2026-06-02T10:00:05Z",
        create_product_action_attributes(
            {
                "name": "checkout.submit",
                "status": "running",
                "sessionId": "sess_123",
                "traceId": trace_id,
                "routeTemplate": "/checkout/:step?email=private@example.test#payment",
                "screen": "checkout",
                "funnel": "checkout",
                "step": "submit",
                "metadata": {"service": "checkout", "payload": {"card": "redacted"}},
            }
        ),
    )
    client.action(
        "evt_payment_api",
        "2026-06-02T10:00:06Z",
        create_network_milestone_attributes(
            {
                "routeTemplate": "https://api.example.test/payments/:id?card=private#receipt",
                "method": "post",
                "statusCode": 202,
                "durationMs": 94,
                "sessionId": "sess_123",
                "traceId": trace_id,
                "metadata": {"service": "checkout", "headers": {"authorization": "redacted"}},
            }
        ),
    )

    print(client.preview_json())
    response = client.shutdown(RecordingTransport.always_accept())
    print(
        json.dumps(
            {
                "ok": True,
                "status": response.status_code,
                "attempts": response.attempts,
                "events": 2,
                "traceparent": headers["traceparent"],
            },
            sort_keys=True,
        ),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
