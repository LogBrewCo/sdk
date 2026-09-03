"""Instance-scoped ARQ producer and worker trace correlation."""

from __future__ import annotations

import asyncio
import functools
import importlib
import logging
import pickle
from collections.abc import Callable, Mapping, MutableMapping, Sequence
from contextlib import suppress
from contextvars import ContextVar
from copy import copy
from dataclasses import dataclass, field
from threading import RLock
from typing import Any, TypeVar, cast

from logbrew_sdk import SdkError, _instrumentation
from logbrew_sdk._queue_client import (
    _queue_trace_carrier,
    _queue_trace_from_carrier,
    _queue_wait_metadata,
    _QueueInstrumentationConfig,
    _QueueSpanRequest,
)
from logbrew_sdk._trace_context import LogBrewTraceContext, use_logbrew_trace

_TRACE_KEY = "_logbrew_trace"
_CodecResult = TypeVar("_CodecResult")
_PUBLISH_CARRIER: ContextVar[Mapping[str, str] | None] = ContextVar(
    "logbrew_arq_publish_carrier", default=None
)
_ACTIVE_JOB: ContextVar[tuple[int, _ArqJobState] | None] = ContextVar(
    "logbrew_arq_active_job", default=None
)
_ACTIVE_CLIENT: ContextVar[tuple[int, Any] | None] = ContextVar(
    "logbrew_arq_active_client", default=None
)


@dataclass(slots=True)
class _ArqJobState:
    start: float | None = None
    carrier: Any = None
    task_name: str | None = None
    context: dict[str, int | None] = field(default_factory=dict)
    started: bool = False
    reported: bool = False
    pending_cancel: tuple[_QueueSpanRequest, BaseException] | None = None
    worker_error: BaseException | None = None
    task_trace: LogBrewTraceContext | None = None

    def read(self, data: Mapping[str, object]) -> None:
        self.task_name = _safe_label(data.get("f"))
        self.context = {"job_try": _safe_attempt(data.get("t")), "enqueue_time_ms": _safe_attempt(data.get("et"))}


class _ArqFailureObserver(logging.Filter):
    """Observe typed ARQ failures without copying worker log messages or arguments."""

    def __init__(self, owner: int) -> None:
        super().__init__()
        self.owner = owner
        self.worker_file = importlib.import_module("arq.worker").Worker.run_job.__code__.co_filename

    def filter(self, record: logging.LogRecord) -> bool:
        active = _ACTIVE_JOB.get()
        if active is None or active[0] != self.owner or active[1].pending_cancel is None:
            return True
        with suppress(Exception):
            if (
                record.levelno >= logging.ERROR
                and record.name == "arq.worker"
                and record.pathname == self.worker_file
                and record.funcName == "run_job"
                and record.exc_info
                and isinstance(record.exc_info[1], BaseException)
            ):
                active[1].worker_error = record.exc_info[1]
        return True


def instrument_arq_pool_with_logbrew_spans(
    pool: Any,
    *,
    client: Any,
    metadata: Mapping[str, Any] | None = None,
    event_id_factory: Callable[[], str] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    wall_clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewArqPoolInstrumentation:
    """Instrument one ARQ Redis pool without changing task arguments."""

    existing = getattr(pool, "_logbrew_arq_pool_instrumentation", None)
    if isinstance(existing, LogBrewArqPoolInstrumentation) and existing.installed:
        return existing
    return LogBrewArqPoolInstrumentation(
        pool,
        client,
        _QueueInstrumentationConfig.create(
            "arq",
            "ARQ",
            metadata,
            event_id_factory,
            span_id_factory,
            clock,
            wall_clock,
            on_capture_error,
        ),
    )


def instrument_arq_worker_with_logbrew_spans(
    worker: Any,
    *,
    client: Any,
    logger_names: Sequence[str] = (),
    metadata: Mapping[str, Any] | None = None,
    event_id_factory: Callable[[], str] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    wall_clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewArqWorkerInstrumentation:
    """Instrument the registered functions of one ARQ worker instance."""

    existing = getattr(worker, "_logbrew_arq_worker_instrumentation", None)
    if isinstance(existing, LogBrewArqWorkerInstrumentation) and existing.installed:
        return existing
    return LogBrewArqWorkerInstrumentation(
        worker,
        client,
        logger_names,
        _QueueInstrumentationConfig.create(
            "arq",
            "ARQ",
            metadata,
            event_id_factory,
            span_id_factory,
            clock,
            wall_clock,
            on_capture_error,
        ),
    )


class LogBrewArqPoolInstrumentation:
    """Reversible ARQ enqueue instrumentation for one Redis pool."""

    def __init__(
        self, pool: Any, client: Any, config: _QueueInstrumentationConfig
    ) -> None:
        enqueue = getattr(pool, "enqueue_job", None)
        if not callable(enqueue):
            raise SdkError("configuration_error", "ARQ pool must provide enqueue_job")
        self._serializer = _arq_codec(pool, "job_serializer", pickle.dumps)
        self.pool, self._client, self._config = pool, client, config
        self._active = 0
        self._enqueue_job = enqueue
        self.installed = True
        self._restore_attributes = _instrumentation.patch_instance_attributes(
            pool, {"job_serializer": self._serialize, "enqueue_job": self._enqueue}
        )
        pool._logbrew_arq_pool_instrumentation = self

    async def _enqueue(self, function: str, *args: Any, **kwargs: Any) -> Any:
        self._active += 1
        try:
            try:
                task_name = _safe_label(function)
                if task_name is None:
                    raise SdkError("configuration_error", "ARQ task name is unavailable")
                queue_name = _safe_label(kwargs.get("_queue_name")) or _safe_label(
                    getattr(self.pool, "default_queue_name", None)
                )
                request = self._config.request(
                    "publish",
                    self._client,
                    task_name,
                    queue_name,
                    attempt=_safe_attempt(kwargs.get("_job_try")),
                )
                carrier = _queue_trace_carrier(request.trace, self._config.wall_clock)
            except Exception as error:
                self._config.notify(error)
                return await self._enqueue_job(function, *args, **kwargs)

            marker = _PUBLISH_CARRIER.set(carrier)
            with use_logbrew_trace(request.trace):
                try:
                    result = await self._enqueue_job(function, *args, **kwargs)
                except BaseException as error:
                    request.capture("error", error_type=type(error).__name__)
                    raise
                finally:
                    _PUBLISH_CARRIER.reset(marker)
            request.capture("ok")
            return result
        finally:
            self._active -= 1

    def _serialize(self, data: dict[str, Any]) -> bytes:
        carrier = _PUBLISH_CARRIER.get()
        if carrier:
            try:
                return self._serializer({**data, _TRACE_KEY: dict(carrier)})
            except Exception as error:
                self._config.notify(error)
        return self._serializer(data)

    def uninstall(self) -> None:
        if not self.installed:
            return
        if self._active:
            raise SdkError("configuration_error", "ARQ instrumentation cannot uninstall while an enqueue is running")
        self._restore_attributes()
        if getattr(self.pool, "_logbrew_arq_pool_instrumentation", None) is self:
            del self.pool._logbrew_arq_pool_instrumentation
        self.installed = False


class LogBrewArqWorkerInstrumentation:
    """Reversible trace, log, and terminal-failure capture for one ARQ worker."""

    def __init__(
        self,
        worker: Any,
        client: Any,
        logger_names: Sequence[str],
        config: _QueueInstrumentationConfig,
    ) -> None:
        run_job = getattr(worker, "run_job", None)
        functions = getattr(worker, "functions", None)
        if not callable(run_job) or not isinstance(functions, MutableMapping):
            raise SdkError(
                "configuration_error",
                "ARQ worker and registered functions are required",
            )
        self._deserializer = _arq_codec(worker, "job_deserializer", pickle.loads)
        self._serializer = _arq_codec(worker, "job_serializer", pickle.dumps)
        self.worker, self._client, self._config = worker, client, config
        self._run_job = run_job
        self._control_errors = _arq_control_errors()
        self._active, self._lock = 0, RLock()
        self._wrapped_functions: list[tuple[Any, Any, Any]] = []
        self._handlers = config.logger_handlers(id(self), _ACTIVE_CLIENT, logger_names)
        self._worker_logger = logging.getLogger("arq.worker")
        self._error_filter = _ArqFailureObserver(id(self))
        for name, function in functions.items():
            coroutine = getattr(function, "coroutine", None)
            if not callable(coroutine):
                continue
            wrapped = copy(function)
            wrapped.coroutine = self._wrap_callback(coroutine, function=function)
            self._wrapped_functions.append((name, function, wrapped))
        overrides = {
            "job_deserializer": self._deserialize, "job_serializer": self._serialize_result, "run_job": self._run,
        }
        for name in ("on_job_end", "after_job_end"):
            hook = getattr(worker, name, None)
            if hook is not None:
                if not callable(hook):
                    raise SdkError("configuration_error", f"ARQ {name} hook must be callable")
                overrides[name] = self._wrap_callback(hook, hook_name=name)
        self.installed = True
        self._restore_attributes = _instrumentation.patch_instance_attributes(worker, overrides)
        for name, _, wrapped in self._wrapped_functions:
            functions[name] = wrapped
        for logger, handler in self._handlers:
            logger.addHandler(handler)
        self._worker_logger.addFilter(self._error_filter)
        worker._logbrew_arq_worker_instrumentation = self

    async def _run(self, job_id: str, score: int) -> Any:
        state = _ArqJobState()
        marker = _ACTIVE_JOB.set((id(self), state))
        with self._lock:
            self._active += 1
        with use_logbrew_trace(None):
            try:
                try:
                    state.start = self._config.clock()
                except Exception as error:
                    self._config.notify(error)
                return await self._run_job(job_id, score)
            except BaseException as error:
                self._capture_early_failure(state, error)
                raise
            finally:
                self._finish_cancelled_job(state)
                _ACTIVE_JOB.reset(marker)
                with self._lock:
                    self._active -= 1

    def _deserialize(self, payload: bytes) -> Any:
        data = self._deserializer(payload)
        active = _ACTIVE_JOB.get()
        if active is not None and active[0] == id(self) and isinstance(data, dict):
            try:
                active[1].carrier = data.get(_TRACE_KEY)
                active[1].read(data)
            except Exception as error:
                self._config.notify(error)
        return data

    def _serialize_result(self, data: dict[str, Any]) -> bytes:
        active = _ACTIVE_JOB.get()
        if active is not None and active[0] == id(self):
            try:
                if data.get("s") is False and isinstance(data.get("r"), BaseException):
                    active[1].read(data)
                    active[1].worker_error = data["r"]
                    self._capture_early_failure(active[1], data["r"])
            except Exception as error:
                self._config.notify(error)
        return self._serializer(data)

    def _finish_cancelled_job(self, state: _ArqJobState) -> None:
        pending, outcome = state.pending_cancel, state.worker_error
        state.pending_cancel = state.worker_error = None
        if pending is None:
            return
        request, cancellation = pending
        request.metadata = {
            **(request.metadata or {}),
            "queueCancellationOutcome": "observed" if outcome is not None else "unavailable",
        }
        self._capture_error(request, outcome if outcome is not None else cancellation)

    def _capture_early_failure(self, state: _ArqJobState, error: BaseException) -> None:
        if state.started or state.reported:
            return
        state.reported = True
        if state.start is None:
            return
        try:
            request = self._config.request(
                "process", self._client, state.task_name, _safe_label(self.worker.queue_name),
                _queue_trace_from_carrier(state.carrier), attempt=state.context.get("job_try"),
                metadata={"queueFailureStage": "before_execution", **_arq_queue_wait_metadata(
                    state.carrier, state.context, self._config.wall_clock,
                )},
            )
            request.start = state.start
            self._capture_error(request, error)
        except Exception as capture_error:
            self._config.notify(capture_error)

    def _capture_error(
        self, request: _QueueSpanRequest, error: BaseException, *, hook_name: str | None = None,
    ) -> None:
        if hook_name:
            request.metadata = {**(request.metadata or {}), "queueFailureStage": "after_execution"}
        retry = hook_name is None and self.worker.retry_jobs and isinstance(error, self._control_errors)
        with use_logbrew_trace(request.trace):
            if isinstance(error, Exception) and not retry:
                try:
                    self._config.capture_issue(request, error, hook_name=hook_name)
                except Exception as capture_error:
                    self._config.notify(capture_error)
            request.capture("error", error_type=type(error).__name__)

    def _wrap_callback(
        self, coroutine: Callable[..., Any], *, function: Any = None, hook_name: str | None = None,
    ) -> Callable[..., Any]:
        @functools.wraps(coroutine)
        async def run(ctx: Mapping[str, Any], *args: Any, **kwargs: Any) -> Any:
            active = _ACTIVE_JOB.get()
            if active is None or active[0] != id(self) or not self.installed:
                return await coroutine(ctx, *args, **kwargs)
            state = active[1]
            if hook_name:
                self._finish_cancelled_job(state)
            else:
                state.started = True
            try:
                task_name = state.task_name if hook_name else _safe_label(getattr(function, "name", None))
                queue_name = _safe_label(getattr(self.worker, "queue_name", None))
                request = self._config.request(
                    "process",
                    self._client,
                    task_name,
                    queue_name,
                    (state.task_trace if hook_name else None) or _queue_trace_from_carrier(state.carrier),
                    attempt=_safe_attempt(ctx.get("job_try")),
                    metadata=({"queueHook": hook_name} if hook_name
                              else _arq_queue_wait_metadata(state.carrier, ctx, self._config.wall_clock)),
                )
                if hook_name:
                    request.operation_name = f"{hook_name} {task_name or 'unknown'}"
                else:
                    state.task_trace = request.trace
            except Exception as error:
                self._config.notify(error)
                return await coroutine(ctx, *args, **kwargs)
            client_marker = _ACTIVE_CLIENT.set((id(self), self._client))
            try:
                with use_logbrew_trace(request.trace):
                    try:
                        result = await coroutine(ctx, *args, **kwargs)
                    except BaseException as error:
                        if hook_name is None and isinstance(error, asyncio.CancelledError):
                            state.pending_cancel = (request, error)
                        else:
                            self._capture_error(request, error, hook_name=hook_name)
                        raise
                request.capture("ok")
                return result
            finally:
                _ACTIVE_CLIENT.reset(client_marker)

        return run

    def uninstall(self) -> None:
        if not self.installed:
            return
        with self._lock:
            if self._active:
                raise SdkError(
                    "configuration_error",
                    "ARQ instrumentation cannot uninstall while a job is running",
                )
        self.installed = False
        self._restore_attributes()
        for name, original, wrapped in self._wrapped_functions:
            if self.worker.functions.get(name) is wrapped:
                self.worker.functions[name] = original
        for logger, handler in self._handlers:
            logger.removeHandler(handler)
        self._worker_logger.removeFilter(self._error_filter)
        if getattr(self.worker, "_logbrew_arq_worker_instrumentation", None) is self:
            del self.worker._logbrew_arq_worker_instrumentation


def _arq_codec(
    instance: Any, name: str, default: Callable[..., _CodecResult]
) -> Callable[..., _CodecResult]:
    codec = getattr(instance, name, None)
    if codec is None:
        return default
    if not callable(codec):
        raise SdkError("configuration_error", f"ARQ {name} must be callable")
    return cast("Callable[..., _CodecResult]", codec)


def _safe_label(value: Any) -> str | None:
    with suppress(Exception):
        label = _instrumentation.optional_label(value)
        return label[:256] if label else None
    return None


def _safe_attempt(value: Any) -> int | None:
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0
        else None
    )


def _arq_queue_wait_metadata(
    carrier: Any,
    context: Mapping[str, Any],
    wall_clock: _instrumentation.Clock,
) -> dict[str, int]:
    metadata = _queue_wait_metadata(carrier, wall_clock)
    if metadata:
        return metadata
    with suppress(Exception):
        enqueued_ms = context.get("enqueue_time_ms")
        enqueued_at = context.get("enqueue_time")
        timestamp = getattr(enqueued_at, "timestamp", None)
        if callable(timestamp):
            enqueued_ms = round(timestamp() * 1000)
        if isinstance(enqueued_ms, int) and enqueued_ms > 0:
            return _queue_wait_metadata({"enqueued_at_ms": str(enqueued_ms)}, wall_clock)
    return {}


def _arq_control_errors() -> tuple[type[BaseException], ...]:
    try:
        worker = importlib.import_module("arq.worker")
        errors = tuple(
            getattr(worker, name)
            for name in ("Retry", "RetryJob")
        )
    except Exception as error:
        raise SdkError(
            "configuration_error",
            "ARQ worker instrumentation requires the arq extra",
        ) from error
    if not all(
        isinstance(error, type) and issubclass(error, BaseException) for error in errors
    ):
        raise SdkError("configuration_error", "ARQ control exceptions are unavailable")
    return errors
