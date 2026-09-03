"""RQ convenience helpers built on explicit LogBrew queue spans."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, TypeVar

from logbrew_sdk import (
    SdkError,
    _instrumentation,
)
from logbrew_sdk._queue_client import (
    Operation,
    _queue_trace_carrier,
    _queue_trace_from_carrier,
    _queue_wait_metadata,
    _QueueInstrumentationConfig,
    _QueueSpanRequest,
    queue_operation_with_logbrew_span,
)
from logbrew_sdk._trace_context import LogBrewTraceContext, use_logbrew_trace

T = TypeVar("T")
_RQ_META_KEY = "_logbrew_trace"
_MAX_LABEL_LENGTH = 256
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
        _QueueInstrumentationConfig.create(
            "rq",
            "RQ",
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
        _QueueInstrumentationConfig.create(
            "rq",
            "RQ",
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

    def __init__(
        self, queue: Any, client: Any, config: _QueueInstrumentationConfig
    ) -> None:
        original = getattr(queue, "enqueue_job", None)
        if not callable(original):
            raise SdkError("configuration_error", "RQ queue must provide enqueue_job")
        self.queue = queue
        self._client = client
        self._config = config
        self._original = original
        self.installed = True
        self._restore_attributes = _instrumentation.patch_instance_attributes(queue, {"enqueue_job": self._enqueue})
        queue._logbrew_queue_instrumentation = self

    def _enqueue(self, job: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            request = _rq_request(
                self._config, "publish", self._client, job, self.queue
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
        self._restore_attributes()
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
        config: _QueueInstrumentationConfig,
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
        self._active: dict[int, _RqJobState] = {}
        self._handlers = config.logger_handlers(id(self), _ACTIVE_RQ_CLIENT, logger_names)
        for logger, handler in self._handlers:
            logger.addHandler(handler)
        self._restore_attributes = _instrumentation.patch_instance_attributes(
            worker, {"perform_job": self._perform, "handle_exception": self._handle}
        )
        worker._logbrew_worker_instrumentation = self
        self.installed = True

    def _perform(self, job: Any, queue: Any) -> Any:
        client: Any = None
        try:
            client = self._client_factory()
            request = _rq_request(
                self._config,
                "process",
                client,
                job,
                queue,
                _queue_trace_from_carrier(_rq_job_carrier(job)),
            )
        except Exception as error:
            self._config.notify(error)
            _shutdown(client, self._config)
            return self._perform_job(job, queue)
        state = _RqJobState(request)
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
                    self._config.capture_issue(state.request, error)
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
        self._restore_attributes()
        if getattr(self.worker, "_logbrew_worker_instrumentation", None) is self:
            del self.worker._logbrew_worker_instrumentation
        for logger, handler in self._handlers:
            logger.removeHandler(handler)
        self.installed = False


@dataclass(slots=True)
class _RqJobState:
    request: _QueueSpanRequest
    error_type: str | None = None


def _rq_request(
    config: _QueueInstrumentationConfig,
    operation_kind: str,
    client: Any,
    job: Any,
    queue: Any,
    trace: LogBrewTraceContext | None = None,
) -> _QueueSpanRequest:
    task_name = _safe_job_label(job, "func_name")
    queue_name = _safe_job_label(queue, "name") or _safe_job_label(job, "origin")
    metadata = (
        _queue_wait_metadata(_rq_job_carrier(job), config.wall_clock)
        if operation_kind == "process"
        else None
    )
    return config.request(
        operation_kind,
        client,
        task_name,
        queue_name,
        trace,
        metadata=metadata,
    )


def _write_job_trace(
    job: Any, trace: LogBrewTraceContext, wall_clock: _instrumentation.Clock
) -> None:
    meta = getattr(job, "meta", None)
    if not isinstance(meta, dict):
        raise SdkError("configuration_error", "RQ job metadata must be a dictionary")
    meta[_RQ_META_KEY] = _queue_trace_carrier(trace, wall_clock)


def _rq_job_carrier(job: Any) -> Any:
    with suppress(Exception):
        return getattr(job, "meta", {}).get(_RQ_META_KEY)
    return None


def _should_retry(job: Any) -> bool:
    with suppress(Exception):
        return bool(job.should_retry)
    return True


def _shutdown(client: Any, config: _QueueInstrumentationConfig) -> None:
    if client is not None:
        try:
            client.shutdown()
        except Exception as error:
            config.notify(error)
