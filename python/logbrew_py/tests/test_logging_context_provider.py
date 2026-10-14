from __future__ import annotations

import asyncio
import copy
import json
import logging
import unittest
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from functools import cached_property
from threading import Barrier
from typing import cast

from logbrew_sdk import (
    LogBrewClient,
    LogBrewLoggingHandler,
    RecordingTransport,
    SdkError,
    TelemetryContext,
    TelemetryTraceContext,
    create_logbrew_trace_context,
    get_active_logbrew_trace,
    trace_metadata,
    use_logbrew_trace,
)

ContextProvider = Callable[[logging.LogRecord], TelemetryContext | None]


def make_client(context: TelemetryContext | None = None) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY", sdk_name="logging-context-consumer", sdk_version="1.0.0",
        capture_runtime_context=False, context=context,
    )


def make_record(message: str = "operation") -> logging.LogRecord:
    return logging.LogRecord("checkout.worker", logging.INFO, "/private/app.py", 42, message, (), None)


def attributes(client: LogBrewClient) -> list[dict[str, object]]:
    return [event["attributes"] for event in json.loads(client.preview_json())["events"]]


class ObservingHandler(LogBrewLoggingHandler):
    @cached_property
    def errors(self) -> list[logging.LogRecord]:
        return []

    def handleError(self, record: logging.LogRecord) -> None:
        self.errors.append(record)


class LoggingContextProviderTests(unittest.TestCase):
    def test_provider_runs_once_for_the_record_and_detaches_first_class_context(self) -> None:
        context: TelemetryContext = {"schemaVersion": 1, "tags": {"stage": "capture"}}
        records: list[logging.LogRecord] = []

        def provider(record: logging.LogRecord) -> TelemetryContext:
            records.append(record)
            return context

        client = make_client()
        handler = ObservingHandler(client, context_provider=provider)
        record = make_record()
        original = copy.deepcopy(record.__dict__)
        handler.emit(record)
        context["tags"]["stage"] = "changed"
        self.assertEqual(records, [record])
        self.assertEqual(record.__dict__, original)
        self.assertEqual(attributes(client)[0]["context"], {"schemaVersion": 1, "tags": {"stage": "capture"}})
        self.assertEqual(handler.errors, [])

    def test_default_ignores_dictionary_extras_and_none_provider_keeps_existing_behavior(self) -> None:
        for provider in (None, lambda record: None):
            with self.subTest(provider=provider):
                client = make_client()
                handler = ObservingHandler(client, context_provider=provider)
                handler.emit(make_record())
                self.assertNotIn("context", attributes(client)[0])
        client = make_client()
        record = make_record()
        record.context = {"schemaVersion": 1, "tags": {"stage": "explicit"}}
        ObservingHandler(client).emit(record)
        self.assertNotIn("context", attributes(client)[0])

    def test_explicit_record_context_overrides_provider_client_and_active_trace(self) -> None:
        client_context: TelemetryContext = {
            "schemaVersion": 1, "tags": {"stage": "client", "clientOnly": "kept"},
            "resource": {"service": {"name": "checkout", "version": "1"}},
        }
        provided: TelemetryContext = {
            "schemaVersion": 1, "tags": {"stage": "provider", "providerOnly": "kept"},
            "resource": {"service": {"name": "worker"}},
            "trace": {"traceId": "1" * 32, "spanId": "2" * 16},
        }
        explicit: TelemetryContext = {
            "schemaVersion": 1, "tags": {"stage": "explicit"},
            "trace": {"traceId": "3" * 32, "spanId": "4" * 16},
        }
        client = make_client(context=client_context)
        record = make_record()
        record.context = explicit
        originals = copy.deepcopy((client_context, provided, explicit, record.__dict__))
        with use_logbrew_trace(create_logbrew_trace_context()):
            ObservingHandler(client, context_provider=lambda record: provided).emit(record)
        context = cast(dict[str, object], attributes(client)[0]["context"])
        self.assertEqual(context["trace"], explicit["trace"])
        self.assertEqual(context["tags"], {"stage": "explicit", "clientOnly": "kept", "providerOnly": "kept"})
        self.assertEqual(context["resource"], {"service": {"name": "worker", "version": "1"}})
        self.assertEqual((client_context, provided, explicit, record.__dict__), originals)

    def test_callback_failure_follows_handle_error_without_capture_or_flush(self) -> None:
        calls = 0

        def provider(record: logging.LogRecord) -> TelemetryContext:
            nonlocal calls
            calls += 1
            if calls == 1:
                with use_logbrew_trace(create_logbrew_trace_context()):
                    raise RuntimeError("private callback detail")
            return {"schemaVersion": 1, "tags": {"stage": "recovered"}}

        client = make_client()
        transport = RecordingTransport.always_accept()
        handler = ObservingHandler(client, context_provider=provider, transport=transport, flush_on_emit=True)
        rejected = make_record("rejected")
        outer = create_logbrew_trace_context()
        with use_logbrew_trace(outer):
            handler.emit(rejected)
            self.assertIs(get_active_logbrew_trace(), outer)
        self.assertIsNone(get_active_logbrew_trace())
        self.assertEqual(handler.errors, [rejected])
        self.assertEqual(client.pending_events(), 0)
        self.assertEqual(transport.sent_bodies, [])
        handler.emit(make_record("recovered"))
        self.assertEqual(len(transport.sent_bodies), 1)
        self.assertNotIn("private callback detail", transport.sent_bodies[0])
        self.assertEqual(json.loads(transport.sent_bodies[0])["events"][0]["attributes"]["message"], "recovered")

    def test_provider_control_flow_interruptions_propagate_without_capture(self) -> None:
        for error in (KeyboardInterrupt(), SystemExit(7)):
            with self.subTest(error=type(error).__name__):
                self.check_interruption(error)

    def check_interruption(self, error: BaseException) -> None:
        def provider(record: logging.LogRecord) -> TelemetryContext:
            raise error

        client = make_client()
        handler = ObservingHandler(client, context_provider=provider)
        with self.assertRaises(type(error)) as caught:
            handler.emit(make_record())
        self.assertIs(caught.exception, error)
        self.assertEqual(handler.errors, [])
        self.assertEqual(client.pending_events(), 0)

    def test_invalid_provided_or_explicit_context_uses_existing_error_path(self) -> None:
        invalid = (
            {"schemaVersion": 2, "tags": {"stage": "invalid"}},
            {"schemaVersion": 1, "headers": {"authorization": "synthetic value"}},
            {"schemaVersion": 1, "trace": {"traceId": "0" * 32}},
            {"schemaVersion": 1, "tags": {f"tag{index}": "value" for index in range(33)}},
        )
        for context in invalid:
            with self.subTest(context=context):
                self.check_invalid(cast(TelemetryContext, context))

    def check_invalid(self, context: TelemetryContext) -> None:
        client = make_client()
        handler = ObservingHandler(client, context_provider=lambda record: context)
        record = make_record()
        handler.emit(record)
        self.assertEqual(handler.errors, [record])
        self.assertEqual(client.pending_events(), 0)
        handler = ObservingHandler(client, context_provider=lambda record: None)
        record.context = context
        handler.emit(record)
        self.assertEqual(handler.errors, [record])
        self.assertEqual(client.pending_events(), 0)

    def test_non_callable_provider_fails_during_configuration(self) -> None:
        with self.assertRaises(SdkError) as caught:
            LogBrewLoggingHandler(make_client(), context_provider=cast(ContextProvider, 7))
        self.assertEqual(caught.exception.code, "configuration_error")

    def test_threaded_records_keep_request_context_and_preserve_outer_scope(self) -> None:
        client = make_client()
        request_context: ContextVar[TelemetryContext | None] = ContextVar("request_context", default=None)
        handler = ObservingHandler(client, context_provider=lambda record: request_context.get())
        logger = logging.Logger("checkout.concurrent", logging.INFO)
        logger.addHandler(handler)
        barrier = Barrier(8)

        def request(index: int) -> tuple[str, str]:
            context: TelemetryContext = {"schemaVersion": 1, "tags": {"slot": str(index)}}
            reset_handle = request_context.set(context)
            trace = create_logbrew_trace_context()
            try:
                with use_logbrew_trace(trace):
                    barrier.wait(5)
                    logger.info("request %s", index)
            finally:
                request_context.reset(reset_handle)
            self.assertIsNone(request_context.get())
            self.assertIsNone(get_active_logbrew_trace())
            return str(index), trace.span_id

        with ThreadPoolExecutor(max_workers=8) as executor:
            expected = dict(executor.map(request, range(8)))
        self.assertEqual(len(attributes(client)), 8)
        for event in attributes(client):
            slot = cast(str, event["message"]).split()[-1]
            context = cast(dict[str, object], event["context"])
            self.assertEqual(context["tags"], {"slot": slot})
            self.assertEqual(cast(dict[str, object], context["trace"])["spanId"], expected[slot])
            self.assertEqual(cast(dict[str, object], event["metadata"])["spanId"], expected[slot])
        self.assertEqual(handler.errors, [])


class AsyncLoggingContextProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_nested_scopes_preserve_request_and_outer_context(self) -> None:
        client = make_client()
        provider_calls: list[logging.LogRecord] = []

        def provider(record: logging.LogRecord) -> TelemetryContext | None:
            provider_calls.append(record)
            trace = trace_metadata()
            return {"schemaVersion": 1, "trace": cast(TelemetryTraceContext, trace)} if trace else None

        handler = ObservingHandler(client, context_provider=provider)
        outer = create_logbrew_trace_context()
        expected: dict[str, str] = {}

        async def request(index: int) -> None:
            trace = create_logbrew_trace_context()
            nested = create_logbrew_trace_context()
            with use_logbrew_trace(trace):
                await asyncio.sleep(0)
                expected[f"request {index}"] = trace.span_id
                handler.emit(make_record(f"request {index}"))
                with use_logbrew_trace(nested):
                    await asyncio.sleep(0)
                    expected[f"nested {index}"] = nested.span_id
                    handler.emit(make_record(f"nested {index}"))
                self.assertIs(get_active_logbrew_trace(), trace)
            self.assertIs(get_active_logbrew_trace(), outer)

        with use_logbrew_trace(outer):
            await asyncio.gather(request(0), request(1))
            self.assertIs(get_active_logbrew_trace(), outer)
        self.assertIsNone(get_active_logbrew_trace())
        for event in attributes(client):
            context = cast(dict[str, object], event["context"])
            self.assertEqual(cast(dict[str, object], context["trace"])["spanId"], expected[cast(str, event["message"])])
        self.assertEqual(len(provider_calls), 4)
        self.assertEqual(handler.errors, [])
