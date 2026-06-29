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
    trace_fetch_methods: bool = False,
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
    _require_dbapi_connection(connection)
    return LogBrewDbapiConnection(
        connection=connection,
        client=client,
        system=system,
        trace_fetch_methods=trace_fetch_methods,
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


def connect_dbapi_connection_with_logbrew_spans(
    connect: Callable[..., Any],
    *,
    client: Any,
    system: str,
    connect_args: Sequence[Any] = (),
    connect_kwargs: Mapping[str, Any] | None = None,
    trace_fetch_methods: bool = False,
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
    """Trace a caller-owned DB-API connect callable and return a tracing wrapper."""

    if not callable(connect):
        raise TypeError("connect must be callable")
    event_ids = event_id_factory or _default_dbapi_event_id
    read_clock = clock or perf_counter
    safe_metadata = _dbapi_metadata(metadata)
    args = tuple(connect_args)
    kwargs = dict(connect_kwargs or {})

    def connect_operation() -> Any:
        connection = connect(*args, **kwargs)
        _require_dbapi_connection(connection)
        return connection

    connection = database_operation_with_logbrew_span(
        "CONNECT",
        client=client,
        event_id=event_ids(),
        operation=connect_operation,
        system=system,
        timestamp=timestamp,
        trace=trace,
        db_name=db_name,
        metadata={**safe_metadata, "framework": "dbapi", "dbMethod": "connect"},
        span_events=span_events,
        span_id_factory=span_id_factory,
        clock=read_clock,
        on_capture_error=on_capture_error,
    )
    return instrument_dbapi_connection_with_logbrew_spans(
        connection,
        client=client,
        system=system,
        trace_fetch_methods=trace_fetch_methods,
        event_id_factory=event_ids,
        timestamp=timestamp,
        trace=trace,
        db_name=db_name,
        metadata=safe_metadata,
        span_events=span_events,
        span_id_factory=span_id_factory,
        clock=read_clock,
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
        trace_fetch_methods: bool,
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
        self._trace_fetch_methods = trace_fetch_methods
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
        return self._trace_method(
            method_name=method_name,
            operation_name=_dbapi_operation_name(method_name, args, kwargs),
            method=method,
            args=args,
            kwargs=kwargs,
            row_count_from_result=lambda _result: _cursor_row_count(cursor),
        )

    def _trace_connection_method(
        self,
        method_name: str,
        operation_name: str,
        method: Callable[..., T],
        args: tuple[Any, ...],
        kwargs: Mapping[str, Any],
    ) -> T:
        return self._trace_method(
            method_name=method_name,
            operation_name=operation_name,
            method=method,
            args=args,
            kwargs=kwargs,
        )

    def _trace_fetch_method(
        self,
        method_name: str,
        method: Callable[..., T],
        args: tuple[Any, ...],
        kwargs: Mapping[str, Any],
    ) -> T:
        if not self._installed or not self._trace_fetch_methods:
            return method(*args, **kwargs)
        return self._trace_method(
            method_name=method_name,
            operation_name=method_name.upper(),
            method=method,
            args=args,
            kwargs=kwargs,
            row_count_from_result=lambda result: _fetch_row_count(method_name, result),
        )

    def _trace_method(
        self,
        *,
        method_name: str,
        operation_name: str,
        method: Callable[..., T],
        args: tuple[Any, ...],
        kwargs: Mapping[str, Any],
        row_count_from_result: Callable[[T], int | None] | None = None,
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
            row_count_from_result=row_count_from_result,
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

    def fetchone(self, *args: Any, **kwargs: Any) -> Any:
        return self._instrumentation._trace_fetch_method("fetchone", self._cursor.fetchone, args, kwargs)

    def fetchmany(self, *args: Any, **kwargs: Any) -> Any:
        return self._instrumentation._trace_fetch_method("fetchmany", self._cursor.fetchmany, args, kwargs)

    def fetchall(self, *args: Any, **kwargs: Any) -> Any:
        return self._instrumentation._trace_fetch_method("fetchall", self._cursor.fetchall, args, kwargs)

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


def _require_dbapi_connection(connection: Any) -> None:
    cursor = getattr(connection, "cursor", None)
    if not callable(cursor):
        raise TypeError("connection must expose a callable cursor method")


def _cursor_row_count(cursor: Any) -> int | None:
    row_count = getattr(cursor, "rowcount", None)
    return row_count if isinstance(row_count, int) and row_count >= 0 else None


def _fetch_row_count(method_name: str, result: Any) -> int | None:
    if method_name == "fetchone":
        return 0 if result is None else 1
    if isinstance(result, str | bytes | bytearray):
        return None
    try:
        row_count = len(result)
    except TypeError:
        return None
    return row_count if isinstance(row_count, int) and row_count >= 0 else None


def _dbapi_metadata(metadata: Mapping[str, Any] | None) -> _instrumentation.Metadata:
    return _instrumentation.compact_metadata_without_keys(metadata, _DBAPI_METADATA_DENYLIST)


def _default_dbapi_event_id() -> str:
    return f"evt_python_dbapi_{uuid4().hex}"
