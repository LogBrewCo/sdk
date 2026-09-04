"""Reversible Dramatiq producer and worker correlation for one broker."""

from __future__ import annotations

import importlib
from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractContextManager, suppress
from contextvars import ContextVar
from dataclasses import dataclass
from threading import RLock
from typing import Any

from logbrew_sdk import SdkError, _instrumentation
from logbrew_sdk._queue_client import (
    _queue_trace_carrier,
    _queue_trace_from_carrier,
    _queue_wait_metadata,
    _QueueInstrumentationConfig,
    _QueueSpanRequest,
)
from logbrew_sdk._trace_context import get_active_logbrew_trace, use_logbrew_trace

_ATTR = "_logbrew_dramatiq_instrumentation"
_TRACE_OPTION = "_logbrew_trace"
_RETRY_OPTION = "_logbrew_retry"
_ACTIVE_TRACE_OPTION = "_logbrew_active_trace"
_ACTIVE_CLIENT: ContextVar[tuple[int, Any] | None] = ContextVar(
    "logbrew_active_dramatiq_client", default=None
)


def instrument_dramatiq_broker_with_logbrew_spans(
    broker: Any,
    *,
    client: Any,
    logger_names: Sequence[str] = (),
    metadata: Mapping[str, Any] | None = None,
    event_id_factory: Callable[[], str] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    wall_clock: _instrumentation.Clock | None = None,
    max_in_flight_jobs: int = 1024,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewDramatiqInstrumentation:
    """Instrument one broker without reading message arguments or patching globals."""

    existing = getattr(broker, _ATTR, None)
    if isinstance(existing, LogBrewDramatiqInstrumentation) and existing.installed:
        return existing
    if type(max_in_flight_jobs) is not int or max_in_flight_jobs <= 0:
        raise TypeError("max_in_flight_jobs must be a positive integer")
    middleware_module, retry_type = _require_dramatiq(broker)
    return LogBrewDramatiqInstrumentation(
        broker,
        client,
        logger_names,
        _QueueInstrumentationConfig.create(
            "dramatiq",
            "Dramatiq",
            metadata,
            event_id_factory,
            span_id_factory,
            clock,
            wall_clock,
            on_capture_error,
        ),
        max_in_flight_jobs,
        middleware_module.Retries,
        retry_type,
    )


class LogBrewDramatiqInstrumentation:
    """Instance-scoped Dramatiq publish, process, log, and issue capture."""

    def __init__(
        self,
        broker: Any,
        client: Any,
        logger_names: Sequence[str],
        config: _QueueInstrumentationConfig,
        max_in_flight_jobs: int,
        retries_type: type[Any],
        retry_type: type[BaseException],
    ) -> None:
        self.broker, self._client, self._config = broker, client, config
        self._enqueue = broker.enqueue
        self._active: dict[int, _DramatiqJobState] = {}
        self._lock, self._maximum = RLock(), max_in_flight_jobs
        self._retry_type = retry_type
        self._handlers = config.logger_handlers(id(self), _ACTIVE_CLIENT, logger_names)
        self._undo_patch: Callable[[], None] = lambda: None
        self.installed = False
        self._has_retries = any(
            isinstance(item, retries_type) for item in broker.middleware
        )
        broker.add_middleware(
            self, **({"before": retries_type} if self._has_retries else {})
        )
        try:
            self._undo_patch = _instrumentation.patch_instance_attributes(
                broker, {"enqueue": self._instrumented_enqueue}
            )
            for logger, handler in self._handlers:
                logger.addHandler(handler)
            setattr(broker, _ATTR, self)
            self.installed = True
        except Exception:
            self._undo_patch()
            self._remove_middleware()
            for logger, handler in self._handlers:
                logger.removeHandler(handler)
            raise

    def _instrumented_enqueue(self, message: Any, *, delay: int | None = None) -> Any:
        try:
            options = _message_options(message)
            active_trace = options.pop(_ACTIVE_TRACE_OPTION, None)
            if active_trace is not None:
                options[_TRACE_OPTION] = active_trace
                options[_RETRY_OPTION] = True
                return self._enqueue(message, delay=delay)
            if options.pop(_RETRY_OPTION, False) is True:
                return self._enqueue(message, delay=delay)
            trace = get_active_logbrew_trace() or _queue_trace_from_carrier(
                options.get(_TRACE_OPTION)
            )
            request = self._config.request(
                "publish",
                self._client,
                _message_label(message, "actor_name"),
                _message_label(message, "queue_name"),
                trace,
            )
            options[_TRACE_OPTION] = _queue_trace_carrier(
                request.trace, self._config.wall_clock
            )
        except Exception as error:
            self._config.notify(error)
            return self._enqueue(message, delay=delay)
        with use_logbrew_trace(request.trace):
            try:
                result = self._enqueue(message, delay=delay)
            except Exception as error:
                request.capture("error", error=error)
                raise
        request.capture("ok")
        return result

    def before_process_message(self, broker: Any, message: Any) -> None:
        if not self.installed:
            return
        try:
            key, options = id(message), _message_options(message)
            with self._lock:
                if key in self._active:
                    return
                if len(self._active) >= self._maximum:
                    raise SdkError(
                        "configuration_error", "Dramatiq in-flight job limit reached"
                    )
                request = self._config.request(
                    "process",
                    self._client,
                    _message_label(message, "actor_name"),
                    _message_label(message, "queue_name"),
                    _queue_trace_from_carrier(options.get(_TRACE_OPTION)),
                    attempt=_safe_attempt(options.get("retries")),
                    metadata=_queue_wait_metadata(
                        options.get(_TRACE_OPTION), self._config.wall_clock
                    ),
                )
                carrier = _queue_trace_carrier(request.trace, self._config.wall_clock)
                scope = use_logbrew_trace(request.trace)
                scope.__enter__()
                state = _DramatiqJobState(
                    request, scope, _ACTIVE_CLIENT.set((id(self), self._client))
                )
                options[_ACTIVE_TRACE_OPTION] = carrier
                self._active[key] = state
        except Exception as error:
            self._config.notify(error)

    def after_process_message(
        self,
        broker: Any,
        message: Any,
        *,
        result: Any = None,
        exception: BaseException | None = None,
    ) -> None:
        outcome = "success" if exception is None else (
            "failure" if getattr(message, "failed", False) or not self._has_retries else "retry"
        )
        self._finish(message, outcome, exception)

    def after_skip_message(self, broker: Any, message: Any) -> None:
        self._finish(message, "skipped", None)

    def _finish(
        self, message: Any, outcome: str, exception: BaseException | None
    ) -> None:
        with self._lock:
            state = self._active.pop(id(message), None)
        if state is None:
            return
        try:
            with suppress(Exception):
                _message_options(message).pop(_ACTIVE_TRACE_OPTION, None)
            state.request.metadata = {**(state.request.metadata or {}), "taskState": outcome}
            if (
                outcome == "failure"
                and isinstance(exception, Exception)
                and not isinstance(exception, self._retry_type)
                and not _declared_error(self.broker, message, exception)
            ):
                try:
                    self._config.capture_issue(state.request, exception)
                except Exception as error:
                    self._config.notify(error)
            state.request.capture(
                "ok" if exception is None else "error",
                error_type=type(exception).__name__ if exception is not None else None,
            )
        finally:
            state.close()

    def uninstall(self) -> None:
        with self._lock:
            if self._active:
                raise SdkError(
                    "configuration_error",
                    "Dramatiq instrumentation cannot uninstall while a job is running",
                )
            if not self.installed:
                return
            self.installed = False
        self._undo_patch()
        self._remove_middleware()
        for logger, handler in self._handlers:
            logger.removeHandler(handler)
        if getattr(self.broker, _ATTR, None) is self:
            delattr(self.broker, _ATTR)

    def _remove_middleware(self) -> None:
        with suppress(ValueError):
            self.broker.middleware.remove(self)

    @property
    def actor_options(self) -> set[str]:
        return set()

    def __getattr__(self, name: str) -> Callable[..., None]:
        if name.startswith(("before_", "after_")):
            return lambda *args, **kwargs: None
        raise AttributeError(name)


@dataclass(slots=True)
class _DramatiqJobState:
    request: _QueueSpanRequest
    scope: AbstractContextManager[Any]
    client_context: Any

    def close(self) -> None:
        _ACTIVE_CLIENT.reset(self.client_context)
        self.scope.__exit__(None, None, None)


def _require_dramatiq(broker: Any) -> tuple[Any, type[BaseException]]:
    if not callable(getattr(broker, "enqueue", None)) or not callable(
        getattr(broker, "add_middleware", None)
    ) or not isinstance(getattr(broker, "middleware", None), list):
        raise SdkError("configuration_error", "a Dramatiq broker instance is required")
    try:
        root = importlib.import_module("dramatiq")
        return importlib.import_module("dramatiq.middleware"), root.Retry
    except Exception as error:
        raise SdkError(
            "configuration_error",
            "Dramatiq instrumentation requires the dramatiq extra",
        ) from error


def _message_options(message: Any) -> dict[str, Any]:
    options = getattr(message, "options", None)
    if not isinstance(options, dict):
        raise SdkError("configuration_error", "Dramatiq message options must be a dictionary")
    return options


def _message_label(message: Any, field: str) -> str | None:
    with suppress(Exception):
        label = _instrumentation.optional_label(getattr(message, field, None))
        return label[:256] if label else None
    return None


def _safe_attempt(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _declared_error(broker: Any, message: Any, error: BaseException) -> bool:
    with suppress(Exception):
        actor = broker.get_actor(message.actor_name)
        throws = message.options.get("throws") or actor.options.get("throws")
        return bool(throws and isinstance(error, throws))
    return False
