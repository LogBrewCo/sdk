"""Optional DB-API connection wrappers for app-owned Python database spans."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from time import perf_counter
from typing import Any, TypeVar
from uuid import uuid4

from logbrew_sdk import _instrumentation
from logbrew_sdk._db_client import (
    _DB_SPAN_EVENT_METADATA_DENYLIST,
    database_operation_with_logbrew_span,
)
from logbrew_sdk._trace_context import LogBrewTraceContext

T = TypeVar("T")

_DBAPI_METADATA_DENYLIST = (
    *_DB_SPAN_EVENT_METADATA_DENYLIST,
    "connection",
    "dsn",
    "host",
    "password",
    "token",
    "url",
    "user",
)
_LEADING_SQL_COMMENT = re.compile(r"^(?:\s*/\*.*?\*/\s*|\s*--[^\n\r]*(?:\r?\n|$)\s*)+", re.DOTALL)


def instrument_dbapi_connection_with_logbrew_spans(
    connection: Any,
    *,
    client: Any,
    system: str,
    event_id_factory: Callable[[], str] | None = None,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    db_name: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_events: Sequence[_instrumentation.SpanEventSummary] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewDbapiConnection:
    """Return a tracing wrapper for one caller-owned Python DB-API connection."""

    if isinstance(connection, LogBrewDbapiConnection):
        return connection
    cursor = getattr(connection, "cursor", None)
    if not callable(cursor):
        raise TypeError("connection must expose a callable cursor method")
    return LogBrewDbapiConnection(
        connection=connection,
        client=client,
        system=system,
        event_id_factory=event_id_factory or _default_dbapi_event_id,
        timestamp=timestamp,
        trace=trace,
        db_name=db_name,
        metadata=_dbapi_metadata(metadata),
        span_events=span_events,
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )


class LogBrewDbapiConnection:
    """Proxy around one app-owned DB-API connection."""

    def __init__(
        self,
        *,
        connection: Any,
        client: Any,
        system: str,
        event_id_factory: Callable[[], str],
        timestamp: str | None,
        trace: LogBrewTraceContext | None,
        db_name: str | None,
        metadata: Mapping[str, Any],
        span_events: Sequence[_instrumentation.SpanEventSummary] | None,
        span_id_factory: Callable[[], str] | None,
        clock: _instrumentation.Clock,
        on_capture_error: Callable[[Exception], None] | None,
    ) -> None:
        self._connection = connection
        self._client = client
        self._system = _instrumentation.required_label("system", system)
        self._event_id_factory = event_id_factory
        self._timestamp = timestamp
        self._trace = trace
        self._db_name = _instrumentation.optional_label(db_name)
        self._metadata = metadata
        self._span_events = span_events
        self._span_id_factory = span_id_factory
        self._clock = clock
        self._on_capture_error = on_capture_error
        self._installed = True

    @property
    def installed(self) -> bool:
        """Return whether this wrapper still emits spans."""

        return self._installed

    def uninstall(self) -> Any:
        """Disable future spans and return the original connection."""

        self._installed = False
        return self._connection

    @property
    def raw_connection(self) -> Any:
        """Return the underlying caller-owned connection."""

        return self._connection

    def cursor(self, *args: Any, **kwargs: Any) -> Any:
        cursor = self._connection.cursor(*args, **kwargs)
        if not self._installed:
            return cursor
        return LogBrewDbapiCursor(cursor=cursor, instrumentation=self)

    def execute(self, *args: Any, **kwargs: Any) -> Any:
        cursor = self.cursor()
        return cursor.execute(*args, **kwargs)

    def executemany(self, *args: Any, **kwargs: Any) -> Any:
        cursor = self.cursor()
        return cursor.executemany(*args, **kwargs)

    def commit(self, *args: Any, **kwargs: Any) -> Any:
        if not self._installed:
            return self._connection.commit(*args, **kwargs)
        return self._trace_connection_method("commit", "COMMIT", self._connection.commit, args, kwargs)

    def rollback(self, *args: Any, **kwargs: Any) -> Any:
        if not self._installed:
            return self._connection.rollback(*args, **kwargs)
        return self._trace_connection_method("rollback", "ROLLBACK", self._connection.rollback, args, kwargs)

    def __enter__(self) -> Any:
        entered = self._connection.__enter__()
        if entered is self._connection:
            return self
        if self._installed and hasattr(entered, "execute"):
            return LogBrewDbapiCursor(cursor=entered, instrumentation=self)
        return entered

    def __exit__(self, *args: Any, **kwargs: Any) -> Any:
        return self._connection.__exit__(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)

    def _trace_cursor_method(
        self,
        cursor: Any,
        method_name: str,
        method: Callable[..., T],
        args: tuple[Any, ...],
        kwargs: Mapping[str, Any],
    ) -> T:
        operation_name = _dbapi_operation_name(method_name, args, kwargs)
        return database_operation_with_logbrew_span(
            operation_name,
            client=self._client,
            event_id=self._event_id_factory(),
            operation=lambda: method(*args, **kwargs),
            system=self._system,
            timestamp=self._timestamp,
            trace=self._trace,
            db_name=self._db_name,
            row_count_from_result=lambda _result: _cursor_row_count(cursor),
            metadata={**self._metadata, "framework": "dbapi", "dbMethod": method_name},
            span_events=self._span_events,
            span_id_factory=self._span_id_factory,
            clock=self._clock,
            on_capture_error=self._on_capture_error,
        )

    def _trace_connection_method(
        self,
        method_name: str,
        operation_name: str,
        method: Callable[..., T],
        args: tuple[Any, ...],
        kwargs: Mapping[str, Any],
    ) -> T:
        return database_operation_with_logbrew_span(
            operation_name,
            client=self._client,
            event_id=self._event_id_factory(),
            operation=lambda: method(*args, **kwargs),
            system=self._system,
            timestamp=self._timestamp,
            trace=self._trace,
            db_name=self._db_name,
            metadata={**self._metadata, "framework": "dbapi", "dbMethod": method_name},
            span_events=self._span_events,
            span_id_factory=self._span_id_factory,
            clock=self._clock,
            on_capture_error=self._on_capture_error,
        )


class LogBrewDbapiCursor:
    """Proxy around one DB-API cursor returned by a wrapped connection."""

    def __init__(self, *, cursor: Any, instrumentation: LogBrewDbapiConnection) -> None:
        self._cursor = cursor
        self._instrumentation = instrumentation

    @property
    def raw_cursor(self) -> Any:
        """Return the underlying caller-owned cursor."""

        return self._cursor

    def execute(self, *args: Any, **kwargs: Any) -> Any:
        return self._trace_cursor_method("execute", self._cursor.execute, args, kwargs)

    def executemany(self, *args: Any, **kwargs: Any) -> Any:
        return self._trace_cursor_method("executemany", self._cursor.executemany, args, kwargs)

    def callproc(self, *args: Any, **kwargs: Any) -> Any:
        return self._trace_cursor_method("callproc", self._cursor.callproc, args, kwargs)

    def __enter__(self) -> Any:
        entered = self._cursor.__enter__()
        return self if entered is self._cursor else entered

    def __exit__(self, *args: Any, **kwargs: Any) -> Any:
        return self._cursor.__exit__(*args, **kwargs)

    def __iter__(self) -> Any:
        return iter(self._cursor)

    def __next__(self) -> Any:
        return next(self._cursor)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._cursor, name)

    def _trace_cursor_method(
        self,
        method_name: str,
        method: Callable[..., T],
        args: tuple[Any, ...],
        kwargs: Mapping[str, Any],
    ) -> Any:
        result = self._instrumentation._trace_cursor_method(self._cursor, method_name, method, args, kwargs)
        return self if result is self._cursor else result


def _dbapi_operation_name(method_name: str, args: tuple[Any, ...], kwargs: Mapping[str, Any]) -> str:
    if method_name == "callproc":
        return f"CALL {_dbapi_label(args[0])}" if args and _dbapi_label(args[0]) else "CALL"
    operation = args[0] if args else kwargs.get("operation")
    label = _dbapi_sql_verb(operation)
    return label or method_name.upper()


def _dbapi_sql_verb(operation: Any) -> str | None:
    if isinstance(operation, bytes | bytearray):
        operation = bytes(operation).decode("utf-8", errors="ignore")
    if not isinstance(operation, str):
        return None
    cleaned = _LEADING_SQL_COMMENT.sub("", operation).strip()
    if not cleaned:
        return None
    return _dbapi_label(cleaned.split(maxsplit=1)[0])


def _dbapi_label(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split())
    return normalized.upper() if normalized else None


def _cursor_row_count(cursor: Any) -> int | None:
    row_count = getattr(cursor, "rowcount", None)
    return row_count if isinstance(row_count, int) and row_count >= 0 else None


def _dbapi_metadata(metadata: Mapping[str, Any] | None) -> _instrumentation.Metadata:
    return _instrumentation.compact_metadata_without_keys(metadata, _DBAPI_METADATA_DENYLIST)


def _default_dbapi_event_id() -> str:
    return f"evt_python_dbapi_{uuid4().hex}"
