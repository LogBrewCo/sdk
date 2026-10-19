"""Automatic issue breadcrumbs scoped to the active request trace."""

from __future__ import annotations

import http.client
import logging
import threading
from collections import OrderedDict
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from logbrew_sdk._issue_diagnostics import MAX_ISSUE_BREADCRUMBS, _validate_breadcrumb
from logbrew_sdk._trace_context import get_active_logbrew_trace

MAX_MESSAGE_LENGTH = 512
MAX_URL_LENGTH = 256
MAX_TRACE_SCOPES = 1024
_LOG_LEVELS = ((logging.ERROR, "error"), (logging.WARNING, "warning"), (logging.INFO, "info"), (0, "debug"))


@dataclass
class _Ring:
    breadcrumbs: list[dict[str, Any]] = field(default_factory=list)
    truncated: bool = False


# Breadcrumbs inside a request belong to that request's trace; others go to the process ring.
_lock = threading.Lock()
_process_ring = _Ring()
_trace_rings: OrderedDict[str, _Ring] = OrderedDict()
_recording = threading.local()
_installed: list[bool] = []
# LogBrew's own delivery requests are not application breadcrumbs.
_ignored_urls: set[str] = set()


def add_logbrew_breadcrumb(breadcrumb: Mapping[str, Any]) -> None:
    """Add one breadcrumb to the active request scope, or the process scope outside a request.

    Invalid breadcrumbs are ignored, so a breadcrumb source never raises into application code.
    """
    if getattr(_recording, "active", False):
        return
    _recording.active = True
    try:
        validated = _validate_breadcrumb({"timestamp": _now(), **breadcrumb})
        with _lock:
            ring = _current_ring_locked()
            if len(ring.breadcrumbs) >= MAX_ISSUE_BREADCRUMBS:
                del ring.breadcrumbs[0]
                ring.truncated = True
            ring.breadcrumbs.append(validated)
    except Exception:
        # Breadcrumbs are advisory.
        return
    finally:
        _recording.active = False


def current_breadcrumbs() -> tuple[list[dict[str, Any]], bool]:
    """Return a copy of the active scope's breadcrumbs and whether older ones were dropped."""
    with _lock:
        ring = _current_ring_locked()
        return [dict(breadcrumb) for breadcrumb in ring.breadcrumbs], ring.truncated


def _current_ring_locked() -> _Ring:
    trace = get_active_logbrew_trace()
    if trace is None:
        return _process_ring
    ring = _trace_rings.get(trace.trace_id)
    if ring is None:
        ring = _Ring()
        _trace_rings[trace.trace_id] = ring
        if len(_trace_rings) > MAX_TRACE_SCOPES:
            _trace_rings.popitem(last=False)
    else:
        _trace_rings.move_to_end(trace.trace_id)
    return ring


class LogBrewBreadcrumbHandler(logging.Handler):
    """Record standard-library log records as issue breadcrumbs.

    Only the level, logger name, and message template are kept. Arguments are never interpolated,
    so values a library passes to its logger (job arguments, payloads) stay out of breadcrumbs.
    """

    def emit(self, record: logging.LogRecord) -> None:
        if record.name == "logbrew" or record.name.startswith(("logbrew.", "logbrew_")):
            return
        with suppress(Exception):
            template = record.msg if isinstance(record.msg, str) else type(record.msg).__name__
            message = _bounded_text(template, MAX_MESSAGE_LENGTH)
            if message:
                add_logbrew_breadcrumb(
                    {
                        "type": "debug",
                        "category": "logging",
                        "level": _log_level(record.levelno),
                        "message": message,
                        "data": {"logger": _bounded_text(record.name, MAX_URL_LENGTH) or "root"},
                    }
                )


def install_automatic_breadcrumbs() -> None:
    """Record logging records and http.client requests as breadcrumbs, once per process."""
    with _lock:
        if _installed:
            return
        _installed.append(True)
    logging.getLogger().addHandler(LogBrewBreadcrumbHandler())
    _patch_http_client()


def _patch_http_client() -> None:
    # http.client backs urllib, requests, and most synchronous HTTP libraries.
    original_putrequest = http.client.HTTPConnection.putrequest
    original_getresponse = http.client.HTTPConnection.getresponse

    def putrequest(self: http.client.HTTPConnection, method: str, url: str, *args: Any, **kwargs: Any) -> Any:
        with suppress(Exception):
            target = _connection_url(self, url)
            self._logbrew_breadcrumb = None if target in _ignored_urls else (method, target)  # type: ignore[attr-defined]
        return original_putrequest(self, method, url, *args, **kwargs)

    def getresponse(self: http.client.HTTPConnection) -> http.client.HTTPResponse:
        started: tuple[str, str | None] | None = getattr(self, "_logbrew_breadcrumb", None)
        try:
            response = original_getresponse(self)
        except Exception:
            if started is not None:
                add_logbrew_breadcrumb({**_http_breadcrumb(started[0], started[1], None), "level": "error"})
            raise
        if started is not None:
            add_logbrew_breadcrumb(_http_breadcrumb(started[0], started[1], response.status))
        return response

    http.client.HTTPConnection.putrequest = putrequest  # type: ignore[method-assign]
    http.client.HTTPConnection.getresponse = getresponse  # type: ignore[method-assign]


def ignore_breadcrumb_url(url: str) -> None:
    """Skip breadcrumbs for requests to this URL, such as the LogBrew ingest endpoint."""
    sanitized = _sanitize_url(url)
    if sanitized:
        with _lock:
            _ignored_urls.add(sanitized)


def _http_breadcrumb(method: str, url: str | None, status: int | None) -> dict[str, Any]:
    level = "info" if status is None or status < 400 else "error" if status >= 500 else "warning"
    data: dict[str, Any] = {"method": (method or "GET").upper()[:16]}
    if url:
        data["url"] = url
    if status is not None:
        data["status_code"] = status
    return {"type": "http", "category": "http.client", "level": level, "data": data}


def _connection_url(connection: http.client.HTTPConnection, target: str) -> str | None:
    if target.startswith(("http://", "https://")):
        return _sanitize_url(target)
    scheme = "https" if isinstance(connection, http.client.HTTPSConnection) else "http"
    default_port = 443 if scheme == "https" else 80
    host = connection.host if connection.port in (None, default_port) else f"{connection.host}:{connection.port}"
    return _sanitize_url(f"{scheme}://{host}{target}")


def _sanitize_url(value: str) -> str | None:
    # Keeps scheme, host, and path; drops user info, query, and fragment.
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    authority = parts.netloc.rsplit("@", 1)[-1]
    if not parts.scheme or not authority:
        return None
    return _bounded_text(f"{parts.scheme}://{authority.lower()}{parts.path or '/'}", MAX_URL_LENGTH) or None


def _log_level(levelno: int) -> str:
    return next(name for floor, name in _LOG_LEVELS if levelno >= floor)


def _bounded_text(value: str, limit: int) -> str:
    cleaned = "".join(" " if ord(character) <= 31 or 127 <= ord(character) <= 159 else character for character in value)
    return " ".join(cleaned.split())[:limit]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
