"""Explicit outbound HTTP span helpers for app-owned Python HTTP calls."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from importlib import import_module
from time import perf_counter
from typing import Any, TypeAlias, cast
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from logbrew_sdk import _instrumentation
from logbrew_sdk._trace_context import (
    LogBrewTraceContext,
    get_active_logbrew_trace,
    use_logbrew_trace,
)

RequestCallable: TypeAlias = Callable[..., Any]
AsyncRequestCallable: TypeAlias = Callable[..., Awaitable[Any]]


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
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> Any:
    """Run ``urllib.request.urlopen`` under a LogBrew child span and W3C trace header."""

    parent_trace = trace if trace is not None else get_active_logbrew_trace()
    child_trace = _instrumentation.child_trace(parent_trace, span_id_factory)
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
            duration_ms = _instrumentation.duration_ms(start, read_clock)
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

    duration_ms = _instrumentation.duration_ms(start, read_clock)
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
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
    **request_kwargs: Any,
) -> Any:
    """Run a caller-owned ``requests`` call under a LogBrew child span and W3C trace header."""

    return _sync_request_with_logbrew_span(
        method,
        url,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        request_callable=_requests_callable(request=request, session=session),
        headers=headers,
        timeout=timeout,
        trace=trace,
        route_template=route_template,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock,
        on_capture_error=on_capture_error,
        source="requests",
        request_kwargs=request_kwargs,
    )


def httpx_request_with_logbrew_span(
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
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
    **request_kwargs: Any,
) -> Any:
    """Run a caller-owned sync ``httpx`` request under a LogBrew child span."""

    return _sync_request_with_logbrew_span(
        method,
        url,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        request_callable=_httpx_callable(request=request, session=session),
        headers=headers,
        timeout=timeout,
        trace=trace,
        route_template=route_template,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock,
        on_capture_error=on_capture_error,
        source="httpx",
        request_kwargs=request_kwargs,
    )


async def async_httpx_request_with_logbrew_span(
    method: str,
    url: str,
    *,
    client: Any,
    event_id: str,
    timestamp: str | None = None,
    request: Callable[..., Awaitable[Any]] | None = None,
    session: Any | None = None,
    headers: Mapping[str, str] | None = None,
    timeout: Any | None = None,
    trace: LogBrewTraceContext | None = None,
    route_template: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
    **request_kwargs: Any,
) -> Any:
    """Run a caller-owned async ``httpx`` request under a LogBrew child span."""

    return await _async_request_with_logbrew_span(
        method,
        url,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        request_callable=_async_httpx_callable(request=request, session=session),
        headers=headers,
        timeout=timeout,
        trace=trace,
        route_template=route_template,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock,
        on_capture_error=on_capture_error,
        source="httpx.async",
        request_kwargs=request_kwargs,
    )


def _sync_request_with_logbrew_span(
    method: str,
    url: str,
    *,
    client: Any,
    event_id: str,
    timestamp: str | None,
    request_callable: RequestCallable,
    headers: Mapping[str, str] | None,
    timeout: Any | None,
    trace: LogBrewTraceContext | None,
    route_template: str | None,
    metadata: Mapping[str, Any] | None,
    span_id_factory: Callable[[], str] | None,
    clock: _instrumentation.Clock | None,
    on_capture_error: Callable[[Exception], None] | None,
    source: str,
    request_kwargs: Mapping[str, Any],
) -> Any:
    method_value = _method_name(method)
    _require_url(url)
    parent_trace = trace if trace is not None else get_active_logbrew_trace()
    child_trace = _instrumentation.child_trace(parent_trace, span_id_factory)
    call_kwargs = _outbound_request_kwargs(request_kwargs, headers, timeout, child_trace)
    route = _route_from_url(url, route_template)
    read_clock = clock or perf_counter
    start = read_clock()

    with use_logbrew_trace(child_trace):
        try:
            response = request_callable(method, url, **call_kwargs)
        except Exception as error:
            _capture_failed_http_span(
                client,
                event_id,
                timestamp,
                child_trace,
                method_value,
                route,
                start,
                read_clock,
                metadata,
                error,
                on_capture_error,
                source,
            )
            raise

    _capture_successful_http_span(
        client,
        event_id,
        timestamp,
        child_trace,
        method_value,
        route,
        start,
        read_clock,
        metadata,
        response,
        on_capture_error,
        source,
    )
    return response


async def _async_request_with_logbrew_span(
    method: str,
    url: str,
    *,
    client: Any,
    event_id: str,
    timestamp: str | None,
    request_callable: AsyncRequestCallable,
    headers: Mapping[str, str] | None,
    timeout: Any | None,
    trace: LogBrewTraceContext | None,
    route_template: str | None,
    metadata: Mapping[str, Any] | None,
    span_id_factory: Callable[[], str] | None,
    clock: _instrumentation.Clock | None,
    on_capture_error: Callable[[Exception], None] | None,
    source: str,
    request_kwargs: Mapping[str, Any],
) -> Any:
    method_value = _method_name(method)
    _require_url(url)
    parent_trace = trace if trace is not None else get_active_logbrew_trace()
    child_trace = _instrumentation.child_trace(parent_trace, span_id_factory)
    call_kwargs = _outbound_request_kwargs(request_kwargs, headers, timeout, child_trace)
    route = _route_from_url(url, route_template)
    read_clock = clock or perf_counter
    start = read_clock()

    with use_logbrew_trace(child_trace):
        try:
            response = await request_callable(method, url, **call_kwargs)
        except Exception as error:
            _capture_failed_http_span(
                client,
                event_id,
                timestamp,
                child_trace,
                method_value,
                route,
                start,
                read_clock,
                metadata,
                error,
                on_capture_error,
                source,
            )
            raise

    _capture_successful_http_span(
        client,
        event_id,
        timestamp,
        child_trace,
        method_value,
        route,
        start,
        read_clock,
        metadata,
        response,
        on_capture_error,
        source,
    )
    return response


def _outbound_request_kwargs(
    request_kwargs: Mapping[str, Any],
    headers: Mapping[str, str] | None,
    timeout: Any | None,
    trace: LogBrewTraceContext,
) -> dict[str, Any]:
    call_kwargs = dict(request_kwargs)
    call_kwargs["headers"] = _headers_with_traceparent(headers, trace)
    if timeout is not None:
        call_kwargs["timeout"] = timeout
    return call_kwargs


def _capture_failed_http_span(
    client: Any,
    event_id: str,
    timestamp: str | None,
    trace: LogBrewTraceContext,
    method: str,
    route: str,
    start: float,
    clock: _instrumentation.Clock,
    metadata: Mapping[str, Any] | None,
    error: Exception,
    on_capture_error: Callable[[Exception], None] | None,
    source: str,
) -> None:
    _capture_http_span(
        client,
        event_id,
        timestamp,
        trace,
        method,
        route,
        "error",
                _instrumentation.duration_ms(start, clock),
        metadata,
        _status_from_error(error),
        error,
        on_capture_error,
        source,
    )


def _capture_successful_http_span(
    client: Any,
    event_id: str,
    timestamp: str | None,
    trace: LogBrewTraceContext,
    method: str,
    route: str,
    start: float,
    clock: _instrumentation.Clock,
    metadata: Mapping[str, Any] | None,
    response: Any,
    on_capture_error: Callable[[Exception], None] | None,
    source: str,
) -> None:
    status_code = _status_from_response(response)
    span_status = "error" if status_code is not None and status_code >= 400 else "ok"
    _capture_http_span(
        client,
        event_id,
        timestamp,
        trace,
        method,
        route,
        span_status,
        _instrumentation.duration_ms(start, clock),
        metadata,
        status_code,
        None,
        on_capture_error,
        source,
    )


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
            timestamp or _instrumentation.now_timestamp(),
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
) -> _instrumentation.Metadata:
    span_metadata = _instrumentation.compact_metadata(metadata)
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
) -> RequestCallable:
    if request is not None or session is not None:
        return _single_request_callable(request=request, session=session, dependency="requests")
    try:
        requests_request = cast("RequestCallable", import_module("requests").request)
    except ImportError as error:
        raise ImportError(
            "requests_request_with_logbrew_span requires requests to be installed or a request callable/session"
        ) from error
    if not callable(requests_request):
        raise TypeError("requests.request must be callable")
    return requests_request


def _httpx_callable(
    *,
    request: Callable[..., Any] | None,
    session: Any | None,
) -> RequestCallable:
    if request is not None or session is not None:
        return _single_request_callable(request=request, session=session, dependency="httpx")
    try:
        httpx_request = cast("RequestCallable", import_module("httpx").request)
    except ImportError as error:
        raise ImportError(
            "httpx_request_with_logbrew_span requires httpx to be installed or a request callable/session"
        ) from error
    if not callable(httpx_request):
        raise TypeError("httpx.request must be callable")
    return httpx_request


def _async_httpx_callable(
    *,
    request: Callable[..., Awaitable[Any]] | None,
    session: Any | None,
) -> AsyncRequestCallable:
    if request is not None:
        return cast(
            "AsyncRequestCallable",
            _single_request_callable(request=request, session=session, dependency="httpx"),
        )
    if session is not None:
        return cast(
            "AsyncRequestCallable",
            _single_request_callable(request=None, session=session, dependency="httpx"),
        )

    async def default_async_request(method: str, url: str, **kwargs: Any) -> Any:
        try:
            async_client_type = import_module("httpx").AsyncClient
        except ImportError as error:
            raise ImportError(
                "async_httpx_request_with_logbrew_span requires httpx to be installed or "
                "an async request callable/session"
            ) from error
        async with async_client_type() as async_client:
            return await async_client.request(method, url, **kwargs)

    return default_async_request


def _single_request_callable(
    *,
    request: Callable[..., Any] | None,
    session: Any | None,
    dependency: str,
) -> RequestCallable:
    if request is not None and session is not None:
        raise TypeError("pass either request or session, not both")
    if request is not None:
        return request
    if session is not None:
        session_request = getattr(session, "request", None)
        if not callable(session_request):
            raise TypeError(f"{dependency} session must expose a callable request method")
        return cast("RequestCallable", session_request)
    raise TypeError("request or session is required")
