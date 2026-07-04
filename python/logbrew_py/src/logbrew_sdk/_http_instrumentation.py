"""Reversible per-client HTTP instrumentation for app-owned Python clients."""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from contextlib import suppress
from time import perf_counter
from typing import Any, TypeAlias, cast
from uuid import uuid4

from logbrew_sdk import _instrumentation
from logbrew_sdk._http_client import (
    AsyncRequestCallable,
    RequestCallable,
    aiohttp_request_with_logbrew_span,
    async_httpx_request_with_logbrew_span,
    httpx_request_with_logbrew_span,
    requests_request_with_logbrew_span,
)
from logbrew_sdk._trace_context import LogBrewTraceContext

RouteTemplateResolver: TypeAlias = Callable[[str, str], str | None]

_REQUESTS_INSTRUMENTATION_ATTR = "_logbrew_requests_session_instrumentation"
_HTTPX_INSTRUMENTATION_ATTR = "_logbrew_httpx_client_instrumentation"
_AIOHTTP_INSTRUMENTATION_ATTR = "_logbrew_aiohttp_client_session_instrumentation"
_REQUESTS_INSTRUMENTATIONS_BY_ID: dict[int, LogBrewRequestsSessionInstrumentation] = {}
_HTTPX_INSTRUMENTATIONS_BY_ID: dict[int, LogBrewHttpxClientInstrumentation] = {}
_AIOHTTP_INSTRUMENTATIONS_BY_ID: dict[int, LogBrewAiohttpClientSessionInstrumentation] = {}


def instrument_requests_session_with_logbrew_spans(
    session: Any,
    *,
    client: Any,
    event_id_factory: Callable[[], str] | None = None,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    route_template_resolver: RouteTemplateResolver | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewRequestsSessionInstrumentation:
    """Wrap one caller-owned ``requests.Session``-style object with LogBrew spans."""

    request = getattr(session, "request", None)
    if not callable(request):
        raise TypeError("session must expose a callable request method")

    existing = _existing_requests_instrumentation(session)
    if existing is not None and existing.installed:
        return existing

    instrumentation = LogBrewRequestsSessionInstrumentation(
        session=session,
        request=request,
        client=client,
        event_id_factory=event_id_factory or _default_requests_event_id,
        timestamp=timestamp,
        trace=trace,
        route_template_resolver=route_template_resolver,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _remember_requests_instrumentation(session, instrumentation)
    return instrumentation


def instrument_httpx_client_with_logbrew_spans(
    httpx_client: Any,
    *,
    client: Any,
    event_id_factory: Callable[[], str] | None = None,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    route_template_resolver: RouteTemplateResolver | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewHttpxClientInstrumentation:
    """Wrap one caller-owned sync or async ``httpx`` client with LogBrew spans."""

    request = getattr(httpx_client, "request", None)
    if not callable(request):
        raise TypeError("httpx_client must expose a callable request method")

    existing = _existing_httpx_instrumentation(httpx_client)
    if existing is not None and existing.installed:
        return existing

    instrumentation = LogBrewHttpxClientInstrumentation(
        httpx_client=httpx_client,
        request=request,
        is_async=inspect.iscoroutinefunction(request),
        client=client,
        event_id_factory=event_id_factory or _default_httpx_event_id,
        timestamp=timestamp,
        trace=trace,
        route_template_resolver=route_template_resolver,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _remember_httpx_instrumentation(httpx_client, instrumentation)
    return instrumentation


def instrument_aiohttp_client_session_with_logbrew_spans(
    session: Any,
    *,
    client: Any,
    event_id_factory: Callable[[], str] | None = None,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    route_template_resolver: RouteTemplateResolver | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewAiohttpClientSessionInstrumentation:
    """Wrap one caller-owned ``aiohttp.ClientSession``-style object with LogBrew spans."""

    request = getattr(session, "_request", None)
    if not callable(request):
        raise TypeError("session must expose a callable _request method")

    existing = _existing_aiohttp_instrumentation(session)
    if existing is not None and existing.installed:
        return existing

    instrumentation = LogBrewAiohttpClientSessionInstrumentation(
        session=session,
        request=cast("AsyncRequestCallable", request),
        client=client,
        event_id_factory=event_id_factory or _default_aiohttp_event_id,
        timestamp=timestamp,
        trace=trace,
        route_template_resolver=route_template_resolver,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _remember_aiohttp_instrumentation(session, instrumentation)
    return instrumentation


class LogBrewRequestsSessionInstrumentation:
    """Reversible instrumentation for one caller-owned requests-style session."""

    def __init__(
        self,
        *,
        session: Any,
        request: RequestCallable,
        client: Any,
        event_id_factory: Callable[[], str],
        timestamp: str | None,
        trace: LogBrewTraceContext | None,
        route_template_resolver: RouteTemplateResolver | None,
        metadata: Mapping[str, Any] | None,
        span_id_factory: Callable[[], str] | None,
        clock: _instrumentation.Clock,
        on_capture_error: Callable[[Exception], None] | None,
    ) -> None:
        self.session = session
        self._request = request
        self._client = client
        self._event_id_factory = event_id_factory
        self._timestamp = timestamp
        self._trace = trace
        self._route_template_resolver = route_template_resolver
        self._metadata = metadata
        self._span_id_factory = span_id_factory
        self._clock = clock
        self._on_capture_error = on_capture_error
        self._installed = False

    @property
    def installed(self) -> bool:
        """Return whether the session instance is currently wrapped."""

        return self._installed

    def install(self) -> None:
        """Wrap the caller-owned session's request method."""

        if self._installed:
            return
        self.session.request = self._wrap_request()
        self._installed = True

    def uninstall(self) -> Any:
        """Put back the original session request method and return the session."""

        if self._installed:
            with suppress(Exception):
                self.session.request = self._request
            self._installed = False
        _forget_requests_instrumentation(self.session, self)
        return self.session

    def _wrap_request(self) -> RequestCallable:
        def request(method: str, url: str, **kwargs: Any) -> Any:
            call_kwargs = dict(kwargs)
            route_template = _resolved_route_template(
                self._route_template_resolver,
                method,
                url,
            )
            return requests_request_with_logbrew_span(
                method,
                url,
                client=self._client,
                event_id=self._event_id_factory(),
                timestamp=self._timestamp,
                request=self._request,
                headers=call_kwargs.pop("headers", None),
                timeout=call_kwargs.pop("timeout", None),
                trace=self._trace,
                route_template=route_template,
                metadata=self._metadata,
                span_id_factory=self._span_id_factory,
                clock=self._clock,
                on_capture_error=self._on_capture_error,
                **call_kwargs,
            )

        return request


class LogBrewHttpxClientInstrumentation:
    """Reversible instrumentation for one caller-owned sync or async httpx client."""

    def __init__(
        self,
        *,
        httpx_client: Any,
        request: RequestCallable | AsyncRequestCallable,
        is_async: bool,
        client: Any,
        event_id_factory: Callable[[], str],
        timestamp: str | None,
        trace: LogBrewTraceContext | None,
        route_template_resolver: RouteTemplateResolver | None,
        metadata: Mapping[str, Any] | None,
        span_id_factory: Callable[[], str] | None,
        clock: _instrumentation.Clock,
        on_capture_error: Callable[[Exception], None] | None,
    ) -> None:
        self.httpx_client = httpx_client
        self._request = request
        self._is_async = is_async
        self._client = client
        self._event_id_factory = event_id_factory
        self._timestamp = timestamp
        self._trace = trace
        self._route_template_resolver = route_template_resolver
        self._metadata = metadata
        self._span_id_factory = span_id_factory
        self._clock = clock
        self._on_capture_error = on_capture_error
        self._installed = False

    @property
    def installed(self) -> bool:
        """Return whether the httpx client instance is currently wrapped."""

        return self._installed

    def install(self) -> None:
        """Wrap the caller-owned httpx client's request method."""

        if self._installed:
            return
        self.httpx_client.request = (
            self._wrap_async_request() if self._is_async else self._wrap_sync_request()
        )
        self._installed = True

    def uninstall(self) -> Any:
        """Put back the original httpx request method and return the client."""

        if self._installed:
            with suppress(Exception):
                self.httpx_client.request = self._request
            self._installed = False
        _forget_httpx_instrumentation(self.httpx_client, self)
        return self.httpx_client

    def _wrap_sync_request(self) -> RequestCallable:
        def request(method: str, url: str, **kwargs: Any) -> Any:
            call_kwargs = dict(kwargs)
            route_template = _resolved_route_template(
                self._route_template_resolver,
                method,
                url,
            )
            return httpx_request_with_logbrew_span(
                method,
                url,
                client=self._client,
                event_id=self._event_id_factory(),
                timestamp=self._timestamp,
                request=cast("RequestCallable", self._request),
                headers=call_kwargs.pop("headers", None),
                timeout=call_kwargs.pop("timeout", None),
                trace=self._trace,
                route_template=route_template,
                metadata=self._metadata,
                span_id_factory=self._span_id_factory,
                clock=self._clock,
                on_capture_error=self._on_capture_error,
                **call_kwargs,
            )

        return request

    def _wrap_async_request(self) -> AsyncRequestCallable:
        async def request(method: str, url: str, **kwargs: Any) -> Any:
            call_kwargs = dict(kwargs)
            route_template = _resolved_route_template(
                self._route_template_resolver,
                method,
                url,
            )
            return await async_httpx_request_with_logbrew_span(
                method,
                url,
                client=self._client,
                event_id=self._event_id_factory(),
                timestamp=self._timestamp,
                request=cast("AsyncRequestCallable", self._request),
                headers=call_kwargs.pop("headers", None),
                timeout=call_kwargs.pop("timeout", None),
                trace=self._trace,
                route_template=route_template,
                metadata=self._metadata,
                span_id_factory=self._span_id_factory,
                clock=self._clock,
                on_capture_error=self._on_capture_error,
                **call_kwargs,
            )

        return request


class LogBrewAiohttpClientSessionInstrumentation:
    """Reversible instrumentation for one caller-owned aiohttp-style client session."""

    def __init__(
        self,
        *,
        session: Any,
        request: AsyncRequestCallable,
        client: Any,
        event_id_factory: Callable[[], str],
        timestamp: str | None,
        trace: LogBrewTraceContext | None,
        route_template_resolver: RouteTemplateResolver | None,
        metadata: Mapping[str, Any] | None,
        span_id_factory: Callable[[], str] | None,
        clock: _instrumentation.Clock,
        on_capture_error: Callable[[Exception], None] | None,
    ) -> None:
        self.session = session
        self._request = request
        self._client = client
        self._event_id_factory = event_id_factory
        self._timestamp = timestamp
        self._trace = trace
        self._route_template_resolver = route_template_resolver
        self._metadata = metadata
        self._span_id_factory = span_id_factory
        self._clock = clock
        self._on_capture_error = on_capture_error
        self._installed = False

    @property
    def installed(self) -> bool:
        """Return whether the aiohttp client session instance is currently wrapped."""

        return self._installed

    def install(self) -> None:
        """Wrap the caller-owned aiohttp client's private request coroutine."""

        if self._installed:
            return
        self.session._request = self._wrap_request()
        self._installed = True

    def uninstall(self) -> Any:
        """Put back the original aiohttp request coroutine and return the session."""

        if self._installed:
            with suppress(Exception):
                self.session._request = self._request
            self._installed = False
        _forget_aiohttp_instrumentation(self.session, self)
        return self.session

    def _wrap_request(self) -> AsyncRequestCallable:
        async def request(method: str, url: str, **kwargs: Any) -> Any:
            call_kwargs = dict(kwargs)
            route_template = _resolved_route_template(
                self._route_template_resolver,
                method,
                str(url),
            )
            return await aiohttp_request_with_logbrew_span(
                method,
                str(url),
                client=self._client,
                event_id=self._event_id_factory(),
                timestamp=self._timestamp,
                request=self._request,
                headers=call_kwargs.pop("headers", None),
                timeout=call_kwargs.pop("timeout", None),
                trace=self._trace,
                route_template=route_template,
                metadata=self._metadata,
                span_id_factory=self._span_id_factory,
                clock=self._clock,
                on_capture_error=self._on_capture_error,
                **call_kwargs,
            )

        return request


def _resolved_route_template(
    resolver: RouteTemplateResolver | None,
    method: str,
    url: str,
) -> str | None:
    if resolver is None:
        return None
    route_template = resolver(_method_name(method), url)
    if route_template is None:
        return None
    if not isinstance(route_template, str):
        raise TypeError("route_template_resolver must return a string or None")
    return route_template


def _method_name(method: str) -> str:
    if not isinstance(method, str) or not method.strip():
        raise TypeError("method must be a non-empty string")
    return method.upper()


def _existing_requests_instrumentation(session: Any) -> LogBrewRequestsSessionInstrumentation | None:
    instrumentation = getattr(session, _REQUESTS_INSTRUMENTATION_ATTR, None)
    if isinstance(instrumentation, LogBrewRequestsSessionInstrumentation):
        return instrumentation
    return _REQUESTS_INSTRUMENTATIONS_BY_ID.get(id(session))


def _remember_requests_instrumentation(
    session: Any,
    instrumentation: LogBrewRequestsSessionInstrumentation,
) -> None:
    with suppress(Exception):
        setattr(session, _REQUESTS_INSTRUMENTATION_ATTR, instrumentation)
    _REQUESTS_INSTRUMENTATIONS_BY_ID[id(session)] = instrumentation


def _forget_requests_instrumentation(
    session: Any,
    instrumentation: LogBrewRequestsSessionInstrumentation,
) -> None:
    with suppress(Exception):
        if getattr(session, _REQUESTS_INSTRUMENTATION_ATTR, None) is instrumentation:
            delattr(session, _REQUESTS_INSTRUMENTATION_ATTR)
    if _REQUESTS_INSTRUMENTATIONS_BY_ID.get(id(session)) is instrumentation:
        del _REQUESTS_INSTRUMENTATIONS_BY_ID[id(session)]


def _existing_httpx_instrumentation(httpx_client: Any) -> LogBrewHttpxClientInstrumentation | None:
    instrumentation = getattr(httpx_client, _HTTPX_INSTRUMENTATION_ATTR, None)
    if isinstance(instrumentation, LogBrewHttpxClientInstrumentation):
        return instrumentation
    return _HTTPX_INSTRUMENTATIONS_BY_ID.get(id(httpx_client))


def _remember_httpx_instrumentation(
    httpx_client: Any,
    instrumentation: LogBrewHttpxClientInstrumentation,
) -> None:
    with suppress(Exception):
        setattr(httpx_client, _HTTPX_INSTRUMENTATION_ATTR, instrumentation)
    _HTTPX_INSTRUMENTATIONS_BY_ID[id(httpx_client)] = instrumentation


def _forget_httpx_instrumentation(
    httpx_client: Any,
    instrumentation: LogBrewHttpxClientInstrumentation,
) -> None:
    with suppress(Exception):
        if getattr(httpx_client, _HTTPX_INSTRUMENTATION_ATTR, None) is instrumentation:
            delattr(httpx_client, _HTTPX_INSTRUMENTATION_ATTR)
    if _HTTPX_INSTRUMENTATIONS_BY_ID.get(id(httpx_client)) is instrumentation:
        del _HTTPX_INSTRUMENTATIONS_BY_ID[id(httpx_client)]


def _existing_aiohttp_instrumentation(session: Any) -> LogBrewAiohttpClientSessionInstrumentation | None:
    instrumentation = getattr(session, _AIOHTTP_INSTRUMENTATION_ATTR, None)
    if isinstance(instrumentation, LogBrewAiohttpClientSessionInstrumentation):
        return instrumentation
    return _AIOHTTP_INSTRUMENTATIONS_BY_ID.get(id(session))


def _remember_aiohttp_instrumentation(
    session: Any,
    instrumentation: LogBrewAiohttpClientSessionInstrumentation,
) -> None:
    with suppress(Exception):
        setattr(session, _AIOHTTP_INSTRUMENTATION_ATTR, instrumentation)
    _AIOHTTP_INSTRUMENTATIONS_BY_ID[id(session)] = instrumentation


def _forget_aiohttp_instrumentation(
    session: Any,
    instrumentation: LogBrewAiohttpClientSessionInstrumentation,
) -> None:
    with suppress(Exception):
        if getattr(session, _AIOHTTP_INSTRUMENTATION_ATTR, None) is instrumentation:
            delattr(session, _AIOHTTP_INSTRUMENTATION_ATTR)
    if _AIOHTTP_INSTRUMENTATIONS_BY_ID.get(id(session)) is instrumentation:
        del _AIOHTTP_INSTRUMENTATIONS_BY_ID[id(session)]


def _default_requests_event_id() -> str:
    return f"evt_python_requests_{uuid4().hex}"


def _default_httpx_event_id() -> str:
    return f"evt_python_httpx_{uuid4().hex}"


def _default_aiohttp_event_id() -> str:
    return f"evt_python_aiohttp_{uuid4().hex}"
