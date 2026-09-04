from __future__ import annotations

import json
import logging
import unittest
from collections import Counter, defaultdict
from collections.abc import Callable
from typing import Any, cast

import logbrew_sdk
from logbrew_sdk import LogBrewClient, SdkError

dramatiq: Any = None
StubBroker: Any = None
try:
    import dramatiq as _dramatiq
    from dramatiq.brokers.stub import StubBroker as _StubBroker
except ImportError:
    pass
else:
    dramatiq, StubBroker = _dramatiq, _StubBroker


_LOGGER = logging.getLogger("logbrew.tests.dramatiq.jobs")


def _run_jobs(broker: Any, actor: Any, expected: Any, explicit_retry: Any) -> None:
    worker = dramatiq.Worker(broker, worker_threads=1)
    worker.start()
    try:
        for value in ("PRIVATE_SUCCESS", "PRIVATE_RETRY", "PRIVATE_TERMINAL"):
            actor.send(value)
        expected.send()
        explicit_retry.send()
        broker.join(actor.queue_name, fail_fast=False, timeout=5_000)
    finally:
        worker.stop()
        worker.join()


@unittest.skipIf(dramatiq is None, "Dramatiq test dependency is not installed")
class DramatiqInstrumentationTests(unittest.TestCase):
    def _assert_event_receipt(
        self,
        client: LogBrewClient,
        lifecycle_errors: list[SdkError],
    ) -> None:
        events = json.loads(client.preview_json())["events"]
        self.assertEqual(
            Counter(event["type"] for event in events),
            {"span": 13, "log": 8, "issue": 1},
        )
        spans = [event["attributes"] for event in events if event["type"] == "span"]
        by_trace: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for span in spans:
            by_trace[span["traceId"]].append(span)
        self.assertEqual(sorted(map(len, by_trace.values())), [2, 2, 3, 3, 3])
        for trace_spans in by_trace.values():
            publish = next(
                span
                for span in trace_spans
                if span["metadata"]["queueOperationKind"] == "publish"
            )
            process = [
                span
                for span in trace_spans
                if span["metadata"]["queueOperationKind"] == "process"
            ]
            self.assertEqual(process[0]["parentSpanId"], publish["spanId"])
            if len(process) == 2:
                self.assertEqual(process[1]["parentSpanId"], process[0]["spanId"])
        issue = next(event["attributes"] for event in events if event["type"] == "issue")
        terminal = next(
            span for span in spans if span["spanId"] == issue["metadata"]["spanId"]
        )
        self.assertEqual(issue["metadata"]["traceId"], terminal["traceId"])
        self.assertEqual(
            issue["exception"]["mechanism"],
            {"type": "dramatiq.job", "handled": False},
        )
        self.assertEqual(len(lifecycle_errors), 8)
        self.assertTrue(
            all("while a job is running" in error.message for error in lifecycle_errors)
        )
        payload = client.preview_json()
        for private in (
            "PRIVATE_SUCCESS",
            "PRIVATE_RETRY",
            "PRIVATE_TERMINAL",
            "PRIVATE_TRANSIENT_EXCEPTION",
            "PRIVATE_TERMINAL_EXCEPTION",
            "PRIVATE_EXPECTED_EXCEPTION",
            "PRIVATE_EXPLICIT_RETRY",
            "PRIVATE_METADATA",
            "jobArgs",
        ):
            self.assertNotIn(private, payload)

    def test_real_worker_correlates_retries_logs_and_terminal_issue(self) -> None:
        instrument = cast(
            Callable[..., Any],
            getattr(logbrew_sdk, "instrument_dramatiq_broker_with_logbrew_spans", None),
        )
        self.assertTrue(callable(instrument), "Dramatiq instrumentation is not exported")
        broker = StubBroker()
        broker.emit_after("process_boot")
        client = LogBrewClient.create(
            api_key="LOGBREW_API_KEY",
            sdk_name="logbrew-python-dramatiq",
            sdk_version="0.1.0",
            automatic_delivery=False,
        )
        attempts: Counter[str] = Counter()
        lifecycle_errors: list[SdkError] = []
        instrumentation: Any = None

        def reject_uninstall() -> None:
            try:
                instrumentation.uninstall()
            except SdkError as error:
                lifecycle_errors.append(error)

        def job(private_argument: str) -> None:
            attempts[private_argument] += 1
            _LOGGER.info("Dramatiq job reached worker")
            reject_uninstall()
            if private_argument == "PRIVATE_RETRY" and attempts[private_argument] == 1:
                raise RuntimeError("PRIVATE_TRANSIENT_EXCEPTION")
            if private_argument == "PRIVATE_TERMINAL":
                raise RuntimeError("PRIVATE_TERMINAL_EXCEPTION")

        def expected_job() -> None:
            _LOGGER.info("Expected Dramatiq failure reached worker")
            reject_uninstall()
            raise ValueError("PRIVATE_EXPECTED_EXCEPTION")

        def explicit_retry_job() -> None:
            attempts["PRIVATE_EXPLICIT_RETRY"] += 1
            _LOGGER.info("Explicit Dramatiq retry reached worker")
            reject_uninstall()
            if attempts["PRIVATE_EXPLICIT_RETRY"] == 1:
                raise dramatiq.Retry(delay=0)

        actor = dramatiq.actor(
            job,
            broker=broker,
            actor_name="logbrew_dramatiq_job",
            queue_name="orders",
            max_retries=1,
            min_backoff=0,
            max_backoff=0,
        )
        expected_actor = dramatiq.actor(
            expected_job,
            broker=broker,
            actor_name="logbrew_expected_dramatiq_job",
            throws=(ValueError,),
        )
        explicit_retry_actor = dramatiq.actor(
            explicit_retry_job,
            broker=broker,
            actor_name="logbrew_explicit_retry_job",
            max_retries=1,
        )
        original_enqueue = broker.enqueue
        original_level = _LOGGER.level
        instrumentation = instrument(
            broker,
            client=client,
            logger_names=[_LOGGER.name],
            metadata={"service": "order-worker", "jobArgs": "PRIVATE_METADATA"},
        )
        self.assertIs(instrument(broker, client=client), instrumentation)
        _LOGGER.setLevel(logging.INFO)
        try:
            _run_jobs(broker, actor, expected_actor, explicit_retry_actor)
        finally:
            _LOGGER.setLevel(original_level)

        self._assert_event_receipt(client, lifecycle_errors)

        instrumentation.uninstall()
        self.assertFalse(instrumentation.installed)
        self.assertEqual(broker.enqueue, original_enqueue)
        self.assertNotIn(instrumentation, broker.middleware)

    def test_failure_is_terminal_without_retries_middleware(self) -> None:
        broker = StubBroker()
        retries = next(item for item in broker.middleware if type(item).__name__ == "Retries")
        broker.middleware.remove(retries)
        client = LogBrewClient.create(
            api_key="LOGBREW_API_KEY",
            sdk_name="logbrew-python-dramatiq",
            sdk_version="0.1.0",
            automatic_delivery=False,
        )
        instrumentation = logbrew_sdk.instrument_dramatiq_broker_with_logbrew_spans(
            broker,
            client=client,
        )
        message = dramatiq.Message("jobs", "missing_actor", (), {}, {})
        instrumentation.before_process_message(broker, message)
        instrumentation.after_process_message(
            broker,
            message,
            exception=RuntimeError("PRIVATE_NO_RETRIES_FAILURE"),
        )
        events = json.loads(client.preview_json())["events"]
        self.assertEqual(Counter(event["type"] for event in events), {"span": 1, "issue": 1})
        self.assertNotIn("PRIVATE_NO_RETRIES_FAILURE", client.preview_json())
        instrumentation.uninstall()


if __name__ == "__main__":
    unittest.main()
