from __future__ import annotations

import asyncio
import json
import logging
import unittest
from collections import Counter
from contextlib import nullcontext
from itertools import product
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    SdkError,
    get_active_logbrew_trace,
    instrument_arq_pool_with_logbrew_spans,
    instrument_arq_worker_with_logbrew_spans,
    use_logbrew_trace,
)

try:
    from arq.connections import ArqRedis
    from arq.constants import abort_jobs_ss, job_key_prefix, result_key_prefix
    from arq.utils import timestamp_ms
    from arq.worker import JobExecutionFailed, Retry, RetryJob, create_worker, func
    from fakeredis.aioredis import FakeRedis
    from redis.asyncio.connection import ConnectionPool
except ImportError:
    ArqRedis = FakeRedis = Retry = create_worker = func = timestamp_ms = None  # type: ignore[assignment,misc]
    JobExecutionFailed = RetryJob = None  # type: ignore[assignment,misc]
    abort_jobs_ss = job_key_prefix = result_key_prefix = ""

_LOGGER = logging.getLogger("logbrew.tests.arq.jobs")


def client(name: str) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name=name,
        sdk_version="0.1.0",
        automatic_delivery=False,
    )


async def successful_job(ctx: dict[str, Any], private_argument: str) -> None:
    _LOGGER.info("ARQ job reached worker")


async def failing_job(ctx: dict[str, Any], private_argument: str) -> None:
    _LOGGER.info("ARQ job reached worker")
    raise RuntimeError("PRIVATE_ARQ_EXCEPTION")


async def retrying_job(ctx: dict[str, Any], private_argument: str) -> None:
    _LOGGER.info("ARQ job reached worker")
    if ctx["job_try"] == 1:
        raise Retry(defer=0)


@unittest.skipIf(ArqRedis is None, "ARQ test dependencies are not installed")
class ArqInstrumentationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        fake = FakeRedis()
        connection_pool = fake.connection_pool
        assert isinstance(connection_pool, ConnectionPool)
        self.pool = ArqRedis(pool_or_conn=connection_pool)

        settings: dict[str, Any] = {
            "functions": [
                successful_job,
                failing_job,
                retrying_job,
            ],
            "redis_pool": self.pool,
            "max_tries": 2,
        }
        self.worker = create_worker(settings)
        self.producer, self.consumer = client("arq-producer"), client("arq-worker")
        previous_level = _LOGGER.level
        _LOGGER.setLevel(logging.INFO)
        self.addCleanup(_LOGGER.setLevel, previous_level)

    async def asyncTearDown(self) -> None:
        for instance, attribute in (
            (self.worker, "_logbrew_arq_worker_instrumentation"),
            (self.pool, "_logbrew_arq_pool_instrumentation"),
        ):
            instrumentation = getattr(instance, attribute, None)
            if instrumentation is not None:
                instrumentation.uninstall()
        await self.worker.close()

    async def test_real_jobs_correlate_spans_logs_retries_and_terminal_issue(
        self,
    ) -> None:
        producer = instrument_arq_pool_with_logbrew_spans(
            self.pool,
            client=self.producer,
            metadata={"jobArgs": "PRIVATE_ARQ_METADATA"},
            wall_clock=lambda: 1_000.0,
        )
        worker = instrument_arq_worker_with_logbrew_spans(
            self.worker,
            client=self.consumer,
            logger_names=[_LOGGER.name],
            metadata={"service": "arq-worker", "jobArgs": "PRIVATE_ARQ_METADATA"},
            wall_clock=lambda: 1_000.2,
        )
        self.assertIs(
            instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer),
            producer,
        )
        self.assertIs(
            instrument_arq_worker_with_logbrew_spans(self.worker, client=self.consumer),
            worker,
        )

        jobs = {
            name: await self.pool.enqueue_job(name, "PRIVATE_ARQ_ARGUMENT")
            for name in ("successful_job", "failing_job", "retrying_job")
        }
        for name, job in jobs.items():
            assert job is not None
            await self.worker.run_job(job.job_id, timestamp_ms())
            if name == "retrying_job":
                await self.worker.run_job(job.job_id, timestamp_ms())

        producer_events = json.loads(self.producer.preview_json())["events"]
        worker_events = json.loads(self.consumer.preview_json())["events"]
        publish = [event for event in producer_events if event["type"] == "span"]
        process = [event for event in worker_events if event["type"] == "span"]
        logs = [event for event in worker_events if event["type"] == "log"]
        issues = [event for event in worker_events if event["type"] == "issue"]
        self.assertEqual((len(publish), len(process)), (3, 4))
        self.assertEqual(
            Counter(event["type"] for event in worker_events),
            {"span": 4, "log": 4, "issue": 1},
        )
        for child in process:
            attributes = child["attributes"]
            parent = next(
                event
                for event in publish
                if event["attributes"]["traceId"] == attributes["traceId"]
            )["attributes"]
            self.assertEqual(attributes["parentSpanId"], parent["spanId"])
            self.assertEqual(attributes["metadata"]["queueWaitMs"], 200)
            self.assertIn(attributes["metadata"]["attempt"], (1, 2))
            self.assertTrue(
                any(
                    log["attributes"]["context"]["trace"]["spanId"] == attributes["spanId"]
                    for log in logs
                )
            )
        issue = issues[0]["attributes"]
        self.assertEqual(
            issue["exception"]["mechanism"], {"type": "arq.job", "handled": False}
        )
        self.assertEqual(issue["message"], "RuntimeError")
        self.assertEqual(
            issue["exceptionChain"]["entries"][0]["messageState"], "redacted"
        )
        self.assertTrue(issue["stackFrames"])
        failed_span = next(
            event["attributes"]
            for event in process
            if event["attributes"]["spanId"] == issue["metadata"]["spanId"]
        )
        self.assertEqual(issue["context"]["trace"]["traceId"], failed_span["traceId"])
        serialized = json.dumps([producer_events, worker_events])
        for private in (
            "PRIVATE_ARQ_ARGUMENT",
            "PRIVATE_ARQ_EXCEPTION",
            "PRIVATE_ARQ_METADATA",
            "jobArgs",
        ):
            self.assertNotIn(private, serialized)

        original_enqueue, original_run = producer._enqueue_job, worker._run_job
        producer.uninstall()
        worker.uninstall()
        self.assertEqual(self.pool.enqueue_job, original_enqueue)
        self.assertEqual(self.worker.run_job, original_run)

    async def test_worker_only_creates_root_span_and_direct_calls_stay_uninstrumented(
        self,
    ) -> None:
        functions = self.worker.functions
        function = self.worker.functions["successful_job"]
        instrumentation = instrument_arq_worker_with_logbrew_spans(
            self.worker,
            client=self.consumer,
            logger_names=[_LOGGER.name],
        )
        self.assertIs(function.coroutine, successful_job)
        await function.coroutine({"job_try": 1}, "PRIVATE_DIRECT_ARGUMENT")
        await self.worker.functions["successful_job"].coroutine(
            {"job_try": 1}, "PRIVATE_DIRECT_ARGUMENT"
        )
        self.assertEqual(self.consumer.events, [])

        job = await self.pool.enqueue_job("successful_job", "PRIVATE_ARQ_ARGUMENT")
        assert job is not None
        await self.worker.run_job(job.job_id, timestamp_ms())
        events = self.consumer.events
        self.assertEqual(
            Counter(event["type"] for event in events), {"log": 1, "span": 1}
        )
        span = next(event["attributes"] for event in events if event["type"] == "span")
        self.assertNotIn("parentSpanId", span)
        self.assertEqual(span["metadata"]["taskName"], "successful_job")
        instrumentation.uninstall()
        self.assertIs(self.worker.functions, functions)

    async def test_pre_execution_failures_keep_evidence_without_retained_results(self) -> None:
        instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer)
        instrument_arq_worker_with_logbrew_spans(self.worker, client=self.consumer)
        self.worker.keep_result_s = 0
        for mode, task, error_type, linked in (
            ("unregistered", "unregistered_task", "JobExecutionFailed", True),
            ("unreadable", "successful_job", "DeserializationError", False),
            ("expired", "successful_job", "JobExecutionFailed", False),
            ("exhausted", "successful_job", "JobExecutionFailed", True),
        ):
            with self.subTest(mode=mode):
                before = len(self.consumer.events)
                job = await self.pool.enqueue_job(
                    task, "PRIVATE_ARQ_ARGUMENT", _job_try=3 if mode == "exhausted" else 1,
                )
                assert job is not None
                if mode == "unreadable":
                    await self.pool.set(job_key_prefix + job.job_id, b"PRIVATE_ARQ_UNREADABLE")
                elif mode == "expired":
                    await self.pool.delete(job_key_prefix + job.job_id)
                ambient = LogBrewTraceContext("a" * 32, "b" * 16)
                with use_logbrew_trace(ambient):
                    await self.worker.run_job(job.job_id, timestamp_ms())
                self.assertIsNone(await job.result_info())
                events = self.consumer.events[before:]
                self.assertEqual(Counter(event["type"] for event in events), {"issue": 1, "span": 1})
                issue, span = (next(event["attributes"] for event in events if event["type"] == kind)
                               for kind in ("issue", "span"))
                self.assertEqual(issue["message"], error_type)
                self.assertEqual(span["status"], "error")
                self.assertEqual(span["metadata"]["errorType"], error_type)
                for attributes in (issue, span):
                    self.assertEqual(attributes["metadata"]["queueFailureStage"], "before_execution")
                    self.assertEqual(attributes["metadata"]["attempt"], 3 if mode == "exhausted" else 1)
                self.assertEqual(issue["context"]["trace"]["traceId"], span["traceId"])
                self.assertEqual(issue["context"]["trace"]["spanId"], span["spanId"])
                parent = self.producer.events[-1]["attributes"]
                if linked:
                    self.assertEqual(span["traceId"], parent["traceId"])
                    self.assertEqual(span["parentSpanId"], parent["spanId"])
                else:
                    self.assertNotIn("parentSpanId", span)
                    self.assertNotEqual(span["traceId"], parent["traceId"])
                    self.assertNotEqual(span["traceId"], ambient.trace_id)
                self.assertNotIn("PRIVATE_ARQ", json.dumps(events))
        self.assertEqual((self.worker.jobs_failed, self.worker.jobs_complete), (4, 0))
        self.assertIsNone(get_active_logbrew_trace())

    async def test_abort_before_execution_records_only_a_span(self) -> None:
        self.worker.allow_abort_jobs = True
        instrument_arq_worker_with_logbrew_spans(self.worker, client=self.consumer)
        job = await self.pool.enqueue_job("successful_job", "PRIVATE_ARQ_ARGUMENT")
        assert job is not None
        await self.pool.zadd(abort_jobs_ss, {job.job_id: timestamp_ms()})
        await self.worker.run_job(job.job_id, timestamp_ms())
        self.assertEqual(Counter(event["type"] for event in self.consumer.events), {"span": 1})
        self.assertEqual(self.consumer.events[0]["attributes"]["metadata"]["errorType"], "CancelledError")
        self.assertEqual(self.worker.jobs_failed, 1)

    async def test_task_execution_failure_is_terminal_but_retryjob_is_not(self) -> None:
        for error, retries, expected in (
            (JobExecutionFailed("PRIVATE_ARQ_TERMINAL"), True, {"issue": 1, "span": 1}),
            (RetryJob(), True, {"span": 1}),
            (Retry(), False, {"issue": 1, "span": 1}),
            (RetryJob(), False, {"issue": 1, "span": 1}),
        ):
            with self.subTest(error=type(error).__name__, retries=retries):
                self.worker.retry_jobs = retries

                async def task(ctx: dict[str, Any], *, failure: Exception = error) -> None:
                    raise failure

                self.worker.functions["task"] = func(task)
                instrumented = instrument_arq_worker_with_logbrew_spans(self.worker, client=self.consumer)
                try:
                    before = len(self.consumer.events)
                    job = await self.pool.enqueue_job("task")
                    assert job is not None
                    await self.worker.run_job(job.job_id, timestamp_ms())
                    self.assertEqual(Counter(event["type"] for event in self.consumer.events[before:]), expected)
                finally:
                    instrumented.uninstall()
        self.assertEqual((self.worker.jobs_failed, self.worker.jobs_retried), (3, 1))
        self.assertNotIn("PRIVATE_ARQ_TERMINAL", self.consumer.preview_json())

    async def test_start_hook_failure_is_preserved_and_correlated(self) -> None:
        error = RuntimeError("PRIVATE_ARQ_START")
        self.worker.on_job_start = AsyncMock(side_effect=error)
        instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer)
        instrument_arq_worker_with_logbrew_spans(self.worker, client=self.consumer)
        job = await self.pool.enqueue_job("successful_job", "PRIVATE_ARQ_ARGUMENT")
        assert job is not None
        with self.assertRaises(RuntimeError) as raised:
            await self.worker.run_job(job.job_id, timestamp_ms())
        self.assertIs(raised.exception, error)
        self.assertEqual(Counter(event["type"] for event in self.consumer.events), {"issue": 1, "span": 1})
        span = self.consumer.events[-1]["attributes"]
        self.assertEqual(span["traceId"], self.producer.events[0]["attributes"]["traceId"])
        self.assertEqual(span["metadata"]["taskName"], "successful_job")
        self.assertEqual(span["metadata"]["queueFailureStage"], "before_execution")
        self.assertNotIn("PRIVATE_ARQ", self.consumer.preview_json())

    def test_worker_error_observer_preserves_logging_fallback(self) -> None:
        worker_logger = logging.getLogger("arq.worker")
        fallback = Mock(level=logging.WARNING)
        with (
            patch.object(worker_logger, "handlers", []),
            patch.object(worker_logger, "filters", []),
            patch.object(worker_logger, "propagate", False),
            patch.object(logging, "lastResort", fallback),
        ):
            instrumented = instrument_arq_worker_with_logbrew_spans(self.worker, client=self.consumer)
            try:
                worker_logger.error("ARQ standalone logging control")
                fallback.handle.assert_called_once()
                self.assertEqual(self.consumer.events, [])
            finally:
                instrumented.uninstall()
            self.assertEqual((worker_logger.handlers, worker_logger.filters), ([], []))

    async def test_post_job_hook_failures_keep_task_results_and_capture_own_evidence(self) -> None:
        instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer)
        error_type: type[BaseException]
        for hook_name, task_name, error_type in product(
            ("on_job_end", "after_job_end"), ("successful_job", "failing_job"), (Retry, asyncio.CancelledError),
        ):
            with self.subTest(hook=hook_name, task=task_name, error=error_type):
                original_error = error_type()
                hook_traces: list[LogBrewTraceContext | None] = []

                async def hook(
                    ctx: dict[str, Any], traces: list[LogBrewTraceContext | None] = hook_traces,
                    error: BaseException = original_error,
                ) -> None:
                    traces.append(get_active_logbrew_trace())
                    _LOGGER.info("ARQ post-job hook reached")
                    raise error

                before = len(self.consumer.events)
                retried = self.worker.jobs_retried
                with patch.object(self.worker, hook_name, hook):
                    instrumentation = instrument_arq_worker_with_logbrew_spans(
                        self.worker, client=self.consumer, logger_names=[_LOGGER.name],
                        clock=Mock(side_effect=[10.0, 11.0, 12.0, 13.0, 14.0]),
                    )
                    try:
                        job = await self.pool.enqueue_job(task_name, "PRIVATE_ARQ_ARGUMENT")
                        assert job is not None
                        with self.assertRaises(error_type) as raised:
                            await self.worker.run_job(job.job_id, timestamp_ms())
                        self.assertIs(raised.exception, original_error)
                    finally:
                        instrumentation.uninstall()
                    self.assertIs(getattr(self.worker, hook_name), hook)
                events = self.consumer.events[before:]
                failed_task = task_name == "failing_job"
                self.assertEqual(
                    Counter(event["type"] for event in events),
                    Counter({"log": 2, "span": 2, "issue": int(failed_task) + int(error_type is Retry)}),
                )
                spans = [event["attributes"] for event in events if event["type"] == "span"]
                task_span, hook_span = spans
                self.assertEqual(task_span["status"], "error" if failed_task else "ok")
                self._assert_hook_span(events, task_span, hook_name, "error")
                self.assertEqual([span["durationMs"] for span in spans], [1_000, 1_000])
                self.assertEqual(hook_span["metadata"]["queueHook"], hook_name)
                self.assertEqual(hook_span["metadata"]["queueFailureStage"], "after_execution")
                self.assertEqual(hook_traces[0].span_id if hook_traces[0] else None, hook_span["spanId"])
                if error_type is Retry:
                    issue = next(event["attributes"] for event in events if event["type"] == "issue"
                                 and event["attributes"]["metadata"].get("queueHook") == hook_name)
                    self.assertEqual(issue["exception"]["mechanism"], {"type": "arq.hook", "handled": False})
                    self.assertEqual(issue["title"], f"ARQ hook {hook_name} failed")
                    self.assertEqual(issue["metadata"]["spanId"], hook_span["spanId"])
                    self.assertEqual(issue["metadata"]["hookState"], "failure")
                    self.assertNotIn("taskState", issue["metadata"])
                    self.assertTrue(any(frame.get("function") == "hook" for frame in issue["stackFrames"]))
                self.assertEqual(self.worker.jobs_retried, retried)
                result = await job.result_info()
                self.assertEqual(result is not None, hook_name == "after_job_end")
                if result is not None:
                    self.assertEqual(result.success, not failed_task)
                self.assertNotIn("PRIVATE_ARQ", json.dumps(events))
                self.assertIsNone(get_active_logbrew_trace())

    async def test_timeout_outcome_does_not_depend_on_result_retention(self) -> None:
        self.worker.retry_jobs = False
        worker_logger = logging.getLogger("arq.worker")

        async def unrelated_error(ctx: dict[str, Any]) -> None:
            error = ValueError("PRIVATE_ARQ_UNRELATED")
            worker_logger.error("unrelated application error", exc_info=(ValueError, error, None))

        async def task(ctx: dict[str, Any], behavior: str) -> None:
            _LOGGER.info("ARQ bounded job started")
            if behavior == "cancel":
                raise asyncio.CancelledError("PRIVATE_ARQ_CANCEL")
            await asyncio.Event().wait()

        self.worker.on_job_end = unrelated_error
        after_hook = AsyncMock()
        self.worker.after_job_end = after_hook
        self.worker.functions["task"] = func(task, timeout=0.01)
        instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer)
        instrument_arq_worker_with_logbrew_spans(
            self.worker, client=self.consumer, logger_names=[_LOGGER.name],
            metadata={"queueCancellationOutcome": "caller-supplied"},
        )
        for mode, keep_result, worker_logs, hook_fails in product(
            ("timeout", "cancel"), (0, 1), (True, False), (False, True),
        ):
            with self.subTest(mode=mode, keep_result=keep_result, worker_logs=worker_logs, hook_fails=hook_fails):
                self.worker.keep_result_s = keep_result
                after_hook.side_effect = RuntimeError("PRIVATE_ARQ_AFTER") if hook_fails else None
                before = len(self.consumer.events)
                job = await self.pool.enqueue_job("task", mode)
                assert job is not None
                with (
                    patch.object(worker_logger, "disabled", not worker_logs),
                    self.assertRaisesRegex(RuntimeError, "PRIVATE_ARQ_AFTER") if hook_fails else nullcontext(None),
                ):
                    await asyncio.wait_for(self.worker.run_job(job.job_id, timestamp_ms()), timeout=2)
                events = self.consumer.events[before:]
                observed = worker_logs or bool(keep_result)
                has_issue = mode == "timeout" and observed
                self.assertEqual(
                    Counter(event["type"] for event in events),
                    Counter({"log": 1, "span": 3, "issue": int(has_issue) + int(hook_fails)}),
                )
                span = next(event["attributes"] for event in events if event["type"] == "span")
                self.assertEqual(span["status"], "error")
                self.assertEqual(span["metadata"]["errorType"], "TimeoutError" if has_issue else "CancelledError")
                self.assertEqual(
                    span["metadata"]["queueCancellationOutcome"], "observed" if observed else "unavailable",
                )
                parent = self.producer.events[-1]["attributes"]
                self.assertEqual(span["traceId"], parent["traceId"])
                self.assertEqual(span["parentSpanId"], parent["spanId"])
                for event in events:
                    if event["type"] != "span" and "queueHook" not in event["attributes"]["metadata"]:
                        self.assertEqual(event["attributes"]["metadata"]["spanId"], span["spanId"])
                for hook_name in ("on_job_end", "after_job_end"):
                    self._assert_hook_span(
                        events, span, hook_name, "error" if hook_name == "after_job_end" and hook_fails else "ok",
                    )
                if has_issue:
                    issue = next(event["attributes"] for event in events if event["type"] == "issue"
                                 and "queueHook" not in event["attributes"]["metadata"])
                    self._assert_timeout_source(issue, task.__code__.co_firstlineno)
                result = await job.result_info()
                self.assertEqual(result is not None, bool(keep_result))
                if result is not None:
                    self.assertFalse(result.success)
                    self.assertEqual(
                        type(result.result).__name__, "TimeoutError" if mode == "timeout" else "CancelledError",
                    )
                self.assertNotIn("PRIVATE_ARQ", json.dumps(events))
                self.assertIsNone(get_active_logbrew_trace())
        self.assertEqual((self.worker.jobs_failed, self.worker.jobs_retried), (16, 0))

    def _assert_hook_span(
        self, events: list[dict[str, Any]], task_span: dict[str, Any], hook_name: str, status: str,
    ) -> None:
        span = next(event["attributes"] for event in events if event["type"] == "span"
                    and event["attributes"]["metadata"].get("queueHook") == hook_name)
        self.assertEqual(span["traceId"], task_span["traceId"])
        self.assertEqual(span["parentSpanId"], task_span["spanId"])
        self.assertEqual(span["status"], status)
        if status == "ok":
            self.assertNotIn("queueFailureStage", span["metadata"])

    def _assert_timeout_source(self, issue: dict[str, Any], task_start: int) -> None:
        self.assertEqual(issue["message"], "TimeoutError")
        self.assertTrue(issue["stackFrames"])
        chain = issue["exceptionChain"]["entries"]
        self.assertEqual([entry["type"] for entry in chain], ["TimeoutError", "CancelledError"])
        self.assertEqual(chain[1]["relationship"], "cause")
        frame = next(frame for frame in chain[1]["stackFrames"] if frame.get("function") == "task")
        self.assertEqual(frame["filename"], "test_arq_client.py")
        self.assertGreater(frame["line"], task_start)

    async def test_concurrent_workers_keep_cancellation_outcomes_isolated(self) -> None:
        entered = asyncio.Event()
        arrivals = 0

        async def task(ctx: dict[str, Any], cancel: bool) -> None:
            nonlocal arrivals
            arrivals += 1
            if arrivals == 2:
                entered.set()
            await entered.wait()
            if cancel:
                raise asyncio.CancelledError()
            await asyncio.Event().wait()

        self.worker.functions["task"] = func(task, name="task", timeout=0.05)
        self.worker.retry_jobs, self.worker.keep_result_s = False, 0
        other = create_worker({
            "functions": [func(task, name="task", timeout=0.05)], "redis_pool": self.pool,
            "retry_jobs": False, "keep_result": 0,
        })
        other_client = client("arq-other-worker")
        instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer)
        instrument_arq_worker_with_logbrew_spans(self.worker, client=self.consumer)
        other_instrumentation = instrument_arq_worker_with_logbrew_spans(other, client=other_client)
        jobs = [await self.pool.enqueue_job("task", cancel) for cancel in (False, True)]
        self.assertTrue(all(job is not None for job in jobs))
        try:
            await asyncio.wait_for(asyncio.gather(*(
                worker.run_job(job.job_id, timestamp_ms())
                for worker, job in zip((self.worker, other), jobs, strict=True) if job is not None
            )), timeout=2)
        finally:
            other_instrumentation.uninstall()
            await other.close()
        self.assertEqual(arrivals, 2)
        for index, consumer in enumerate((self.consumer, other_client)):
            with self.subTest(worker=index):
                expected = {"issue": 1, "span": 1} if index == 0 else {"span": 1}
                self.assertEqual(Counter(event["type"] for event in consumer.events), expected)
                span = consumer.events[-1]["attributes"]
                parent = self.producer.events[index]["attributes"]
                self.assertEqual(span["traceId"], parent["traceId"])
                self.assertEqual(span["parentSpanId"], parent["spanId"])
                self.assertEqual(span["metadata"]["errorType"], "TimeoutError" if index == 0 else "CancelledError")
                self.assertEqual(span["metadata"]["queueCancellationOutcome"], "observed")
                job = jobs[index]
                assert job is not None
                self.assertIsNone(await job.result_info())
        self.assertEqual((self.worker.jobs_failed, other.jobs_failed), (1, 1))
        self.assertIsNone(get_active_logbrew_trace())

    async def test_result_codec_retry_does_not_duplicate_early_failure(self) -> None:
        codec_error = ValueError("PRIVATE_ARQ_CODEC")
        serialize = Mock(side_effect=[codec_error, b"application-result"])
        self.worker.job_serializer = serialize
        instrumentation = instrument_arq_worker_with_logbrew_spans(
            self.worker, client=self.consumer, clock=Mock(side_effect=[10.0, 11.0, 12.0]),
        )
        job = await self.pool.enqueue_job("unregistered_task")
        assert job is not None
        await self.worker.run_job(job.job_id, timestamp_ms())
        self.assertEqual(serialize.call_count, 2)
        self.assertEqual(await self.pool.get(result_key_prefix + job.job_id), b"application-result")
        self.assertEqual(Counter(event["type"] for event in self.consumer.events), {"issue": 1, "span": 1})
        self.assertEqual(self.consumer.events[-1]["attributes"]["durationMs"], 2_000)
        self.assertEqual(self.worker.jobs_failed, 1)
        instrumentation.uninstall()
        self.assertIs(self.worker.job_serializer, serialize)
        self.assertNotIn("PRIVATE_ARQ", self.consumer.preview_json())

    async def test_early_failure_capture_errors_preserve_original_result(self) -> None:
        errors: list[Exception] = []

        def callback(error: Exception) -> None:
            errors.append(error)
            raise ValueError("callback unavailable")

        for stage, method in product(("before_execution", "on_job_end", "after_job_end"), ("issue", "span")):
            with self.subTest(stage=stage, method=method):
                before = len(self.consumer.events)
                errors_before = len(errors)
                failure = RuntimeError("capture unavailable")
                hook_error = RuntimeError("PRIVATE_ARQ_HOOK")
                hook = AsyncMock(side_effect=hook_error)
                is_hook = stage != "before_execution"
                job = await self.pool.enqueue_job(
                    "successful_job" if is_hook else "unregistered_task", "PRIVATE_ARQ_ARGUMENT",
                )
                assert job is not None
                with patch.object(self.worker, stage, hook) if is_hook else nullcontext(None):
                    instrumentation = instrument_arq_worker_with_logbrew_spans(
                        self.worker, client=self.consumer, on_capture_error=callback,
                    )
                    try:
                        with (
                            patch.object(self.consumer, method, Mock(side_effect=failure)),
                            (self.assertRaisesRegex(RuntimeError, "PRIVATE_ARQ_HOOK")
                             if is_hook else nullcontext(None)) as raised,
                        ):
                            await self.worker.run_job(job.job_id, timestamp_ms())
                        if is_hook:
                            assert raised is not None
                            self.assertIs(raised.exception, hook_error)
                            hook.assert_awaited_once()
                    finally:
                        instrumentation.uninstall()
                result = await job.result_info()
                if stage == "on_job_end":
                    self.assertIsNone(result)
                else:
                    assert result is not None
                    self.assertEqual(result.success, is_hook)
                    if not is_hook:
                        self.assertEqual(type(result.result).__name__, "JobExecutionFailed")
                expected = ["span"] * (1 + int(is_hook)) if method == "issue" else ["issue"]
                self.assertEqual([event["type"] for event in self.consumer.events[before:]], expected)
                self.assertEqual(errors[errors_before:], [failure] * (1 + int(is_hook and method == "span")))
                self.assertIsNone(get_active_logbrew_trace())

    async def test_concurrent_early_failures_use_their_own_producer(self) -> None:
        instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer)
        instrument_arq_worker_with_logbrew_spans(self.worker, client=self.consumer)
        jobs = [await self.pool.enqueue_job(name) for name in ("missing_first", "missing_second")]
        await asyncio.gather(*(self.worker.run_job(job.job_id, timestamp_ms()) for job in jobs if job is not None))
        self.assertEqual(Counter(event["type"] for event in self.consumer.events), {"issue": 2, "span": 2})
        for parent in self.producer.events:
            publish = parent["attributes"]
            span = next(event["attributes"] for event in self.consumer.events
                        if event["type"] == "span" and event["attributes"]["traceId"] == publish["traceId"])
            self.assertEqual(span["parentSpanId"], publish["spanId"])
            self.assertEqual(span["metadata"]["taskName"], publish["metadata"]["taskName"])
            issues = [event for event in self.consumer.events if event["type"] == "issue"
                      and event["attributes"]["metadata"]["spanId"] == span["spanId"]]
            self.assertEqual(len(issues), 1)

    async def test_capture_failures_do_not_fail_the_job(self) -> None:
        for option, behavior, message in (
            ("event_id_factory", RuntimeError("event factory unavailable"), "event factory unavailable"),
            ("clock", [1.0, RuntimeError("clock unavailable")], "clock unavailable"),
        ):
            with self.subTest(option=option):
                errors: list[Exception] = []
                completed = self.worker.jobs_complete
                instrumentation = instrument_arq_worker_with_logbrew_spans(
                    self.worker,
                    client=self.consumer,
                    on_capture_error=errors.append,
                    **{option: Mock(side_effect=behavior)},
                )
                job = await self.pool.enqueue_job("successful_job", "PRIVATE_ARQ_ARGUMENT")
                assert job is not None
                await self.worker.run_job(job.job_id, timestamp_ms())
                instrumentation.uninstall()
                self.assertEqual(self.worker.jobs_complete, completed + 1)
                self.assertEqual([str(error) for error in errors], [message])
                self.assertEqual(self.consumer.events, [])

    async def test_concurrent_jobs_keep_context_and_prevent_early_uninstall(self) -> None:
        entered, release = asyncio.Event(), asyncio.Event()
        active_traces: list[LogBrewTraceContext] = []

        async def concurrent_job(ctx: dict[str, Any]) -> None:
            trace = get_active_logbrew_trace()
            assert trace is not None
            active_traces.append(trace)
            if len(active_traces) == 2:
                entered.set()
            await release.wait()
            self.assertEqual(get_active_logbrew_trace(), trace)
            _LOGGER.info("ARQ concurrent job completed")

        self.worker.functions["concurrent_job"] = func(concurrent_job, name="concurrent_job")
        instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer)
        instrumentation = instrument_arq_worker_with_logbrew_spans(
            self.worker, client=self.consumer, logger_names=[_LOGGER.name]
        )
        jobs = [await self.pool.enqueue_job("concurrent_job") for _ in range(2)]
        running = [
            asyncio.create_task(self.worker.run_job(job.job_id, timestamp_ms()))
            for job in jobs
            if job is not None
        ]
        try:
            await asyncio.wait_for(entered.wait(), timeout=2)
            with self.assertRaisesRegex(SdkError, "while a job is running"):
                instrumentation.uninstall()
        finally:
            release.set()
            await asyncio.gather(*running)
        self.assertEqual(len({trace.trace_id for trace in active_traces}), 2)
        spans = [event["attributes"] for event in self.consumer.events if event["type"] == "span"]
        logs = [event["attributes"] for event in self.consumer.events if event["type"] == "log"]
        self.assertEqual(
            Counter(log["metadata"]["spanId"] for log in logs),
            {span["spanId"]: 1 for span in spans},
        )
        self.assertEqual((len(spans), self.worker.jobs_complete), (2, 2))
        self.assertIsNone(get_active_logbrew_trace())

    async def test_custom_json_codec_preserves_jobs_results_and_correlation(self) -> None:
        serialize = Mock(side_effect=lambda data: json.dumps(data).encode())
        deserialize = Mock(side_effect=json.loads)
        self.pool.job_serializer = self.worker.job_serializer = serialize
        self.pool.job_deserializer = self.worker.job_deserializer = deserialize
        producer = instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer)
        worker = instrument_arq_worker_with_logbrew_spans(
            self.worker, client=self.consumer, logger_names=[_LOGGER.name]
        )
        job = await self.pool.enqueue_job("successful_job", "PRIVATE_ARQ_ARGUMENT")
        assert job is not None
        info = await job.info()
        assert info is not None
        self.assertEqual(info.args, ["PRIVATE_ARQ_ARGUMENT"])
        await self.worker.run_job(job.job_id, timestamp_ms())
        self.assertIsNone(await job.result(timeout=1))
        self.assertEqual(self.worker.jobs_complete, 1)
        span = next(event["attributes"] for event in self.consumer.events if event["type"] == "span")
        parent = self.producer.events[0]["attributes"]
        self.assertEqual(span["traceId"], parent["traceId"])
        self.assertEqual(span["parentSpanId"], parent["spanId"])
        self.assertEqual(self.consumer.events[0]["attributes"]["metadata"]["spanId"], span["spanId"])
        self.assertEqual(serialize.call_count, 2)
        self.assertGreaterEqual(deserialize.call_count, 3)
        self.assertNotIn("PRIVATE_ARQ_ARGUMENT", self.consumer.preview_json())
        producer.uninstall()
        worker.uninstall()
        self.assertIs(self.pool.job_serializer, serialize)
        self.assertIs(self.worker.job_deserializer, deserialize)
        self.assertIs(self.worker.job_serializer, serialize)
        producer = instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer)
        replacement = AsyncMock()
        with patch.object(self.pool, "enqueue_job", replacement):
            producer.uninstall()
            self.assertIs(self.pool.enqueue_job, replacement)

    async def test_strict_codec_falls_back_without_breaking_job_or_faking_parent(self) -> None:
        errors: list[Exception] = []
        rejected = ValueError("additional key rejected")

        def serialize(data: dict[str, Any]) -> bytes:
            if "_logbrew_trace" in data:
                raise rejected
            return json.dumps(data).encode()

        self.pool.job_serializer = serialize
        self.worker.job_deserializer = json.loads
        instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer, on_capture_error=errors.append)
        instrument_arq_worker_with_logbrew_spans(self.worker, client=self.consumer)
        job = await self.pool.enqueue_job("successful_job", "PRIVATE_ARQ_ARGUMENT")
        assert job is not None
        await self.worker.run_job(job.job_id, timestamp_ms())
        self.assertEqual(self.worker.jobs_complete, 1)
        self.assertEqual(errors, [rejected])
        self.assertEqual(len(self.consumer.events), 1)
        self.assertNotIn("parentSpanId", self.consumer.events[0]["attributes"])
        self.assertNotEqual(
            self.consumer.events[0]["attributes"]["traceId"],
            self.producer.events[0]["attributes"]["traceId"],
        )

    async def test_invalid_codecs_are_rejected_without_mutation(self) -> None:
        for target, field, factory, sdk, method in (
            (self.pool, "job_serializer", instrument_arq_pool_with_logbrew_spans, self.producer, "enqueue_job"),
            (self.worker, "job_deserializer", instrument_arq_worker_with_logbrew_spans, self.consumer, "run_job"),
            (self.worker, "job_serializer", instrument_arq_worker_with_logbrew_spans, self.consumer, "run_job"),
            (self.worker, "on_job_end", instrument_arq_worker_with_logbrew_spans, self.consumer, "run_job"),
            (self.worker, "after_job_end", instrument_arq_worker_with_logbrew_spans, self.consumer, "run_job"),
        ):
            original = getattr(target, method)
            for invalid in (False, 0, "json"):
                with self.subTest(field=field, invalid=invalid), patch.object(target, field, invalid):
                    with self.assertRaisesRegex(SdkError, "must be callable"):
                        factory(target, client=sdk)
                    self.assertIs(getattr(target, field), invalid)
                    self.assertEqual(getattr(target, method), original)

    async def test_cancelled_enqueue_preserves_error_and_records_span(self) -> None:
        error = asyncio.CancelledError("PRIVATE_ARQ_CANCELLATION")
        with patch.object(self.pool, "enqueue_job", AsyncMock(side_effect=error)):
            instrumentation = instrument_arq_pool_with_logbrew_spans(self.pool, client=self.producer)
            with self.assertRaises(asyncio.CancelledError) as raised:
                await self.pool.enqueue_job("successful_job")
            instrumentation.uninstall()
        self.assertIs(raised.exception, error)
        self.assertIsNone(get_active_logbrew_trace())
        self.assertEqual(len(self.producer.events), 1)
        attributes = self.producer.events[0]["attributes"]
        self.assertEqual(attributes["status"], "error")
        self.assertEqual(attributes["metadata"]["errorType"], "CancelledError")
        self.assertNotIn("PRIVATE_ARQ_CANCELLATION", self.producer.preview_json())

    async def test_operations_reject_removal_from_first_await_until_completion(self) -> None:
        job = await self.pool.enqueue_job("successful_job", "PRIVATE_ARQ_ARGUMENT")
        assert job is not None
        cases = (
            (self.pool, "enqueue_job", instrument_arq_pool_with_logbrew_spans, self.producer,
             ("successful_job", "PRIVATE_ARQ_ARGUMENT"), False),
            (self.pool, "enqueue_job", instrument_arq_pool_with_logbrew_spans, self.producer,
             ("successful_job", "PRIVATE_ARQ_ARGUMENT"), True),
            (self.worker, "run_job", instrument_arq_worker_with_logbrew_spans, self.consumer,
             (job.job_id, timestamp_ms()), False),
        )
        for target, method, factory, sdk, arguments, fail_capture in cases:
            with self.subTest(method=method, fail_capture=fail_capture):
                entered, release = asyncio.Event(), asyncio.Event()
                original = getattr(target, method)

                async def delayed(
                    *args: Any, _entered: asyncio.Event = entered,
                    _release: asyncio.Event = release, _original: Any = original, **kwargs: Any,
                ) -> Any:
                    _entered.set()
                    await _release.wait()
                    return await _original(*args, **kwargs)

                with patch.object(target, method, delayed):
                    instrumentation = factory(
                        target, client=sdk,
                        event_id_factory=(
                            Mock(side_effect=RuntimeError("capture unavailable")) if fail_capture else None
                        ),
                    )
                    running = asyncio.create_task(getattr(target, method)(*arguments))
                    try:
                        await asyncio.wait_for(entered.wait(), timeout=2)
                        with self.assertRaisesRegex(SdkError, "is running"):
                            instrumentation.uninstall()
                    finally:
                        release.set()
                        await running
                    self.assertTrue(instrumentation.installed)
                    instrumentation.uninstall()
                    self.assertFalse(instrumentation.installed)
                    self.assertEqual(getattr(target, method), delayed)

    async def test_logger_name_bounds_fail_before_worker_mutation(self) -> None:
        original = self.worker.run_job
        with self.assertRaisesRegex(SdkError, "at most 16"):
            instrument_arq_worker_with_logbrew_spans(
                self.worker,
                client=self.consumer,
                logger_names=[f"logger-{index}" for index in range(17)],
            )
        self.assertEqual(self.worker.run_job, original)


if __name__ == "__main__":
    unittest.main()
