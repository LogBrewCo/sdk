"""RQ convenience helpers built on explicit LogBrew queue spans."""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from contextvars import ContextVar
from dataclasses import dataclass
from time import perf_counter, time
from typing import Any, TypeVar
from uuid import uuid4

from logbrew_sdk import (
    LogBrewLoggingHandler,
    SdkError,
    _instrumentation,
    create_issue_attributes_from_exception,
    create_traceparent,
    parse_traceparent,
)
from logbrew_sdk._queue_client import (
    _QUEUE_METADATA_DENYLIST,
    Operation,
    _queue_span_request,
    _QueueSpanRequest,
    queue_operation_with_logbrew_span,
)
from logbrew_sdk._trace_context import LogBrewTraceContext, use_logbrew_trace

T = TypeVar("T")
_RQ_META_KEY = "_logbrew_trace"
_MAX_LOGGERS = 16
_MAX_LABEL_LENGTH = 256
_MISSING = object()
_ACTIVE_RQ_CLIENT: ContextVar[tuple[int, Any] | None] = ContextVar(
    "logbrew_active_rq_client", default=None
)


def rq_operation_with_logbrew_span(
    *,
    client: Any,
    event_id: str,
    job: Any,
    operation: Operation[T],
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    operation_kind: str = "process",
    operation_name: str | None = None,
    queue_name: str | None = None,
    task_name: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_events: Sequence[_instrumentation.SpanEventSummary] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> T:
    """Run an app-owned RQ operation under a privacy-bounded LogBrew span.

    The helper duck-types common RQ job fields but never imports or patches RQ.
    """

    normalized_kind = _instrumentation.required_label("operation_kind", operation_kind)
    normalized_task_name = _instrumentation.optional_label(
        task_name
    ) or _safe_job_label(job, "func_name")
    normalized_queue_name = _instrumentation.optional_label(
        queue_name
    ) or _safe_job_label(job, "origin")
    default_name = " ".join(filter(None, (normalized_kind, normalized_task_name)))
    normalized_operation_name = (
        _instrumentation.optional_label(operation_name) or default_name
    )

    return queue_operation_with_logbrew_span(
        normalized_operation_name,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        operation=operation,
        system="rq",
        trace=trace,
        operation_kind=normalized_kind,
        queue_name=normalized_queue_name,
        task_name=normalized_task_name,
        message_count=1,
        metadata=metadata,
        span_events=span_events,
        span_id_factory=span_id_factory,
        clock=clock,
        on_capture_error=on_capture_error,
    )


def _safe_job_label(job: Any, field: str) -> str | None:
    with suppress(Exception):
        label = _instrumentation.optional_label(getattr(job, field, None))
        return label[:_MAX_LABEL_LENGTH] if label else None
    return None


def instrument_rq_queue_with_logbrew_spans(
    queue: Any,
    *,
    client: Any,
    metadata: Mapping[str, Any] | None = None,
    event_id_factory: Callable[[], str] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    wall_clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewRqQueueInstrumentation:
    """Instrument one RQ queue instance and persist only W3C parentage."""

    existing = getattr(queue, "_logbrew_queue_instrumentation", None)
    if isinstance(existing, LogBrewRqQueueInstrumentation) and existing.installed:
        return existing
    return LogBrewRqQueueInstrumentation(
        queue,
        client,
        _RqConfig.create(
            metadata,
            event_id_factory,
            span_id_factory,
            clock,
            wall_clock,
            on_capture_error,
        ),
    )


def instrument_rq_worker_processes_with_logbrew(
    worker: Any,
    *,
    client_factory: Callable[[], Any],
    logger_names: Sequence[str] = (),
    metadata: Mapping[str, Any] | None = None,
    event_id_factory: Callable[[], str] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    wall_clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewRqWorkerInstrumentation:
    """Create, flush, and close one child-owned client per RQ job."""

    existing = getattr(worker, "_logbrew_worker_instrumentation", None)
    if isinstance(existing, LogBrewRqWorkerInstrumentation) and existing.installed:
        return existing
    return LogBrewRqWorkerInstrumentation(
        worker,
        client_factory,
        logger_names,
        _RqConfig.create(
            metadata,
            event_id_factory,
            span_id_factory,
            clock,
            wall_clock,
            on_capture_error,
        ),
    )


class LogBrewRqQueueInstrumentation:
    """Reversible producer instrumentation for one RQ queue instance."""

    def __init__(self, queue: Any, client: Any, config: _RqConfig) -> None:
        original = getattr(queue, "enqueue_job", None)
        if not callable(original):
            raise SdkError("configuration_error", "RQ queue must provide enqueue_job")
        self.queue = queue
        self._client = client
        self._config = config
        self._original = original
        self._wrapped = self._enqueue
        self._previous = vars(queue).get("enqueue_job", _MISSING)
        self.installed = True
        queue.enqueue_job = self._wrapped
        queue._logbrew_queue_instrumentation = self

    def _enqueue(self, job: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            request, _, _ = self._config.request(
                "publish", self._client, job, self.queue
            )
            _write_job_trace(job, request.trace, self._config.wall_clock)
        except Exception as error:
            self._config.notify(error)
            return self._original(job, *args, **kwargs)
        with use_logbrew_trace(request.trace):
            try:
                result = self._original(job, *args, **kwargs)
            except Exception as error:
                request.capture("error", error=error)
                raise
        request.capture("ok")
        return result

    def uninstall(self) -> None:
        if not self.installed:
            return
        if getattr(self.queue, "enqueue_job", None) is self._wrapped:
            _restore(self.queue, "enqueue_job", self._previous)
        if getattr(self.queue, "_logbrew_queue_instrumentation", None) is self:
            del self.queue._logbrew_queue_instrumentation
        self.installed = False


class LogBrewRqWorkerInstrumentation:
    """Reversible, fork-safe worker instrumentation for one RQ worker."""

    def __init__(
        self,
        worker: Any,
        client_factory: Callable[[], Any],
        logger_names: Sequence[str],
        config: _RqConfig,
    ) -> None:
        perform_job = getattr(worker, "perform_job", None)
        handle_exception = getattr(worker, "handle_exception", None)
        if (
            not callable(client_factory)
            or not callable(perform_job)
            or not callable(handle_exception)
        ):
            raise SdkError(
                "configuration_error", "RQ worker and client factory are required"
            )
        self.worker = worker
        self._client_factory = client_factory
        self._config = config
        self._perform_job = perform_job
        self._handle_exception = handle_exception
        attributes = vars(worker)
        self._previous = {
            "perform_job": attributes.get("perform_job", _MISSING),
            "handle_exception": attributes.get("handle_exception", _MISSING),
        }
        self._active: dict[int, _RqJobState] = {}
        self._wrapped_perform = self._perform
        self._wrapped_exception = self._handle
        proxy: Any = _RqClientProxy(id(self))
        self._handlers = [
            (
                logging.getLogger(name),
                LogBrewLoggingHandler(
                    proxy,
                    metadata=_instrumentation.compact_metadata_without_keys(
                        self._config.metadata,
                        _QUEUE_METADATA_DENYLIST,
                    ),
                ),
            )
            for name in _normalized_logger_names(logger_names)
        ]
        for logger, handler in self._handlers:
            logger.addHandler(handler)
        worker.perform_job = self._wrapped_perform
        worker.handle_exception = self._wrapped_exception
        worker._logbrew_worker_instrumentation = self
        self.installed = True

    def _perform(self, job: Any, queue: Any) -> Any:
        client: Any = None
        try:
            client = self._client_factory()
            request, task_name, queue_name = self._config.request(
                "process",
                client,
                job,
                queue,
                _read_job_trace(job),
            )
        except Exception as error:
            self._config.notify(error)
            _shutdown(client, self._config)
            return self._perform_job(job, queue)
        state = _RqJobState(client, request, task_name, queue_name)
        self._active[id(job)] = state
        context_marker = _ACTIVE_RQ_CLIENT.set((id(self), client))
        result: Any = False
        with use_logbrew_trace(request.trace):
            try:
                result = self._perform_job(job, queue)
            except BaseException as error:
                state.error_type = type(error).__name__
                raise
            finally:
                self._active.pop(id(job), None)
                request.capture(
                    "ok" if result is True else "error", error_type=state.error_type
                )
                _ACTIVE_RQ_CLIENT.reset(context_marker)
                _shutdown(client, self._config)
        return result

    def _handle(self, job: Any, *exc_info: Any, **kwargs: Any) -> Any:
        state = self._active.get(id(job))
        error = exc_info[1] if len(exc_info) > 1 else None
        if state is not None and isinstance(error, BaseException):
            state.error_type = type(error).__name__
            if not _should_retry(job):
                try:
                    state.capture_issue(error, self._config)
                except Exception as capture_error:
                    self._config.notify(capture_error)
        return self._handle_exception(job, *exc_info, **kwargs)

    def uninstall(self) -> None:
        if not self.installed:
            return
        if self._active:
            raise SdkError(
                "configuration_error",
                "RQ instrumentation cannot uninstall while a job is running",
            )
        if getattr(self.worker, "perform_job", None) is self._wrapped_perform:
            _restore(self.worker, "perform_job", self._previous["perform_job"])
        if getattr(self.worker, "handle_exception", None) is self._wrapped_exception:
            _restore(
                self.worker, "handle_exception", self._previous["handle_exception"]
            )
        if getattr(self.worker, "_logbrew_worker_instrumentation", None) is self:
            del self.worker._logbrew_worker_instrumentation
        for logger, handler in self._handlers:
            logger.removeHandler(handler)
        self.installed = False


class _RqClientProxy:
    def __init__(self, owner: int) -> None:
        self.owner = owner

    def log(self, *args: Any, **kwargs: Any) -> None:
        active = _ACTIVE_RQ_CLIENT.get()
        if active is not None and active[0] == self.owner:
            active[1].log(*args, **kwargs)


@dataclass(slots=True)
class _RqJobState:
    client: Any
    request: _QueueSpanRequest
    task_name: str | None
    queue_name: str | None
    error_type: str | None = None

    def capture_issue(self, error: BaseException, config: _RqConfig) -> None:
        error_type = type(error).__name__
        issue_metadata = {
            **_instrumentation.compact_metadata_without_keys(
                config.metadata, _QUEUE_METADATA_DENYLIST
            ),
            "source": "queue",
            "operation": "queue.process",
            "taskName": self.task_name or "unknown",
            "taskState": "failure",
            **({"queueName": self.queue_name} if self.queue_name else {}),
            **self.request.trace.metadata(),
        }
        self.client.issue(
            config.event_id_factory(),
            _instrumentation.now_timestamp(),
            create_issue_attributes_from_exception(
                error,
                title=f"RQ task {self.task_name or 'unknown'} failed",
                message=error_type,
                mechanism="rq.job",
                handled=False,
                metadata=issue_metadata,
            ),
        )


@dataclass(slots=True)
class _RqConfig:
    metadata: Mapping[str, Any]
    event_id_factory: Callable[[], str]
    span_id_factory: Callable[[], str] | None
    clock: _instrumentation.Clock
    wall_clock: _instrumentation.Clock
    on_capture_error: Callable[[Exception], None] | None

    @classmethod
    def create(
        cls,
        metadata: Mapping[str, Any] | None,
        event_id_factory: Callable[[], str] | None,
        span_id_factory: Callable[[], str] | None,
        clock: _instrumentation.Clock | None,
        wall_clock: _instrumentation.Clock | None,
        on_capture_error: Callable[[Exception], None] | None,
    ) -> _RqConfig:
        return cls(
            {"framework": "rq", **(metadata or {})},
            event_id_factory or _event_id,
            span_id_factory,
            clock or perf_counter,
            wall_clock or time,
            on_capture_error,
        )

    def request(
        self,
        operation_kind: str,
        client: Any,
        job: Any,
        queue: Any,
        trace: LogBrewTraceContext | None = None,
    ) -> tuple[_QueueSpanRequest, str | None, str | None]:
        task_name = _safe_job_label(job, "func_name")
        queue_name = _safe_job_label(queue, "name") or _safe_job_label(job, "origin")
        request = _queue_span_request(
            operation_name=f"{operation_kind} {task_name}"
            if task_name
            else operation_kind,
            system="rq",
            client=client,
            event_id=self.event_id_factory(),
            timestamp=None,
            trace=trace,
            operation_kind=operation_kind,
            queue_name=queue_name,
            task_name=task_name,
            message_count=1,
            attempt=None,
            metadata={
                **self.metadata,
                **(
                    _queue_wait_metadata(job, self.wall_clock)
                    if operation_kind == "process"
                    else {}
                ),
            },
            span_events=None,
            span_id_factory=self.span_id_factory,
            clock=self.clock,
            on_capture_error=self.on_capture_error,
        )
        return request, task_name, queue_name

    def notify(self, error: Exception) -> None:
        if self.on_capture_error is not None:
            with suppress(Exception):
                self.on_capture_error(error)


def _write_job_trace(
    job: Any, trace: LogBrewTraceContext, wall_clock: _instrumentation.Clock
) -> None:
    meta = getattr(job, "meta", None)
    if not isinstance(meta, dict):
        raise SdkError("configuration_error", "RQ job metadata must be a dictionary")
    meta[_RQ_META_KEY] = {
        "traceparent": create_traceparent(
            trace_id=trace.trace_id,
            span_id=trace.span_id,
            trace_flags="01" if trace.sampled else "00",
        ),
        "enqueued_at_ms": str(round(wall_clock() * 1000)),
    }


def _read_job_trace(job: Any) -> LogBrewTraceContext | None:
    with suppress(Exception):
        trace_data = getattr(job, "meta", {}).get(_RQ_META_KEY)
        traceparent = (
            trace_data.get("traceparent") if isinstance(trace_data, Mapping) else None
        )
        if isinstance(traceparent, str):
            parsed = parse_traceparent(traceparent)
            return LogBrewTraceContext(
                parsed.trace_id, parsed.parent_span_id, sampled=parsed.sampled
            )
    return None


def _queue_wait_metadata(
    job: Any, wall_clock: _instrumentation.Clock
) -> dict[str, int]:
    with suppress(Exception):
        trace_data = getattr(job, "meta", {}).get(_RQ_META_KEY)
        value = (
            trace_data.get("enqueued_at_ms")
            if isinstance(trace_data, Mapping)
            else None
        )
        if isinstance(value, str) and len(value) <= 16 and value.isdecimal():
            return {
                "queueWaitMs": min(
                    max(round(wall_clock() * 1000) - int(value), 0), 86_400_000
                )
            }
    return {}


def _should_retry(job: Any) -> bool:
    with suppress(Exception):
        return bool(job.should_retry)
    return True


def _normalized_logger_names(logger_names: Sequence[str]) -> tuple[str, ...]:
    if isinstance(logger_names, str) or len(logger_names) > _MAX_LOGGERS:
        raise SdkError(
            "configuration_error",
            f"logger_names must contain at most {_MAX_LOGGERS} names",
        )
    normalized = tuple(
        dict.fromkeys(
            _instrumentation.required_label("logger name", name)
            for name in logger_names
        )
    )
    if any(len(name) > _MAX_LABEL_LENGTH for name in normalized):
        raise SdkError(
            "configuration_error",
            f"logger names cannot exceed {_MAX_LABEL_LENGTH} characters",
        )
    return normalized


def _restore(instance: Any, name: str, previous: Any) -> None:
    if previous is _MISSING:
        delattr(instance, name)
    else:
        setattr(instance, name, previous)


def _shutdown(client: Any, config: _RqConfig) -> None:
    if client is not None:
        try:
            client.shutdown()
        except Exception as error:
            config.notify(error)


def _event_id() -> str:
    return f"evt_python_rq_{uuid4().hex}"
