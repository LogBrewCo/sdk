from __future__ import annotations

import json
import logging
import os
import unittest
from collections import Counter
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, ClassVar

import queue_framework_contract as contract
from logbrew_sdk import (
    LogBrewClient,
    RecordingTransport,
    TransportResponse,
    instrument_rq_queue_with_logbrew_spans,
    instrument_rq_worker_processes_with_logbrew,
    rq_operation_with_logbrew_span,
)

try:
    import fakeredis
    from redis import Redis
    from rq import Queue, Retry, SimpleWorker, Worker
except ImportError:
    fakeredis = Queue = Redis = Retry = SimpleWorker = Worker = None  # type: ignore[assignment,misc]


_JOB_LOGGER = logging.getLogger("logbrew.tests.rq.jobs")


def successful_rq_job(private_argument: str) -> None:
    _JOB_LOGGER.info("RQ job reached worker")


def failing_rq_job(private_argument: str) -> None:
    _JOB_LOGGER.info("RQ job reached worker")
    raise RuntimeError("PRIVATE_RQ_EXCEPTION")


class FileTransport:
    def __init__(self, path: Path) -> None:
        self.path = path

    def send(self, api_key: str, body: str) -> TransportResponse:
        with self.path.open("a") as receipts:
            receipts.write(json.dumps(body) + "\n")
        return TransportResponse(status_code=202, attempts=1)


class StubRqJob:
    func_name = "checkout.send_email"
    origin = "emails"
    args = ("raw-order-id",)
    kwargs: ClassVar[dict[str, str]] = {"payload": "raw job body"}


def sample_client() -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
    )


def assert_worker_parentage(
    test: unittest.TestCase,
    publish_spans: list[dict[str, Any]],
    process_spans: list[dict[str, Any]],
    logs: list[dict[str, Any]] | None = None,
) -> None:
    for process in process_spans:
        attributes = process["attributes"]
        parent = next(
            event
            for event in publish_spans
            if event["attributes"]["traceId"] == attributes["traceId"]
        )
        test.assertEqual(attributes["parentSpanId"], parent["attributes"]["spanId"])
        if logs is not None:
            job_log = next(
                event
                for event in logs
                if event["attributes"]["metadata"]["traceId"] == attributes["traceId"]
                and event["attributes"]["metadata"]["spanId"] == attributes["spanId"]
            )
            test.assertEqual(
                job_log["attributes"]["metadata"]["spanId"], attributes["spanId"]
            )


class RqOperationSpanTests(contract.QueueFrameworkContract):
    framework = "rq"
    object_parameter = "job"
    queue_name = "emails"
    operation = staticmethod(rq_operation_with_logbrew_span)
    entity_factory = staticmethod(StubRqJob)
    private_values = ("raw-order-id", "raw job body")

    @unittest.skipUnless(
        os.getenv("LOGBREW_RQ_REDIS_URL"), "real Redis fork test is not configured"
    )
    def test_default_worker_fork_preserves_correlation_and_flushes_child_client(
        self,
    ) -> None:
        connection = Redis.from_url(os.environ["LOGBREW_RQ_REDIS_URL"])
        connection.flushdb()
        self.addCleanup(connection.flushdb)
        queue = Queue("fork-jobs", connection=connection)
        producer = sample_client()
        with TemporaryDirectory() as directory:
            receipts = Path(directory, "worker.jsonl")

            def worker_client() -> LogBrewClient:
                return LogBrewClient.create(
                    api_key="LOGBREW_API_KEY",
                    sdk_name="logbrew-python-rq-worker",
                    sdk_version="0.1.0",
                    transport=FileTransport(receipts),
                    automatic_delivery=False,
                )

            worker = Worker([queue], connection=connection)
            logging.getLogger(_JOB_LOGGER.name).setLevel(logging.INFO)
            instrument_rq_queue_with_logbrew_spans(queue, client=producer)
            instrument_rq_worker_processes_with_logbrew(
                worker,
                client_factory=worker_client,
                logger_names=[_JOB_LOGGER.name],
            )
            for task in (successful_rq_job, failing_rq_job):
                queue.enqueue(task, "PRIVATE_RQ_ARGUMENT")
            self.assertTrue(worker.work(burst=True, logging_level="CRITICAL"))
            worker_events = [
                event
                for line in receipts.read_text().splitlines()
                for event in json.loads(json.loads(line))["events"]
            ]

        publish_spans = json.loads(producer.preview_json())["events"]
        process_spans = [event for event in worker_events if event["type"] == "span"]
        logs = [event for event in worker_events if event["type"] == "log"]
        self.assertEqual(
            Counter(event["type"] for event in worker_events),
            {"span": 2, "log": 2, "issue": 1},
        )
        assert_worker_parentage(self, publish_spans, process_spans, logs)

    @unittest.skipIf(Queue is None, "RQ test dependencies are not installed")
    def test_instrumentation_correlates_real_producer_worker_logs_and_failure(
        self,
    ) -> None:
        producer = sample_client()
        transports: list[RecordingTransport] = []

        def worker_client() -> LogBrewClient:
            transport = RecordingTransport.always_accept()
            transports.append(transport)
            return LogBrewClient.create(
                api_key="LOGBREW_API_KEY",
                sdk_name="logbrew-python-rq-worker",
                sdk_version="0.1.0",
                transport=transport,
                automatic_delivery=False,
            )

        connection = fakeredis.FakeRedis()
        queue = Queue("jobs", connection=connection)
        worker = SimpleWorker([queue], connection=connection)
        original_enqueue, original_perform = queue.enqueue_job, worker.perform_job
        previous_level = _JOB_LOGGER.level
        _JOB_LOGGER.setLevel(logging.INFO)
        self.addCleanup(_JOB_LOGGER.setLevel, previous_level)
        producer_instrumentation = instrument_rq_queue_with_logbrew_spans(
            queue, client=producer
        )
        worker_instrumentation = instrument_rq_worker_processes_with_logbrew(
            worker,
            client_factory=worker_client,
            logger_names=[_JOB_LOGGER.name],
            metadata={"service": "rq-worker", "jobArgs": "PRIVATE_RQ_METADATA"},
        )
        self.assertIs(
            instrument_rq_queue_with_logbrew_spans(queue, client=producer),
            producer_instrumentation,
        )
        self.assertIs(
            instrument_rq_worker_processes_with_logbrew(
                worker, client_factory=worker_client
            ),
            worker_instrumentation,
        )

        queue.enqueue(successful_rq_job, "PRIVATE_RQ_ARGUMENT")
        queue.enqueue(failing_rq_job, "PRIVATE_RQ_ARGUMENT", retry=Retry(max=1))
        self.assertTrue(worker.work(burst=True, logging_level="CRITICAL"))

        producer_events = json.loads(producer.preview_json())["events"]
        worker_events = [
            event
            for transport in transports
            for event in json.loads(transport.last_body() or "{}").get("events", [])
        ]
        publish_spans = [event for event in producer_events if event["type"] == "span"]
        process_spans = [event for event in worker_events if event["type"] == "span"]
        logs = [event for event in worker_events if event["type"] == "log"]
        issues = [event for event in worker_events if event["type"] == "issue"]
        self.assertEqual(
            Counter(event["type"] for event in worker_events),
            {"span": 3, "log": 3, "issue": 1},
        )
        self.assertEqual(len(publish_spans), 2)
        assert_worker_parentage(self, publish_spans, process_spans, logs)
        issue = issues[0]["attributes"]
        failure_span = next(
            event
            for event in process_spans
            if event["attributes"]["spanId"] == issue["metadata"]["spanId"]
        )
        self.assertEqual(
            issue["exception"]["mechanism"], {"type": "rq.job", "handled": False}
        )
        self.assertEqual(
            issue["metadata"]["traceId"], failure_span["attributes"]["traceId"]
        )
        self.assertEqual(
            issue["metadata"]["spanId"], failure_span["attributes"]["spanId"]
        )
        self.assertEqual(
            issue["exceptionChain"]["entries"][0]["messageState"], "redacted"
        )
        payload = json.dumps([producer_events, worker_events])
        for private_value in (
            "PRIVATE_RQ_ARGUMENT",
            "PRIVATE_RQ_EXCEPTION",
            "PRIVATE_RQ_METADATA",
            "jobArgs",
        ):
            self.assertNotIn(private_value, payload)

        producer_instrumentation.uninstall()
        worker_instrumentation.uninstall()
        self.assertFalse(producer_instrumentation.installed)
        self.assertFalse(worker_instrumentation.installed)
        self.assertEqual(queue.enqueue_job, original_enqueue)
        self.assertEqual(worker.perform_job, original_perform)


if __name__ == "__main__":
    unittest.main()
