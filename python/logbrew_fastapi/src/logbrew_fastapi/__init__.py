"""FastAPI integration helpers for capturing LogBrew request spans and exceptions."""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, Request, Response
from logbrew_sdk import (
    LogBrewClient,
    RecordingTransport,
    SdkError,
    SpanAttributes,
    TransportError,
    parse_traceparent,
    span_attributes_from_traceparent,
)
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.types import ASGIApp


@dataclass(slots=True)
class LogBrewFastAPIConfig:
    """Runtime options used by the LogBrew FastAPI middleware."""

    client: LogBrewClient
    transport: RecordingTransport | None = None
    capture_successful_requests: bool = True
    capture_exceptions: bool = True
    flush_on_response: bool = True
    raise_flush_errors: bool = False
    service_name: str = "fastapi"
    span_id_factory: Callable[[], str] | None = None


def utc_timestamp() -> str:
    """Return a LogBrew-compatible UTC timestamp."""

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def request_name(request: Request) -> str:
    """Return the stable request name used for span and issue titles."""

    return f"{request.method} {request.url.path}"


def request_metadata(
    request: Request,
    *,
    status_code: int | None = None,
    duration_ms: float | None = None,
) -> dict[str, Any]:
    """Return metadata that is useful for request-level troubleshooting without including query strings."""

    metadata: dict[str, Any] = {
        "framework": "fastapi",
        "method": request.method,
        "path": request.url.path,
    }
    route = request.scope.get("route")
    route_path = getattr(route, "path", None)
    if isinstance(route_path, str):
        metadata["route"] = route_path
    if status_code is not None:
        metadata["status_code"] = status_code
    if duration_ms is not None:
        metadata["duration_ms"] = round(duration_ms, 3)
    return metadata


def capture_request_span(
    client: LogBrewClient,
    request: Request,
    *,
    status_code: int,
    duration_ms: float,
    event_id: str | None = None,
    timestamp: str | None = None,
    span_id_factory: Callable[[], str] | None = None,
) -> str:
    """Capture a FastAPI request as a LogBrew span event and return its event id."""

    span_event_id = event_id or f"evt_fastapi_span_{uuid.uuid4().hex}"
    span_seed = span_event_id.replace("-", "_")
    traceparent = request.headers.get("traceparent")
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
    request: Request,
    exc: BaseException,
    *,
    event_id: str | None = None,
    timestamp: str | None = None,
) -> str:
    """Capture an exception raised while handling a FastAPI request and return its event id."""

    issue_event_id = event_id or f"evt_fastapi_issue_{uuid.uuid4().hex}"
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


class LogBrewFastAPIMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware that records request spans and exception issues with LogBrew."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        client: LogBrewClient,
        transport: RecordingTransport | None = None,
        capture_successful_requests: bool = True,
        capture_exceptions: bool = True,
        flush_on_response: bool = True,
        raise_flush_errors: bool = False,
        service_name: str = "fastapi",
        span_id_factory: Callable[[], str] | None = None,
    ) -> None:
        super().__init__(app)
        self.config = LogBrewFastAPIConfig(
            client=client,
            transport=transport,
            capture_successful_requests=capture_successful_requests,
            capture_exceptions=capture_exceptions,
            flush_on_response=flush_on_response,
            raise_flush_errors=raise_flush_errors,
            service_name=service_name,
            span_id_factory=span_id_factory,
        )

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception as exc:
            duration_ms = (time.perf_counter() - start) * 1000
            if self.config.capture_exceptions:
                capture_exception(self.config.client, request, exc)
                capture_request_span(
                    self.config.client,
                    request,
                    status_code=500,
                    duration_ms=duration_ms,
                    span_id_factory=self.config.span_id_factory,
                )
                self._flush_if_configured()
            raise

        duration_ms = (time.perf_counter() - start) * 1000
        if self.config.capture_successful_requests or response.status_code >= 500:
            capture_request_span(
                self.config.client,
                request,
                status_code=response.status_code,
                duration_ms=duration_ms,
                span_id_factory=self.config.span_id_factory,
            )
            self._flush_if_configured()
        return response

    def _flush_if_configured(self) -> None:
        if not self.config.flush_on_response or self.config.transport is None:
            return
        try:
            self.config.client.flush(self.config.transport)
        except (SdkError, TransportError):
            if self.config.raise_flush_errors:
                raise


def add_logbrew_middleware(
    app: FastAPI,
    *,
    client: LogBrewClient,
    transport: RecordingTransport | None = None,
    capture_successful_requests: bool = True,
    capture_exceptions: bool = True,
    flush_on_response: bool = True,
    raise_flush_errors: bool = False,
    service_name: str = "fastapi",
    span_id_factory: Callable[[], str] | None = None,
) -> None:
    """Install LogBrew request/exception capture middleware on a FastAPI app."""

    app.add_middleware(
        LogBrewFastAPIMiddleware,
        client=client,
        transport=transport,
        capture_successful_requests=capture_successful_requests,
        capture_exceptions=capture_exceptions,
        flush_on_response=flush_on_response,
        raise_flush_errors=raise_flush_errors,
        service_name=service_name,
        span_id_factory=span_id_factory,
    )


def default_span_id_factory() -> str:
    """Return a fresh W3C-compatible child span id."""

    span_id = uuid.uuid4().hex[:16]
    return "0000000000000001" if span_id == "0000000000000000" else span_id


__all__ = [
    "LogBrewFastAPIConfig",
    "LogBrewFastAPIMiddleware",
    "add_logbrew_middleware",
    "capture_exception",
    "capture_request_span",
    "request_metadata",
    "request_name",
    "utc_timestamp",
]
