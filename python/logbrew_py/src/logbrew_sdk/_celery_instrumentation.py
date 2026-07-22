"""Explicit, reversible Celery app instrumentation for privacy-bounded queue spans."""

from __future__ import annotations

import functools
import importlib
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager, suppress
from dataclasses import dataclass
from threading import RLock
from time import perf_counter, time
from typing import Any
from uuid import uuid4
from weakref import WeakKeyDictionary

from logbrew_sdk import SdkError, _instrumentation, create_traceparent
from logbrew_sdk._celery_client import (
    _safe_celery_queue_name,
    _safe_task_label,
    logbrew_trace_context_from_celery_headers,
)
from logbrew_sdk._queue_client import _queue_span_request, _QueueSpanRequest
from logbrew_sdk._trace_context import (
    LogBrewTraceContext,
    get_active_logbrew_trace,
    use_logbrew_trace,
)

_INSTRUMENTATION_ATTR = "_logbrew_celery_app_instrumentation"
_WORKER_LIFECYCLE_ATTR = "_logbrew_celery_worker_lifecycle"
_ENQUEUED_AT_HEADER = "logbrew-enqueued-at-ms"
_MAX_QUEUE_WAIT_MS = 7 * 24 * 60 * 60 * 1000
_DEFAULT_MAX_IN_FLIGHT_TASKS = 1024
_TASK_STATES = frozenset(
    {
        "failure",
        "ignored",
        "pending",
        "received",
        "rejected",
        "retry",
        "revoked",
        "started",
        "success",
    }
)
_APP_INSTRUMENTATIONS: WeakKeyDictionary[Any, LogBrewCeleryInstrumentation] = WeakKeyDictionary()
_APP_INSTRUMENTATIONS_BY_ID: dict[int, LogBrewCeleryInstrumentation] = {}
_APP_WORKER_LIFECYCLES: WeakKeyDictionary[Any, Any] = WeakKeyDictionary()
_APP_WORKER_LIFECYCLES_BY_ID: dict[int, Any] = {}


def instrument_celery_app_with_logbrew_spans(
    app: Any,
    *,
    client: Any,
    event_id_factory: Callable[[], str] | None = None,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    wall_clock: _instrumentation.Clock | None = None,
    max_in_flight_tasks: int = _DEFAULT_MAX_IN_FLIGHT_TASKS,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewCeleryInstrumentation:
    """Instrument one caller-owned Celery app without patching Celery globally."""

    worker_lifecycle = _existing_worker_lifecycle(app)
    if worker_lifecycle is not None and getattr(worker_lifecycle, "installed", False):
        raise SdkError(
            "configuration_error",
            "Celery app already has a LogBrew worker-process lifecycle",
        )

    existing = _existing_instrumentation(app)
    if existing is not None and existing.installed:
        return existing

    instrumentation = _new_celery_instrumentation(
        app=app,
        signals=_require_celery_signals(),
        client=client,
        event_id_factory=event_id_factory,
        timestamp=timestamp,
        trace=trace,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock,
        wall_clock=wall_clock,
        max_in_flight_tasks=max_in_flight_tasks,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _remember_instrumentation(app, instrumentation)
    return instrumentation


def _new_celery_instrumentation(
    *,
    app: Any,
    signals: Any,
    client: Any,
    event_id_factory: Callable[[], str] | None,
    timestamp: str | None,
    trace: LogBrewTraceContext | None,
    metadata: Mapping[str, Any] | None,
    span_id_factory: Callable[[], str] | None,
    clock: _instrumentation.Clock | None,
    wall_clock: _instrumentation.Clock | None,
    max_in_flight_tasks: int,
    on_capture_error: Callable[[Exception], None] | None,
) -> LogBrewCeleryInstrumentation:
    send_task = getattr(app, "send_task", None)
    if not callable(send_task):
        raise TypeError("app must expose a callable send_task method")
    if (
        isinstance(max_in_flight_tasks, bool)
        or not isinstance(max_in_flight_tasks, int)
        or max_in_flight_tasks <= 0
    ):
        raise TypeError("max_in_flight_tasks must be a positive integer")

    return LogBrewCeleryInstrumentation(
        app=app,
        signals=signals,
        send_task=send_task,
        had_instance_send_task=_has_instance_attribute(app, "send_task"),
        instance_send_task=_instance_attribute(app, "send_task"),
        client=client,
        event_id_factory=event_id_factory or _default_event_id,
        timestamp=timestamp,
        trace=trace,
        metadata={**(metadata or {}), "framework": "celery"},
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        wall_clock=wall_clock or time,
        max_in_flight_tasks=max_in_flight_tasks,
        on_capture_error=on_capture_error,
    )


class LogBrewCeleryInstrumentation:
    """Reversible producer and worker span instrumentation for one Celery app."""

    def __init__(
        self,
        *,
        app: Any,
        signals: Any,
        send_task: Callable[..., Any],
        had_instance_send_task: bool,
        instance_send_task: Any,
        client: Any,
        event_id_factory: Callable[[], str],
        timestamp: str | None,
        trace: LogBrewTraceContext | None,
        metadata: Mapping[str, Any],
        span_id_factory: Callable[[], str] | None,
        clock: _instrumentation.Clock,
        wall_clock: _instrumentation.Clock,
        max_in_flight_tasks: int,
        on_capture_error: Callable[[Exception], None] | None,
    ) -> None:
        self.app = app
        self._signals = signals
        self._send_task = send_task
        self._had_instance_send_task = had_instance_send_task
        self._instance_send_task = instance_send_task
        self._client = client
        self._event_id_factory = event_id_factory
        self._timestamp = timestamp
        self._trace = trace
        self._metadata = metadata
        self._span_id_factory = span_id_factory
        self._clock = clock
        self._wall_clock = wall_clock
        self._max_in_flight_tasks = max_in_flight_tasks
        self._on_capture_error = on_capture_error
        self._active_tasks: dict[int, _CeleryTaskSpanState] = {}
        self._lock = RLock()
        self._dispatch_prefix = f"logbrew-celery-{id(self)}"
        self._wrapped_send_task = self._wrap_send_task()
        self._installed = False

    @property
    def installed(self) -> bool:
        """Return whether this app is currently instrumented."""

        return self._installed

    @property
    def in_flight_tasks(self) -> int:
        """Return the bounded number of worker task spans awaiting postrun."""

        with self._lock:
            return len(self._active_tasks)

    def install(self) -> None:
        """Wrap this app's producer method and attach app-filtered worker signals."""

        if self._installed:
            return
        connected: list[tuple[Any, str]] = []
        try:
            for signal_name, receiver in self._signal_receivers():
                signal = getattr(self._signals, signal_name)
                dispatch_uid = self._dispatch_uid(signal_name)
                signal.connect(receiver, weak=False, dispatch_uid=dispatch_uid)
                connected.append((signal, dispatch_uid))
            self.app.send_task = self._wrapped_send_task
        except Exception:
            for signal, dispatch_uid in reversed(connected):
                with suppress(Exception):
                    signal.disconnect(dispatch_uid=dispatch_uid)
            raise
        self._installed = True

    def uninstall(self) -> Any:
        """Remove this instrumentation after the app's worker tasks have drained."""

        with self._lock:
            if self._active_tasks:
                raise SdkError(
                    "configuration_error",
                    "cannot uninstall Celery instrumentation while owned tasks are still running",
                )
            if not self._installed:
                _forget_instrumentation(self.app, self)
                return self.app
            self._installed = False

        for signal_name, _ in self._signal_receivers():
            with suppress(Exception):
                getattr(self._signals, signal_name).disconnect(
                    dispatch_uid=self._dispatch_uid(signal_name)
                )
        self._put_back_send_task()
        _forget_instrumentation(self.app, self)
        return self.app

    def _wrap_send_task(self) -> Callable[..., Any]:
        @functools.wraps(self._send_task)
        def send_task(name: str, *args: Any, **kwargs: Any) -> Any:
            if not self._installed:
                return self._send_task(name, *args, **kwargs)
            try:
                return self._send_task_with_span(name, args, kwargs)
            except _CeleryInstrumentationError as error:
                _notify_capture_error(self._on_capture_error, error)
                return self._send_task(name, *args, **kwargs)

        return send_task

    def _send_task_with_span(self, name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        try:
            task_name = _instrumentation.required_label("task_name", name)
            headers = _copied_headers(kwargs.get("headers"))
            parent_trace = self._trace or get_active_logbrew_trace()
            if parent_trace is None:
                parent_trace = logbrew_trace_context_from_celery_headers(headers)
            request = self._new_span_request(
                operation_kind="publish",
                task_name=task_name,
                queue_name=_publish_queue_name(kwargs),
                trace=parent_trace,
                attempt=_safe_non_negative_int(kwargs.get("retries")),
                metadata=None,
            )
            headers["traceparent"] = _traceparent(request.trace)
            headers[_ENQUEUED_AT_HEADER] = str(round(self._wall_clock() * 1000))
            call_kwargs = dict(kwargs)
            call_kwargs["headers"] = headers
        except _CeleryInstrumentationError:
            raise
        except Exception as error:
            raise _CeleryInstrumentationError(
                "Celery producer instrumentation setup failed; task sent unchanged"
            ) from error

        with use_logbrew_trace(request.trace):
            try:
                result = self._send_task(task_name, *args, **call_kwargs)
            except Exception as error:
                request.capture("error", error=error)
                raise
        request.capture("ok")
        return result

    def _on_task_prerun(self, sender: Any = None, task: Any = None, **kwargs: Any) -> None:
        owned_task = task if task is not None else sender
        if not self._installed or not self._owns_task(owned_task):
            return
        try:
            request_context = getattr(owned_task, "request", None)
            request_key = id(request_context)
            with self._lock:
                if request_key in self._active_tasks:
                    return
                if len(self._active_tasks) >= self._max_in_flight_tasks:
                    raise _CeleryInstrumentationError("Celery in-flight task limit reached; span skipped")

            task_name = _safe_task_label(owned_task, "name")
            if task_name is None:
                raise _CeleryInstrumentationError("Celery task name is unavailable; span skipped")
            headers = _request_headers(request_context)
            span_metadata: dict[str, Any] = {}
            queue_wait_ms = _queue_wait_ms(headers, self._wall_clock)
            if queue_wait_ms is not None:
                span_metadata["queueWaitMs"] = queue_wait_ms
            request = self._new_span_request(
                operation_kind="process",
                task_name=task_name,
                queue_name=_safe_celery_queue_name(owned_task),
                trace=logbrew_trace_context_from_celery_headers(headers),
                attempt=_safe_non_negative_int(getattr(request_context, "retries", None)),
                metadata=span_metadata,
            )
            request_metadata = request.metadata
            if not isinstance(request_metadata, dict):
                raise _CeleryInstrumentationError("Celery span metadata state is unavailable; span skipped")
            trace_scope = use_logbrew_trace(request.trace)
            trace_scope.__enter__()
            state = _CeleryTaskSpanState(request=request, trace_scope=trace_scope, metadata=request_metadata)
            with self._lock:
                if len(self._active_tasks) >= self._max_in_flight_tasks:
                    trace_scope.__exit__(None, None, None)
                    raise _CeleryInstrumentationError("Celery in-flight task limit reached; span skipped")
                self._active_tasks[request_key] = state
        except Exception as error:
            _notify_capture_error(self._on_capture_error, error)

    def _on_task_failure(self, sender: Any = None, exception: Any = None, **kwargs: Any) -> None:
        if not self._owns_task(sender):
            return
        try:
            state = self._active_state(sender)
            if state is not None and isinstance(exception, BaseException):
                state.error_type = type(exception).__name__
        except Exception as error:
            _notify_capture_error(self._on_capture_error, error)

    def _on_task_retry(self, sender: Any = None, request: Any = None, reason: Any = None, **kwargs: Any) -> None:
        if not self._owns_task(sender):
            return
        try:
            state = self._active_state(sender, request=request)
            retry_error = getattr(reason, "exc", None)
            if state is not None and isinstance(retry_error, BaseException):
                state.error_type = type(retry_error).__name__
        except Exception as error:
            _notify_capture_error(self._on_capture_error, error)

    def _on_task_postrun(self, sender: Any = None, task: Any = None, state: Any = None, **kwargs: Any) -> None:
        owned_task = task if task is not None else sender
        if not self._owns_task(owned_task):
            return
        try:
            request_context = getattr(owned_task, "request", None)
            with self._lock:
                active = self._active_tasks.pop(id(request_context), None)
            if active is None:
                return
            active.finish(_normalized_task_state(state))
        except Exception as error:
            _notify_capture_error(self._on_capture_error, error)

    def _new_span_request(
        self,
        *,
        operation_kind: str,
        task_name: str,
        queue_name: str | None,
        trace: LogBrewTraceContext | None,
        attempt: int | None,
        metadata: Mapping[str, Any] | None,
    ) -> _QueueSpanRequest:
        return _queue_span_request(
            operation_name=f"{operation_kind} {task_name}",
            system="celery",
            client=self._client,
            event_id=self._event_id_factory(),
            timestamp=self._timestamp,
            trace=trace,
            operation_kind=operation_kind,
            queue_name=queue_name,
            task_name=task_name,
            message_count=1,
            attempt=attempt,
            metadata={**self._metadata, **(metadata or {})},
            span_events=None,
            span_id_factory=self._span_id_factory,
            clock=self._clock,
            on_capture_error=self._on_capture_error,
        )

    def _active_state(self, task: Any, *, request: Any = None) -> _CeleryTaskSpanState | None:
        request_context = request if request is not None else getattr(task, "request", None)
        with self._lock:
            return self._active_tasks.get(id(request_context))

    def _owns_task(self, task: Any) -> bool:
        with suppress(Exception):
            return getattr(task, "app", None) is self.app
        return False

    def _signal_receivers(self) -> tuple[tuple[str, Callable[..., None]], ...]:
        return (
            ("task_prerun", self._on_task_prerun),
            ("task_postrun", self._on_task_postrun),
            ("task_failure", self._on_task_failure),
            ("task_retry", self._on_task_retry),
        )

    def _dispatch_uid(self, signal_name: str) -> str:
        return f"{self._dispatch_prefix}-{signal_name}"

    def _put_back_send_task(self) -> None:
        with suppress(Exception):
            if getattr(self.app, "send_task", None) is not self._wrapped_send_task:
                return
            if self._had_instance_send_task:
                self.app.send_task = self._instance_send_task
            else:
                del self.app.send_task


@dataclass(slots=True)
class _CeleryTaskSpanState:
    request: _QueueSpanRequest
    trace_scope: AbstractContextManager[Any]
    metadata: dict[str, Any]
    error_type: str | None = None

    def finish(self, task_state: str) -> None:
        self.metadata["taskState"] = task_state
        try:
            self.request.capture(
                "ok" if task_state == "success" else "error",
                error_type=self.error_type,
            )
        finally:
            self.trace_scope.__exit__(None, None, None)


class _CeleryInstrumentationError(RuntimeError):
    pass


def _require_celery_signals() -> Any:
    try:
        signals = importlib.import_module("celery.signals")
    except Exception as error:
        raise SdkError(
            "configuration_error",
            "Celery app instrumentation requires the celery extra to be installed",
        ) from error
    for signal_name in ("task_prerun", "task_postrun", "task_failure", "task_retry"):
        signal = getattr(signals, signal_name, None)
        if not callable(getattr(signal, "connect", None)) or not callable(getattr(signal, "disconnect", None)):
            raise SdkError(
                "configuration_error",
                "Celery app instrumentation requires Celery task signal APIs",
            )
    return signals


def _copied_headers(headers: Any) -> dict[str, Any]:
    if headers is None:
        return {}
    if not isinstance(headers, Mapping):
        raise _CeleryInstrumentationError("Celery headers must be a mapping; instrumentation skipped")
    try:
        return dict(headers)
    except Exception as error:
        raise _CeleryInstrumentationError("Celery headers could not be copied; instrumentation skipped") from error


def _request_headers(request: Any) -> Mapping[str, Any] | None:
    headers = request.get("headers") if isinstance(request, Mapping) else getattr(request, "headers", None)
    return headers if isinstance(headers, Mapping) else None


def _traceparent(trace: LogBrewTraceContext) -> str:
    return create_traceparent(
        trace_id=trace.trace_id,
        span_id=trace.span_id,
        trace_flags="01" if trace.sampled else "00",
    )


def _publish_queue_name(kwargs: Mapping[str, Any]) -> str | None:
    for key in ("queue", "routing_key"):
        value = kwargs.get(key)
        if isinstance(value, str):
            return _instrumentation.optional_label(value)
    return None


def _safe_non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _queue_wait_ms(headers: Mapping[str, Any] | None, wall_clock: _instrumentation.Clock) -> int | None:
    if headers is None:
        return None
    raw_value = None
    for key, value in headers.items():
        if isinstance(key, str) and key.lower() == _ENQUEUED_AT_HEADER:
            raw_value = value
            break
    if not isinstance(raw_value, str) or len(raw_value) > 16 or not raw_value.isdecimal():
        return None
    enqueued_at_ms = int(raw_value)
    now_ms = round(wall_clock() * 1000)
    return min(max(now_ms - enqueued_at_ms, 0), _MAX_QUEUE_WAIT_MS)


def _normalized_task_state(state: Any) -> str:
    if not isinstance(state, str):
        return "unknown"
    normalized = state.strip().lower()
    return normalized if normalized in _TASK_STATES else "unknown"


def _default_event_id() -> str:
    return f"evt_python_celery_{uuid4().hex}"


def _has_instance_attribute(instance: Any, name: str) -> bool:
    try:
        return name in vars(instance)
    except TypeError:
        return False


def _instance_attribute(instance: Any, name: str) -> Any:
    try:
        return vars(instance).get(name)
    except TypeError:
        return None


def _existing_instrumentation(app: Any) -> LogBrewCeleryInstrumentation | None:
    with suppress(Exception):
        instrumentation = getattr(app, _INSTRUMENTATION_ATTR, None)
        if isinstance(instrumentation, LogBrewCeleryInstrumentation):
            return instrumentation
    try:
        return _APP_INSTRUMENTATIONS.get(app)
    except TypeError:
        return _APP_INSTRUMENTATIONS_BY_ID.get(id(app))


def _remember_instrumentation(app: Any, instrumentation: LogBrewCeleryInstrumentation) -> None:
    with suppress(Exception):
        setattr(app, _INSTRUMENTATION_ATTR, instrumentation)
    try:
        _APP_INSTRUMENTATIONS[app] = instrumentation
    except TypeError:
        _APP_INSTRUMENTATIONS_BY_ID[id(app)] = instrumentation


def _forget_instrumentation(app: Any, instrumentation: LogBrewCeleryInstrumentation) -> None:
    with suppress(Exception):
        if getattr(app, _INSTRUMENTATION_ATTR, None) is instrumentation:
            delattr(app, _INSTRUMENTATION_ATTR)
    try:
        if _APP_INSTRUMENTATIONS.get(app) is instrumentation:
            del _APP_INSTRUMENTATIONS[app]
        return
    except TypeError:
        pass
    if _APP_INSTRUMENTATIONS_BY_ID.get(id(app)) is instrumentation:
        del _APP_INSTRUMENTATIONS_BY_ID[id(app)]


def _existing_worker_lifecycle(app: Any) -> Any:
    with suppress(Exception):
        lifecycle = getattr(app, _WORKER_LIFECYCLE_ATTR, None)
        if lifecycle is not None:
            return lifecycle
    try:
        return _APP_WORKER_LIFECYCLES.get(app)
    except TypeError:
        return _APP_WORKER_LIFECYCLES_BY_ID.get(id(app))


def _remember_worker_lifecycle(app: Any, lifecycle: Any) -> None:
    with suppress(Exception):
        setattr(app, _WORKER_LIFECYCLE_ATTR, lifecycle)
    try:
        _APP_WORKER_LIFECYCLES[app] = lifecycle
    except TypeError:
        _APP_WORKER_LIFECYCLES_BY_ID[id(app)] = lifecycle


def _forget_worker_lifecycle(app: Any, lifecycle: Any) -> None:
    with suppress(Exception):
        if getattr(app, _WORKER_LIFECYCLE_ATTR, None) is lifecycle:
            delattr(app, _WORKER_LIFECYCLE_ATTR)
    try:
        if _APP_WORKER_LIFECYCLES.get(app) is lifecycle:
            del _APP_WORKER_LIFECYCLES[app]
        return
    except TypeError:
        pass
    if _APP_WORKER_LIFECYCLES_BY_ID.get(id(app)) is lifecycle:
        del _APP_WORKER_LIFECYCLES_BY_ID[id(app)]


def _notify_capture_error(callback: Callable[[Exception], None] | None, error: Exception) -> None:
    if callback is not None:
        with suppress(Exception):
            callback(error)
