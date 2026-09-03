"""Optional pymemcache client instrumentation for app-owned Python cache spans."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, cast

from logbrew_sdk import _instrumentation
from logbrew_sdk._cache_client import _CACHE_METADATA_DENYLIST, _CacheSpanRequest
from logbrew_sdk._framework_cache_client import (
    CacheMethodsInstrumentation,
    _collection_count,
    _default,
    _item_size,
    _mapping_count,
    _result_count,
    _second_item_size,
    instrument_cache_methods,
)
from logbrew_sdk._trace_context import LogBrewTraceContext

_ATTR = "_logbrew_pymemcache_instrumentation"
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
_READ = {"get", "get_many", "get_multi", "gets", "gets_many", "stats", "version"}
_WRITE = {
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
_DELETE = {"delete", "delete_many", "flush_all"}


class LogBrewPymemcacheInstrumentation(CacheMethodsInstrumentation):
    """Reversible instrumentation for a caller-owned pymemcache-style client."""

    supported_methods = _METHODS
    cache_parameter = "pymemcache_client"
    metadata_denylist = (
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
    framework_label = "pymemcache"
    instrumentation_attr = _ATTR
    event_prefix = "pymemcache"
    framework = "pymemcache"
    system = "memcached"

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
        super().__init__(
            cache=pymemcache_client,
            methods=methods,
            client=client,
            event_id_factory=event_id_factory,
            timestamp=timestamp,
            trace=trace,
            cache_name=cache_name,
            metadata=metadata,
            span_id_factory=span_id_factory,
            clock=clock,
            on_capture_error=on_capture_error,
        )

    def _operation_name(self, name: str) -> str:
        return {"get_multi": "GET_MANY", "set_multi": "SET_MANY"}.get(
            name,
            name.upper(),
        )

    def _operation_kind(self, name: str) -> str:
        if name in _READ:
            return "read"
        if name in _WRITE:
            return "write"
        if name in _DELETE:
            return "delete"
        return "command"

    def _apply_result(
        self,
        request: _CacheSpanRequest,
        name: str,
        args: tuple[Any, ...],
        kwargs: Mapping[str, Any],
        result: Any,
    ) -> None:
        if name == "get":
            request.cache_hit = result != _default(args, kwargs)
            request.item_size_bytes = _item_size(result) if request.cache_hit else None
        elif name == "gets":
            defaults = (
                _default(args, kwargs),
                args[2] if len(args) > 2 else kwargs.get("cas_default"),
            )
            request.cache_hit = (
                result != defaults
                if isinstance(result, tuple)
                else result != defaults[0]
            )
            value = result[0] if isinstance(result, tuple) and result else result
            request.item_size_bytes = _item_size(value) if request.cache_hit else None
        elif name in {"get_many", "get_multi", "gets_many"}:
            request.item_count = _result_count(result)
            request.cache_hit = request.item_count > 0
        elif name in {"set", "add", "replace", "append", "prepend"}:
            request.item_size_bytes = _second_item_size(args)
        elif name in {"set_many", "set_multi"}:
            request.item_count = _mapping_count(args)
        elif name == "delete_many":
            request.item_count = _collection_count(args)


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

    return cast(
        LogBrewPymemcacheInstrumentation,
        instrument_cache_methods(
            pymemcache_client,
            instrumentation_type=LogBrewPymemcacheInstrumentation,
            client=client,
            event_id_factory=event_id_factory,
            timestamp=timestamp,
            trace=trace,
            cache_name=cache_name,
            metadata=metadata,
            span_id_factory=span_id_factory,
            clock=clock,
            on_capture_error=on_capture_error,
        ),
    )
