from __future__ import annotations

import asyncio
import json

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    async_database_operation_with_logbrew_span,
    database_operation_with_logbrew_span,
    get_active_logbrew_trace,
    use_logbrew_trace,
)


class QueryResult:
    def __init__(self, rowcount: int) -> None:
        self.rowcount = rowcount


class StubDatabaseError(RuntimeError):
    pass


client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-database",
    sdk_version="0.1.0",
)
parent_trace = LogBrewTraceContext(
    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
    span_id="00f067aa0ba902b7",
    sampled=True,
)
captured: dict[str, object] = {}


def query_operation() -> QueryResult:
    active = get_active_logbrew_trace()
    captured["activeSpan"] = active.span_id if active is not None else None
    return QueryResult(3)


async def async_query_operation() -> QueryResult:
    active = get_active_logbrew_trace()
    captured["asyncActiveSpan"] = active.span_id if active is not None else None
    return QueryResult(2)


with use_logbrew_trace(parent_trace):
    result = database_operation_with_logbrew_span(
        "SELECT checkout_order",
        client=client,
        event_id="evt_python_database_client",
        timestamp="2026-06-19T10:30:00Z",
        operation=query_operation,
        system="postgresql",
        db_name="checkout",
        statement_template="SELECT * FROM checkout_order WHERE email = ?",
        row_count_from_result=lambda value: value.rowcount,
        span_id_factory=lambda: "b7ad6b7169203341",
        clock=iter([70.0, 70.019]).__next__,
        metadata={"service": "checkout", "params": {"email": "private@example.test"}},
    )

with use_logbrew_trace(parent_trace):
    async_result = asyncio.run(
        async_database_operation_with_logbrew_span(
            "SELECT cache_warmup",
            client=client,
            event_id="evt_python_database_async_client",
            timestamp="2026-06-19T10:30:01Z",
            operation=async_query_operation,
            system="mysql",
            db_name="checkout",
            row_count_from_result=lambda value: value.rowcount,
            span_id_factory=lambda: "b7ad6b7169203342",
            clock=iter([80.0, 80.023]).__next__,
            metadata={"service": "checkout", "parameters": ["private"]},
        )
    )

try:
    database_operation_with_logbrew_span(
        "INSERT checkout_order",
        client=client,
        event_id="evt_python_database_error",
        timestamp="2026-06-19T10:30:02Z",
        operation=lambda: (_ for _ in ()).throw(StubDatabaseError("duplicate private@example.test")),
        system="postgresql",
        db_name="checkout",
        span_id_factory=lambda: "b7ad6b7169203343",
        clock=iter([90.0, 90.007]).__next__,
    )
except StubDatabaseError:
    pass

closed_client = LogBrewClient.create(
    api_key="LOGBREW_API_KEY",
    sdk_name="smoke-app-database",
    sdk_version="0.1.0",
)
closed_client.closed = True
capture_errors: list[str] = []
database_operation_with_logbrew_span(
    "SELECT health",
    client=closed_client,
    event_id="evt_python_database_capture_failure",
    timestamp="2026-06-19T10:30:03Z",
    operation=lambda: QueryResult(1),
    system="sqlite",
    span_id_factory=lambda: "b7ad6b7169203344",
    on_capture_error=lambda error: capture_errors.append(str(error)),
)

serialized = client.preview_json()
for forbidden in ("private@example.test", '"params"', '"parameters"', "duplicate private"):
    if forbidden in serialized:
        raise SystemExit(f"database span leaked private data: {forbidden}")

payload = json.loads(serialized)
sync_metadata = payload["events"][0]["attributes"]["metadata"]
async_metadata = payload["events"][1]["attributes"]["metadata"]
error_metadata = payload["events"][2]["attributes"]["metadata"]

print(
    json.dumps(
        {
            "activeSpan": captured["activeSpan"],
            "asyncActiveSpan": captured["asyncActiveSpan"],
            "asyncDbSystem": async_metadata["dbSystem"],
            "asyncRowCount": async_metadata["rowCount"],
            "asyncRows": async_result.rowcount,
            "captureErrors": len(capture_errors),
            "dbSystem": sync_metadata["dbSystem"],
            "errorType": error_metadata["errorType"],
            "events": len(payload["events"]),
            "ok": True,
            "rowCount": sync_metadata["rowCount"],
            "syncRows": result.rowcount,
        },
        sort_keys=True,
    )
)
