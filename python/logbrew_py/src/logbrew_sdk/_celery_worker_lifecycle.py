"""Explicit child-process ownership and delivery for Celery worker telemetry."""

from __future__ import annotations

import importlib
import os
import stat
from collections.abc import Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from threading import RLock
from typing import Any, cast

from logbrew_sdk import SdkError, TransportResponse, _instrumentation
from logbrew_sdk._celery_instrumentation import (
    LogBrewCeleryInstrumentation,
    _existing_instrumentation,
    _existing_worker_lifecycle,
    _forget_worker_lifecycle,
    _new_celery_instrumentation,
    _notify_capture_error,
    _remember_worker_lifecycle,
)

_DEFAULT_MAX_IN_FLIGHT_TASKS = 1024


def celery_worker_persistent_queue_directory(root: str | os.PathLike[str]) -> str:
    """Return one stable owner-only queue directory for the current Celery child slot."""

    root_path = _validated_persistent_queue_root(root)
    try:
        celery_log = importlib.import_module("celery.utils.log")
    except Exception as error:
        raise SdkError(
            "configuration_error",
            "Celery persistent delivery requires the celery extra to be installed",
        ) from error
    current_process_index = getattr(celery_log, "current_process_index", None)
    if not callable(current_process_index):
        raise SdkError(
            "configuration_error",
            "Celery persistent delivery requires the Celery process-index API",
        )
    index = current_process_index()
    if index is None:
        index = 0
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        raise SdkError(
            "configuration_error",
            "Celery persistent delivery received an invalid process index",
        )
    return str(root_path / f"worker-{index}")


def instrument_celery_worker_processes_with_logbrew(
    app: Any,
    *,
    client_factory: Callable[[], Any],
    transport_factory: Callable[[], Any],
    event_id_factory: Callable[[], str] | None = None,
    timestamp: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    wall_clock: _instrumentation.Clock | None = None,
    max_in_flight_tasks: int = _DEFAULT_MAX_IN_FLIGHT_TASKS,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewCeleryWorkerLifecycle:
    """Install child-only client ownership on one caller-owned Celery app."""

    if not callable(client_factory):
        raise TypeError("client_factory must be callable")
    if not callable(transport_factory):
        raise TypeError("transport_factory must be callable")
    existing_instrumentation = _existing_instrumentation(app)
    if existing_instrumentation is not None and existing_instrumentation.installed:
        raise SdkError(
            "configuration_error",
            "Celery app already has direct Celery instrumentation",
        )
    existing = _existing_worker_lifecycle(app)
    if existing is not None and getattr(existing, "installed", False):
        return cast(LogBrewCeleryWorkerLifecycle, existing)

    lifecycle = LogBrewCeleryWorkerLifecycle(
        app=app,
        signals=_require_celery_worker_signals(),
        client_factory=client_factory,
        transport_factory=transport_factory,
        event_id_factory=event_id_factory,
        timestamp=timestamp,
        metadata=dict(metadata or {}),
        span_id_factory=span_id_factory,
        clock=clock,
        wall_clock=wall_clock,
        max_in_flight_tasks=max_in_flight_tasks,
        on_capture_error=on_capture_error,
    )
    lifecycle.install()
    _remember_worker_lifecycle(app, lifecycle)
    return lifecycle


class LogBrewCeleryWorkerLifecycle:
    """Own one fresh LogBrew client and transport in each Celery worker child."""

    def __init__(
        self,
        *,
        app: Any,
        signals: Any,
        client_factory: Callable[[], Any],
        transport_factory: Callable[[], Any],
        event_id_factory: Callable[[], str] | None,
        timestamp: str | None,
        metadata: Mapping[str, Any],
        span_id_factory: Callable[[], str] | None,
        clock: _instrumentation.Clock | None,
        wall_clock: _instrumentation.Clock | None,
        max_in_flight_tasks: int,
        on_capture_error: Callable[[Exception], None] | None,
    ) -> None:
        self.app = app
        self._signals = signals
        self._client_factory = client_factory
        self._transport_factory = transport_factory
        self._event_id_factory = event_id_factory
        self._timestamp = timestamp
        self._metadata = dict(metadata)
        self._span_id_factory = span_id_factory
        self._clock = clock
        self._wall_clock = wall_clock
        self._max_in_flight_tasks = max_in_flight_tasks
        self._on_capture_error = on_capture_error
        self._state: _WorkerProcessState | None = None
        self._lock = RLock()
        self._dispatch_prefix = f"logbrew-celery-worker-{id(self)}"
        self._installed = False
        self._shutting_down = False
        self._process_shutdown_complete = False

    @property
    def installed(self) -> bool:
        """Return whether this lifecycle still owns its Celery process signals."""

        return self._installed

    @property
    def current_client(self) -> Any | None:
        """Return the current child-process client after process initialization."""

        with self._lock:
            if self._state is None or not self._state.ready:
                return None
            return self._state.client

    def install(self) -> None:
        """Attach child init/shutdown receivers without constructing runtime state."""

        if self._installed:
            return
        connected: list[tuple[Any, str]] = []
        try:
            for signal_name, receiver in self._signal_receivers():
                signal = getattr(self._signals, signal_name)
                dispatch_uid = self._dispatch_uid(signal_name)
                signal.connect(receiver, weak=False, dispatch_uid=dispatch_uid)
                connected.append((signal, dispatch_uid))
        except Exception:
            for signal, dispatch_uid in reversed(connected):
                with suppress(Exception):
                    signal.disconnect(dispatch_uid=dispatch_uid)
            raise
        self._installed = True

    def _initialize_current_process(self) -> LogBrewCeleryInstrumentation | None:
        """Create and install one fresh client-backed tracer in this worker child."""

        with self._lock:
            if not self._installed:
                raise SdkError("configuration_error", "Celery worker lifecycle is not installed")
            if self._process_shutdown_complete:
                return None
            if self._state is not None:
                if not self._state.instrumentation.installed:
                    self._state.instrumentation.install()
                    self._state.ready = True
                return self._state.instrumentation

            transport = self._transport_factory()
            _validate_process_transport(transport)
            client = self._client_factory()
            _validate_process_client(client)
            instrumentation = _new_celery_instrumentation(
                app=self.app,
                signals=self._signals,
                client=client,
                event_id_factory=self._event_id_factory,
                timestamp=self._timestamp,
                trace=None,
                metadata=self._metadata,
                span_id_factory=self._span_id_factory,
                clock=self._clock,
                wall_clock=self._wall_clock,
                max_in_flight_tasks=self._max_in_flight_tasks,
                on_capture_error=self._on_capture_error,
            )
            self._state = _WorkerProcessState(
                client=client,
                transport=transport,
                instrumentation=instrumentation,
            )
            instrumentation.install()
            self._state.ready = True
            return instrumentation

    def shutdown_current_process(self) -> TransportResponse | None:
        """Stop task capture and deliver this child process's queued telemetry."""

        with self._lock:
            state = self._state
            if state is None or self._shutting_down:
                return None
            if state.instrumentation.in_flight_tasks:
                raise _CeleryWorkerTasksActive
            self._shutting_down = True

        try:
            state.instrumentation.uninstall()
            response = cast(TransportResponse, state.client.shutdown(state.transport))
        except Exception:
            with self._lock:
                self._shutting_down = False
            raise

        with self._lock:
            self._state = None
            self._shutting_down = False
            self._process_shutdown_complete = True
        return response

    def uninstall(self) -> Any:
        """Deliver current child state when present, then remove owned signals."""

        self.shutdown_current_process()
        if not self._installed:
            _forget_worker_lifecycle(self.app, self)
            return self.app
        for signal_name, _ in self._signal_receivers():
            with suppress(Exception):
                getattr(self._signals, signal_name).disconnect(
                    dispatch_uid=self._dispatch_uid(signal_name)
                )
        self._installed = False
        _forget_worker_lifecycle(self.app, self)
        return self.app

    def _on_worker_process_init(self, sender: Any = None, **kwargs: Any) -> None:
        try:
            if _current_celery_app() is not self.app:
                return
            self._initialize_current_process()
        except Exception:
            self._notify("Celery worker initialization failed; instrumentation skipped")

    def _on_worker_process_shutdown(self, sender: Any = None, **kwargs: Any) -> None:
        self._shutdown_without_raising()

    def _shutdown_without_raising(self) -> None:
        try:
            self.shutdown_current_process()
        except _CeleryWorkerTasksActive:
            self._notify("Celery worker shutdown deferred while owned tasks are active")
        except Exception:
            self._notify("Celery worker delivery failed; retry is only available before process exit")

    def _notify(self, message: str) -> None:
        _notify_capture_error(self._on_capture_error, _CeleryWorkerLifecycleError(message))

    def _signal_receivers(self) -> tuple[tuple[str, Callable[..., None]], ...]:
        return (
            ("worker_process_init", self._on_worker_process_init),
            ("worker_process_shutdown", self._on_worker_process_shutdown),
        )

    def _dispatch_uid(self, signal_name: str) -> str:
        return f"{self._dispatch_prefix}-{signal_name}"


@dataclass(slots=True)
class _WorkerProcessState:
    client: Any
    transport: Any
    instrumentation: LogBrewCeleryInstrumentation
    ready: bool = False


class _CeleryWorkerLifecycleError(RuntimeError):
    pass


class _CeleryWorkerTasksActive(RuntimeError):
    pass


def _require_celery_worker_signals() -> Any:
    try:
        signals = importlib.import_module("celery.signals")
    except Exception as error:
        raise SdkError(
            "configuration_error",
            "Celery worker lifecycle requires the celery extra to be installed",
        ) from error
    required = (
        "task_prerun",
        "task_postrun",
        "task_failure",
        "task_retry",
        "worker_process_init",
        "worker_process_shutdown",
    )
    for signal_name in required:
        signal = getattr(signals, signal_name, None)
        if not callable(getattr(signal, "connect", None)) or not callable(
            getattr(signal, "disconnect", None)
        ):
            raise SdkError(
                "configuration_error",
                "Celery worker lifecycle requires Celery worker process signal APIs",
            )
    try:
        state = importlib.import_module("celery._state")
    except Exception as error:
        raise SdkError(
            "configuration_error",
            "Celery worker lifecycle requires the Celery current-app API",
        ) from error
    if not callable(getattr(state, "get_current_app", None)):
        raise SdkError(
            "configuration_error",
            "Celery worker lifecycle requires the Celery current-app API",
        )
    return signals


def _current_celery_app() -> Any:
    state = importlib.import_module("celery._state")
    return state.get_current_app()


def _validated_persistent_queue_root(root: str | os.PathLike[str]) -> Path:
    try:
        raw_path = os.fspath(root)
    except TypeError:
        raise SdkError(
            "configuration_error",
            "Celery persistent queue root must be a normalized absolute owner-only directory",
        ) from None
    if not isinstance(raw_path, str) or not raw_path:
        raise SdkError(
            "configuration_error",
            "Celery persistent queue root must be a normalized absolute owner-only directory",
        )
    path = Path(raw_path)
    if not path.is_absolute() or raw_path != os.path.normpath(raw_path):
        raise SdkError(
            "configuration_error",
            "Celery persistent queue root must be a normalized absolute owner-only directory",
        )
    current = Path(path.anchor)
    try:
        for component in path.parts[1:]:
            current /= component
            component_stat = os.lstat(current)
            if stat.S_ISLNK(component_stat.st_mode) or not stat.S_ISDIR(component_stat.st_mode):
                raise OSError
    except OSError:
        raise SdkError(
            "configuration_error",
            "Celery persistent queue root must be a normalized absolute owner-only directory",
        ) from None
    root_stat = os.lstat(path)
    if (
        (hasattr(os, "getuid") and root_stat.st_uid != os.getuid())
        or stat.S_IMODE(root_stat.st_mode) != 0o700
    ):
        raise SdkError(
            "configuration_error",
            "Celery persistent queue root must be a normalized absolute owner-only directory",
        )
    return path


def _validate_process_client(client: Any) -> None:
    if not callable(getattr(client, "span", None)) or not callable(getattr(client, "shutdown", None)):
        raise TypeError("client_factory must return a LogBrew client-like object")
    delivery_health = getattr(client, "delivery_health", None)
    if callable(delivery_health) and getattr(delivery_health(), "automatic_delivery", False):
        client.shutdown()
        raise SdkError(
            "configuration_error",
            "Celery worker lifecycle requires a client with automatic_delivery disabled",
        )


def _validate_process_transport(transport: Any) -> None:
    if not callable(getattr(transport, "send", None)):
        raise TypeError("transport_factory must return a LogBrew transport-like object")
