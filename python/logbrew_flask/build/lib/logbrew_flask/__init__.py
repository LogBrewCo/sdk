# Copyright (c) 2026 LogBrew
"""Flask integration helpers for capturing LogBrew request spans and exceptions."""

from logbrew_sdk import default_span_id_factory as default_span_id_factory
from logbrew_sdk import get_active_logbrew_trace

from logbrew_flask._middleware import (
    LOGBREW_FLASK_EXTENSION_KEY as LOGBREW_FLASK_EXTENSION_KEY,
)
from logbrew_flask._middleware import (
    LOGBREW_FLASK_SDK_VERSION,
    LogBrewFlaskConfig,
    add_logbrew_middleware,
    capture_exception,
    capture_request_metric,
    capture_request_span,
    create_request_metric_attributes,
    create_request_trace_context,
    init_logbrew,
    request_logbrew_trace,
    request_metadata,
    request_name,
    request_route_template,
    utc_timestamp,
)
from logbrew_flask._middleware import (
    flush_if_configured as flush_if_configured,
)
from logbrew_flask._middleware import (
    request_duration_ms as request_duration_ms,
)
from logbrew_flask._middleware import (
    route_template_only as route_template_only,
)
from logbrew_flask._middleware import (
    status_code_class as status_code_class,
)

__all__ = [
    "LOGBREW_FLASK_SDK_VERSION",
    "LogBrewFlaskConfig",
    "add_logbrew_middleware",
    "capture_exception",
    "capture_request_metric",
    "capture_request_span",
    "create_request_metric_attributes",
    "create_request_trace_context",
    "get_active_logbrew_trace",
    "init_logbrew",
    "request_logbrew_trace",
    "request_metadata",
    "request_name",
    "request_route_template",
    "utc_timestamp",
]
