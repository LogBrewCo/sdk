# Copyright (c) 2026 LogBrew
"""Capture Flask request spans, duration metrics, and unhandled exceptions."""

from __future__ import annotations

import os
import time
import uuid

# Runtime lookup supports get_type_hints on the public config and callables.
# Reviewed 2026-09-05; public annotation resolution is covered by contract tests.
from collections.abc import Callable, Iterable, Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from importlib.metadata import version
from typing import cast

from flask import Flask, Response, has_request_context, request
from flask.signals import got_request_exception, request_finished, request_started
from logbrew_sdk import (
    HttpTransport,
    IssueAttributes,
    LogBrewClient,
    LogBrewTraceContext,
    Metadata,
    MetricAttributes,
    SdkError,
    SpanAttributes,
    TelemetryDeployment,
    TelemetryResource,
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

LOGBREW_FLASK_EXTENSION_KEY = "logbrew"
LOGBREW_FLASK_SDK_VERSION = "0.1.8"
_CONFIGURATION_ERROR = "configuration_error"
_REQUEST_STATE_KEY = "logbrew.request_state"
_MAX_HTTP_STATUS = 599


@dataclass(slots=True)
class _RequestState:
    trace: LogBrewTraceContext
    started_at: float
    timestamp: str
    activation: ExitStack
    name: str
    metadata: Metadata
    exception_captured: bool = False
    completed: bool = False
    failed: bool = False
    deferred: bool = False


class _StreamingResponse(Iterator[str | bytes]):
    """Complete request capture when the WSGI body finishes or closes."""

    def __init__(
        self,
        body: Iterable[str | bytes],
        config: LogBrewFlaskConfig,
        state: _RequestState,
        status_code: int,
        environ: dict[str, object],
    ) -> None:
        self._body = body
        self._iterator: Iterator[str | bytes] | None = None
        self._config = config
        self._state = state
        self._status_code = status_code
        self._closed = False
        self._environ = environ

    @contextmanager
    def _activate(self) -> Iterator[None]:
        previous = self._environ.get(_REQUEST_STATE_KEY)
        self._environ[_REQUEST_STATE_KEY] = self._state
        try:
            with use_logbrew_trace(self._state.trace):
                yield
        finally:
            if previous is None:
                self._environ.pop(_REQUEST_STATE_KEY, None)
            else:
                self._environ[_REQUEST_STATE_KEY] = previous

    def __next__(self) -> str | bytes:
        if self._closed:
            raise StopIteration
        with self._activate():
            try:
                if self._iterator is None:
                    self._iterator = iter(self._body)
                return next(self._iterator)
            except StopIteration:
                self.close()
                raise
            except Exception as exc:
                self._finish(exc)
                raise

    def close(self) -> None:
        """Close the original body once, including a body never iterated."""
        self._finish()

    def _finish(self, error: Exception | None = None) -> None:
        if self._closed:
            return
        self._closed = True
        with self._activate():
            try:
                close = getattr(self._body, "close", None)
                if close is not None:
                    close()
            except Exception as exc:
                self._capture_completion(error or exc)
                if error is not None:
                    raise error from None
                raise
            self._capture_completion(error)
            if error is not None:
                raise error

    def _capture_completion(self, error: Exception | None) -> None:
        if error is not None:
            self._state.failed = True
            _capture_request_exception(self._config, error, self._state)
        try:
            _capture_completed_request(self._config, self._status_code, self._state)
        except (SdkError, TransportError):
            if error is None:
                raise


def _request_state() -> _RequestState | None:
    state = request.environ.get(_REQUEST_STATE_KEY) if has_request_context() else None
    return state if isinstance(state, _RequestState) else None


@dataclass(slots=True)
class LogBrewFlaskConfig:
    """Runtime options used by the LogBrew Flask middleware."""

    client: LogBrewClient
    transport: Transport | None = None
    capture_successful_requests: bool = True
    capture_request_metrics: bool = False
    capture_exceptions: bool = True
    flush_on_response: bool = True
    raise_flush_errors: bool = False
    service_name: str = "flask"
    request_metric_name: str = "http.server.duration"
    span_id_factory: Callable[[], str] | None = None


# The four PLR0913 exceptions preserve released keyword-only call contracts.
# Reviewed 2026-09-05; exact signatures and defaults have compatibility tests.
# Revisit only with an explicitly versioned public API change.
def init_logbrew(  # noqa: PLR0913
    app: Flask,
    *,
    api_key: str | None = None,
    service_name: str | None = None,
    environment: str | None = None,
    release: str | None = None,
    transport: Transport | None = None,
    capture_successful_requests: bool = True,
    capture_request_metrics: bool = False,
    capture_exceptions: bool = True,
    flush_on_response: bool = False,
    raise_flush_errors: bool = False,
    request_metric_name: str = "http.server.duration",
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewFlaskConfig:
    """Configure a Flask app from explicit values or standard LogBrew settings.

    The default owns an HTTP transport and delivers captured telemetry on a
    background worker. Set ``flush_on_response`` only when a controlled app
    explicitly prefers synchronous response-path delivery.

    Returns:
        The existing or newly installed app configuration.

    Raises:
        SdkError: If required settings are missing or an extension conflicts.

    """
    existing = _existing_logbrew_config(app)
    if existing is not None:
        return existing

    resolved_api_key = _resolve_setting(
        app,
        "LOGBREW_SERVER_API_KEY",
        api_key,
        required=True,
    )
    resolved_service_name = _resolve_setting(
        app,
        "LOGBREW_SERVICE_NAME",
        service_name,
        fallback=app.import_name,
    )
    if resolved_api_key is None or resolved_service_name is None:
        missing = "LOGBREW_SERVER_API_KEY" if resolved_api_key is None else "LOGBREW_SERVICE_NAME"
        raise SdkError(_CONFIGURATION_ERROR, f"{missing} is required")
    resolved_environment = _resolve_setting(app, "LOGBREW_ENVIRONMENT", environment)
    resolved_release = _resolve_setting(app, "LOGBREW_RELEASE", release)

    resource: TelemetryResource = {
        "service": {"name": resolved_service_name},
        "framework": {"name": "flask", "version": version("Flask")},
    }
    deployment: TelemetryDeployment = {}
    if resolved_environment is not None:
        deployment["environment"] = resolved_environment
    if resolved_release is not None:
        deployment["release"] = resolved_release
    if deployment:
        resource["deployment"] = deployment
    selected_transport = transport if transport is not None else HttpTransport()
    client = LogBrewClient.create(
        api_key=resolved_api_key,
        sdk_name="logbrew-flask",
        sdk_version=LOGBREW_FLASK_SDK_VERSION,
        context={"schemaVersion": 1, "resource": resource},
        transport=None if flush_on_response else selected_transport,
        automatic_delivery=not flush_on_response,
        delivery_queue_threshold=1,
    )
    return add_logbrew_middleware(
        app,
        client=client,
        transport=selected_transport if flush_on_response else None,
        capture_successful_requests=capture_successful_requests,
        capture_request_metrics=capture_request_metrics,
        capture_exceptions=capture_exceptions,
        flush_on_response=flush_on_response,
        raise_flush_errors=raise_flush_errors,
        service_name=resolved_service_name,
        request_metric_name=request_metric_name,
        span_id_factory=span_id_factory,
    )


def _resolve_setting(
    app: Flask,
    name: str,
    explicit: str | None,
    *,
    fallback: str | None = None,
    required: bool = False,
) -> str | None:
    value: object = explicit
    if value is None:
        value = app.config.get(name)
    if value is None:
        value = os.environ.get(name)
    if value is None:
        value = fallback
    if value is None:
        if required:
            raise SdkError(_CONFIGURATION_ERROR, f"{name} is required")
        return None
    if not isinstance(value, str) or not value.strip():
        raise SdkError(_CONFIGURATION_ERROR, f"{name} must be a non-empty string")
    return value.strip()


def _existing_logbrew_config(app: Flask) -> LogBrewFlaskConfig | None:
    existing = app.extensions.get(LOGBREW_FLASK_EXTENSION_KEY)
    if existing is None:
        return None
    if not isinstance(existing, LogBrewFlaskConfig):
        raise SdkError(_CONFIGURATION_ERROR, "Flask app extension name logbrew is already in use")
    return existing


def utc_timestamp() -> str:
    """Read the current time.

    Returns:
        A UTC timestamp with millisecond precision and a Z suffix.

    """
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def request_name() -> str:
    """Name the current request without a concrete path.

    Returns:
        The HTTP method and normalized Flask route template.

    """
    return f"{request.method} {request_route_template()}"


def request_metadata(
    *,
    status_code: int | None = None,
    duration_ms: float | None = None,
) -> Metadata:
    """Describe the matched request without including query strings.

    Returns:
        Framework, method, route, and any supplied status and duration.

    """
    route_template = request_route_template()
    metadata: Metadata = {
        "framework": "flask",
        "method": request.method,
        "routeTemplate": route_template,
    }
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
    """Read the matched Flask rule.

    Returns:
        A normalized route template, or <unmatched> when no rule exists.

    """
    rule = getattr(request.url_rule, "rule", None)
    if not isinstance(rule, str) or not rule:
        return "<unmatched>"
    return route_template_only(rule)


def route_template_only(value: str) -> str:
    """Strip query and fragment text from a route template.

    Returns:
        The trimmed template, or / when it is empty.

    """
    route_template = value.split("?", 1)[0].split("#", 1)[0].strip()
    return route_template or "/"


def status_code_class(status_code: int) -> str:
    """Classify an HTTP response for request metrics.

    Returns:
        The 1xx through 5xx class, or unknown outside the HTTP range.

    """
    return f"{status_code // 100}xx" if HTTPStatus.CONTINUE <= status_code <= _MAX_HTTP_STATUS else "unknown"


def create_request_metric_attributes(
    *,
    status_code: int,
    duration_ms: float,
    metric_name: str = "http.server.duration",
) -> MetricAttributes:
    """Describe the duration of one completed Flask request.

    Returns:
        A nonnegative delta histogram in milliseconds with bounded dimensions.

    """
    return _metric_attributes(
        status_code,
        duration_ms,
        metric_name,
        {"framework": "flask", "method": request.method, "routeTemplate": request_route_template()},
        get_active_logbrew_trace(),
    )


def _metric_attributes(
    status_code: int,
    duration_ms: float,
    metric_name: str,
    metadata: Metadata,
    trace: LogBrewTraceContext | None,
) -> MetricAttributes:
    attributes: MetricAttributes = {
        "name": metric_name,
        "description": "Duration of one completed server request.",
        "kind": "histogram",
        "value": max(float(duration_ms), 0.0),
        "unit": "ms",
        "temporality": "delta",
        "metadata": {
            **metadata,
            "statusCode": status_code,
            "statusCodeClass": status_code_class(status_code),
        },
    }
    if trace is not None:
        trace_context: TelemetryTraceContext = {
            "traceId": trace.trace_id,
            "spanId": trace.span_id,
            "sampled": trace.sampled,
        }
        if trace.parent_span_id is not None:
            trace_context["parentSpanId"] = trace.parent_span_id
        attributes["context"] = {"schemaVersion": 1, "trace": trace_context}
    return attributes


def capture_request_metric(  # noqa: PLR0913
    client: LogBrewClient,
    *,
    status_code: int,
    duration_ms: float,
    event_id: str | None = None,
    timestamp: str | None = None,
    metric_name: str = "http.server.duration",
) -> str:
    """Capture a Flask request duration metric.

    Returns:
        The supplied or generated metric event ID.

    """
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


def capture_request_span(  # noqa: PLR0913
    client: LogBrewClient,
    *,
    status_code: int,
    duration_ms: float,
    event_id: str | None = None,
    timestamp: str | None = None,
    span_id_factory: Callable[[], str] | None = None,
    trace: LogBrewTraceContext | None = None,
) -> str:
    """Capture a Flask request with its supplied or active trace context.

    Returns:
        The supplied or generated span event ID.

    """
    span_event_id = event_id or f"evt_flask_span_{uuid.uuid4().hex}"
    trace_context = (
        trace
        or request_logbrew_trace()
        or create_request_trace_context(
            span_id_factory=span_id_factory,
        )
    )
    attributes: SpanAttributes = span_attributes_from_trace_context(
        trace_context,
        name=request_name(),
        status="ok" if status_code < HTTPStatus.INTERNAL_SERVER_ERROR else "error",
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
    """Capture an unhandled request exception without its private message.

    Returns:
        The supplied or generated issue event ID.

    """
    issue_event_id = event_id or f"evt_flask_issue_{uuid.uuid4().hex}"
    trace_context = trace or request_logbrew_trace() or get_active_logbrew_trace()
    client.issue(
        issue_event_id,
        timestamp or utc_timestamp(),
        _issue_attributes(exc, request_name(), request_metadata(status_code=500), trace_context),
    )
    return issue_event_id


def _issue_attributes(
    exc: BaseException, name: str, metadata: Metadata, trace: LogBrewTraceContext | None
) -> IssueAttributes:
    return create_issue_attributes_from_exception(
        exc,
        title=f"{name} failed",
        message="Unhandled exception",
        mechanism="flask.middleware",
        handled=False,
        metadata={**metadata, **trace_metadata(trace)},
    )


def add_logbrew_middleware(  # noqa: PLR0913
    app: Flask,
    *,
    client: LogBrewClient,
    transport: Transport | None = None,
    capture_successful_requests: bool = True,
    capture_request_metrics: bool = False,
    capture_exceptions: bool = True,
    flush_on_response: bool = True,
    raise_flush_errors: bool = False,
    service_name: str = "flask",
    request_metric_name: str = "http.server.duration",
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewFlaskConfig:
    """Install LogBrew request and exception capture hooks on a Flask app.

    Returns:
        The installed configuration, reusing an identical prior installation.

    Raises:
        SdkError: If an existing extension has different settings or ownership.

    """
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
    existing = _existing_logbrew_config(app)
    if existing is not None:
        if existing == config:
            return existing
        raise SdkError(_CONFIGURATION_ERROR, "LogBrew Flask middleware is already configured")

    def logbrew_request_started(_sender: Flask, **_: object) -> None:
        trace_context = create_request_trace_context(span_id_factory=config.span_id_factory)
        state = _RequestState(
            trace_context, time.perf_counter(), utc_timestamp(), ExitStack(), request_name(), request_metadata()
        )
        state.activation.enter_context(use_logbrew_trace(trace_context))
        request.environ[_REQUEST_STATE_KEY] = state

    def logbrew_request_finished(_sender: Flask, response: Response, **_: object) -> None:
        state = _request_state()
        # Error responses are complete; only defer application bodies that are still streaming.
        if state is not None and response.is_streamed and not state.exception_captured:
            state.name = request_name()
            state.metadata = request_metadata(status_code=response.status_code)
            response.response = cast(
                "Iterable[bytes]",
                _StreamingResponse(response.response, config, state, response.status_code, request.environ),
            )
            state.deferred = True
            request.environ.pop(_REQUEST_STATE_KEY, None)
            state.activation.close()
            return
        _capture_completed_request(config, response.status_code)

    @app.teardown_request
    def logbrew_teardown_request(exc: BaseException | None) -> None:
        state = _request_state()
        try:
            if exc is not None and (state is None or not state.deferred):
                _capture_request_exception(config, exc)
                _capture_completed_request(config, 500)
        finally:
            state = _request_state()
            if state is not None:
                request.environ.pop(_REQUEST_STATE_KEY, None)
                state.activation.close()

    def logbrew_got_request_exception(_sender: Flask, exception: BaseException, **_: object) -> None:
        _capture_request_exception(config, exception)

    request_started.connect(logbrew_request_started, app, weak=False)
    got_request_exception.connect(logbrew_got_request_exception, app, weak=False)
    request_finished.connect(logbrew_request_finished, app, weak=False)
    app.extensions[LOGBREW_FLASK_EXTENSION_KEY] = config
    return config


def _capture_request_exception(
    config: LogBrewFlaskConfig, exc: BaseException, state: _RequestState | None = None
) -> None:
    """Record an eligible issue once, without completing the request early."""
    state = state or _request_state()
    if (
        state is not None
        and config.capture_exceptions
        and not isinstance(exc, (SdkError, TransportError))
        and not state.exception_captured
    ):
        config.client.issue(
            f"evt_flask_issue_{uuid.uuid4().hex}",
            utc_timestamp(),
            _issue_attributes(exc, state.name, {"status_code": 500, **state.metadata}, state.trace),
        )
        state.exception_captured = True


def _capture_completed_request(
    config: LogBrewFlaskConfig, status_code: int, state: _RequestState | None = None
) -> None:
    """Record one completed request, or the teardown fallback for propagation."""
    state = state or _request_state()
    if state is None or state.completed:
        return
    state.completed = True
    duration_ms = max(0.0, (time.perf_counter() - state.started_at) * 1000)
    capture_span = (
        config.capture_successful_requests
        or status_code >= HTTPStatus.INTERNAL_SERVER_ERROR
        or state.exception_captured
        or state.failed
    )
    if capture_span:
        config.client.span(
            f"evt_flask_span_{uuid.uuid4().hex}",
            state.timestamp,
            span_attributes_from_trace_context(
                state.trace,
                name=state.name,
                status="error" if state.failed or status_code >= HTTPStatus.INTERNAL_SERVER_ERROR else "ok",
                duration_ms=duration_ms,
                metadata={**state.metadata, "status_code": status_code, "duration_ms": round(duration_ms, 3)},
            ),
        )
    if config.capture_request_metrics:
        config.client.metric(
            f"evt_flask_metric_{uuid.uuid4().hex}",
            utc_timestamp(),
            _metric_attributes(
                status_code,
                duration_ms,
                config.request_metric_name,
                {key: state.metadata[key] for key in ("framework", "method", "routeTemplate")},
                state.trace,
            ),
        )
    if capture_span or config.capture_request_metrics:
        flush_if_configured(config)


def flush_if_configured(config: LogBrewFlaskConfig) -> None:
    """Flush the configured transport if response-path flushing is enabled.

    Raises:
        SdkError: If flush validation fails and raise_flush_errors is enabled.
        TransportError: If delivery fails and raise_flush_errors is enabled.

    """
    if not config.flush_on_response or config.transport is None:
        return
    try:
        config.client.flush(config.transport)
    except (SdkError, TransportError):
        if config.raise_flush_errors:
            raise


def request_duration_ms() -> float:
    """Measure time since request capture started.

    Returns:
        Nonnegative elapsed milliseconds, or zero outside captured dispatch.

    """
    state = _request_state()
    return max(0.0, (time.perf_counter() - state.started_at) * 1000) if state is not None else 0.0


def create_request_trace_context(
    *,
    span_id_factory: Callable[[], str] | None = None,
) -> LogBrewTraceContext:
    """Continue a valid inbound trace or start a local request trace.

    Returns:
        A fresh span context without retaining the raw inbound header.

    """
    traceparent = request.headers.get("traceparent")
    if traceparent:
        try:
            parse_traceparent(traceparent)
        except SdkError:
            pass
        else:
            return create_logbrew_trace_context(traceparent, span_id_factory=span_id_factory)
    return create_logbrew_trace_context(span_id_factory=span_id_factory)


def request_logbrew_trace() -> LogBrewTraceContext | None:
    """Read the trace attached to the current Flask request.

    Returns:
        The captured request context, or None before capture and after teardown.

    """
    state = _request_state()
    return state.trace if state is not None else None
