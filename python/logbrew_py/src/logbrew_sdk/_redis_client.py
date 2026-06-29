"""Optional Redis client instrumentation for app-owned Python cache spans."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from time import perf_counter
from typing import Any, TypeVar
from uuid import uuid4

from logbrew_sdk import _instrumentation
from logbrew_sdk._cache_client import _CACHE_METADATA_DENYLIST, _cache_span_request
from logbrew_sdk._trace_context import LogBrewTraceContext, use_logbrew_trace

T = TypeVar("T")

_INSTRUMENTATION_ATTR = "_logbrew_redis_instrumentation"
_REDIS_METADATA_DENYLIST = (
    *_CACHE_METADATA_DENYLIST,
    "connection",
    "database_url",
    "dsn",
    "host",
    "port",
    "secret",
    "url",
    "user",
    "username",
)
_READ_COMMANDS = {
    "EXISTS",
    "GET",
    "GETBIT",
    "GETDEL",
    "GETEX",
    "GETRANGE",
    "HGET",
    "HGETALL",
    "HMGET",
    "HVALS",
    "LINDEX",
    "LLEN",
    "LRANGE",
    "MGET",
    "SCARD",
    "SGET",
    "SISMEMBER",
    "SMEMBERS",
    "STRLEN",
    "TTL",
    "PTTL",
    "ZCARD",
    "ZRANGE",
    "ZRANK",
    "ZSCORE",
}
_WRITE_COMMANDS = {
    "APPEND",
    "DECR",
    "EXPIRE",
    "HDEL",
    "HINCRBY",
    "HSET",
    "INCR",
    "LPUSH",
    "LREM",
    "MSET",
    "PERSIST",
    "PEXPIRE",
    "PUBLISH",
    "RENAME",
    "RPOP",
    "RPUSH",
    "SADD",
    "SET",
    "SETEX",
    "SETNX",
    "ZADD",
    "ZREM",
}
_DELETE_COMMANDS = {
    "DEL",
    "DELETE",
    "UNLINK",
}
_PIPELINE_COMMAND_LIMIT = 8


def instrument_redis_client_with_logbrew_spans(
    redis_client: Any,
    *,
    client: Any,
    trace_pipelines: bool = False,
    event_id_factory: Callable[[], str] | None = None,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    cache_name: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewRedisInstrumentation:
    """Wrap one caller-owned redis-py style client instance with LogBrew spans."""

    execute_command = getattr(redis_client, "execute_command", None)
    if not callable(execute_command):
        raise TypeError("redis_client must expose a callable execute_command method")

    existing = _existing_instrumentation(redis_client)
    if existing is not None and existing.installed:
        return existing

    instrumentation = LogBrewRedisInstrumentation(
        redis_client=redis_client,
        execute_command=execute_command,
        pipeline=getattr(redis_client, "pipeline", None) if trace_pipelines else None,
        client=client,
        event_id_factory=event_id_factory or _default_redis_event_id,
        timestamp=timestamp,
        trace=trace,
        cache_name=cache_name,
        metadata=_redis_metadata(metadata),
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _remember_instrumentation(redis_client, instrumentation)
    return instrumentation


class LogBrewRedisInstrumentation:
    """Reversible instrumentation for a caller-owned Redis client instance."""

    def __init__(
        self,
        *,
        redis_client: Any,
        execute_command: Callable[..., Any],
        pipeline: Callable[..., Any] | None,
        client: Any,
        event_id_factory: Callable[[], str],
        timestamp: str | None,
        trace: LogBrewTraceContext | None,
        cache_name: str | None,
        metadata: Mapping[str, Any],
        span_id_factory: Callable[[], str] | None,
        clock: _instrumentation.Clock,
        on_capture_error: Callable[[Exception], None] | None,
    ) -> None:
        self.redis_client = redis_client
        self._execute_command = execute_command
        self._pipeline = pipeline
        self._client = client
        self._event_id_factory = event_id_factory
        self._timestamp = timestamp
        self._trace = trace
        self._cache_name = cache_name
        self._metadata = metadata
        self._span_id_factory = span_id_factory
        self._clock = clock
        self._on_capture_error = on_capture_error
        self._installed = False

    @property
    def installed(self) -> bool:
        """Return whether the client instance is currently wrapped."""

        return self._installed

    def install(self) -> None:
        """Wrap the app-owned Redis client's command methods."""

        if self._installed:
            return
        self.redis_client.execute_command = self._wrap_execute_command()
        if callable(self._pipeline):
            self.redis_client.pipeline = self._wrap_pipeline()
        self._installed = True

    def uninstall(self) -> None:
        """Put the original Redis client methods back on the client."""

        if not self._installed:
            return
        with suppress(Exception):
            self.redis_client.execute_command = self._execute_command
        if callable(self._pipeline):
            with suppress(Exception):
                self.redis_client.pipeline = self._pipeline
        self._installed = False
        _forget_instrumentation(self.redis_client, self)

    def _wrap_execute_command(self) -> Callable[..., Any]:
        def execute_command_with_logbrew_span(*args: Any, **kwargs: Any) -> Any:
            return self._execute_with_logbrew_span(args, kwargs)

        return execute_command_with_logbrew_span

    def _wrap_pipeline(self) -> Callable[..., Any]:
        def pipeline_with_logbrew_span(*args: Any, **kwargs: Any) -> Any:
            pipeline = self._pipeline(*args, **kwargs) if self._pipeline is not None else None
            self._instrument_pipeline(pipeline)
            return pipeline

        return pipeline_with_logbrew_span

    def _execute_with_logbrew_span(self, args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
        operation = _redis_operation(args)
        request = _cache_span_request(
            operation_name=operation,
            system="redis",
            client=self._client,
            event_id=self._event_id_factory(),
            timestamp=self._timestamp,
            trace=self._trace,
            cache_name=self._cache_name,
            cache_hit=None,
            item_size_bytes=None,
            item_count=None,
            metadata={**self._metadata, "cacheOperationKind": _operation_kind(operation)},
            span_events=None,
            span_id_factory=self._span_id_factory,
            clock=self._clock,
            on_capture_error=self._on_capture_error,
        )
        try:
            with use_logbrew_trace(request.trace):
                result = self._execute_command(*args, **kwargs)
        except Exception as error:
            request.capture("error", error=error)
            raise
        if inspect.isawaitable(result):
            return self._await_result(request, operation, result)
        _set_result_metadata(request, operation, result)
        request.capture("ok")
        return result

    async def _await_result(self, request: Any, operation: str, result: Awaitable[T]) -> T:
        with use_logbrew_trace(request.trace):
            try:
                resolved = await result
            except Exception as error:
                request.capture("error", error=error)
                raise
        _set_result_metadata(request, operation, resolved)
        request.capture("ok")
        return resolved

    def _instrument_pipeline(self, pipeline: Any) -> None:
        execute = getattr(pipeline, "execute", None)
        if not callable(execute) or getattr(pipeline, "_logbrew_redis_pipeline_wrapped", False):
            return

        def execute_pipeline_with_logbrew_span(*args: Any, **kwargs: Any) -> Any:
            return self._execute_pipeline_with_logbrew_span(pipeline, execute, args, kwargs)

        with suppress(Exception):
            pipeline.execute = execute_pipeline_with_logbrew_span
            pipeline._logbrew_redis_pipeline_wrapped = True

    def _execute_pipeline_with_logbrew_span(
        self,
        pipeline: Any,
        execute: Callable[..., Any],
        args: tuple[Any, ...],
        kwargs: Mapping[str, Any],
    ) -> Any:
        if not self._installed:
            return execute(*args, **kwargs)

        pipeline_metadata = _pipeline_metadata(pipeline)
        request = _cache_span_request(
            operation_name="PIPELINE",
            system="redis",
            client=self._client,
            event_id=self._event_id_factory(),
            timestamp=self._timestamp,
            trace=self._trace,
            cache_name=self._cache_name,
            cache_hit=None,
            item_size_bytes=None,
            item_count=None,
            metadata={**self._metadata, "cacheOperationKind": "command", **pipeline_metadata},
            span_events=None,
            span_id_factory=self._span_id_factory,
            clock=self._clock,
            on_capture_error=self._on_capture_error,
        )
        try:
            with use_logbrew_trace(request.trace):
                result = execute(*args, **kwargs)
        except Exception as error:
            request.capture("error", error=error)
            raise
        if inspect.isawaitable(result):
            return self._await_pipeline_result(request, result)
        request.capture("ok")
        return result

    async def _await_pipeline_result(self, request: Any, result: Awaitable[T]) -> T:
        with use_logbrew_trace(request.trace):
            try:
                resolved = await result
            except Exception as error:
                request.capture("error", error=error)
                raise
        request.capture("ok")
        return resolved


def _existing_instrumentation(redis_client: Any) -> LogBrewRedisInstrumentation | None:
    with suppress(Exception):
        instrumentation = getattr(redis_client, _INSTRUMENTATION_ATTR, None)
        if isinstance(instrumentation, LogBrewRedisInstrumentation):
            return instrumentation
    return None


def _remember_instrumentation(redis_client: Any, instrumentation: LogBrewRedisInstrumentation) -> None:
    with suppress(Exception):
        setattr(redis_client, _INSTRUMENTATION_ATTR, instrumentation)


def _forget_instrumentation(redis_client: Any, instrumentation: LogBrewRedisInstrumentation) -> None:
    with suppress(Exception):
        if getattr(redis_client, _INSTRUMENTATION_ATTR, None) is instrumentation:
            delattr(redis_client, _INSTRUMENTATION_ATTR)


def _redis_operation(args: tuple[Any, ...]) -> str:
    if not args:
        return "COMMAND"
    command = args[0]
    if isinstance(command, bytes | bytearray):
        command = bytes(command).decode("utf-8", errors="ignore")
    if isinstance(command, str):
        normalized = command.strip().split(maxsplit=1)[0]
        return normalized.upper() if normalized else "COMMAND"
    return "COMMAND"


def _operation_kind(operation: str) -> str:
    if operation in _READ_COMMANDS:
        return "read"
    if operation in _DELETE_COMMANDS:
        return "delete"
    if operation in _WRITE_COMMANDS:
        return "write"
    return "command"


def _set_result_metadata(request: Any, operation: str, result: Any) -> None:
    if _operation_kind(operation) != "read":
        return
    item_count = _read_item_count(result)
    request.cache_hit = item_count > 0
    request.item_count = item_count
    item_size_bytes = _read_item_size_bytes(result)
    if item_size_bytes is not None:
        request.item_size_bytes = item_size_bytes


def _read_item_count(result: Any) -> int:
    if not _redis_value_present(result):
        return 0
    if isinstance(result, list | tuple | set | frozenset):
        return sum(1 for item in result if _redis_value_present(item))
    if isinstance(result, Mapping):
        return len(result)
    return 1


def _redis_value_present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bytes | bytearray | memoryview | str | list | tuple | set | frozenset | Mapping):
        return len(value) > 0
    return True


def _read_item_size_bytes(result: Any) -> int | None:
    if isinstance(result, bytes | bytearray | memoryview):
        return len(result)
    if isinstance(result, str):
        return len(result.encode("utf-8"))
    return None


def _pipeline_metadata(pipeline: Any) -> _instrumentation.Metadata:
    commands = _pipeline_commands(pipeline)
    metadata: _instrumentation.Metadata = {"pipelineLength": len(commands)}
    if commands:
        metadata["pipelineOperations"] = ",".join(commands[:_PIPELINE_COMMAND_LIMIT])
    return metadata


def _pipeline_commands(pipeline: Any) -> list[str]:
    command_stack = getattr(pipeline, "command_stack", None)
    if command_stack is None:
        command_stack = getattr(pipeline, "_command_stack", None)
    if not isinstance(command_stack, list | tuple):
        return []
    return [_redis_operation(_pipeline_command_args(command)) for command in command_stack]


def _pipeline_command_args(command: Any) -> tuple[Any, ...]:
    command_args = getattr(command, "args", None)
    if isinstance(command_args, tuple | list):
        return tuple(command_args)
    if isinstance(command, tuple | list):
        if command and isinstance(command[0], tuple | list):
            return tuple(command[0])
        return tuple(command)
    return ()


def _redis_metadata(metadata: Mapping[str, Any] | None) -> _instrumentation.Metadata:
    safe_metadata = _instrumentation.compact_metadata_without_keys(metadata, _REDIS_METADATA_DENYLIST)
    safe_metadata["framework"] = "redis-py"
    return safe_metadata


def _default_redis_event_id() -> str:
    return f"evt_python_redis_{uuid4().hex}"
