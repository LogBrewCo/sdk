"""Optional Flask-Caching instrumentation for app-owned Python cache spans."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, cast

from logbrew_sdk import _instrumentation
from logbrew_sdk._framework_cache_client import (
    CacheMethodsInstrumentation,
    instrument_cache_methods,
)
from logbrew_sdk._trace_context import LogBrewTraceContext

_ATTR = "_logbrew_flask_cache_instrumentation"


class LogBrewFlaskCacheInstrumentation(CacheMethodsInstrumentation):
    """Reversible instrumentation for a caller-owned Flask-Caching style object."""

    framework_label = "Flask-Caching"
    instrumentation_attr = _ATTR
    event_prefix = "flask_cache"
    framework = "flask-caching"
    system = "flask-caching"


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

    return cast(
        LogBrewFlaskCacheInstrumentation,
        instrument_cache_methods(
            cache,
            instrumentation_type=LogBrewFlaskCacheInstrumentation,
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
