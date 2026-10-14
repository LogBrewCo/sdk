"""Django integration helpers for capturing LogBrew request spans and exceptions."""

from __future__ import annotations

import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from django.conf import settings
from django.core import signals
from django.core.exceptions import ImproperlyConfigured
from django.http import HttpRequest, HttpResponse, StreamingHttpResponse
from logbrew_sdk import (
    LogBrewClient,
    LogBrewTraceContext,
    MetricAttributes,
    SdkError,
    SpanAttributes,
    TelemetryTraceContext,
    Transport,
    TransportError,
    create_issue_attributes_from_exception,
    create_logbrew_trace_context,
    get_active_logbrew_trace,
    parse_traceparent,
    span_attributes_from_trace_context,
    trace_metadata,
    use_logbrew_trace,
)
from logbrew_sdk import (
    RecordingTransport as RecordingTransport,
)

from ._streaming import wrap_streaming_response


@dataclass(slots=True)
class LogBrewDjangoConfig:
    """Runtime options used by the LogBrew Django middleware."""

    client: LogBrewClient
    transport: Transport | None = None
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
    transport: Transport | None = None,
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
    if transport is not None and not callable(getattr(transport, "send", None)):
        raise ImproperlyConfigured("LOGBREW_TRANSPORT must provide a callable send method.")
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

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def request_name(request: HttpRequest) -> str:
    """Return the stable request name used for span and issue titles."""

    return f"{request.method} {request_route_template(request)}"


def request_metadata(
    request: HttpRequest,
    *,
    status_code: int | None = None,
    duration_ms: float | None = None,
    service_name: str | None = None,
) -> dict[str, Any]:
    """Return request metadata without including query strings or request bodies."""

    route_template = request_route_template(request)
    metadata: dict[str, Any] = {
        "framework": "django",
        "method": request.method,
        "routeTemplate": route_template,
    }
    if service_name:
        metadata["service"] = service_name
    if route_template == request.path:
        metadata["path"] = request.path
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
    service_name: str | None = None,
) -> MetricAttributes:
    """Create privacy-safe request duration metric attributes for a completed Django request."""

    duration_value = float(duration_ms)
    if duration_value < 0:
        duration_value = 0.0
    attributes: MetricAttributes = {
        "name": metric_name,
        "description": "Duration of one completed server request.",
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
            **({"service": service_name} if service_name else {}),
        },
    }
    trace = request_logbrew_trace(request) or get_active_logbrew_trace()
    if trace is not None:
        metric_trace: TelemetryTraceContext = {
            "traceId": trace.trace_id,
            "spanId": trace.span_id,
            "sampled": trace.sampled,
        }
        if trace.parent_span_id is not None:
            metric_trace["parentSpanId"] = trace.parent_span_id
        attributes["context"] = {"schemaVersion": 1, "trace": metric_trace}
    return attributes


def capture_request_metric(
    client: LogBrewClient,
    request: HttpRequest,
    *,
    status_code: int,
    duration_ms: float,
    event_id: str | None = None,
    timestamp: str | None = None,
    metric_name: str = "http.server.duration",
    service_name: str | None = None,
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
            service_name=service_name,
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
    trace: LogBrewTraceContext | None = None,
    failed: bool = False,
    service_name: str | None = None,
) -> str:
    """Capture a Django request as a LogBrew span event and return its event id."""

    span_event_id = event_id or f"evt_django_span_{uuid.uuid4().hex}"
    trace_context = trace or request_logbrew_trace(request) or create_request_trace_context(
        request,
        span_id_factory=span_id_factory,
    )
    attributes: SpanAttributes = span_attributes_from_trace_context(
        trace_context,
        name=request_name(request),
        status="error" if failed or status_code >= 500 else "ok",
        duration_ms=duration_ms,
        metadata=request_metadata(
            request, status_code=status_code, duration_ms=duration_ms, service_name=service_name,
        ),
    )
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
    trace: LogBrewTraceContext | None = None,
    status_code: int = 500,
    service_name: str | None = None,
) -> str:
    """Capture an exception raised while handling a Django request and return its event id."""

    issue_event_id = event_id or f"evt_django_issue_{uuid.uuid4().hex}"
    trace_context = trace or request_logbrew_trace(request) or get_active_logbrew_trace()
    client.issue(
        issue_event_id,
        timestamp or utc_timestamp(),
        create_issue_attributes_from_exception(
            exc,
            title=f"{request_name(request)} failed",
            message="Unhandled exception",
            mechanism="django.middleware",
            handled=False,
            metadata={
                **request_metadata(request, status_code=status_code, service_name=service_name),
                **trace_metadata(trace_context),
            },
        ),
    )
    return issue_event_id


class LogBrewDjangoMiddleware:
    """Django middleware that records request spans and exception issues with LogBrew."""

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        signals.got_request_exception.connect(self._capture_unhandled_exception)

    def _capture_unhandled_exception(self, sender: object, request: HttpRequest, **kwargs: Any) -> None:
        if request.META.get("logbrew.owner") is not self:
            return
        config = request.META.get("logbrew.config")
        if not isinstance(config, LogBrewDjangoConfig) or not config.capture_exceptions:
            return
        if request.META.get("logbrew.exception_captured") is True:
            return
        exception = sys.exc_info()[1]
        if isinstance(exception, Exception):
            trace = request_logbrew_trace(request)
            with use_logbrew_trace(trace):
                capture_exception(config.client, request, exception, trace=trace, service_name=config.service_name)
            request.META["logbrew.exception_captured"] = True

    def __call__(self, request: HttpRequest) -> HttpResponse:
        config = get_logbrew_config()
        start = time.perf_counter()
        trace_context = create_request_trace_context(request, span_id_factory=config.span_id_factory)
        request.META["logbrew.trace"] = trace_context
        request.META["logbrew.owner"] = self
        request.META["logbrew.config"] = config
        try:
            with use_logbrew_trace(trace_context):
                response = self.get_response(request)
        except Exception as exc:
            duration_ms = (time.perf_counter() - start) * 1000
            should_capture_exception = (
                config.capture_exceptions and request.META.get("logbrew.exception_captured") is not True
            )
            if should_capture_exception:
                capture_exception(config.client, request, exc, trace=trace_context, service_name=config.service_name)
                capture_request_span(
                    config.client,
                    request,
                    status_code=500,
                    duration_ms=duration_ms,
                    span_id_factory=config.span_id_factory,
                    trace=trace_context,
                    service_name=config.service_name,
                )
            if config.capture_request_metrics:
                capture_request_metric(
                    config.client,
                    request,
                    status_code=500,
                    duration_ms=duration_ms,
                    metric_name=config.request_metric_name,
                    service_name=config.service_name,
                )
            if should_capture_exception or config.capture_request_metrics:
                self._flush_if_configured(config)
            raise
        finally:
            request.META.pop("logbrew.owner", None)
            request.META.pop("logbrew.config", None)

        if isinstance(response, StreamingHttpResponse):
            wrap_streaming_response(
                response,
                trace_context,
                lambda error: self._finish_request(
                    config, request, trace_context, start, status_code=response.status_code, error=error,
                ),
            )
            return response

        with use_logbrew_trace(trace_context):
            self._finish_request(config, request, trace_context, start, status_code=response.status_code)
        return response

    def _finish_request(
        self,
        config: LogBrewDjangoConfig,
        request: HttpRequest,
        trace: LogBrewTraceContext,
        start: float,
        *,
        status_code: int,
        error: Exception | None = None,
    ) -> None:
        duration_ms = (time.perf_counter() - start) * 1000
        failed = error is not None
        if error is not None and config.capture_exceptions:
            capture_exception(
                config.client, request, error, trace=trace, status_code=status_code, service_name=config.service_name,
            )
        should_capture_request_span = (
            config.capture_successful_requests or status_code >= 500 or (failed and config.capture_exceptions)
        )
        if should_capture_request_span:
            capture_request_span(
                config.client,
                request,
                status_code=status_code,
                duration_ms=duration_ms,
                span_id_factory=config.span_id_factory,
                trace=trace,
                failed=failed,
                service_name=config.service_name,
            )
        if config.capture_request_metrics:
            capture_request_metric(
                config.client,
                request,
                status_code=status_code,
                duration_ms=duration_ms,
                metric_name=config.request_metric_name,
                service_name=config.service_name,
            )
        if should_capture_request_span or config.capture_request_metrics:
            self._flush_if_configured(config)

    def process_exception(self, request: HttpRequest, exception: Exception) -> None:
        """Capture Django view exceptions before Django converts them into responses."""

        config = get_logbrew_config()
        if not config.capture_exceptions:
            return None
        capture_exception(
            config.client, request, exception, trace=request_logbrew_trace(request), service_name=config.service_name,
        )
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


def create_request_trace_context(
    request: HttpRequest,
    *,
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewTraceContext:
    """Return a privacy-safe request-local trace context for Django telemetry."""

    traceparent = traceparent_from_request(request)
    if traceparent:
        try:
            parse_traceparent(traceparent)
        except SdkError:
            pass
        else:
            return create_logbrew_trace_context(traceparent, span_id_factory=span_id_factory)
    return create_logbrew_trace_context(span_id_factory=span_id_factory)


def request_logbrew_trace(request: HttpRequest) -> LogBrewTraceContext | None:
    """Return the trace context attached to a Django request, when present."""

    trace = request.META.get("logbrew.trace")
    return trace if isinstance(trace, LogBrewTraceContext) else None


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
    "create_request_trace_context",
    "get_active_logbrew_trace",
    "get_logbrew_config",
    "request_logbrew_trace",
    "request_metadata",
    "request_name",
    "request_route_template",
    "utc_timestamp",
]
