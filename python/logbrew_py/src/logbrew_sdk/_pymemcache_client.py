"""Optional pymemcache client instrumentation for app-owned Python cache spans."""

from __future__ import annotations

import functools
from collections.abc import Callable, Mapping, Sequence
from time import perf_counter
from typing import Any
from uuid import uuid4

from logbrew_sdk import _instrumentation
from logbrew_sdk._cache_client import (
    _CACHE_METADATA_DENYLIST,
    _cache_span_request,
    _CacheSpanRequest,
)
from logbrew_sdk._trace_context import LogBrewTraceContext, use_logbrew_trace

_INSTRUMENTATION_ATTR = "_logbrew_pymemcache_instrumentation"
_METHODS = (
    "set",
    "set_many",
    "set_multi",
    "add",
    "replace",
    "append",
    "prepend",
    "cas",
    "get",
    "get_many",
    "get_multi",
    "gets",
    "gets_many",
    "delete",
    "delete_many",
    "incr",
    "decr",
    "touch",
    "stats",
    "version",
    "flush_all",
    "quit",
)
_READ_METHODS = {"get", "get_many", "get_multi", "gets", "gets_many", "stats", "version"}
_WRITE_METHODS = {
    "set",
    "set_many",
    "set_multi",
    "add",
    "replace",
    "append",
    "prepend",
    "cas",
    "incr",
    "decr",
    "touch",
}
_DELETE_METHODS = {"delete", "delete_many", "flush_all"}
_PYMEMCACHE_METADATA_DENYLIST = (
    *_CACHE_METADATA_DENYLIST,
    "connection",
    "database_url",
    "dsn",
    "host",
    "port",
    "server",
    "socket",
    "url",
    "user",
    "username",
)


def instrument_pymemcache_client_with_logbrew_spans(
    pymemcache_client: Any,
    *,
    client: Any,
    event_id_factory: Callable[[], str] | None = None,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    cache_name: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewPymemcacheInstrumentation:
    """Wrap one caller-owned pymemcache-style client instance with LogBrew spans."""

    methods = _cache_methods(pymemcache_client)
    if not methods:
        raise TypeError("pymemcache_client must expose at least one supported pymemcache method")

    existing = _existing_instrumentation(pymemcache_client)
    if existing is not None and existing.installed:
        return existing

    instrumentation = LogBrewPymemcacheInstrumentation(
        pymemcache_client=pymemcache_client,
        methods=methods,
        client=client,
        event_id_factory=event_id_factory or _default_event_id,
        timestamp=timestamp,
        trace=trace,
        cache_name=cache_name,
        metadata=_pymemcache_metadata(metadata),
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _remember_instrumentation(pymemcache_client, instrumentation)
    return instrumentation


class LogBrewPymemcacheInstrumentation:
    """Reversible instrumentation for a caller-owned pymemcache-style client."""

    def __init__(
        self,
        *,
        pymemcache_client: Any,
        methods: Mapping[str, Callable[..., Any]],
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
        self.pymemcache_client = pymemcache_client
        self._methods = dict(methods)
        self._client = client
        self._event_id_factory = event_id_factory
        self._timestamp = timestamp
        self._trace = trace
        self._cache_name = cache_name
        self._metadata = metadata
        self._span_id_factory = span_id_factory
        self._clock = clock
        self._on_capture_error = on_capture_error
        self._active_depth = 0
        self._installed = False

    @property
    def installed(self) -> bool:
        """Return whether the client instance is currently wrapped."""

        return self._installed

    def install(self) -> None:
        """Wrap supported app-owned pymemcache client methods."""

        if self._installed:
            return
        installed: list[str] = []
        for method_name, method in self._methods.items():
            try:
                setattr(self.pymemcache_client, method_name, self._wrap_method(method_name, method))
            except Exception:
                self._reset_methods(installed)
                raise
            installed.append(method_name)
        self._installed = True

    def uninstall(self) -> None:
        """Put original app-owned pymemcache client methods back."""

        if not self._installed:
            return
        self._reset_methods(self._methods)
        self._installed = False
        _forget_instrumentation(self.pymemcache_client, self)

    def _reset_methods(self, method_names: Mapping[str, Callable[..., Any]] | Sequence[str]) -> None:
        if isinstance(method_names, Mapping):
            names = method_names
        else:
            names = {method_name: self._methods[method_name] for method_name in method_names}
        for method_name, method in names.items():
            setattr(self.pymemcache_client, method_name, method)

    def _wrap_method(self, method_name: str, method: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(method)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            return self._execute_with_logbrew_span(method_name, method, args, kwargs)

        return wrapper

    def _execute_with_logbrew_span(
        self,
        method_name: str,
        method: Callable[..., Any],
        args: tuple[Any, ...],
        kwargs: dict[str, Any],
    ) -> Any:
        if not self._installed:
            return method(*args, **kwargs)
        if self._active_depth > 0:
            return method(*args, **kwargs)

        request = _cache_span_request(
            operation_name=_operation_name(method_name),
            system="memcached",
            client=self._client,
            event_id=self._event_id_factory(),
            timestamp=self._timestamp,
            trace=self._trace,
            cache_name=self._cache_name,
            cache_hit=None,
            item_size_bytes=None,
            item_count=None,
            metadata={**self._metadata, "cacheOperationKind": _operation_kind(method_name)},
            span_events=None,
            span_id_factory=self._span_id_factory,
            clock=self._clock,
            on_capture_error=self._on_capture_error,
        )
        self._active_depth += 1
        try:
            with use_logbrew_trace(request.trace):
                try:
                    result = method(*args, **kwargs)
                except Exception as error:
                    request.capture("error", error=error)
                    raise
        finally:
            self._active_depth -= 1
        _apply_result_metadata(request, method_name, args, kwargs, result)
        request.capture("ok")
        return result


def _cache_methods(pymemcache_client: Any) -> dict[str, Callable[..., Any]]:
    methods: dict[str, Callable[..., Any]] = {}
    for method_name in _METHODS:
        method = getattr(pymemcache_client, method_name, None)
        if callable(method):
            methods[method_name] = method
    return methods


def _existing_instrumentation(client: Any) -> LogBrewPymemcacheInstrumentation | None:
    try:
        instrumentation = getattr(client, _INSTRUMENTATION_ATTR, None)
    except Exception:
        return None
    if isinstance(instrumentation, LogBrewPymemcacheInstrumentation):
        return instrumentation
    return None


def _remember_instrumentation(client: Any, instrumentation: LogBrewPymemcacheInstrumentation) -> None:
    try:
        setattr(client, _INSTRUMENTATION_ATTR, instrumentation)
    except Exception:
        return


def _forget_instrumentation(client: Any, instrumentation: LogBrewPymemcacheInstrumentation) -> None:
    try:
        if getattr(client, _INSTRUMENTATION_ATTR, None) is instrumentation:
            delattr(client, _INSTRUMENTATION_ATTR)
    except Exception:
        return


def _operation_name(method_name: str) -> str:
    if method_name == "get_multi":
        return "GET_MANY"
    if method_name == "set_multi":
        return "SET_MANY"
    return method_name.upper()


def _operation_kind(method_name: str) -> str:
    if method_name in _READ_METHODS:
        return "read"
    if method_name in _WRITE_METHODS:
        return "write"
    if method_name in _DELETE_METHODS:
        return "delete"
    return "command"


def _apply_result_metadata(
    request: _CacheSpanRequest,
    method_name: str,
    args: tuple[Any, ...],
    kwargs: Mapping[str, Any],
    result: Any,
) -> None:
    if method_name == "get":
        request.cache_hit = result != _single_default(args, kwargs)
        if request.cache_hit:
            request.item_size_bytes = _item_size_bytes(result)
    elif method_name == "gets":
        request.cache_hit = not _gets_returned_default(args, kwargs, result)
        value = _gets_value(result)
        if request.cache_hit:
            request.item_size_bytes = _item_size_bytes(value)
    elif method_name in {"get_many", "get_multi", "gets_many"}:
        request.item_count = _result_item_count(result)
        request.cache_hit = request.item_count > 0
    elif method_name in {"set", "add", "replace", "append", "prepend"}:
        request.item_size_bytes = _second_arg_size(args)
    elif method_name in {"set_many", "set_multi"}:
        request.item_count = _first_mapping_count(args)
    elif method_name == "delete_many":
        request.item_count = _first_collection_count(args)


def _single_default(args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
    if len(args) > 1:
        return args[1]
    return kwargs.get("default")


def _gets_value(result: Any) -> Any:
    if isinstance(result, tuple) and result:
        return result[0]
    return result


def _gets_returned_default(args: tuple[Any, ...], kwargs: Mapping[str, Any], result: Any) -> bool:
    defaults = (_gets_default(args, kwargs), _gets_cas_default(args, kwargs))
    if isinstance(result, tuple):
        return bool(result == defaults)
    return bool(result == defaults[0])


def _gets_default(args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
    if len(args) > 1:
        return args[1]
    return kwargs.get("default")


def _gets_cas_default(args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
    if len(args) > 2:
        return args[2]
    return kwargs.get("cas_default")


def _result_item_count(result: Any) -> int:
    if isinstance(result, Mapping):
        return len(result)
    if _safe_sequence(result):
        return sum(1 for item in result if item is not None)
    return 0


def _first_mapping_count(args: tuple[Any, ...]) -> int | None:
    if not args or not isinstance(args[0], Mapping):
        return None
    return len(args[0])


def _first_collection_count(args: tuple[Any, ...]) -> int | None:
    if not args:
        return None
    value = args[0]
    if isinstance(value, Mapping):
        return len(value)
    if _safe_sequence(value):
        return len(value)
    return None


def _second_arg_size(args: tuple[Any, ...]) -> int | None:
    if len(args) < 2:
        return None
    return _item_size_bytes(args[1])


def _item_size_bytes(value: Any) -> int | None:
    if isinstance(value, (bytes, bytearray, memoryview)):
        return len(value)
    if isinstance(value, str):
        return len(value)
    return None


def _safe_sequence(value: Any) -> bool:
    return isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray, memoryview))


def _pymemcache_metadata(metadata: Mapping[str, Any] | None) -> _instrumentation.Metadata:
    safe_metadata = _instrumentation.compact_metadata_without_keys(metadata, _PYMEMCACHE_METADATA_DENYLIST)
    safe_metadata["framework"] = "pymemcache"
    return safe_metadata


def _default_event_id() -> str:
    return f"evt_python_pymemcache_{uuid4().hex}"
