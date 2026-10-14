from __future__ import annotations

import copy
import gc
import json
import logging
import multiprocessing
import unittest
import weakref
from concurrent.futures import ThreadPoolExecutor
from multiprocessing.connection import Connection
from threading import Barrier, Event, Thread

from logbrew_sdk import (
    LogBrewClient,
    LogBrewLoggingHandler,
    RecordingTransport,
    SdkError,
    _logging_identity,
    cache_operation_with_logbrew_span,
    create_logbrew_trace_context,
    default_log_record_event_id,
    get_active_logbrew_trace,
    use_logbrew_trace,
)


def make_record(index: int = 0) -> logging.LogRecord:
    record = logging.LogRecord("checkout.worker", logging.INFO, "/private/app.py", 42, "operation %s", (index,), None)
    record.created = 1_700_000_000.0
    return record


def make_client() -> LogBrewClient:
    return LogBrewClient.create(api_key="LOGBREW_API_KEY", sdk_name="logging-consumer", sdk_version="1.0.0")


class EqualRecord(logging.LogRecord):
    def __eq__(self, other: object) -> bool:
        return isinstance(other, logging.LogRecord)

    def __hash__(self) -> int:
        raise TypeError("unhashable type: 'EqualRecord'")


def child_identity(record: logging.LogRecord, connection: Connection[str, object]) -> None:
    try:
        connection.send(default_log_record_event_id(record))
    finally:
        connection.close()


class LoggingIdentityTests(unittest.TestCase):
    def test_distinct_records_at_one_logger_time_and_line_keep_distinct_ids(self) -> None:
        client = make_client()
        handler = LogBrewLoggingHandler(client)
        records = [make_record(index) for index in range(64)]
        for record in records:
            handler.handle(record)
        events = json.loads(client.preview_json())["events"]
        self.assertEqual(len(events), len(records))
        self.assertEqual(len({event["id"] for event in events}), len(records))

    def test_same_record_keeps_identity_across_handlers_and_attribute_changes(self) -> None:
        clients = [make_client(), make_client()]
        record = make_record()
        original = default_log_record_event_id(record)
        LogBrewLoggingHandler(clients[0]).handle(record)
        record.name = "another.logger"
        record.created += 1
        record.lineno += 1
        LogBrewLoggingHandler(clients[1]).handle(record)
        self.assertEqual(default_log_record_event_id(record), original)
        self.assertEqual([client.events[0]["id"] for client in clients], [original, original])

    def test_copies_and_caller_supplied_identity_values_do_not_merge_records(self) -> None:
        first = make_record()
        first.__dict__["_logbrew_event_id"] = "evt_same"
        first.__dict__["event_id"] = "evt_same"
        original = default_log_record_event_id(first)
        second = copy.copy(first)
        self.assertNotEqual(default_log_record_event_id(second), original)
        equal_records = [
            EqualRecord("checkout.worker", logging.INFO, "/private/app.py", 42, "operation", (), None) for _ in range(2)
        ]
        self.assertEqual(equal_records[0], equal_records[1])
        self.assertNotEqual(
            default_log_record_event_id(equal_records[0]), default_log_record_event_id(equal_records[1])
        )

    def test_concurrent_handler_fanout_keeps_one_identity_per_record(self) -> None:
        records = [make_record(index) for index in range(32)]
        barrier = Barrier(8)

        def capture(_index: int) -> list[str]:
            client = make_client()
            handler = LogBrewLoggingHandler(client)
            barrier.wait(timeout=5)
            for record in records:
                handler.handle(record)
            return [event["id"] for event in client.events]

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(capture, range(8)))
        self.assertEqual(len(set(results[0])), len(records))
        self.assertTrue(all(result == results[0] for result in results))

    def test_identity_does_not_add_metadata_or_retain_log_records(self) -> None:
        client = make_client()
        record = make_record()
        initial_keys = set(record.__dict__)
        LogBrewLoggingHandler(client).handle(record)
        event_id = client.events[0]["id"]
        self.assertRegex(event_id, r"^evt_log_[0-9a-f]{32}$")
        self.assertNotIn(record.name, event_id)
        self.assertNotIn(record.pathname, event_id)
        self.assertNotIn(record.getMessage(), event_id)
        self.assertEqual(set(record.__dict__), initial_keys)
        reference = weakref.ref(record)
        del record
        gc.collect()
        self.assertIsNone(reference())

    def test_handler_identity_and_child_correlation_survive_delivery_retry(self) -> None:
        client = make_client()
        handler = LogBrewLoggingHandler(client)
        record = make_record()
        trace = create_logbrew_trace_context()
        with use_logbrew_trace(trace):
            handler.handle(record)
            cache_operation_with_logbrew_span(
                "GET inventory",
                client=client,
                event_id="evt_cache_child",
                operation=lambda: True,
                system="memory-cache",
            )
        self.assertIsNone(get_active_logbrew_trace())
        payload = json.loads(client.preview_json())
        log, child = [event["attributes"] for event in payload["events"]]
        self.assertEqual(log["metadata"]["traceId"], trace.trace_id)
        self.assertEqual(log["metadata"]["spanId"], trace.span_id)
        self.assertEqual(child["traceId"], trace.trace_id)
        self.assertEqual(child["parentSpanId"], trace.span_id)
        transport = RecordingTransport([{"status_code": 401}, {"status_code": 202}])
        with self.assertRaises(SdkError):
            client.flush(transport)
        client.flush(transport)
        self.assertEqual(transport.sent_bodies[0], transport.sent_bodies[1])
        self.assertEqual(client.pending_events(), 0)

    @unittest.skipUnless("fork" in multiprocessing.get_all_start_methods(), "fork is unavailable")
    def test_record_identity_remains_usable_after_fork(self) -> None:
        record = make_record()
        expected = default_log_record_event_id(record)
        context = multiprocessing.get_context("fork")
        receiving, sending = context.Pipe(duplex=False)
        process = context.Process(target=child_identity, args=(record, sending))
        locked, release = Event(), Event()

        def hold_lock() -> None:
            with _logging_identity._cache.lock:
                locked.set()
                release.wait(5)

        worker = Thread(target=hold_lock)
        worker.start()
        self.assertTrue(locked.wait(5))
        try:
            process.start()
            sending.close()
            self.assertTrue(receiving.poll(5), "child identity lookup did not complete")
            self.assertEqual(receiving.recv(), expected)
            process.join(5)
            self.assertEqual(process.exitcode, 0)
        finally:
            release.set()
            worker.join(5)
            if process.is_alive():
                process.kill()
                process.join(5)
            receiving.close()


if __name__ == "__main__":
    unittest.main()
