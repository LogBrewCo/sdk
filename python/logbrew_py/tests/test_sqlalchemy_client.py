from __future__ import annotations

import json
import sys
import unittest
from contextlib import contextmanager
from types import ModuleType, SimpleNamespace
from typing import Any

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    SdkError,
    get_active_logbrew_trace,
    instrument_sqlalchemy_engine_with_logbrew_spans,
    use_logbrew_trace,
)


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


class FakeSqlAlchemyEvent:
    def __init__(self) -> None:
        self.listeners: dict[str, list[Any]] = {}

    def listen(self, engine: object, event_name: str, listener: Any) -> None:
        self.listeners.setdefault(event_name, []).append(listener)

    def remove(self, engine: object, event_name: str, listener: Any) -> None:
        self.listeners[event_name].remove(listener)


@contextmanager
def fake_sqlalchemy_module() -> Any:
    existing = sys.modules.get("sqlalchemy")
    fake_event = FakeSqlAlchemyEvent()
    fake_sqlalchemy = ModuleType("sqlalchemy")
    fake_sqlalchemy.__dict__["event"] = fake_event
    sys.modules["sqlalchemy"] = fake_sqlalchemy
    try:
        yield fake_event
    finally:
        if existing is None:
            sys.modules.pop("sqlalchemy", None)
        else:
            sys.modules["sqlalchemy"] = existing


class SqlAlchemyEngineInstrumentationTests(unittest.TestCase):
    def test_engine_instrumentation_queues_privacy_bounded_span_and_reverts_trace(self) -> None:
        with fake_sqlalchemy_module() as fake_event:
            client = sample_client()
            engine = SimpleNamespace(
                name="sqlite",
                url=SimpleNamespace(
                    database="/sample/app.sqlite",
                    host="sample-db.example",
                    username="sample-user",
                ),
            )
            parent_trace = LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="00f067aa0ba902b7",
                sampled=True,
            )
            clock_values = iter([100.0, 100.014])

            with use_logbrew_trace(parent_trace):
                instrumentation = instrument_sqlalchemy_engine_with_logbrew_spans(
                    engine,
                    client=client,
                    event_id_factory=lambda: "evt_python_sqlalchemy_query",
                    timestamp="2026-06-29T08:00:00Z",
                    db_name="checkout",
                    span_id_factory=lambda: "b7ad6b7169203371",
                    clock=lambda: next(clock_values),
                    metadata={
                        "service": "checkout",
                        "queryParams": {"email": "private@example.test"},
                    },
                )

                duplicate = instrument_sqlalchemy_engine_with_logbrew_spans(
                    engine,
                    client=client,
                    event_id_factory=lambda: "evt_python_sqlalchemy_duplicate",
                )

                context = SimpleNamespace()
                fake_event.listeners["before_cursor_execute"][0](
                    None,
                    None,
                    "SELECT * FROM users WHERE email = :email",
                    {"email": "private@example.test"},
                    context,
                    False,
                )
                active_trace = get_active_logbrew_trace()
                self.assertEqual(
                    active_trace,
                    LogBrewTraceContext(
                        trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                        span_id="b7ad6b7169203371",
                        parent_span_id="00f067aa0ba902b7",
                        sampled=True,
                    ),
                )
                fake_event.listeners["after_cursor_execute"][0](
                    None,
                    SimpleNamespace(rowcount=4),
                    "SELECT * FROM users WHERE email = :email",
                    {"email": "private@example.test"},
                    context,
                    False,
                )
                self.assertEqual(get_active_logbrew_trace(), parent_trace)

            self.assertIs(duplicate, instrumentation)
            self.assertTrue(instrumentation.installed)
            self.assertEqual(len(fake_event.listeners["before_cursor_execute"]), 1)
            event = json.loads(client.preview_json())["events"][0]
            self.assertEqual(event["id"], "evt_python_sqlalchemy_query")
            self.assertEqual(event["attributes"]["name"], "sqlite SELECT")
            self.assertEqual(event["attributes"]["durationMs"], 14.0)
            metadata = event["attributes"]["metadata"]
            self.assertEqual(metadata["source"], "database")
            self.assertEqual(metadata["dbSystem"], "sqlite")
            self.assertEqual(metadata["dbOperation"], "SELECT")
            self.assertEqual(metadata["dbName"], "checkout")
            self.assertEqual(metadata["framework"], "sqlalchemy")
            self.assertEqual(metadata["rowCount"], 4)
            self.assertEqual(metadata["service"], "checkout")
            serialized = client.preview_json()
            self.assertNotIn("private@example.test", serialized)
            self.assertNotIn("queryParams", serialized)
            self.assertNotIn("SELECT * FROM users", serialized)
            self.assertNotIn("sample-db.example", serialized)
            self.assertNotIn("sample-user", serialized)
            self.assertNotIn("/sample/app.sqlite", serialized)

            instrumentation.uninstall()
            self.assertFalse(instrumentation.installed)
            self.assertEqual(fake_event.listeners["before_cursor_execute"], [])
            self.assertEqual(fake_event.listeners["after_cursor_execute"], [])
            self.assertEqual(fake_event.listeners["handle_error"], [])
            instrumentation.uninstall()

    def test_engine_instrumentation_records_error_type_without_message_or_sql(self) -> None:
        with fake_sqlalchemy_module() as fake_event:
            client = sample_client()
            engine = SimpleNamespace(name="postgresql")
            parent_trace = LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="00f067aa0ba902b7",
                sampled=True,
            )
            clock_values = iter([120.0, 120.009])

            class StubSqlAlchemyError(RuntimeError):
                pass

            with use_logbrew_trace(parent_trace):
                instrument_sqlalchemy_engine_with_logbrew_spans(
                    engine,
                    client=client,
                    event_id_factory=lambda: "evt_python_sqlalchemy_error",
                    timestamp="2026-06-29T08:00:01Z",
                    span_id_factory=lambda: "b7ad6b7169203372",
                    clock=lambda: next(clock_values),
                )
                context = SimpleNamespace()
                fake_event.listeners["before_cursor_execute"][0](
                    None,
                    None,
                    "INSERT INTO users(email) VALUES (:email)",
                    {"email": "private@example.test"},
                    context,
                    False,
                )
                result = fake_event.listeners["handle_error"][0](
                    SimpleNamespace(
                        execution_context=context,
                        original_exception=StubSqlAlchemyError("duplicate private@example.test"),
                    )
                )
                self.assertIsNone(result)
                self.assertEqual(get_active_logbrew_trace(), parent_trace)

            event = json.loads(client.preview_json())["events"][0]
            self.assertEqual(event["attributes"]["status"], "error")
            self.assertEqual(event["attributes"]["name"], "postgresql INSERT")
            self.assertEqual(event["attributes"]["metadata"]["errorType"], "StubSqlAlchemyError")
            self.assertEqual(
                event["attributes"]["events"],
                [
                    {
                        "name": "exception",
                        "metadata": {
                            "exceptionEscaped": True,
                            "exceptionType": "StubSqlAlchemyError",
                        },
                    }
                ],
            )
            serialized = client.preview_json()
            self.assertNotIn("private@example.test", serialized)
            self.assertNotIn("duplicate", serialized)
            self.assertNotIn("INSERT INTO users", serialized)

    def test_engine_instrumentation_reports_capture_failure_without_breaking_query(self) -> None:
        with fake_sqlalchemy_module() as fake_event:
            closed_client = sample_client()
            closed_client.closed = True
            capture_errors: list[str] = []
            instrument_sqlalchemy_engine_with_logbrew_spans(
                SimpleNamespace(name="sqlite"),
                client=closed_client,
                event_id_factory=lambda: "evt_python_sqlalchemy_capture_failure",
                span_id_factory=lambda: "b7ad6b7169203373",
                on_capture_error=lambda error: capture_errors.append(str(error)),
            )
            context = SimpleNamespace()
            fake_event.listeners["before_cursor_execute"][0](None, None, "SELECT 1", (), context, False)
            fake_event.listeners["after_cursor_execute"][0](
                None,
                SimpleNamespace(rowcount=-1),
                "SELECT 1",
                (),
                context,
                False,
            )

            self.assertEqual(len(capture_errors), 1)
            self.assertIn("client is already shut down", capture_errors[0])

    def test_engine_instrumentation_reverts_trace_when_context_state_cannot_be_stored(self) -> None:
        class LockedContext:
            __slots__ = ()

        with fake_sqlalchemy_module() as fake_event:
            capture_errors: list[str] = []
            parent_trace = LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="00f067aa0ba902b7",
                sampled=True,
            )
            instrument_sqlalchemy_engine_with_logbrew_spans(
                SimpleNamespace(name="sqlite"),
                client=sample_client(),
                event_id_factory=lambda: "evt_python_sqlalchemy_state_failure",
                span_id_factory=lambda: "b7ad6b7169203374",
                on_capture_error=lambda error: capture_errors.append(type(error).__name__),
            )

            with use_logbrew_trace(parent_trace):
                fake_event.listeners["before_cursor_execute"][0](
                    None,
                    None,
                    "SELECT 1",
                    (),
                    LockedContext(),
                    False,
                )
                self.assertEqual(get_active_logbrew_trace(), parent_trace)

            self.assertEqual(capture_errors, ["AttributeError"])

    def test_engine_instrumentation_requires_sqlalchemy_event_api(self) -> None:
        existing = sys.modules.get("sqlalchemy")
        sys.modules["sqlalchemy"] = ModuleType("sqlalchemy")
        try:
            with self.assertRaises(SdkError) as raised:
                instrument_sqlalchemy_engine_with_logbrew_spans(
                    SimpleNamespace(name="sqlite"),
                    client=sample_client(),
                )
        finally:
            if existing is not None:
                sys.modules["sqlalchemy"] = existing
            else:
                sys.modules.pop("sqlalchemy", None)

        self.assertEqual(raised.exception.code, "configuration_error")
