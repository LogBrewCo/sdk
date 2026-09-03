"""Shared instance instrumentation for method-oriented cache clients."""

from __future__ import annotations

import functools
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from time import perf_counter
from typing import Any, ClassVar
from uuid import uuid4

from logbrew_sdk import _instrumentation
from logbrew_sdk._cache_client import (
    _CACHE_METADATA_DENYLIST,
    _cache_span_request,
    _CacheSpanRequest,
)
from logbrew_sdk._trace_context import LogBrewTraceContext, use_logbrew_trace

_FRAMEWORK_METHODS = (
    "get",
    "get_many",
    "set",
    "set_many",
    "add",
    "delete",
    "delete_many",
    "clear",
)
_FRAMEWORK_KINDS = {
    **dict.fromkeys(("get", "get_many"), "read"),
    **dict.fromkeys(("set", "set_many", "add"), "write"),
}


def instrument_cache_methods(
    cache: Any,
    *,
    instrumentation_type: type[CacheMethodsInstrumentation],
    client: Any,
    event_id_factory: Callable[[], str] | None,
    timestamp: str | None,
    trace: LogBrewTraceContext | None,
    cache_name: str | None,
    metadata: Mapping[str, Any] | None,
    span_id_factory: Callable[[], str] | None,
    clock: _instrumentation.Clock | None,
    on_capture_error: Callable[[Exception], None] | None,
) -> CacheMethodsInstrumentation:
    methods = {
        name: method
        for name in instrumentation_type.supported_methods
        if callable(method := getattr(cache, name, None))
    }
    if not methods:
        raise TypeError(
            f"{instrumentation_type.cache_parameter} must expose at least one supported "
            f"{instrumentation_type.framework_label} method"
        )
    existing = _safe_attribute(cache, instrumentation_type.instrumentation_attr)
    if isinstance(existing, instrumentation_type) and existing.installed:
        return existing
    safe_metadata = _instrumentation.compact_metadata_without_keys(
        metadata,
        instrumentation_type.metadata_denylist,
    )
    safe_metadata["framework"] = instrumentation_type.framework
    parameters: dict[str, Any] = {
        instrumentation_type.cache_parameter: cache,
        "methods": methods,
        "client": client,
        "event_id_factory": event_id_factory
        or (lambda: f"evt_python_{instrumentation_type.event_prefix}_{uuid4().hex}"),
        "timestamp": timestamp,
        "trace": trace,
        "cache_name": cache_name,
        "metadata": safe_metadata,
        "span_id_factory": span_id_factory,
        "clock": clock or perf_counter,
        "on_capture_error": on_capture_error,
    }
    instrumentation = instrumentation_type(**parameters)
    instrumentation.install()
    with suppress(Exception):
        setattr(cache, instrumentation_type.instrumentation_attr, instrumentation)
    return instrumentation


class CacheMethodsInstrumentation:
    """Shared reversible cache-method instrumentation."""

    supported_methods: ClassVar[tuple[str, ...]] = _FRAMEWORK_METHODS
    metadata_denylist: ClassVar[tuple[str, ...]] = (
        *_CACHE_METADATA_DENYLIST,
        "connection",
    )
    cache_parameter: ClassVar[str] = "cache"
    framework_label: ClassVar[str]
    instrumentation_attr: ClassVar[str]
    event_prefix: ClassVar[str]
    framework: ClassVar[str]
    system: ClassVar[str]
    django_semantics: ClassVar[bool] = False

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
        return self._installed

    def install(self) -> None:
        if self._installed:
            return
        installed: list[str] = []
        try:
            for name, method in self._methods.items():
                setattr(self.cache, name, self._wrapper(name, method))
                installed.append(name)
        except Exception:
            self._reset(installed)
            raise
        self._installed = True

    def uninstall(self) -> None:
        if not self._installed:
            return
        self._reset(self._methods)
        self._installed = False
        with suppress(Exception):
            if getattr(self.cache, self.instrumentation_attr, None) is self:
                delattr(self.cache, self.instrumentation_attr)

    def _reset(self, names: Mapping[str, Any] | Sequence[str]) -> None:
        originals = (
            names
            if isinstance(names, Mapping)
            else {name: self._methods[name] for name in names}
        )
        for name, method in originals.items():
            setattr(self.cache, name, method)

    def _wrapper(self, name: str, method: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(method)
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            if not self._installed or self._active_depth:
                return method(*args, **kwargs)
            request = _cache_span_request(
                operation_name=self._operation_name(name),
                system=self.system,
                client=self._client,
                event_id=self._event_id_factory(),
                timestamp=self._timestamp,
                trace=self._trace,
                cache_name=self._cache_name,
                cache_hit=None,
                item_size_bytes=None,
                item_count=None,
                metadata={
                    **self._metadata,
                    "cacheOperationKind": self._operation_kind(name),
                },
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
            self._apply_result(request, name, args, kwargs, result)
            request.capture("ok")
            return result

        return wrapped

    def _operation_name(self, name: str) -> str:
        return name.upper()

    def _operation_kind(self, name: str) -> str:
        return _FRAMEWORK_KINDS.get(name, "delete")

    def _apply_result(
        self,
        request: _CacheSpanRequest,
        name: str,
        args: tuple[Any, ...],
        kwargs: Mapping[str, Any],
        result: Any,
    ) -> None:
        if name == "get":
            request.cache_hit = (
                result != _default(args, kwargs)
                if self.django_semantics
                else result is not None
            )
            request.item_size_bytes = _item_size(result) if request.cache_hit else None
        elif name == "get_many":
            request.item_count = _result_count(result)
            request.cache_hit = request.item_count > 0
        elif name in {"set", "add"}:
            request.item_size_bytes = _second_item_size(args)
        elif name == "set_many":
            request.item_count = _mapping_count(args)
        elif name == "delete_many":
            request.item_count = _collection_count(
                args,
                varargs=not self.django_semantics,
            )


def _safe_attribute(instance: Any, name: str) -> Any:
    try:
        return getattr(instance, name, None)
    except Exception:
        return None


def _sequence(value: Any) -> bool:
    return isinstance(value, Sequence) and not isinstance(
        value, (str, bytes, bytearray, memoryview)
    )


def _default(args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> Any:
    return args[1] if len(args) > 1 else kwargs.get("default")


def _result_count(result: Any) -> int:
    if isinstance(result, Mapping):
        return len(result)
    return sum(item is not None for item in result) if _sequence(result) else 0


def _mapping_count(args: tuple[Any, ...]) -> int | None:
    return len(args[0]) if args and isinstance(args[0], Mapping) else None


def _collection_count(args: tuple[Any, ...], *, varargs: bool = False) -> int | None:
    if not args:
        return None
    first = args[0]
    if varargs:
        return len(first) if len(args) == 1 and _sequence(first) else len(args)
    return len(first) if isinstance(first, Mapping) or _sequence(first) else None


def _second_item_size(args: tuple[Any, ...]) -> int | None:
    return _item_size(args[1]) if len(args) > 1 else None


def _item_size(value: Any) -> int | None:
    return (
        len(value) if isinstance(value, (str, bytes, bytearray, memoryview)) else None
    )
