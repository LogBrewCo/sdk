"""Flask integration helpers for capturing LogBrew request spans and exceptions."""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from flask import Flask, Response, g, request
from flask.signals import got_request_exception
from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    MetricAttributes,
    RecordingTransport,
    SdkError,
    SpanAttributes,
    TransportError,
    create_logbrew_trace_context,
    get_active_logbrew_trace,
    parse_traceparent,
    span_attributes_from_trace_context,
    trace_metadata,
    use_logbrew_trace,
)


@dataclass(slots=True)
class LogBrewFlaskConfig:
    """Runtime options used by the LogBrew Flask middleware."""

    client: LogBrewClient
    transport: RecordingTransport | None = None
    capture_successful_requests: bool = True
    capture_request_metrics: bool = False
    capture_exceptions: bool = True
    flush_on_response: bool = True
    raise_flush_errors: bool = False
    service_name: str = "flask"
    request_metric_name: str = "http.server.duration"
    span_id_factory: Callable[[], str] | None = None


def utc_timestamp() -> str:
    """Return a LogBrew-compatible UTC timestamp."""

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def request_name() -> str:
    """Return the stable request name used for span and issue titles."""

    return f"{request.method} {request_route_template()}"


def request_metadata(
    *,
    status_code: int | None = None,
    duration_ms: float | None = None,
) -> dict[str, Any]:
    """Return metadata that is useful for request-level troubleshooting without including query strings."""

    route_template = request_route_template()
    metadata: dict[str, Any] = {
        "framework": "flask",
        "method": request.method,
        "routeTemplate": route_template,
    }
    if route_template == request.path:
        metadata["path"] = request.path
    rule = getattr(request.url_rule, "rule", None)
    endpoint = getattr(request.url_rule, "endpoint", None)
    if isinstance(rule, str):
        metadata["route"] = rule
    if isinstance(endpoint, str):
        metadata["endpoint"] = endpoint
    if status_code is not None:
        metadata["status_code"] = status_code
    if duration_ms is not None:
        metadata["duration_ms"] = round(duration_ms, 3)
    return metadata


def request_route_template() -> str:
    """Return a low-cardinality Flask route template without query strings."""

    rule = getattr(request.url_rule, "rule", None)
    template = rule if isinstance(rule, str) and rule else request.path
    return route_template_only(template)


def route_template_only(value: str) -> str:
    """Strip query/hash text from a route template and normalize empty values."""

    route_template = value.split("?", 1)[0].split("#", 1)[0].strip()
    return route_template or "/"


def status_code_class(status_code: int) -> str:
    """Return the coarse HTTP status code class used by request metrics."""

    return f"{status_code // 100}xx" if 100 <= status_code <= 599 else "unknown"


def create_request_metric_attributes(
    *,
    status_code: int,
    duration_ms: float,
    metric_name: str = "http.server.duration",
) -> MetricAttributes:
    """Create privacy-safe request duration metric attributes for a completed Flask request."""

    duration_value = float(duration_ms)
    if duration_value < 0:
        duration_value = 0.0
    return {
        "name": metric_name,
        "kind": "histogram",
        "value": duration_value,
        "unit": "ms",
        "temporality": "delta",
        "metadata": {
            "framework": "flask",
            "method": request.method,
            "routeTemplate": request_route_template(),
            "statusCode": status_code,
            "statusCodeClass": status_code_class(status_code),
        },
    }


def capture_request_metric(
    client: LogBrewClient,
    *,
    status_code: int,
    duration_ms: float,
    event_id: str | None = None,
    timestamp: str | None = None,
    metric_name: str = "http.server.duration",
) -> str:
    """Capture a Flask request duration metric and return its event id."""

    metric_event_id = event_id or f"evt_flask_metric_{uuid.uuid4().hex}"
    client.metric(
        metric_event_id,
        timestamp or utc_timestamp(),
        create_request_metric_attributes(
            status_code=status_code,
            duration_ms=duration_ms,
            metric_name=metric_name,
        ),
    )
    return metric_event_id


def capture_request_span(
    client: LogBrewClient,
    *,
    status_code: int,
    duration_ms: float,
    event_id: str | None = None,
    timestamp: str | None = None,
    span_id_factory: Callable[[], str] | None = None,
    trace: LogBrewTraceContext | None = None,
) -> str:
    """Capture a Flask request as a LogBrew span event and return its event id."""

    span_event_id = event_id or f"evt_flask_span_{uuid.uuid4().hex}"
    trace_context = trace or request_logbrew_trace() or create_request_trace_context(
        span_id_factory=span_id_factory,
    )
    attributes: SpanAttributes = span_attributes_from_trace_context(
        trace_context,
        name=request_name(),
        status="ok" if status_code < 500 else "error",
        duration_ms=duration_ms,
        metadata=request_metadata(status_code=status_code, duration_ms=duration_ms),
    )
    client.span(
        span_event_id,
        timestamp or utc_timestamp(),
        attributes,
    )
    return span_event_id


def capture_exception(
    client: LogBrewClient,
    exc: BaseException,
    *,
    event_id: str | None = None,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
) -> str:
    """Capture an exception raised while handling a Flask request and return its event id."""

    issue_event_id = event_id or f"evt_flask_issue_{uuid.uuid4().hex}"
    trace_context = trace or request_logbrew_trace() or get_active_logbrew_trace()
    client.issue(
        issue_event_id,
        timestamp or utc_timestamp(),
        {
            "title": f"{request_name()} failed",
            "level": "error",
            "message": str(exc) or exc.__class__.__name__,
            "metadata": {
                **request_metadata(status_code=500),
                "exception_type": exc.__class__.__name__,
                **trace_metadata(trace_context),
            },
        },
    )
    return issue_event_id


def add_logbrew_middleware(
    app: Flask,
    *,
    client: LogBrewClient,
    transport: RecordingTransport | None = None,
    capture_successful_requests: bool = True,
    capture_request_metrics: bool = False,
    capture_exceptions: bool = True,
    flush_on_response: bool = True,
    raise_flush_errors: bool = False,
    service_name: str = "flask",
    request_metric_name: str = "http.server.duration",
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewFlaskConfig:
    """Install LogBrew request/exception capture hooks on a Flask app."""

    config = LogBrewFlaskConfig(
        client=client,
        transport=transport,
        capture_successful_requests=capture_successful_requests,
        capture_request_metrics=capture_request_metrics,
        capture_exceptions=capture_exceptions,
        flush_on_response=flush_on_response,
        raise_flush_errors=raise_flush_errors,
        service_name=service_name,
        request_metric_name=request_metric_name,
        span_id_factory=span_id_factory,
    )

    @app.before_request
    def logbrew_before_request() -> None:
        trace_context = create_request_trace_context(span_id_factory=config.span_id_factory)
        g.logbrew_trace = trace_context
        g.logbrew_started_at = time.perf_counter()
        g.logbrew_exception_captured = False
        g.logbrew_span_captured = False
        activation = use_logbrew_trace(trace_context)
        activation.__enter__()
        g.logbrew_trace_activation = activation

    @app.after_request
    def logbrew_after_request(response: Response) -> Response:
        duration_ms = request_duration_ms()
        exception_captured = bool(getattr(g, "logbrew_exception_captured", False))
        should_capture_request_span = (
            not exception_captured and (config.capture_successful_requests or response.status_code >= 500)
        )
        if should_capture_request_span:
            capture_request_span(
                config.client,
                status_code=response.status_code,
                duration_ms=duration_ms,
                span_id_factory=config.span_id_factory,
                trace=request_logbrew_trace(),
            )
            g.logbrew_span_captured = True
        if config.capture_request_metrics:
            capture_request_metric(
                config.client,
                status_code=response.status_code,
                duration_ms=duration_ms,
                metric_name=config.request_metric_name,
            )
        if should_capture_request_span or config.capture_request_metrics:
            flush_if_configured(config)
        return response

    @app.teardown_request
    def logbrew_teardown_request(exc: BaseException | None) -> None:
        if (
            exc is not None
            and not isinstance(exc, (SdkError, TransportError))
            and config.capture_exceptions
            and not bool(getattr(g, "logbrew_exception_captured", False))
        ):
            capture_exception_and_span(config, exc)
        activation = getattr(g, "logbrew_trace_activation", None)
        if activation is not None:
            activation.__exit__(None, None, None)

    def logbrew_got_request_exception(sender: Flask, exception: BaseException, **_: Any) -> None:
        if (
            sender is app
            and not isinstance(exception, (SdkError, TransportError))
            and config.capture_exceptions
            and not bool(getattr(g, "logbrew_exception_captured", False))
        ):
            capture_exception_and_span(config, exception)

    got_request_exception.connect(logbrew_got_request_exception, app, weak=False)
    return config


def capture_exception_and_span(config: LogBrewFlaskConfig, exc: BaseException) -> None:
    """Capture an exception issue and matching error span for the active request."""

    duration_ms = request_duration_ms()
    trace_context = request_logbrew_trace()
    capture_exception(config.client, exc, trace=trace_context)
    capture_request_span(
        config.client,
        status_code=500,
        duration_ms=duration_ms,
        span_id_factory=config.span_id_factory,
        trace=trace_context,
    )
    g.logbrew_exception_captured = True
    g.logbrew_span_captured = True
    if config.capture_request_metrics:
        capture_request_metric(
            config.client,
            status_code=500,
            duration_ms=duration_ms,
            metric_name=config.request_metric_name,
        )
    flush_if_configured(config)


def flush_if_configured(config: LogBrewFlaskConfig) -> None:
    """Flush the configured client transport if response-path flushing is enabled."""

    if not config.flush_on_response or config.transport is None:
        return
    try:
        config.client.flush(config.transport)
    except (SdkError, TransportError):
        if config.raise_flush_errors:
            raise


def request_duration_ms() -> float:
    """Return elapsed request duration in milliseconds."""

    started_at = getattr(g, "logbrew_started_at", None)
    if not isinstance(started_at, float):
        return 0.0
    return max(0.0, (time.perf_counter() - started_at) * 1000)


def default_span_id_factory() -> str:
    """Return a fresh W3C-compatible child span id."""

    span_id = uuid.uuid4().hex[:16]
    return "0000000000000001" if span_id == "0000000000000000" else span_id


def create_request_trace_context(
    *,
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewTraceContext:
    """Return a privacy-safe request-local trace context for Flask telemetry."""

    traceparent = request.headers.get("traceparent")
    if traceparent:
        try:
            parse_traceparent(traceparent)
            return create_logbrew_trace_context(traceparent, span_id_factory=span_id_factory)
        except SdkError:
            pass
    return create_logbrew_trace_context(span_id_factory=span_id_factory)


def request_logbrew_trace() -> LogBrewTraceContext | None:
    """Return the trace context attached to the current Flask request, when present."""

    trace = getattr(g, "logbrew_trace", None)
    return trace if isinstance(trace, LogBrewTraceContext) else None


__all__ = [
    "LogBrewFlaskConfig",
    "add_logbrew_middleware",
    "capture_exception",
    "capture_request_metric",
    "capture_request_span",
    "create_request_metric_attributes",
    "create_request_trace_context",
    "get_active_logbrew_trace",
    "request_logbrew_trace",
    "request_metadata",
    "request_name",
    "request_route_template",
    "utc_timestamp",
]
