"""Django integration helpers for capturing LogBrew request spans and exceptions."""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.http import HttpRequest, HttpResponse
from logbrew_sdk import (
    LogBrewClient,
    MetricAttributes,
    RecordingTransport,
    SdkError,
    SpanAttributes,
    TransportError,
    parse_traceparent,
    span_attributes_from_traceparent,
)


@dataclass(slots=True)
class LogBrewDjangoConfig:
    """Runtime options used by the LogBrew Django middleware."""

    client: LogBrewClient
    transport: RecordingTransport | None = None
    capture_successful_requests: bool = True
    capture_request_metrics: bool = False
    capture_exceptions: bool = True
    flush_on_response: bool = True
    raise_flush_errors: bool = False
    service_name: str = "django"
    request_metric_name: str = "http.server.duration"
    span_id_factory: Callable[[], str] | None = None


_configured_state: dict[str, LogBrewDjangoConfig] = {}


def configure_logbrew(
    *,
    client: LogBrewClient,
    transport: RecordingTransport | None = None,
    capture_successful_requests: bool = True,
    capture_request_metrics: bool = False,
    capture_exceptions: bool = True,
    flush_on_response: bool = True,
    raise_flush_errors: bool = False,
    service_name: str = "django",
    request_metric_name: str = "http.server.duration",
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewDjangoConfig:
    """Configure LogBrew Django middleware from application startup code."""

    config = LogBrewDjangoConfig(
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
    _configured_state["config"] = config
    return config


def get_logbrew_config() -> LogBrewDjangoConfig:
    """Return the active LogBrew Django config from explicit setup or Django settings."""

    config = _configured_state.get("config")
    if config is not None:
        return config

    client = getattr(settings, "LOGBREW_CLIENT", None)
    if not isinstance(client, LogBrewClient):
        raise ImproperlyConfigured(
            "LogBrewDjangoMiddleware requires configure_logbrew(client=...) "
            "or a LOGBREW_CLIENT setting."
        )

    transport = getattr(settings, "LOGBREW_TRANSPORT", None)
    if transport is not None and not isinstance(transport, RecordingTransport):
        raise ImproperlyConfigured("LOGBREW_TRANSPORT must be a RecordingTransport-compatible instance.")
    span_id_factory = getattr(settings, "LOGBREW_SPAN_ID_FACTORY", None)
    if span_id_factory is not None and not callable(span_id_factory):
        raise ImproperlyConfigured("LOGBREW_SPAN_ID_FACTORY must be callable when provided.")

    return LogBrewDjangoConfig(
        client=client,
        transport=transport,
        capture_successful_requests=bool(getattr(settings, "LOGBREW_CAPTURE_SUCCESSFUL_REQUESTS", True)),
        capture_request_metrics=bool(getattr(settings, "LOGBREW_CAPTURE_REQUEST_METRICS", False)),
        capture_exceptions=bool(getattr(settings, "LOGBREW_CAPTURE_EXCEPTIONS", True)),
        flush_on_response=bool(getattr(settings, "LOGBREW_FLUSH_ON_RESPONSE", True)),
        raise_flush_errors=bool(getattr(settings, "LOGBREW_RAISE_FLUSH_ERRORS", False)),
        service_name=str(getattr(settings, "LOGBREW_SERVICE_NAME", "django")),
        request_metric_name=str(getattr(settings, "LOGBREW_REQUEST_METRIC_NAME", "http.server.duration")),
        span_id_factory=span_id_factory,
    )


def utc_timestamp() -> str:
    """Return a LogBrew-compatible UTC timestamp."""

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def request_name(request: HttpRequest) -> str:
    """Return the stable request name used for span and issue titles."""

    return f"{request.method} {request.path}"


def request_metadata(
    request: HttpRequest,
    *,
    status_code: int | None = None,
    duration_ms: float | None = None,
) -> dict[str, Any]:
    """Return request metadata without including query strings or request bodies."""

    metadata: dict[str, Any] = {
        "framework": "django",
        "method": request.method,
        "path": request.path,
    }
    resolver_match = getattr(request, "resolver_match", None)
    route = getattr(resolver_match, "route", None)
    view_name = getattr(resolver_match, "view_name", None)
    if isinstance(route, str):
        metadata["route"] = route
    if isinstance(view_name, str):
        metadata["view_name"] = view_name
    if status_code is not None:
        metadata["status_code"] = status_code
    if duration_ms is not None:
        metadata["duration_ms"] = round(duration_ms, 3)
    return metadata


def request_route_template(request: HttpRequest) -> str:
    """Return a low-cardinality Django route template without query strings."""

    resolver_match = getattr(request, "resolver_match", None)
    route = getattr(resolver_match, "route", None)
    template = route if isinstance(route, str) and route else request.path
    return route_template_only(template)


def route_template_only(value: str) -> str:
    """Strip query/hash text from a route template and normalize Django route strings."""

    route_template = value.split("?", 1)[0].split("#", 1)[0].strip()
    if not route_template:
        return "/"
    return route_template if route_template.startswith("/") else f"/{route_template}"


def status_code_class(status_code: int) -> str:
    """Return the coarse HTTP status code class used by request metrics."""

    return f"{status_code // 100}xx" if 100 <= status_code <= 599 else "unknown"


def create_request_metric_attributes(
    request: HttpRequest,
    *,
    status_code: int,
    duration_ms: float,
    metric_name: str = "http.server.duration",
) -> MetricAttributes:
    """Create privacy-safe request duration metric attributes for a completed Django request."""

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
            "framework": "django",
            "method": request.method,
            "routeTemplate": request_route_template(request),
            "statusCode": status_code,
            "statusCodeClass": status_code_class(status_code),
        },
    }


def capture_request_metric(
    client: LogBrewClient,
    request: HttpRequest,
    *,
    status_code: int,
    duration_ms: float,
    event_id: str | None = None,
    timestamp: str | None = None,
    metric_name: str = "http.server.duration",
) -> str:
    """Capture a Django request duration metric and return its event id."""

    metric_event_id = event_id or f"evt_django_metric_{uuid.uuid4().hex}"
    client.metric(
        metric_event_id,
        timestamp or utc_timestamp(),
        create_request_metric_attributes(
            request,
            status_code=status_code,
            duration_ms=duration_ms,
            metric_name=metric_name,
        ),
    )
    return metric_event_id


def capture_request_span(
    client: LogBrewClient,
    request: HttpRequest,
    *,
    status_code: int,
    duration_ms: float,
    event_id: str | None = None,
    timestamp: str | None = None,
    span_id_factory: Callable[[], str] | None = None,
) -> str:
    """Capture a Django request as a LogBrew span event and return its event id."""

    span_event_id = event_id or f"evt_django_span_{uuid.uuid4().hex}"
    span_seed = span_event_id.replace("-", "_")
    traceparent = traceparent_from_request(request)
    attributes: SpanAttributes = {
        "name": request_name(request),
        "traceId": f"trace_{span_seed}",
        "spanId": f"span_{span_seed}",
        "status": "ok" if status_code < 500 else "error",
        "durationMs": duration_ms,
        "metadata": request_metadata(request, status_code=status_code, duration_ms=duration_ms),
    }
    if traceparent:
        try:
            parse_traceparent(traceparent)
            attributes = span_attributes_from_traceparent(
                traceparent,
                name=request_name(request),
                span_id=(span_id_factory or default_span_id_factory)(),
                status="ok" if status_code < 500 else "error",
                duration_ms=duration_ms,
                metadata=request_metadata(request, status_code=status_code, duration_ms=duration_ms),
            )
        except SdkError:
            pass
    client.span(
        span_event_id,
        timestamp or utc_timestamp(),
        attributes,
    )
    return span_event_id


def capture_exception(
    client: LogBrewClient,
    request: HttpRequest,
    exc: BaseException,
    *,
    event_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    """Capture an exception raised while handling a Django request and return its event id."""

    issue_event_id = event_id or f"evt_django_issue_{uuid.uuid4().hex}"
    client.issue(
        issue_event_id,
        timestamp or utc_timestamp(),
        {
            "title": f"{request_name(request)} failed",
            "level": "error",
            "message": str(exc) or exc.__class__.__name__,
            "metadata": {
                **request_metadata(request, status_code=500),
                "exception_type": exc.__class__.__name__,
            },
        },
    )
    return issue_event_id


class LogBrewDjangoMiddleware:
    """Django middleware that records request spans and exception issues with LogBrew."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        config = get_logbrew_config()
        start = time.perf_counter()
        try:
            response = self.get_response(request)
        except Exception as exc:
            duration_ms = (time.perf_counter() - start) * 1000
            should_capture_exception = (
                config.capture_exceptions and request.META.get("logbrew.exception_captured") is not True
            )
            if should_capture_exception:
                capture_exception(config.client, request, exc)
                capture_request_span(
                    config.client,
                    request,
                    status_code=500,
                    duration_ms=duration_ms,
                    span_id_factory=config.span_id_factory,
                )
            if config.capture_request_metrics:
                capture_request_metric(
                    config.client,
                    request,
                    status_code=500,
                    duration_ms=duration_ms,
                    metric_name=config.request_metric_name,
                )
            if should_capture_exception or config.capture_request_metrics:
                self._flush_if_configured(config)
            raise

        duration_ms = (time.perf_counter() - start) * 1000
        should_capture_request_span = config.capture_successful_requests or response.status_code >= 500
        if should_capture_request_span:
            capture_request_span(
                config.client,
                request,
                status_code=response.status_code,
                duration_ms=duration_ms,
                span_id_factory=config.span_id_factory,
            )
        if config.capture_request_metrics:
            capture_request_metric(
                config.client,
                request,
                status_code=response.status_code,
                duration_ms=duration_ms,
                metric_name=config.request_metric_name,
            )
        if should_capture_request_span or config.capture_request_metrics:
            self._flush_if_configured(config)
        return response

    def process_exception(self, request: HttpRequest, exception: Exception) -> None:
        """Capture Django view exceptions before Django converts them into responses."""

        config = get_logbrew_config()
        if not config.capture_exceptions:
            return None
        capture_exception(config.client, request, exception)
        request.META["logbrew.exception_captured"] = True
        return None

    @staticmethod
    def _flush_if_configured(config: LogBrewDjangoConfig) -> None:
        if not config.flush_on_response or config.transport is None:
            return
        try:
            config.client.flush(config.transport)
        except (SdkError, TransportError):
            if config.raise_flush_errors:
                raise


def traceparent_from_request(request: HttpRequest) -> str | None:
    """Return the incoming W3C traceparent header from a Django request."""

    value = request.headers.get("traceparent")
    if isinstance(value, str):
        return value
    value = request.META.get("HTTP_TRACEPARENT")
    return value if isinstance(value, str) else None


def default_span_id_factory() -> str:
    """Return a fresh W3C-compatible child span id."""

    span_id = uuid.uuid4().hex[:16]
    return "0000000000000001" if span_id == "0000000000000000" else span_id


__all__ = [
    "LogBrewDjangoConfig",
    "LogBrewDjangoMiddleware",
    "capture_exception",
    "capture_request_metric",
    "capture_request_span",
    "configure_logbrew",
    "create_request_metric_attributes",
    "get_logbrew_config",
    "request_metadata",
    "request_name",
    "request_route_template",
    "utc_timestamp",
]
