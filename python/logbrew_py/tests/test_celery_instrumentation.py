from __future__ import annotations

import json
import sys
import unittest
from contextlib import contextmanager
from types import ModuleType, SimpleNamespace
from typing import Any

import logbrew_sdk
from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    SdkError,
    get_active_logbrew_trace,
    use_logbrew_trace,
)


def sample_client(*, max_queue_size: int = 1000) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python",
        sdk_version="0.1.0",
        max_retries=2,
        max_queue_size=max_queue_size,
    )


class FakeSignal:
    def __init__(self) -> None:
        self.receivers: list[tuple[str | None, Any]] = []

    def connect(
        self,
        receiver: Any,
        *,
        weak: bool = True,
        dispatch_uid: str | None = None,
        **kwargs: Any,
    ) -> None:
        if dispatch_uid is not None and any(uid == dispatch_uid for uid, _ in self.receivers):
            return
        self.receivers.append((dispatch_uid, receiver))

    def disconnect(
        self,
        receiver: Any | None = None,
        *,
        dispatch_uid: str | None = None,
        **kwargs: Any,
    ) -> bool:
        before = len(self.receivers)
        self.receivers = [
            (uid, connected)
            for uid, connected in self.receivers
            if not (
                (dispatch_uid is not None and uid == dispatch_uid)
                or (dispatch_uid is None and receiver is not None and connected == receiver)
            )
        ]
        return len(self.receivers) != before

    def send(self, sender: Any = None, **kwargs: Any) -> list[tuple[Any, Any]]:
        return [(receiver, receiver(sender=sender, **kwargs)) for _, receiver in list(self.receivers)]


class FakeCelerySignals:
    def __init__(self) -> None:
        self.task_prerun = FakeSignal()
        self.task_postrun = FakeSignal()
        self.task_failure = FakeSignal()
        self.task_retry = FakeSignal()


@contextmanager
def fake_celery_module() -> Any:
    existing_celery = sys.modules.get("celery")
    existing_signals = sys.modules.get("celery.signals")
    signals = FakeCelerySignals()
    celery_module = ModuleType("celery")
    signals_module = ModuleType("celery.signals")
    for name in ("task_prerun", "task_postrun", "task_failure", "task_retry"):
        setattr(signals_module, name, getattr(signals, name))
    celery_module.__dict__["signals"] = signals_module
    sys.modules["celery"] = celery_module
    sys.modules["celery.signals"] = signals_module
    try:
        yield signals
    finally:
        if existing_celery is None:
            sys.modules.pop("celery", None)
        else:
            sys.modules["celery"] = existing_celery
        if existing_signals is None:
            sys.modules.pop("celery.signals", None)
        else:
            sys.modules["celery.signals"] = existing_signals


class FakeCeleryApp:
    def __init__(self, name: str) -> None:
        self.name = name
        self.tasks: dict[str, FakeCeleryTask] = {}
        self.calls: list[dict[str, Any]] = []
        self.failure: Exception | None = None

    def send_task(self, name: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
        self.calls.append({"name": name, "args": args, "kwargs": kwargs})
        if self.failure is not None:
            raise self.failure
        return {"name": name, "headers": kwargs.get("headers")}


class FakeCeleryTask:
    def __init__(
        self,
        app: FakeCeleryApp,
        name: str,
        *,
        headers: dict[str, Any] | None = None,
        retries: int = 0,
    ) -> None:
        self.app = app
        self.name = name
        self.request = SimpleNamespace(
            headers=headers or {},
            retries=retries,
            args=["private-order-id"],
            kwargs={"payload": "private-body"},
            worker_node="sensitive-worker.invalid",
            delivery_info={
                "routing_key": "critical",
                "exchange": "private-exchange",
            },
        )
        app.tasks[name] = self


def instrument_celery_app(app: Any, **kwargs: Any) -> Any:
    instrument = getattr(logbrew_sdk, "instrument_celery_app_with_logbrew_spans", None)
    if instrument is None:
        raise AssertionError("Celery app instrumentation is not exported")
    return instrument(app, **kwargs)


class CeleryAppInstrumentationTests(unittest.TestCase):
    def test_owned_app_publish_and_worker_spans_share_w3c_trace(self) -> None:
        with fake_celery_module() as signals:
            client = sample_client()
            app = FakeCeleryApp("checkout")
            task = FakeCeleryTask(app, "checkout.send_receipt")
            span_ids = iter(["b7ad6b7169203371", "b7ad6b7169203372"])
            event_ids = iter(["evt_celery_publish", "evt_celery_process"])
            clock_values = iter([100.0, 100.012, 101.0, 101.019])
            wall_clock_values = iter([1_000.0, 1_000.025])
            original_headers = {
                "x-app-context": "private-context",
                "baggage": "private=value",
                "tracestate": "private=state",
            }
            parent_trace = LogBrewTraceContext(
                trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                span_id="00f067aa0ba902b7",
                sampled=True,
            )

            instrumentation = instrument_celery_app(
                app,
                client=client,
                event_id_factory=lambda: next(event_ids),
                timestamp="2026-07-12T08:00:00Z",
                span_id_factory=lambda: next(span_ids),
                clock=lambda: next(clock_values),
                wall_clock=lambda: next(wall_clock_values),
                metadata={
                    "service": "checkout-worker",
                    "headers": "private headers",
                    "taskArgs": "private args",
                },
            )

            with use_logbrew_trace(parent_trace):
                result = app.send_task(
                    "checkout.send_receipt",
                    args=["private-order-id"],
                    kwargs={"payload": "private-body"},
                    headers=original_headers,
                    queue="critical",
                    broker_url="amqp://private-broker.internal/vhost",
                )

            self.assertEqual(original_headers.keys(), {"x-app-context", "baggage", "tracestate"})
            sent_headers = result["headers"]
            self.assertEqual(sent_headers["x-app-context"], "private-context")
            self.assertEqual(sent_headers["baggage"], "private=value")
            self.assertEqual(sent_headers["tracestate"], "private=state")
            self.assertEqual(
                sent_headers["traceparent"],
                "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203371-01",
            )
            self.assertEqual(sent_headers["logbrew-enqueued-at-ms"], "1000000")

            task.request.headers = sent_headers
            signals.task_prerun.send(sender=task, task_id="private-task-id", args=task.request.args)
            self.assertEqual(
                get_active_logbrew_trace(),
                LogBrewTraceContext(
                    trace_id="4bf92f3577b34da6a3ce929d0e0e4736",
                    span_id="b7ad6b7169203372",
                    parent_span_id="b7ad6b7169203371",
                    sampled=True,
                ),
            )
            signals.task_postrun.send(
                sender=task,
                task_id="private-task-id",
                state="SUCCESS",
                retval={"private": "result"},
            )
            self.assertIsNone(get_active_logbrew_trace())

            payload = json.loads(client.preview_json())
            self.assertEqual(len(payload["events"]), 2)
            publish = payload["events"][0]["attributes"]
            process = payload["events"][1]["attributes"]
            self.assertEqual(publish["name"], "celery publish checkout.send_receipt")
            self.assertEqual(publish["durationMs"], 12.0)
            self.assertEqual(process["name"], "celery process checkout.send_receipt")
            self.assertEqual(process["durationMs"], 19.0)
            self.assertEqual(process["traceId"], publish["traceId"])
            self.assertEqual(process["parentSpanId"], publish["spanId"])
            self.assertEqual(publish["metadata"]["queueName"], "critical")
            self.assertEqual(process["metadata"]["queueName"], "critical")
            self.assertEqual(process["metadata"]["queueWaitMs"], 25)
            self.assertEqual(process["metadata"]["taskState"], "success")
            self.assertEqual(process["metadata"]["attempt"], 0)
            self.assertEqual(process["metadata"]["framework"], "celery")
            serialized = client.preview_json()
            for private_value in (
                "private-order-id",
                "private-body",
                "private-context",
                "private=value",
                "private=state",
                "private-task-id",
                "sensitive-worker.invalid",
                "private-exchange",
                "private-broker.internal",
                "traceparent",
                "tracestate",
                "baggage",
            ):
                self.assertNotIn(private_value, serialized)

            instrumentation.uninstall()

    def test_duplicate_install_and_uninstall_preserve_app_and_signal_ownership(self) -> None:
        with fake_celery_module() as signals:
            client = sample_client()
            app = FakeCeleryApp("checkout")
            other_app = FakeCeleryApp("billing")
            task = FakeCeleryTask(app, "checkout.send_receipt")
            other_task = FakeCeleryTask(other_app, "billing.charge")
            existing_receiver_calls: list[str] = []
            signals.task_prerun.connect(
                lambda sender=None, **kwargs: existing_receiver_calls.append(sender.name),
                weak=False,
                dispatch_uid="app-existing-receiver",
            )
            instrumentation = instrument_celery_app(app, client=client)
            duplicate = instrument_celery_app(app, client=client)

            other_app.send_task("billing.charge", headers={"x-app": "billing"})
            signals.task_prerun.send(sender=other_task, task_id="private-other-task-id")
            signals.task_postrun.send(sender=other_task, task_id="private-other-task-id", state="SUCCESS")
            signals.task_prerun.send(sender=task, task_id="private-task-id")
            signals.task_postrun.send(sender=task, task_id="private-task-id", state="SUCCESS")

            self.assertIs(duplicate, instrumentation)
            self.assertEqual(existing_receiver_calls, ["billing.charge", "checkout.send_receipt"])
            self.assertEqual(len(json.loads(client.preview_json())["events"]), 1)

            original_send_task = app.__class__.send_task
            instrumentation.uninstall()
            self.assertFalse(instrumentation.installed)
            self.assertNotIn("send_task", app.__dict__)
            self.assertIs(app.__class__.send_task, original_send_task)
            self.assertEqual(len(signals.task_prerun.receivers), 1)
            app.send_task("checkout.send_receipt", headers={})
            self.assertEqual(len(json.loads(client.preview_json())["events"]), 1)

    def test_publish_and_worker_failures_keep_type_only_and_preserve_original_errors(self) -> None:
        class PrivateBrokerError(RuntimeError):
            pass

        class PrivateTaskError(ValueError):
            pass

        with fake_celery_module() as signals:
            client = sample_client()
            app = FakeCeleryApp("checkout")
            app.failure = PrivateBrokerError("sensitive broker value")
            task = FakeCeleryTask(
                app,
                "checkout.fail_receipt",
                headers={
                    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
                },
            )
            span_ids = iter(["b7ad6b7169203381", "b7ad6b7169203382"])
            clock_values = iter([200.0, 200.003, 201.0, 201.007])
            instrumentation = instrument_celery_app(
                app,
                client=client,
                event_id_factory=iter(["evt_publish_error", "evt_process_error"]).__next__,
                timestamp="2026-07-12T08:00:01Z",
                span_id_factory=lambda: next(span_ids),
                clock=lambda: next(clock_values),
                wall_clock=lambda: 2_000.0,
            )

            with self.assertRaisesRegex(PrivateBrokerError, "sensitive broker value"):
                app.send_task("checkout.fail_receipt", headers={"authorization": "opaque-value"})

            app.failure = None
            signals.task_prerun.send(sender=task, task_id="private-task-id")
            signals.task_failure.send(
                sender=task,
                task_id="private-task-id",
                exception=PrivateTaskError("account sensitive@example.test"),
                args=["private-order-id"],
                kwargs={"payload": "private-body"},
                traceback="private stack",
            )
            signals.task_postrun.send(sender=task, task_id="private-task-id", state="FAILURE")

            payload = json.loads(client.preview_json())
            self.assertEqual(len(payload["events"]), 2)
            publish = payload["events"][0]["attributes"]
            process = payload["events"][1]["attributes"]
            self.assertEqual(publish["status"], "error")
            self.assertEqual(publish["metadata"]["errorType"], "PrivateBrokerError")
            self.assertEqual(process["status"], "error")
            self.assertEqual(process["metadata"]["errorType"], "PrivateTaskError")
            self.assertEqual(process["metadata"]["taskState"], "failure")
            self.assertEqual(
                process["events"],
                [
                    {
                        "name": "exception",
                        "metadata": {
                            "exceptionEscaped": True,
                            "exceptionType": "PrivateTaskError",
                        },
                    }
                ],
            )
            serialized = client.preview_json()
            for private_value in (
                "sensitive broker value",
                "private@example.test",
                "private-order-id",
                "private-body",
                "opaque-value",
                "private-task-id",
                "private stack",
            ):
                self.assertNotIn(private_value, serialized)
            instrumentation.uninstall()

    def test_retry_records_root_error_type_without_reason_text(self) -> None:
        class PrivateRetryError(OSError):
            pass

        with fake_celery_module() as signals:
            client = sample_client()
            app = FakeCeleryApp("checkout")
            task = FakeCeleryTask(
                app,
                "checkout.retry_receipt",
                headers={
                    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-00",
                },
                retries=2,
            )
            instrumentation = instrument_celery_app(
                app,
                client=client,
                event_id_factory=lambda: "evt_process_retry",
                timestamp="2026-07-12T08:00:02Z",
                span_id_factory=lambda: "b7ad6b7169203391",
                clock=iter([300.0, 300.004]).__next__,
                wall_clock=lambda: 3_000.0,
            )

            signals.task_prerun.send(sender=task, task_id="private-retry-id")
            signals.task_retry.send(
                sender=task,
                request=task.request,
                reason=SimpleNamespace(exc=PrivateRetryError("private retry destination")),
            )
            signals.task_postrun.send(sender=task, task_id="private-retry-id", state="RETRY")

            event = json.loads(client.preview_json())["events"][0]["attributes"]
            self.assertEqual(event["status"], "error")
            self.assertEqual(event["metadata"]["errorType"], "PrivateRetryError")
            self.assertEqual(event["metadata"]["taskState"], "retry")
            self.assertEqual(event["metadata"]["attempt"], 2)
            self.assertNotIn("private retry destination", client.preview_json())
            instrumentation.uninstall()

    def test_unknown_task_state_and_oversized_enqueue_time_are_not_serialized(self) -> None:
        with fake_celery_module() as signals:
            client = sample_client()
            app = FakeCeleryApp("checkout")
            task = FakeCeleryTask(
                app,
                "checkout.custom_state",
                headers={
                    "logbrew-enqueued-at-ms": "9" * 100,
                },
            )
            instrumentation = instrument_celery_app(
                app,
                client=client,
                event_id_factory=lambda: "evt_process_unknown_state",
                span_id_factory=lambda: "b7ad6b7169203392",
                clock=iter([310.0, 310.002]).__next__,
                wall_clock=lambda: 3_100.0,
            )

            signals.task_prerun.send(sender=task, task_id="private-state-id")
            signals.task_postrun.send(
                sender=task,
                task_id="private-state-id",
                state="CUSTOM account-sensitive-state",
            )

            event = json.loads(client.preview_json())["events"][0]["attributes"]
            self.assertEqual(event["metadata"]["taskState"], "unknown")
            self.assertNotIn("queueWaitMs", event["metadata"])
            self.assertNotIn("account-sensitive-state", client.preview_json())
            instrumentation.uninstall()

    def test_in_flight_limit_fails_open_and_uninstall_waits_for_owned_tasks(self) -> None:
        with fake_celery_module() as signals:
            client = sample_client()
            app = FakeCeleryApp("checkout")
            first = FakeCeleryTask(app, "checkout.first")
            second = FakeCeleryTask(app, "checkout.second")
            capture_errors: list[str] = []
            instrumentation = instrument_celery_app(
                app,
                client=client,
                event_id_factory=iter(["evt_first", "evt_second"]).__next__,
                span_id_factory=iter(["b7ad6b71692033a1", "b7ad6b71692033a2"]).__next__,
                clock=iter([400.0, 400.006]).__next__,
                wall_clock=lambda: 4_000.0,
                max_in_flight_tasks=1,
                on_capture_error=lambda error: capture_errors.append(str(error)),
            )

            signals.task_prerun.send(sender=first, task_id="private-first-id")
            first_trace = get_active_logbrew_trace()
            signals.task_prerun.send(sender=second, task_id="private-second-id")
            self.assertEqual(instrumentation.in_flight_tasks, 1)
            self.assertEqual(get_active_logbrew_trace(), first_trace)
            self.assertEqual(len(capture_errors), 1)
            self.assertIn("in-flight task limit", capture_errors[0])
            self.assertNotIn("private-second-id", capture_errors[0])

            with self.assertRaisesRegex(SdkError, "tasks are still running"):
                instrumentation.uninstall()
            self.assertTrue(instrumentation.installed)

            signals.task_postrun.send(sender=second, task_id="private-second-id", state="SUCCESS")
            self.assertEqual(get_active_logbrew_trace(), first_trace)
            signals.task_postrun.send(sender=first, task_id="private-first-id", state="SUCCESS")
            self.assertIsNone(get_active_logbrew_trace())
            self.assertEqual(instrumentation.in_flight_tasks, 0)
            self.assertEqual(len(json.loads(client.preview_json())["events"]), 1)
            instrumentation.uninstall()

    def test_capture_failures_never_interrupt_celery_signal_or_send_task_behavior(self) -> None:
        with fake_celery_module() as signals:
            client = sample_client()
            client.closed = True
            app = FakeCeleryApp("checkout")
            task = FakeCeleryTask(app, "checkout.send_receipt")
            capture_errors: list[str] = []
            instrumentation = instrument_celery_app(
                app,
                client=client,
                event_id_factory=iter(["evt_publish", "evt_process"]).__next__,
                span_id_factory=iter(["b7ad6b71692033b1", "b7ad6b71692033b2"]).__next__,
                clock=iter([500.0, 500.002, 501.0, 501.003]).__next__,
                wall_clock=lambda: 5_000.0,
                on_capture_error=lambda error: capture_errors.append(str(error)),
            )

            result = app.send_task("checkout.send_receipt")
            task.request.headers = result["headers"]
            signals.task_prerun.send(sender=task, task_id="private-task-id")
            signals.task_postrun.send(sender=task, task_id="private-task-id", state="SUCCESS")

            self.assertEqual(result["name"], "checkout.send_receipt")
            self.assertEqual(len(capture_errors), 2)
            self.assertTrue(all("client is already shut down" in error for error in capture_errors))
            instrumentation.uninstall()

    def test_all_worker_signal_callbacks_fail_open_when_task_request_is_unavailable(self) -> None:
        class UnavailableRequestTask:
            name = "checkout.unavailable_request"

            def __init__(self, app: FakeCeleryApp) -> None:
                self.app = app

            @property
            def request(self) -> Any:
                raise RuntimeError("request unavailable")

        with fake_celery_module() as signals:
            app = FakeCeleryApp("checkout")
            task = UnavailableRequestTask(app)
            capture_errors: list[str] = []
            instrumentation = instrument_celery_app(
                app,
                client=sample_client(),
                on_capture_error=lambda error: capture_errors.append(str(error)),
            )

            signals.task_prerun.send(sender=task)
            signals.task_failure.send(sender=task, exception=RuntimeError("task failed"))
            signals.task_retry.send(sender=task, reason=SimpleNamespace(exc=RuntimeError("task retry")))
            signals.task_postrun.send(sender=task, state="FAILURE")

            self.assertEqual(capture_errors, ["request unavailable"] * 4)
            instrumentation.uninstall()

    def test_instrumentation_setup_failure_calls_original_send_task_once(self) -> None:
        with fake_celery_module():
            app = FakeCeleryApp("checkout")
            capture_errors: list[str] = []

            def failing_event_id() -> str:
                raise RuntimeError("private event factory state")

            instrumentation = instrument_celery_app(
                app,
                client=sample_client(),
                event_id_factory=failing_event_id,
                on_capture_error=lambda error: capture_errors.append(str(error)),
            )

            result = app.send_task("checkout.send_receipt", headers={"x-app": "preserved"})

            self.assertEqual(result["name"], "checkout.send_receipt")
            self.assertEqual(len(app.calls), 1)
            self.assertEqual(app.calls[0]["kwargs"]["headers"], {"x-app": "preserved"})
            self.assertEqual(capture_errors, ["Celery producer instrumentation setup failed; task sent unchanged"])
            instrumentation.uninstall()


if __name__ == "__main__":
    unittest.main()
