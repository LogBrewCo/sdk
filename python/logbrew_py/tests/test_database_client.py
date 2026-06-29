from __future__ import annotations

import asyncio
import json
import unittest

from logbrew_sdk import (
    LogBrewClient,
    LogBrewDbapiConnection,
    LogBrewTraceContext,
    async_database_operation_with_logbrew_span,
    database_operation_with_logbrew_span,
    get_active_logbrew_trace,
    instrument_dbapi_connection_with_logbrew_spans,
    use_logbrew_trace,
)


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class StubDbapiCursor:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...], dict[str, object]]] = []
        self.rowcount = -1
        self.active_trace: LogBrewTraceContext | None = None

    def execute(self, operation: object, parameters: object | None = None) -> object:
        self.calls.append(("execute", (operation, parameters), {}))
        self.active_trace = get_active_logbrew_trace()
        self.rowcount = 2
        return self

    def executemany(self, operation: object, seq_of_parameters: object) -> object:
        self.calls.append(("executemany", (operation, seq_of_parameters), {}))
        self.active_trace = get_active_logbrew_trace()
        self.rowcount = 3
        return self


class StubDbapiConnection:
    def __init__(self) -> None:
        self.cursor_instance = StubDbapiCursor()
        self.cursor_calls = 0

    def cursor(self) -> StubDbapiCursor:
        self.cursor_calls += 1
        return self.cursor_instance


class DatabaseOperationSpanTests(unittest.TestCase):
    def test_database_operation_with_logbrew_span_queues_privacy_bounded_span(self) -> None:
        client = sample_client()
        active_trace: LogBrewTraceContext | None = None
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([100.0, 100.013])

        class QueryResult:
            rowcount = 3

        def operation() -> QueryResult:
            nonlocal active_trace
            active_trace = get_active_logbrew_trace()
            return QueryResult()

        with use_logbrew_trace(parent_trace):
            result = database_operation_with_logbrew_span(
                operation_name="SELECT checkout_order",
                client=client,
                event_id="evt_python_db_query",
                timestamp="2026-06-19T10:30:00Z",
                operation=operation,
                system="postgresql",
                db_name="checkout",
                statement_template="SELECT * FROM checkout_order WHERE email = ?",
                row_count_from_result=lambda value: value.rowcount,
                span_id_factory=lambda: "b7ad6b7169203341",
                clock=lambda: next(clock_values),
                metadata={"service": "checkout", "params": {"email": "private@example.test"}},
                span_events=[
                    {
                        "name": "db.cursor.ready",
                        "metadata": {
                            "poolSlot": 2,
                            "queryParams": {"email": "private@example.test"},
                        },
                    }
                ],
            )

        self.assertEqual(result.rowcount, 3)
        self.assertEqual(
            active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203341",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["name"], "postgresql SELECT checkout_order")
        self.assertEqual(event["attributes"]["durationMs"], 13.0)
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["source"], "database")
        self.assertEqual(metadata["dbSystem"], "postgresql")
        self.assertEqual(metadata["dbOperation"], "SELECT checkout_order")
        self.assertEqual(metadata["dbName"], "checkout")
        self.assertEqual(metadata["statementTemplate"], "SELECT * FROM checkout_order WHERE email = ?")
        self.assertEqual(metadata["rowCount"], 3)
        self.assertEqual(metadata["service"], "checkout")
        self.assertEqual(
            event["attributes"]["events"],
            [{"name": "db.cursor.ready", "metadata": {"poolSlot": 2}}],
        )
        serialized = client.preview_json()
        self.assertNotIn("private@example.test", serialized)
        self.assertNotIn("params", serialized)
        self.assertNotIn("queryParams", serialized)

    def test_database_operation_with_logbrew_span_preserves_errors_and_capture_failures(self) -> None:
        client = sample_client()

        class StubDatabaseError(RuntimeError):
            pass

        original_error = StubDatabaseError("duplicate key for private@example.test")

        with self.assertRaises(StubDatabaseError) as raised:
            database_operation_with_logbrew_span(
                operation_name="INSERT checkout_order",
                client=client,
                event_id="evt_python_db_failure",
                timestamp="2026-06-19T10:30:01Z",
                operation=lambda: (_ for _ in ()).throw(original_error),
                system="postgresql",
                db_name="checkout",
                span_id_factory=lambda: "b7ad6b7169203342",
                clock=lambda: 120.0,
            )

        self.assertIs(raised.exception, original_error)
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(event["attributes"]["metadata"]["source"], "database")
        self.assertEqual(event["attributes"]["metadata"]["errorType"], "StubDatabaseError")
        self.assertEqual(
            event["attributes"]["events"],
            [
                {
                    "name": "exception",
                    "metadata": {
                        "exceptionEscaped": True,
                        "exceptionType": "StubDatabaseError",
                    },
                }
            ],
        )
        self.assertNotIn("private@example.test", client.preview_json())
        self.assertNotIn("duplicate key", client.preview_json())

        closed_client = sample_client()
        closed_client.closed = True
        capture_errors: list[str] = []
        result = database_operation_with_logbrew_span(
            operation_name="SELECT health",
            client=closed_client,
            event_id="evt_python_db_capture_error",
            timestamp="2026-06-19T10:30:02Z",
            operation=lambda: "ok",
            system="sqlite",
            span_id_factory=lambda: "b7ad6b7169203343",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        self.assertEqual(result, "ok")
        self.assertEqual(len(capture_errors), 1)
        self.assertIn("client is already shut down", capture_errors[0])

    def test_async_database_operation_with_logbrew_span_queues_privacy_bounded_span(self) -> None:
        async def run() -> None:
            client = sample_client()
            active_trace: LogBrewTraceContext | None = None
            parent_trace = LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="00f067aa0ba902b7",
                sampled=True,
            )
            clock_values = iter([130.0, 130.021])

            class QueryResult:
                rowcount = 2

            async def operation() -> QueryResult:
                nonlocal active_trace
                active_trace = get_active_logbrew_trace()
                return QueryResult()

            with use_logbrew_trace(parent_trace):
                result = await async_database_operation_with_logbrew_span(
                    operation_name="SELECT cache_warmup",
                    client=client,
                    event_id="evt_python_db_async_query",
                    timestamp="2026-06-19T10:30:03Z",
                    operation=operation,
                    system="mysql",
                    db_name="checkout",
                    row_count_from_result=lambda value: value.rowcount,
                    span_id_factory=lambda: "b7ad6b7169203344",
                    clock=lambda: next(clock_values),
                    metadata={"service": "checkout", "parameters": ["private"]},
                )

            self.assertEqual(result.rowcount, 2)
            self.assertEqual(
                active_trace,
                LogBrewTraceContext(
                    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                    span_id="b7ad6b7169203344",
                    parent_span_id="00f067aa0ba902b7",
                    sampled=True,
                ),
            )
            event = json.loads(client.preview_json())["events"][0]
            self.assertEqual(event["attributes"]["name"], "mysql SELECT cache_warmup")
            self.assertEqual(event["attributes"]["durationMs"], 21.0)
            metadata = event["attributes"]["metadata"]
            self.assertEqual(metadata["source"], "database")
            self.assertEqual(metadata["dbSystem"], "mysql")
            self.assertEqual(metadata["rowCount"], 2)
            serialized = client.preview_json()
            self.assertNotIn("parameters", serialized)
            self.assertNotIn("private", serialized)

        asyncio.run(run())

    def test_dbapi_connection_wrapper_traces_execute_without_sql_or_parameters(self) -> None:
        client = sample_client()
        connection = StubDbapiConnection()
        parent_trace = LogBrewTraceContext(
            trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
            span_id="00f067aa0ba902b7",
            sampled=True,
        )
        clock_values = iter([200.0, 200.009, 201.0, 201.014])

        with use_logbrew_trace(parent_trace):
            wrapped = instrument_dbapi_connection_with_logbrew_spans(
                connection,
                client=client,
                system="postgresql",
                db_name="checkout",
                event_id_factory=lambda: "evt_python_dbapi_query",
                timestamp="2026-06-29T20:00:00Z",
                span_id_factory=lambda: "b7ad6b7169203391",
                clock=lambda: next(clock_values),
                metadata={
                    "service": "checkout",
                    "statement": "SELECT * FROM checkout_order WHERE email = ?",
                    "parameters": "sensitive@example.test",
                },
            )
            duplicate = instrument_dbapi_connection_with_logbrew_spans(wrapped, client=client, system="postgresql")
            cursor = wrapped.cursor()
            result = cursor.execute("SELECT * FROM checkout_order WHERE email = ?", ("sensitive@example.test",))

        self.assertIsInstance(wrapped, LogBrewDbapiConnection)
        self.assertIs(duplicate, wrapped)
        self.assertIs(result, cursor)
        self.assertEqual(connection.cursor_calls, 1)
        self.assertEqual(
            connection.cursor_instance.active_trace,
            LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="b7ad6b7169203391",
                parent_span_id="00f067aa0ba902b7",
                sampled=True,
            ),
        )
        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["id"], "evt_python_dbapi_query")
        self.assertEqual(event["attributes"]["name"], "postgresql SELECT")
        self.assertEqual(event["attributes"]["durationMs"], 9.0)
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["source"], "database")
        self.assertEqual(metadata["framework"], "dbapi")
        self.assertEqual(metadata["dbSystem"], "postgresql")
        self.assertEqual(metadata["dbOperation"], "SELECT")
        self.assertEqual(metadata["dbMethod"], "execute")
        self.assertEqual(metadata["dbName"], "checkout")
        self.assertEqual(metadata["rowCount"], 2)
        self.assertEqual(metadata["service"], "checkout")
        serialized = client.preview_json()
        self.assertNotIn("checkout_order", serialized)
        self.assertNotIn("sensitive@example.test", serialized)
        self.assertNotIn("statement", serialized)
        self.assertNotIn("parameters", serialized)

        raw_connection = wrapped.uninstall()
        self.assertIs(raw_connection, connection)
        with use_logbrew_trace(parent_trace):
            wrapped.cursor().executemany("INSERT INTO checkout_order VALUES (?)", [("sensitive@example.test",)])
        self.assertEqual(len(json.loads(client.preview_json())["events"]), 1)

    def test_dbapi_connection_wrapper_preserves_errors_and_capture_failures(self) -> None:
        client = sample_client()

        class StubDbapiError(RuntimeError):
            pass

        class FailingCursor(StubDbapiCursor):
            def execute(self, operation: object, parameters: object | None = None) -> object:
                self.active_trace = get_active_logbrew_trace()
                raise StubDbapiError("duplicate checkout_order for sensitive@example.test")

        class FailingConnection(StubDbapiConnection):
            def __init__(self) -> None:
                super().__init__()
                self.cursor_instance = FailingCursor()

        connection = FailingConnection()
        wrapped = instrument_dbapi_connection_with_logbrew_spans(
            connection,
            client=client,
            system="sqlite",
            event_id_factory=lambda: "evt_python_dbapi_error",
            timestamp="2026-06-29T20:00:01Z",
            span_id_factory=lambda: "b7ad6b7169203392",
            clock=lambda: 220.0,
        )

        with self.assertRaises(StubDbapiError):
            wrapped.cursor().execute("INSERT INTO checkout_order VALUES (?)", ("sensitive@example.test",))

        event = json.loads(client.preview_json())["events"][0]
        self.assertEqual(event["attributes"]["status"], "error")
        self.assertEqual(event["attributes"]["name"], "sqlite INSERT")
        metadata = event["attributes"]["metadata"]
        self.assertEqual(metadata["framework"], "dbapi")
        self.assertEqual(metadata["dbMethod"], "execute")
        self.assertEqual(metadata["errorType"], "StubDbapiError")
        self.assertEqual(
            event["attributes"]["events"],
            [
                {
                    "name": "exception",
                    "metadata": {
                        "exceptionEscaped": True,
                        "exceptionType": "StubDbapiError",
                    },
                }
            ],
        )
        serialized = client.preview_json()
        self.assertNotIn("checkout_order", serialized)
        self.assertNotIn("sensitive@example.test", serialized)
        self.assertNotIn("duplicate", serialized)

        closed_client = sample_client()
        closed_client.closed = True
        capture_errors: list[str] = []
        ok_connection = StubDbapiConnection()
        ok_wrapped = instrument_dbapi_connection_with_logbrew_spans(
            ok_connection,
            client=closed_client,
            system="sqlite",
            event_id_factory=lambda: "evt_python_dbapi_capture_error",
            span_id_factory=lambda: "b7ad6b7169203393",
            on_capture_error=lambda error: capture_errors.append(str(error)),
        )

        ok_cursor = ok_wrapped.cursor()
        self.assertIs(ok_cursor.execute("SELECT 1"), ok_cursor)
        self.assertEqual(len(capture_errors), 1)
        self.assertIn("client is already shut down", capture_errors[0])
