from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import patch

import logbrew_sdk
from logbrew_sdk import (
    LogBrewClient,
    RecordingTransport,
    SdkError,
    TransportError,
    TransportResponse,
)


def sample_client(*, max_retries: int = 1, max_queue_size: int = 1000) -> LogBrewClient:
    return LogBrewClient.create(
        api_key="LOGBREW_API_KEY",
        sdk_name="logbrew-python-celery-worker",
        sdk_version="0.1.0",
        max_retries=max_retries,
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
        self.current_app: Any | None = None
        self.process_index: int | None = None
        self.task_prerun = FakeSignal()
        self.task_postrun = FakeSignal()
        self.task_failure = FakeSignal()
        self.task_retry = FakeSignal()
        self.worker_process_init = FakeSignal()
        self.worker_process_shutdown = FakeSignal()


@contextmanager
def fake_celery_module(*, include_worker_shutdown: bool = True) -> Any:
    existing_celery = sys.modules.get("celery")
    existing_signals = sys.modules.get("celery.signals")
    existing_state = sys.modules.get("celery._state")
    existing_utils = sys.modules.get("celery.utils")
    existing_utils_log = sys.modules.get("celery.utils.log")
    signals = FakeCelerySignals()
    celery_module = ModuleType("celery")
    signals_module = ModuleType("celery.signals")
    state_module = ModuleType("celery._state")
    utils_module = ModuleType("celery.utils")
    utils_log_module = ModuleType("celery.utils.log")
    signal_names = [
        "task_prerun",
        "task_postrun",
        "task_failure",
        "task_retry",
        "worker_process_init",
    ]
    if include_worker_shutdown:
        signal_names.append("worker_process_shutdown")
    for name in signal_names:
        setattr(signals_module, name, getattr(signals, name))
    celery_module.__dict__["signals"] = signals_module
    celery_module.__dict__["_state"] = state_module
    state_module.__dict__["get_current_app"] = lambda: signals.current_app
    utils_log_module.__dict__["current_process_index"] = lambda: signals.process_index
    sys.modules["celery"] = celery_module
    sys.modules["celery.signals"] = signals_module
    sys.modules["celery._state"] = state_module
    sys.modules["celery.utils"] = utils_module
    sys.modules["celery.utils.log"] = utils_log_module
    try:
        yield signals
    finally:
        _reset_module("celery", existing_celery)
        _reset_module("celery.signals", existing_signals)
        _reset_module("celery._state", existing_state)
        _reset_module("celery.utils", existing_utils)
        _reset_module("celery.utils.log", existing_utils_log)


def _reset_module(name: str, previous: ModuleType | None) -> None:
    if previous is None:
        sys.modules.pop(name, None)
    else:
        sys.modules[name] = previous


class FakeCeleryApp:
    def __init__(self, name: str) -> None:
        self.name = name
        self.calls: list[str] = []

    def send_task(self, name: str, *args: Any, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(name)
        return {"name": name, "headers": kwargs.get("headers")}


class FakeCeleryTask:
    def __init__(self, app: FakeCeleryApp, name: str) -> None:
        self.app = app
        self.name = name
        self.request = SimpleNamespace(
            headers={},
            retries=0,
            delivery_info={"routing_key": "critical"},
        )


class FailOnceTransport:
    def __init__(self) -> None:
        self.sent_bodies: list[str] = []

    def send(self, api_key: str, body: str) -> TransportResponse:
        self.sent_bodies.append(body)
        if len(self.sent_bodies) == 1:
            raise TransportError.network("private intake host must not escape")
        return TransportResponse(status_code=202, attempts=1)


def install_worker_lifecycle(app: Any, **kwargs: Any) -> Any:
    install = getattr(logbrew_sdk, "instrument_celery_worker_processes_with_logbrew", None)
    if install is None:
        raise AssertionError("Celery worker-process lifecycle is not exported")
    return install(app, **kwargs)


def persistent_worker_directory(root: Path) -> Path:
    helper = getattr(logbrew_sdk, "celery_worker_persistent_queue_directory", None)
    if helper is None:
        raise AssertionError("Celery persistent queue directory helper is not exported")
    return Path(helper(root))


class CeleryWorkerLifecycleTests(unittest.TestCase):
    def test_persistent_queue_directory_is_stable_per_celery_worker_slot(self) -> None:
        with fake_celery_module() as signals, tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "queues"
            root.mkdir(mode=0o700)
            persistence_key = bytes(range(32))

            self.assertEqual(persistent_worker_directory(root), root / "worker-0")
            signals.process_index = 2
            first_slot = persistent_worker_directory(root)
            self.assertEqual(first_slot, root / "worker-2")

            first = LogBrewClient.create(
                api_key="LOGBREW_API_KEY",
                sdk_name="logbrew-python-celery-worker",
                sdk_version="0.1.0",
                persistent_queue_directory=first_slot,
                persistent_queue_encryption_key=persistence_key,
            )
            first.log(
                "evt_slot_2",
                "2026-07-14T10:00:00Z",
                {"message": "recover me", "level": "info", "logger": "celery-slot"},
            )
            first._queue.close()

            replacement = LogBrewClient.create(
                api_key="LOGBREW_API_KEY",
                sdk_name="logbrew-python-celery-worker",
                sdk_version="0.1.0",
                persistent_queue_directory=persistent_worker_directory(root),
                persistent_queue_encryption_key=persistence_key,
            )
            self.assertEqual([event["id"] for event in replacement.events], ["evt_slot_2"])
            replacement.shutdown(RecordingTransport.always_accept())

            signals.process_index = 3
            isolated = LogBrewClient.create(
                api_key="LOGBREW_API_KEY",
                sdk_name="logbrew-python-celery-worker",
                sdk_version="0.1.0",
                persistent_queue_directory=persistent_worker_directory(root),
                persistent_queue_encryption_key=persistence_key,
            )
            self.assertEqual(isolated.pending_events(), 0)
            isolated.shutdown(RecordingTransport.always_accept())

    def test_persistent_queue_directory_rejects_unsafe_roots_and_missing_celery_api(self) -> None:
        helper = getattr(logbrew_sdk, "celery_worker_persistent_queue_directory", None)
        if helper is None:
            raise AssertionError("Celery persistent queue directory helper is not exported")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            broad = root / "broad"
            broad.mkdir(mode=0o755)
            os.chmod(broad, 0o755)
            for invalid in (Path("relative"), root / "missing", broad):
                with self.subTest(invalid=invalid.name), self.assertRaises(SdkError):
                    helper(invalid)

            safe = root / "safe"
            safe.mkdir(mode=0o700)
            with patch(
                "logbrew_sdk._celery_worker_lifecycle.importlib.import_module",
                side_effect=ImportError("injected missing Celery"),
            ), self.assertRaisesRegex(SdkError, "requires the celery extra"):
                helper(safe)
    def test_factories_run_only_after_process_init_and_shutdown_retries_one_stable_body(self) -> None:
        with fake_celery_module() as signals:
            app = FakeCeleryApp("checkout")
            signals.current_app = app
            clients: list[LogBrewClient] = []
            transports: list[RecordingTransport] = []

            def client_factory() -> LogBrewClient:
                client = sample_client()
                clients.append(client)
                return client

            def transport_factory() -> RecordingTransport:
                transport = RecordingTransport([{"status_code": 503}, {"status_code": 202}])
                transports.append(transport)
                return transport

            lifecycle = install_worker_lifecycle(
                app,
                client_factory=client_factory,
                transport_factory=transport_factory,
                event_id_factory=lambda: "evt_worker_process",
                timestamp="2026-07-12T12:00:00Z",
                span_id_factory=lambda: "b7ad6b7169203401",
                clock=iter([100.0, 100.005]).__next__,
                wall_clock=lambda: 1_000.0,
                metadata={"service": "checkout-worker"},
            )
            duplicate = install_worker_lifecycle(
                app,
                client_factory=client_factory,
                transport_factory=transport_factory,
            )

            self.assertIs(duplicate, lifecycle)
            self.assertEqual(clients, [])
            self.assertEqual(transports, [])
            self.assertEqual(len(signals.worker_process_init.receivers), 1)
            self.assertEqual(len(signals.worker_process_shutdown.receivers), 1)
            self.assertEqual(len(signals.task_prerun.receivers), 0)

            signals.worker_process_init.send()
            signals.worker_process_init.send()
            self.assertEqual(len(clients), 1)
            self.assertEqual(len(transports), 1)
            self.assertIs(lifecycle.current_client, clients[0])
            self.assertEqual(len(signals.task_prerun.receivers), 1)

            task = FakeCeleryTask(app, "checkout.send_receipt")
            signals.task_prerun.send(sender=task, task_id="private-task-id")
            signals.task_postrun.send(sender=task, task_id="private-task-id", state="SUCCESS")
            signals.worker_process_shutdown.send(pid=12345, exitcode=0)
            signals.worker_process_shutdown.send(pid=12345, exitcode=0)
            signals.worker_process_init.send()

            self.assertTrue(clients[0].closed)
            self.assertIsNone(lifecycle.current_client)
            self.assertEqual(len(clients), 1)
            self.assertEqual(len(transports), 1)
            self.assertEqual(len(transports[0].sent_bodies), 2)
            self.assertEqual(transports[0].sent_bodies[0], transports[0].sent_bodies[1])
            payload = json.loads(transports[0].sent_bodies[0])
            self.assertEqual(len(payload["events"]), 1)
            self.assertEqual(payload["events"][0]["attributes"]["metadata"]["taskState"], "success")
            self.assertNotIn("private-task-id", transports[0].sent_bodies[0])
            self.assertEqual(len(signals.task_prerun.receivers), 0)

            lifecycle.uninstall()
            self.assertFalse(lifecycle.installed)
            self.assertEqual(len(signals.worker_process_init.receivers), 0)
            self.assertEqual(len(signals.worker_process_shutdown.receivers), 0)

    def test_active_task_defers_shutdown_without_losing_the_span(self) -> None:
        with fake_celery_module() as signals:
            app = FakeCeleryApp("checkout")
            signals.current_app = app
            transport = RecordingTransport.always_accept()
            capture_errors: list[str] = []
            lifecycle = install_worker_lifecycle(
                app,
                client_factory=sample_client,
                transport_factory=lambda: transport,
                event_id_factory=lambda: "evt_worker_active",
                span_id_factory=lambda: "b7ad6b7169203402",
                clock=iter([200.0, 200.007]).__next__,
                wall_clock=lambda: 2_000.0,
                on_capture_error=lambda error: capture_errors.append(str(error)),
            )
            signals.worker_process_init.send()
            task = FakeCeleryTask(app, "checkout.active")
            signals.task_prerun.send(sender=task, task_id="private-active-id")

            signals.worker_process_shutdown.send(pid=12345, exitcode=0)
            self.assertEqual(transport.sent_bodies, [])
            self.assertIsNotNone(lifecycle.current_client)
            self.assertEqual(capture_errors, ["Celery worker shutdown deferred while owned tasks are active"])

            signals.task_postrun.send(sender=task, task_id="private-active-id", state="SUCCESS")
            response = lifecycle.shutdown_current_process()
            self.assertEqual(response, TransportResponse(status_code=202, attempts=1))
            self.assertIsNone(lifecycle.current_client)
            self.assertNotIn("private-active-id", transport.sent_bodies[0])
            lifecycle.uninstall()

    def test_failed_signal_delivery_is_redacted_and_manual_retry_preserves_the_batch(self) -> None:
        with fake_celery_module() as signals:
            app = FakeCeleryApp("checkout")
            signals.current_app = app
            client = sample_client(max_retries=0)
            transport = FailOnceTransport()
            capture_errors: list[str] = []
            lifecycle = install_worker_lifecycle(
                app,
                client_factory=lambda: client,
                transport_factory=lambda: transport,
                on_capture_error=lambda error: capture_errors.append(str(error)),
            )
            signals.worker_process_init.send()
            current = lifecycle.current_client
            assert current is not None
            current.log(
                "evt_worker_retry",
                "2026-07-12T12:00:01Z",
                {"message": "worker delivery", "level": "info"},
            )

            signals.worker_process_shutdown.send(pid=12345, exitcode=1)
            self.assertIs(lifecycle.current_client, client)
            self.assertFalse(client.closed)
            self.assertEqual(client.pending_events(), 1)
            self.assertEqual(
                capture_errors,
                ["Celery worker delivery failed; retry is only available before process exit"],
            )
            self.assertNotIn("private intake host", capture_errors[0])

            response = lifecycle.shutdown_current_process()
            self.assertEqual(response, TransportResponse(status_code=202, attempts=1))
            self.assertTrue(client.closed)
            self.assertEqual(transport.sent_bodies[0], transport.sent_bodies[1])
            self.assertIsNone(lifecycle.current_client)
            lifecycle.uninstall()

    def test_factory_failure_is_redacted_and_a_later_process_init_can_retry(self) -> None:
        with fake_celery_module() as signals:
            app = FakeCeleryApp("checkout")
            signals.current_app = app
            factory_calls = 0
            capture_errors: list[str] = []

            def client_factory() -> LogBrewClient:
                nonlocal factory_calls
                factory_calls += 1
                if factory_calls == 1:
                    raise RuntimeError("private child configuration")
                return sample_client()

            lifecycle = install_worker_lifecycle(
                app,
                client_factory=client_factory,
                transport_factory=RecordingTransport.always_accept,
                on_capture_error=lambda error: capture_errors.append(str(error)),
            )

            signals.worker_process_init.send()
            self.assertIsNone(lifecycle.current_client)
            self.assertEqual(capture_errors, ["Celery worker initialization failed; instrumentation skipped"])
            self.assertNotIn("private child configuration", capture_errors[0])

            signals.worker_process_init.send()
            self.assertIsNotNone(lifecycle.current_client)
            self.assertEqual(factory_calls, 2)
            lifecycle.shutdown_current_process()
            lifecycle.uninstall()

    def test_process_init_only_constructs_factories_for_the_current_worker_app(self) -> None:
        with fake_celery_module() as signals:
            current_app = FakeCeleryApp("current")
            unrelated_app = FakeCeleryApp("unrelated")
            current_clients: list[LogBrewClient] = []
            unrelated_clients: list[LogBrewClient] = []

            def current_client_factory() -> LogBrewClient:
                client = sample_client()
                current_clients.append(client)
                return client

            def unrelated_client_factory() -> LogBrewClient:
                client = sample_client()
                unrelated_clients.append(client)
                return client

            current = install_worker_lifecycle(
                current_app,
                client_factory=current_client_factory,
                transport_factory=RecordingTransport.always_accept,
            )
            unrelated = install_worker_lifecycle(
                unrelated_app,
                client_factory=unrelated_client_factory,
                transport_factory=RecordingTransport.always_accept,
            )
            signals.current_app = current_app

            signals.worker_process_init.send()

            self.assertEqual(len(current_clients), 1)
            self.assertEqual(unrelated_clients, [])
            self.assertIsNotNone(current.current_client)
            self.assertIsNone(unrelated.current_client)
            current.shutdown_current_process()
            current.uninstall()
            unrelated.uninstall()

    def test_process_initialization_is_signal_owned_and_does_not_register_atexit(self) -> None:
        with fake_celery_module() as signals:
            app = FakeCeleryApp("checkout")
            signals.current_app = app
            lifecycle = install_worker_lifecycle(
                app,
                client_factory=sample_client,
                transport_factory=RecordingTransport.always_accept,
            )

            self.assertFalse(hasattr(lifecycle, "initialize_current_process"))
            with patch("atexit.register") as register:
                signals.worker_process_init.send()
            register.assert_not_called()
            lifecycle.shutdown_current_process()
            lifecycle.uninstall()

    def test_direct_and_process_lifecycle_ownership_cannot_be_mixed(self) -> None:
        with fake_celery_module():
            app = FakeCeleryApp("checkout")
            direct = logbrew_sdk.instrument_celery_app_with_logbrew_spans(
                app,
                client=sample_client(),
            )
            with self.assertRaisesRegex(SdkError, "already has direct Celery instrumentation"):
                install_worker_lifecycle(
                    app,
                    client_factory=sample_client,
                    transport_factory=RecordingTransport.always_accept,
                )
            direct.uninstall()

            lifecycle = install_worker_lifecycle(
                app,
                client_factory=sample_client,
                transport_factory=RecordingTransport.always_accept,
            )
            with self.assertRaisesRegex(SdkError, "worker-process lifecycle"):
                logbrew_sdk.instrument_celery_app_with_logbrew_spans(
                    app,
                    client=sample_client(),
                )
            lifecycle.uninstall()

    def test_invalid_factories_and_missing_worker_signal_fail_before_registration(self) -> None:
        with fake_celery_module() as signals:
            app = FakeCeleryApp("checkout")
            with self.assertRaisesRegex(TypeError, "client_factory must be callable"):
                install_worker_lifecycle(
                    app,
                    client_factory=None,
                    transport_factory=RecordingTransport.always_accept,
                )
            with self.assertRaisesRegex(TypeError, "transport_factory must be callable"):
                install_worker_lifecycle(
                    app,
                    client_factory=sample_client,
                    transport_factory=None,
                )
            self.assertEqual(len(signals.worker_process_init.receivers), 0)

        with (
            fake_celery_module(include_worker_shutdown=False),
            self.assertRaisesRegex(SdkError, "worker process signal APIs"),
        ):
            install_worker_lifecycle(
                FakeCeleryApp("checkout"),
                client_factory=sample_client,
                transport_factory=RecordingTransport.always_accept,
            )


if __name__ == "__main__":
    unittest.main()
