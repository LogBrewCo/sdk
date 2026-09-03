"""Optional Django cache instrumentation for app-owned Python cache spans."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, cast

from logbrew_sdk import _instrumentation
from logbrew_sdk._framework_cache_client import (
    CacheMethodsInstrumentation,
    instrument_cache_methods,
)
from logbrew_sdk._trace_context import LogBrewTraceContext

_ATTR = "_logbrew_django_cache_instrumentation"


class LogBrewDjangoCacheInstrumentation(CacheMethodsInstrumentation):
    """Reversible instrumentation for a caller-owned Django-style cache object."""

    framework_label = "Django cache"
    instrumentation_attr = _ATTR
    event_prefix = "django_cache"
    framework = "django-cache"
    system = "django-cache"
    django_semantics = True


def instrument_django_cache_with_logbrew_spans(
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
) -> LogBrewDjangoCacheInstrumentation:
    """Wrap one caller-owned Django-style cache object with LogBrew spans."""

    return cast(
        LogBrewDjangoCacheInstrumentation,
        instrument_cache_methods(
            cache,
            instrumentation_type=LogBrewDjangoCacheInstrumentation,
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
