"""Optional SQLAlchemy engine instrumentation for app-owned database spans."""

from __future__ import annotations

import importlib
import re
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager, suppress
from dataclasses import dataclass
from time import perf_counter
from typing import Any
from uuid import uuid4
from weakref import WeakKeyDictionary

from logbrew_sdk import SdkError, _instrumentation
from logbrew_sdk._db_client import _DB_SPAN_EVENT_METADATA_DENYLIST, _db_span_request
from logbrew_sdk._trace_context import LogBrewTraceContext, use_logbrew_trace

_CONTEXT_STATE_ATTR = "_logbrew_sqlalchemy_span_state"
_SQL_OPERATION_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]*")
_SQLALCHEMY_METADATA_DENYLIST = (
    *_DB_SPAN_EVENT_METADATA_DENYLIST,
    "connection",
    "database_url",
    "dsn",
    "host",
    "password",
    "sql",
    "url",
    "user",
)
_SYSTEM_ALIASES = {
    "postgres": "postgresql",
    "postgresql": "postgresql",
    "postgresql+asyncpg": "postgresql",
    "postgresql+psycopg": "postgresql",
    "postgresql+psycopg2": "postgresql",
    "sqlite": "sqlite",
    "mysql": "mysql",
    "mariadb": "mariadb",
    "oracle": "oracle",
    "mssql": "mssql",
}

_ENGINE_INSTRUMENTATIONS: WeakKeyDictionary[Any, LogBrewSqlAlchemyInstrumentation] = WeakKeyDictionary()
_ENGINE_INSTRUMENTATIONS_BY_ID: dict[int, LogBrewSqlAlchemyInstrumentation] = {}


def instrument_sqlalchemy_engine_with_logbrew_spans(
    engine: Any,
    *,
    client: Any,
    event_id_factory: Callable[[], str] | None = None,
    timestamp: str | None = None,
    trace: LogBrewTraceContext | None = None,
    system: str | None = None,
    db_name: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    span_id_factory: Callable[[], str] | None = None,
    clock: _instrumentation.Clock | None = None,
    on_capture_error: Callable[[Exception], None] | None = None,
) -> LogBrewSqlAlchemyInstrumentation:
    """Attach reversible LogBrew span listeners to one caller-owned SQLAlchemy engine."""

    sqlalchemy_event = _require_sqlalchemy_event()
    existing = _existing_instrumentation(engine)
    if existing is not None and existing.installed:
        return existing

    instrumentation = LogBrewSqlAlchemyInstrumentation(
        engine=engine,
        sqlalchemy_event=sqlalchemy_event,
        client=client,
        event_id_factory=event_id_factory or _default_sqlalchemy_event_id,
        timestamp=timestamp,
        trace=trace,
        system=_system_from_engine(engine, system),
        db_name=db_name,
        metadata=_sqlalchemy_metadata(metadata),
        span_id_factory=span_id_factory,
        clock=clock or perf_counter,
        on_capture_error=on_capture_error,
    )
    instrumentation.install()
    _remember_instrumentation(engine, instrumentation)
    return instrumentation


class LogBrewSqlAlchemyInstrumentation:
    """Reversible SQLAlchemy event listeners for LogBrew database spans."""

    def __init__(
        self,
        *,
        engine: Any,
        sqlalchemy_event: Any,
        client: Any,
        event_id_factory: Callable[[], str],
        timestamp: str | None,
        trace: LogBrewTraceContext | None,
        system: str,
        db_name: str | None,
        metadata: Mapping[str, Any],
        span_id_factory: Callable[[], str] | None,
        clock: _instrumentation.Clock,
        on_capture_error: Callable[[Exception], None] | None,
    ) -> None:
        self.engine = engine
        self._event = sqlalchemy_event
        self._client = client
        self._event_id_factory = event_id_factory
        self._timestamp = timestamp
        self._trace = trace
        self._system = system
        self._db_name = db_name
        self._metadata = metadata
        self._span_id_factory = span_id_factory
        self._clock = clock
        self._on_capture_error = on_capture_error
        self._installed = False

    @property
    def installed(self) -> bool:
        """Return whether listeners are currently attached to the engine."""

        return self._installed

    def install(self) -> None:
        """Attach listeners to the caller-owned engine."""

        if self._installed:
            return
        self._event.listen(self.engine, "before_cursor_execute", self._before_cursor_execute)
        self._event.listen(self.engine, "after_cursor_execute", self._after_cursor_execute)
        self._event.listen(self.engine, "handle_error", self._handle_error)
        self._installed = True

    def uninstall(self) -> None:
        """Remove listeners without affecting the caller-owned engine."""

        if not self._installed:
            return
        for event_name, listener in (
            ("before_cursor_execute", self._before_cursor_execute),
            ("after_cursor_execute", self._after_cursor_execute),
            ("handle_error", self._handle_error),
        ):
            with suppress(Exception):
                self._event.remove(self.engine, event_name, listener)
        self._installed = False
        _forget_instrumentation(self.engine, self)

    def _before_cursor_execute(
        self,
        connection: Any,
        cursor: Any,
        statement: Any,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        if not self._installed:
            return
        try:
            request = _db_span_request(
                operation_name=_operation_from_statement(statement),
                system=self._system,
                client=self._client,
                event_id=self._event_id_factory(),
                timestamp=self._timestamp,
                trace=self._trace,
                db_name=self._db_name,
                statement_template=None,
                row_count=None,
                row_count_from_result=_cursor_row_count,
                metadata=self._metadata,
                span_events=None,
                span_id_factory=self._span_id_factory,
                clock=self._clock,
                on_capture_error=self._on_capture_error,
            )
            trace_scope = use_logbrew_trace(request.trace)
            trace_scope.__enter__()
            try:
                setattr(
                    context,
                    _CONTEXT_STATE_ATTR,
                    _SqlAlchemySpanState(request=request, trace_scope=trace_scope),
                )
            except Exception:
                trace_scope.__exit__(None, None, None)
                raise
        except Exception as error:
            _notify_capture_error(self._on_capture_error, error)

    def _after_cursor_execute(
        self,
        connection: Any,
        cursor: Any,
        statement: Any,
        parameters: Any,
        context: Any,
        executemany: bool,
    ) -> None:
        state = _take_state(context)
        if state is not None:
            state.finish("ok", result=cursor)

    def _handle_error(self, exception_context: Any) -> None:
        execution_context = getattr(exception_context, "execution_context", None)
        state = _take_state(execution_context)
        if state is None:
            return None

        original_error = getattr(exception_context, "original_exception", None)
        state.finish("error", error=original_error if isinstance(original_error, Exception) else None)
        return None


@dataclass(slots=True)
class _SqlAlchemySpanState:
    request: Any
    trace_scope: AbstractContextManager[Any]

    def finish(self, status: str, *, result: Any = None, error: Exception | None = None) -> None:
        try:
            self.request.capture(status, result=result, error=error)
        finally:
            self.trace_scope.__exit__(None, None, None)


def _require_sqlalchemy_event() -> Any:
    try:
        sqlalchemy = importlib.import_module("sqlalchemy")
    except Exception as error:
        raise SdkError(
            "configuration_error",
            "SQLAlchemy engine instrumentation requires SQLAlchemy to be installed by the application",
        ) from error
    sqlalchemy_event = getattr(sqlalchemy, "event", None)
    if not callable(getattr(sqlalchemy_event, "listen", None)) or not callable(
        getattr(sqlalchemy_event, "remove", None)
    ):
        raise SdkError(
            "configuration_error",
            "SQLAlchemy engine instrumentation requires sqlalchemy.event listen/remove APIs",
        )
    return sqlalchemy_event


def _existing_instrumentation(engine: Any) -> LogBrewSqlAlchemyInstrumentation | None:
    try:
        return _ENGINE_INSTRUMENTATIONS.get(engine)
    except TypeError:
        return _ENGINE_INSTRUMENTATIONS_BY_ID.get(id(engine))


def _remember_instrumentation(engine: Any, instrumentation: LogBrewSqlAlchemyInstrumentation) -> None:
    try:
        _ENGINE_INSTRUMENTATIONS[engine] = instrumentation
    except TypeError:
        _ENGINE_INSTRUMENTATIONS_BY_ID[id(engine)] = instrumentation


def _forget_instrumentation(engine: Any, instrumentation: LogBrewSqlAlchemyInstrumentation) -> None:
    try:
        if _ENGINE_INSTRUMENTATIONS.get(engine) is instrumentation:
            del _ENGINE_INSTRUMENTATIONS[engine]
        return
    except TypeError:
        pass
    if _ENGINE_INSTRUMENTATIONS_BY_ID.get(id(engine)) is instrumentation:
        del _ENGINE_INSTRUMENTATIONS_BY_ID[id(engine)]


def _operation_from_statement(statement: Any) -> str:
    if not isinstance(statement, str):
        return "QUERY"
    stripped = _strip_leading_sql_comments(statement)
    match = _SQL_OPERATION_PATTERN.match(stripped)
    return match.group(0).upper() if match is not None else "QUERY"


def _strip_leading_sql_comments(statement: str) -> str:
    remaining = statement.lstrip()
    while remaining.startswith("--") or remaining.startswith("/*"):
        if remaining.startswith("--"):
            _, separator, tail = remaining.partition("\n")
            remaining = tail.lstrip() if separator else ""
            continue
        end = remaining.find("*/", 2)
        if end == -1:
            return ""
        remaining = remaining[end + 2 :].lstrip()
    return remaining


def _cursor_row_count(cursor: Any) -> int | None:
    row_count = getattr(cursor, "rowcount", None)
    if isinstance(row_count, int) and not isinstance(row_count, bool) and row_count >= 0:
        return row_count
    return None


def _take_state(context: Any) -> _SqlAlchemySpanState | None:
    if context is None:
        return None
    state = getattr(context, _CONTEXT_STATE_ATTR, None)
    with suppress(Exception):
        delattr(context, _CONTEXT_STATE_ATTR)
    return state if isinstance(state, _SqlAlchemySpanState) else None


def _system_from_engine(engine: Any, system: str | None) -> str:
    if system is not None:
        return _instrumentation.required_label("system", system)
    dialect_name = getattr(getattr(engine, "dialect", None), "name", None)
    engine_name = getattr(engine, "name", None)
    candidate = dialect_name if isinstance(dialect_name, str) else engine_name
    if isinstance(candidate, str):
        normalized = candidate.strip().lower()
        return _SYSTEM_ALIASES.get(normalized, normalized or "sql")
    return "sql"


def _sqlalchemy_metadata(metadata: Mapping[str, Any] | None) -> _instrumentation.Metadata:
    safe_metadata = _instrumentation.compact_metadata_without_keys(metadata, _SQLALCHEMY_METADATA_DENYLIST)
    safe_metadata["framework"] = "sqlalchemy"
    return safe_metadata


def _default_sqlalchemy_event_id() -> str:
    return f"evt_python_sqlalchemy_{uuid4().hex}"


def _notify_capture_error(callback: Callable[[Exception], None] | None, error: Exception) -> None:
    if callback is not None:
        with suppress(Exception):
            callback(error)
