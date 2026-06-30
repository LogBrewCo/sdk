"""Optional Flask-Caching instrumentation for app-owned Python cache spans."""

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

_INSTRUMENTATION_ATTR = "_logbrew_flask_cache_instrumentation"
_METHODS = ("get", "get_many", "set", "set_many", "add", "delete", "delete_many", "clear")
_READ_METHODS = {"get", "get_many"}
_WRITE_METHODS = {"set", "set_many", "add"}
_DELETE_METHODS = {"delete", "delete_many", "clear"}


def instrument_flask_cache_with_logbrew_spans(
    cache: Any,
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
) -> LogBrewFlaskCacheInstrumentation:
    """Wrap one caller-owned Flask-Caching style cache object with LogBrew spans."""

    methods = _cache_methods(cache)
    if not methods:
        raise TypeError("cache must expose at least one supported Flask-Caching method")

    existing = _existing_instrumentation(cache)
    if existing is not None and existing.installed:
        return existing

    instrumentation = LogBrewFlaskCacheInstrumentation(
        cache=cache,
        methods=methods,
        client=client,
        event_id_factory=event_id_factory or _default_event_id,
        timestamp=timestamp,
        trace=trace,
        cache_name=cache_name,
        metadata=_flask_cache_metadata(metadata),
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _remember_instrumentation(cache, instrumentation)
    return instrumentation


class LogBrewFlaskCacheInstrumentation:
    """Reversible instrumentation for a caller-owned Flask-Caching style object."""

    def __init__(
        self,
        *,
        cache: Any,
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
        self.cache = cache
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
        """Return whether the cache object is currently wrapped."""

        return self._installed

    def install(self) -> None:
        """Wrap supported app-owned Flask-Caching methods."""

        if self._installed:
            return
        installed: list[str] = []
        for method_name, method in self._methods.items():
            try:
                setattr(self.cache, method_name, self._wrap_method(method_name, method))
            except Exception:
                self._reset_methods(installed)
                raise
            installed.append(method_name)
        self._installed = True

    def uninstall(self) -> None:
        """Put original app-owned Flask-Caching methods back."""

        if not self._installed:
            return
        self._reset_methods(self._methods)
        self._installed = False
        _forget_instrumentation(self.cache, self)

    def _reset_methods(self, method_names: Mapping[str, Callable[..., Any]] | Sequence[str]) -> None:
        if isinstance(method_names, Mapping):
            names = method_names
        else:
            names = {method_name: self._methods[method_name] for method_name in method_names}
        for method_name, method in names.items():
            setattr(self.cache, method_name, method)

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
            system="flask-caching",
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
        _apply_result_metadata(request, method_name, args, result)
        request.capture("ok")
        return result


def _cache_methods(cache: Any) -> dict[str, Callable[..., Any]]:
    methods: dict[str, Callable[..., Any]] = {}
    for method_name in _METHODS:
        method = getattr(cache, method_name, None)
        if callable(method):
            methods[method_name] = method
    return methods


def _existing_instrumentation(cache: Any) -> LogBrewFlaskCacheInstrumentation | None:
    try:
        instrumentation = getattr(cache, _INSTRUMENTATION_ATTR, None)
    except Exception:
        return None
    if isinstance(instrumentation, LogBrewFlaskCacheInstrumentation):
        return instrumentation
    return None


def _remember_instrumentation(cache: Any, instrumentation: LogBrewFlaskCacheInstrumentation) -> None:
    try:
        setattr(cache, _INSTRUMENTATION_ATTR, instrumentation)
    except Exception:
        return


def _forget_instrumentation(cache: Any, instrumentation: LogBrewFlaskCacheInstrumentation) -> None:
    try:
        if getattr(cache, _INSTRUMENTATION_ATTR, None) is instrumentation:
            delattr(cache, _INSTRUMENTATION_ATTR)
    except Exception:
        return


def _operation_name(method_name: str) -> str:
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
    result: Any,
) -> None:
    if method_name == "get":
        request.cache_hit = result is not None
        if request.cache_hit:
            request.item_size_bytes = _item_size_bytes(result)
    elif method_name == "get_many":
        request.item_count = _result_item_count(result)
        request.cache_hit = request.item_count > 0
    elif method_name in {"set", "add"}:
        request.item_size_bytes = _second_arg_size(args)
    elif method_name == "set_many":
        request.item_count = _first_mapping_count(args)
    elif method_name == "delete_many":
        request.item_count = _key_arg_count(args)


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


def _key_arg_count(args: tuple[Any, ...]) -> int | None:
    if not args:
        return None
    if len(args) == 1 and _safe_sequence(args[0]):
        return len(args[0])
    return len(args)


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


def _flask_cache_metadata(metadata: Mapping[str, Any] | None) -> _instrumentation.Metadata:
    safe_metadata = _instrumentation.compact_metadata_without_keys(metadata, (*_CACHE_METADATA_DENYLIST, "connection"))
    safe_metadata["framework"] = "flask-caching"
    return safe_metadata


def _default_event_id() -> str:
    return f"evt_python_flask_cache_{uuid4().hex}"
