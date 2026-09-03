"""Explicit outbound HTTP span helpers for app-owned Python HTTP calls."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass
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
    route = _route_from_url(traced_request.full_url, route_template)
    open_callable = open_url or urlopen
    read_clock = clock or perf_counter
    start = read_clock()
    capture = _HttpSpanCapture(
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        trace=child_trace,
        method=method,
        route=route,
        metadata=metadata,
        on_capture_error=on_capture_error,
        source="urllib.request",
        clock=read_clock,
        start=start,
    )

    with use_logbrew_trace(child_trace):
        try:
            response = _call_urlopen(open_callable, traced_request, timeout)
        except Exception as error:
            capture.failed(error)
            raise

    duration_ms = _instrumentation.duration_ms(start, read_clock)
    status_code = _status_from_response(response)
    span_status = "error" if status_code is not None and status_code >= 400 else "ok"
    capture.record(span_status, duration_ms, status_code, None)
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

    return _request_with_logbrew_span(
        method,
        url,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        request_callable=_default_request_callable(request=request, session=session, dependency="requests"),
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

    return _request_with_logbrew_span(
        method,
        url,
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        request_callable=_default_request_callable(request=request, session=session, dependency="httpx"),
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

    return await _request_with_logbrew_span(
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
        asynchronous=True,
    )


async def aiohttp_request_with_logbrew_span(
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
    """Run a caller-owned async ``aiohttp`` request under a LogBrew child span."""

    return await _request_with_logbrew_span(
        method,
        str(url),
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        request_callable=_aiohttp_callable(request=request, session=session),
        headers=headers,
        timeout=timeout,
        trace=trace,
        route_template=route_template,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock,
        on_capture_error=on_capture_error,
        source="aiohttp",
        request_kwargs=request_kwargs,
        asynchronous=True,
    )


def _request_with_logbrew_span(
    method: str,
    url: str,
    *,
    client: Any,
    event_id: str,
    timestamp: str | None,
    request_callable: RequestCallable | AsyncRequestCallable,
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
    asynchronous: bool = False,
) -> Any:
    method_value = _method_name(method)
    _require_url(url)
    parent_trace = trace if trace is not None else get_active_logbrew_trace()
    child_trace = _instrumentation.child_trace(parent_trace, span_id_factory)
    call_kwargs = _outbound_request_kwargs(request_kwargs, headers, timeout, child_trace)
    route = _route_from_url(url, route_template)
    read_clock = clock or perf_counter
    start = read_clock()
    capture = _HttpSpanCapture(
        client=client,
        event_id=event_id,
        timestamp=timestamp,
        trace=child_trace,
        method=method_value,
        route=route,
        metadata=metadata,
        on_capture_error=on_capture_error,
        source=source,
        clock=read_clock,
        start=start,
    )

    async def async_request() -> Any:
        with use_logbrew_trace(child_trace):
            try:
                response = await request_callable(method, url, **call_kwargs)
            except Exception as error:
                capture.failed(error)
                raise
        capture.successful(response)
        return response

    if asynchronous:
        return async_request()

    with use_logbrew_trace(child_trace):
        try:
            response = request_callable(method, url, **call_kwargs)
        except Exception as error:
            capture.failed(error)
            raise

    capture.successful(response)
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
    return Request(
        request.full_url,
        data=getattr(request, "data", None),
        headers=_headers_with_traceparent(dict(request.header_items()), trace),
        method=request.get_method(),
    )


def _call_urlopen(open_url: Callable[..., Any], request: Request, timeout: float | None) -> Any:
    if timeout is None:
        return open_url(request)
    return open_url(request, timeout=timeout)


@dataclass(slots=True)
class _HttpSpanCapture:
    client: Any
    event_id: str
    timestamp: str | None
    trace: LogBrewTraceContext
    method: str
    route: str
    metadata: Mapping[str, Any] | None
    on_capture_error: Callable[[Exception], None] | None
    source: str
    clock: _instrumentation.Clock
    start: float

    def failed(self, error: Exception) -> None:
        duration_ms = _instrumentation.duration_ms(self.start, self.clock)
        self.record("error", duration_ms, _status_from_error(error), error)

    def successful(self, response: Any) -> None:
        status_code = _status_from_response(response)
        status = "error" if status_code is not None and status_code >= 400 else "ok"
        self.record(status, _instrumentation.duration_ms(self.start, self.clock), status_code, None)

    def record(
        self, status: str, duration_ms: float, status_code: int | None, error: Exception | None,
    ) -> None:
        try:
            _instrumentation.capture_client_span(
                client=self.client,
                event_id=self.event_id,
                timestamp=self.timestamp or _instrumentation.now_timestamp(),
                trace=self.trace,
                name=f"{self.method} {self.route}",
                status=status,
                duration_ms=duration_ms,
                metadata=_span_metadata(
                    method=self.method,
                    route=self.route,
                    sampled=self.trace.sampled,
                    metadata=self.metadata,
                    status_code=status_code,
                    error=error,
                    source=self.source,
                ),
                on_capture_error=self.on_capture_error,
            )
        except Exception as capture_error:
            if self.on_capture_error is not None:
                with suppress(Exception):
                    self.on_capture_error(capture_error)


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
    return span_metadata


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
    return _status_from_response(error)


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


def _default_request_callable(
    *,
    request: Callable[..., Any] | None,
    session: Any | None,
    dependency: str,
) -> RequestCallable:
    if request is not None or session is not None:
        return _single_request_callable(request=request, session=session, dependency=dependency)
    try:
        default_request = cast("RequestCallable", import_module(dependency).request)
    except ImportError as error:
        raise ImportError(
            f"{dependency}_request_with_logbrew_span requires {dependency} to be installed "
            "or a request callable/session"
        ) from error
    if not callable(default_request):
        raise TypeError(f"{dependency}.request must be callable")
    return default_request


def _async_httpx_callable(
    *,
    request: Callable[..., Awaitable[Any]] | None,
    session: Any | None,
) -> AsyncRequestCallable:
    if request is not None or session is not None:
        return cast(
            "AsyncRequestCallable",
            _single_request_callable(request=request, session=session, dependency="httpx"),
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


def _aiohttp_callable(
    *,
    request: Callable[..., Awaitable[Any]] | None,
    session: Any | None,
) -> AsyncRequestCallable:
    if request is not None:
        return cast(
            "AsyncRequestCallable",
            _single_request_callable(request=request, session=session, dependency="aiohttp"),
        )
    if session is not None:
        session_request = getattr(session, "_request", None)
        if not callable(session_request):
            raise TypeError("aiohttp session must expose a callable _request method")
        return cast("AsyncRequestCallable", session_request)
    raise TypeError("aiohttp_request_with_logbrew_span requires a request callable or session")


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
