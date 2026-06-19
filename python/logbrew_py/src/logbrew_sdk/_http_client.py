"""Explicit outbound HTTP span helpers for app-owned Python HTTP calls."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from contextlib import suppress
from datetime import UTC, datetime
from importlib import import_module
from time import perf_counter
from typing import Any, TypeAlias, cast
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

from logbrew_sdk._trace_context import (
    LogBrewTraceContext,
    get_active_logbrew_trace,
    use_logbrew_trace,
)

MetadataValue: TypeAlias = str | int | float | bool | None
Metadata: TypeAlias = dict[str, MetadataValue]
Clock: TypeAlias = Callable[[], float]

HEX16 = re.compile(r"^[0-9a-fA-F]{16}$")
ZERO_SPAN_ID = "0000000000000000"


def urlopen_with_logbrew_span(
    request: str | Request,
    data: bytes | None = None,
    *,
    client: Any,
    event_id: str,
    timestamp: str | None = None,
    open_url: Callable[..., Any] | None = None,
    timeout: float | None = None,
    trace: LogBrewTraceContext | None = None,
    route_template: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> Any:
    """Run ``urllib.request.urlopen`` under a LogBrew child span and W3C trace header."""

    parent_trace = trace if trace is not None else get_active_logbrew_trace()
    child_trace = _child_trace(parent_trace, span_id_factory)
    source_request = _request_from_input(request, data)
    traced_request = _clone_request_with_traceparent(source_request, child_trace)
    method = traced_request.get_method().upper()
    route = _route_from_request(traced_request, route_template)
    open_callable = open_url or urlopen
    read_clock = clock or perf_counter
    start = read_clock()

    with use_logbrew_trace(child_trace):
        try:
            response = _call_urlopen(open_callable, traced_request, timeout)
        except Exception as error:
            duration_ms = _duration_ms(start, read_clock)
            _capture_http_span(
                client,
                event_id,
                timestamp,
                child_trace,
                method,
                route,
                "error",
                duration_ms,
                metadata,
                _status_from_error(error),
                error,
                on_capture_error,
                "urllib.request",
            )
            raise

    duration_ms = _duration_ms(start, read_clock)
    status_code = _status_from_response(response)
    span_status = "error" if status_code is not None and status_code >= 400 else "ok"
    _capture_http_span(
        client,
        event_id,
        timestamp,
        child_trace,
        method,
        route,
        span_status,
        duration_ms,
        metadata,
        status_code,
        None,
        on_capture_error,
        "urllib.request",
    )
    return response


def requests_request_with_logbrew_span(
    method: str,
    url: str,
    *,
    client: Any,
    event_id: str,
    timestamp: str | None = None,
    request: Callable[..., Any] | None = None,
    session: Any | None = None,
    headers: Mapping[str, str] | None = None,
    timeout: Any | None = None,
    trace: LogBrewTraceContext | None = None,
    route_template: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
    **request_kwargs: Any,
) -> Any:
    """Run a caller-owned ``requests`` call under a LogBrew child span and W3C trace header."""

    method_value = _method_name(method)
    _require_url(url)
    parent_trace = trace if trace is not None else get_active_logbrew_trace()
    child_trace = _child_trace(parent_trace, span_id_factory)
    request_callable = _requests_callable(request=request, session=session)
    call_kwargs = dict(request_kwargs)
    call_kwargs["headers"] = _headers_with_traceparent(headers, child_trace)
    if timeout is not None:
        call_kwargs["timeout"] = timeout
    route = _route_from_url(url, route_template)
    read_clock = clock or perf_counter
    start = read_clock()

    with use_logbrew_trace(child_trace):
        try:
            response = request_callable(method, url, **call_kwargs)
        except Exception as error:
            duration_ms = _duration_ms(start, read_clock)
            _capture_http_span(
                client,
                event_id,
                timestamp,
                child_trace,
                method_value,
                route,
                "error",
                duration_ms,
                metadata,
                _status_from_error(error),
                error,
                on_capture_error,
                "requests",
            )
            raise

    duration_ms = _duration_ms(start, read_clock)
    status_code = _status_from_response(response)
    span_status = "error" if status_code is not None and status_code >= 400 else "ok"
    _capture_http_span(
        client,
        event_id,
        timestamp,
        child_trace,
        method_value,
        route,
        span_status,
        duration_ms,
        metadata,
        status_code,
        None,
        on_capture_error,
        "requests",
    )
    return response


def _request_from_input(request: str | Request, data: bytes | None) -> Request:
    if isinstance(request, Request):
        if data is not None:
            return Request(
                request.full_url,
                data=data,
                headers=dict(request.header_items()),
                method=request.get_method(),
            )
        return request
    if isinstance(request, str):
        return Request(request, data=data)
    raise TypeError("request must be a URL string or urllib.request.Request")


def _child_trace(
    parent_trace: LogBrewTraceContext | None,
    span_id_factory: Callable[[], str] | None,
) -> LogBrewTraceContext:
    span_id = (span_id_factory or _default_span_id)().lower()
    _require_span_id(span_id)
    if parent_trace is None:
        return LogBrewTraceContext(
            trace_id=_default_trace_id(),
            span_id=span_id,
            sampled=False,
        )
    return LogBrewTraceContext(
        trace_id=parent_trace.trace_id,
        span_id=span_id,
        parent_span_id=parent_trace.span_id,
        sampled=parent_trace.sampled,
    )


def _clone_request_with_traceparent(request: Request, trace: LogBrewTraceContext) -> Request:
    headers = {
        name: value
        for name, value in request.header_items()
        if name.lower() != "traceparent"
    }
    headers["traceparent"] = (
        f"00-{trace.trace_id}-{trace.span_id}-{'01' if trace.sampled else '00'}"
    )
    return Request(
        request.full_url,
        data=getattr(request, "data", None),
        headers=headers,
        method=request.get_method(),
    )


def _call_urlopen(open_url: Callable[..., Any], request: Request, timeout: float | None) -> Any:
    if timeout is None:
        return open_url(request)
    return open_url(request, timeout=timeout)


def _capture_http_span(
    client: Any,
    event_id: str,
    timestamp: str | None,
    trace: LogBrewTraceContext,
    method: str,
    route: str,
    status: str,
    duration_ms: float,
    metadata: Mapping[str, Any] | None,
    status_code: int | None,
    error: Exception | None,
    on_capture_error: Callable[[Exception], None] | None,
    source: str,
) -> None:
    try:
        client.span(
            event_id,
            timestamp or _now_timestamp(),
            {
                "name": f"{method} {route}",
                "traceId": trace.trace_id,
                "spanId": trace.span_id,
                **({"parentSpanId": trace.parent_span_id} if trace.parent_span_id else {}),
                "status": status,
                "durationMs": duration_ms,
                "metadata": _span_metadata(
                    method=method,
                    route=route,
                    sampled=trace.sampled,
                    metadata=metadata,
                    status_code=status_code,
                    error=error,
                    source=source,
                ),
            },
        )
    except Exception as capture_error:
        if on_capture_error is not None:
            with suppress(Exception):
                on_capture_error(capture_error)


def _span_metadata(
    *,
    method: str,
    route: str,
    sampled: bool,
    metadata: Mapping[str, Any] | None,
    status_code: int | None,
    error: Exception | None,
    source: str,
) -> Metadata:
    span_metadata: Metadata = _compact_metadata(metadata)
    span_metadata.update(
        {
            "source": source,
            "routeTemplate": route,
            "method": method,
            "sampled": sampled,
        }
    )
    if status_code is not None:
        span_metadata["statusCode"] = status_code
    if error is not None:
        span_metadata["errorType"] = type(error).__name__
        span_metadata["errorMessage"] = str(error)
    return span_metadata


def _compact_metadata(metadata: Mapping[str, Any] | None) -> Metadata:
    if metadata is None:
        return {}
    return {
        key: value
        for key, value in metadata.items()
        if isinstance(key, str) and (isinstance(value, str | int | float | bool) or value is None)
    }


def _route_from_request(request: Request, route_template: str | None) -> str:
    candidate = route_template if route_template is not None else request.full_url
    return _route_from_url(candidate, None)


def _route_from_url(url: str, route_template: str | None) -> str:
    candidate = route_template if route_template is not None else url
    parsed = urlsplit(candidate)
    return parsed.path or "/"


def _status_from_response(response: Any) -> int | None:
    status = getattr(response, "status", None)
    if status is None:
        status = getattr(response, "status_code", None)
    if status is None:
        getcode = getattr(response, "getcode", None)
        if callable(getcode):
            status = getcode()
    return int(status) if isinstance(status, int) else None


def _status_from_error(error: Exception) -> int | None:
    if isinstance(error, HTTPError):
        return int(error.code)
    response = getattr(error, "response", None)
    if response is not None:
        return _status_from_response(response)
    return None


def _duration_ms(start: float, clock: Clock) -> float:
    return round(max((clock() - start) * 1000, 0), 3)


def _now_timestamp() -> str:
    return datetime.now(tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _default_trace_id() -> str:
    trace_id = uuid4().hex
    return "00000000000000000000000000000001" if trace_id == "0" * 32 else trace_id


def _default_span_id() -> str:
    span_id = uuid4().hex[:16]
    return "0000000000000001" if span_id == ZERO_SPAN_ID else span_id


def _require_span_id(span_id: str) -> None:
    if HEX16.fullmatch(span_id) is None or span_id == ZERO_SPAN_ID:
        raise ValueError("span_id_factory must return a non-zero 16-character hex span id")


def _method_name(method: str) -> str:
    if not isinstance(method, str) or not method.strip():
        raise TypeError("method must be a non-empty string")
    return method.upper()


def _require_url(url: str) -> None:
    if not isinstance(url, str) or not url.strip():
        raise TypeError("url must be a non-empty string")


def _headers_with_traceparent(headers: Mapping[str, str] | None, trace: LogBrewTraceContext) -> dict[str, str]:
    traced_headers = {
        name: value
        for name, value in (headers or {}).items()
        if isinstance(name, str) and name.lower() != "traceparent"
    }
    traced_headers["traceparent"] = (
        f"00-{trace.trace_id}-{trace.span_id}-{'01' if trace.sampled else '00'}"
    )
    return traced_headers


def _requests_callable(
    *,
    request: Callable[..., Any] | None,
    session: Any | None,
) -> Callable[..., Any]:
    if request is not None and session is not None:
        raise TypeError("pass either request or session, not both")
    if request is not None:
        return request
    if session is not None:
        session_request = getattr(session, "request", None)
        if not callable(session_request):
            raise TypeError("session must expose a callable request method")
        return cast("Callable[..., Any]", session_request)
    try:
        requests_request = cast("Callable[..., Any]", import_module("requests").request)
    except ImportError as error:
        raise ImportError(
            "requests_request_with_logbrew_span requires requests to be installed or a request callable/session"
        ) from error
    if not callable(requests_request):
        raise TypeError("requests.request must be callable")
    return requests_request
