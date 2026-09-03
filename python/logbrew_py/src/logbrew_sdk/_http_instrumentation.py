"""Reversible per-client HTTP instrumentation for app-owned Python clients."""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from contextlib import suppress
from time import perf_counter
from typing import Any, Generic, TypeAlias, TypeVar, cast
from uuid import uuid4

from logbrew_sdk import _instrumentation
from logbrew_sdk._http_client import (
    AsyncRequestCallable,
    RequestCallable,
    _method_name,
    aiohttp_request_with_logbrew_span,
    async_httpx_request_with_logbrew_span,
    httpx_request_with_logbrew_span,
    requests_request_with_logbrew_span,
)
from logbrew_sdk._trace_context import LogBrewTraceContext

RouteTemplateResolver: TypeAlias = Callable[[str, str], str | None]

_Instrumentation = TypeVar("_Instrumentation")
_Request = TypeVar("_Request", bound=Callable[..., Any])


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

    existing = _REQUESTS_REGISTRY.get(session)
    if existing is not None and existing.installed:
        return existing

    instrumentation = LogBrewRequestsSessionInstrumentation(
        session=session,
        request=request,
        client=client,
        event_id_factory=event_id_factory or (lambda: f"evt_python_requests_{uuid4().hex}"),
        timestamp=timestamp,
        trace=trace,
        route_template_resolver=route_template_resolver,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _REQUESTS_REGISTRY.remember(session, instrumentation)
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

    existing = _HTTPX_REGISTRY.get(httpx_client)
    if existing is not None and existing.installed:
        return existing

    instrumentation = LogBrewHttpxClientInstrumentation(
        httpx_client=httpx_client,
        request=request,
        is_async=inspect.iscoroutinefunction(request),
        client=client,
        event_id_factory=event_id_factory or (lambda: f"evt_python_httpx_{uuid4().hex}"),
        timestamp=timestamp,
        trace=trace,
        route_template_resolver=route_template_resolver,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _HTTPX_REGISTRY.remember(httpx_client, instrumentation)
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

    existing = _AIOHTTP_REGISTRY.get(session)
    if existing is not None and existing.installed:
        return existing

    instrumentation = LogBrewAiohttpClientSessionInstrumentation(
        session=session,
        request=cast("AsyncRequestCallable", request),
        client=client,
        event_id_factory=event_id_factory or (lambda: f"evt_python_aiohttp_{uuid4().hex}"),
        timestamp=timestamp,
        trace=trace,
        route_template_resolver=route_template_resolver,
        metadata=metadata,
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _AIOHTTP_REGISTRY.remember(session, instrumentation)
    return instrumentation


class _HttpClientInstrumentation(Generic[_Request]):
    """Share per-client request capture and ownership-aware installation."""

    _request_method = "request"
    _is_async = False
    _stringify_url = False
    _span_helper: Callable[..., Any]
    _registry: _InstrumentationRegistry[Any]

    def __init__(
        self,
        *,
        session: Any,
        request: _Request,
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
        self._restore_request = _instrumentation.patch_instance_attributes(
            self.session, {self._request_method: self._wrap_request()},
        )
        self._installed = True

    def uninstall(self) -> Any:
        """Put back the original session request method and return the session."""

        if self._installed:
            with suppress(Exception):
                self._restore_request()
            self._installed = False
        self._registry.forget(self.session, self)
        return self.session

    def _wrap_request(self) -> RequestCallable:
        def request(method: str, url: str, **kwargs: Any) -> Any:
            return self._call(method, url, kwargs)

        async def async_request(method: str, url: str, **kwargs: Any) -> Any:
            return await self._call(method, url, kwargs)

        return async_request if self._is_async else request

    def _call(self, method: str, url: str, kwargs: Mapping[str, Any]) -> Any:
        call_kwargs = dict(kwargs)
        url = str(url) if self._stringify_url else url
        route_template = _resolved_route_template(self._route_template_resolver, method, url)
        return self._span_helper(
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


class LogBrewRequestsSessionInstrumentation(_HttpClientInstrumentation[RequestCallable]):
    """Reversible instrumentation for one caller-owned requests-style session."""

    _span_helper = staticmethod(requests_request_with_logbrew_span)


class LogBrewHttpxClientInstrumentation(_HttpClientInstrumentation[RequestCallable | AsyncRequestCallable]):
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
        self._is_async = is_async
        self._span_helper = async_httpx_request_with_logbrew_span if is_async else httpx_request_with_logbrew_span
        super().__init__(
            session=httpx_client,
            request=request,
            client=client,
            event_id_factory=event_id_factory,
            timestamp=timestamp,
            trace=trace,
            route_template_resolver=route_template_resolver,
            metadata=metadata,
            span_id_factory=span_id_factory,
            clock=clock,
            on_capture_error=on_capture_error,
        )


class LogBrewAiohttpClientSessionInstrumentation(_HttpClientInstrumentation[AsyncRequestCallable]):
    """Reversible instrumentation for one caller-owned aiohttp-style client session."""

    _request_method = "_request"
    _is_async = True
    _stringify_url = True
    _span_helper = staticmethod(aiohttp_request_with_logbrew_span)


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


class _InstrumentationRegistry(Generic[_Instrumentation]):
    """Track client ownership even when the client rejects custom attributes."""

    def __init__(self, attribute: str, kind: type[_Instrumentation]) -> None:
        """Bind the adapter type and its existing client attribute name."""
        self.attribute = attribute
        self.kind = kind
        self.by_id: dict[int, _Instrumentation] = {}

    def get(self, session: object) -> _Instrumentation | None:
        instrumentation = getattr(session, self.attribute, None)
        if isinstance(instrumentation, self.kind):
            return instrumentation
        return self.by_id.get(id(session))

    def remember(self, session: object, instrumentation: _Instrumentation) -> None:
        with suppress(Exception):
            setattr(session, self.attribute, instrumentation)
        self.by_id[id(session)] = instrumentation

    def forget(self, session: object, instrumentation: _Instrumentation) -> None:
        with suppress(Exception):
            if getattr(session, self.attribute, None) is instrumentation:
                delattr(session, self.attribute)
        if self.by_id.get(id(session)) is instrumentation:
            del self.by_id[id(session)]


_REQUESTS_REGISTRY = _InstrumentationRegistry(
    "_logbrew_requests_session_instrumentation", LogBrewRequestsSessionInstrumentation,
)
_HTTPX_REGISTRY = _InstrumentationRegistry(
    "_logbrew_httpx_client_instrumentation", LogBrewHttpxClientInstrumentation,
)
_AIOHTTP_REGISTRY = _InstrumentationRegistry(
    "_logbrew_aiohttp_client_session_instrumentation", LogBrewAiohttpClientSessionInstrumentation,
)
LogBrewRequestsSessionInstrumentation._registry = _REQUESTS_REGISTRY
LogBrewHttpxClientInstrumentation._registry = _HTTPX_REGISTRY
LogBrewAiohttpClientSessionInstrumentation._registry = _AIOHTTP_REGISTRY
