"""Process-level crash capture through Python's own exception hooks."""

from __future__ import annotations

import sys
import threading
from collections.abc import Callable
from contextlib import suppress
from datetime import datetime, timezone
from types import TracebackType
from uuid import uuid4

from logbrew_sdk import (
    LogBrewClient,
    SdkError,
    Transport,
    create_issue_attributes_from_exception,
)

DEFAULT_FLUSH_TIMEOUT_SECONDS = 2.0
MAX_FLUSH_TIMEOUT_SECONDS = 30.0
_install_lock = threading.Lock()
_installed: list[ProcessErrorCapture] = []


class ProcessErrorCapture:
    """Installed hooks; `uninstall()` puts back the hooks that were active before."""

    def __init__(
        self,
        client: LogBrewClient,
        transport: Transport | None,
        flush_timeout_seconds: float,
        on_capture_error: Callable[[BaseException], None] | None,
    ) -> None:
        self._client = client
        self._transport = transport
        self._flush_timeout_seconds = flush_timeout_seconds
        self._on_capture_error = on_capture_error
        self._previous_excepthook = sys.excepthook
        self._previous_threading_excepthook = threading.excepthook

    def uninstall(self) -> None:
        """Put the previous hooks back. Calling it again does nothing."""
        with _install_lock:
            if self not in _installed:
                return
            _installed.remove(self)
            if sys.excepthook == self._excepthook:
                sys.excepthook = self._previous_excepthook
            if threading.excepthook == self._threading_excepthook:
                threading.excepthook = self._previous_threading_excepthook

    def _excepthook(
        self,
        exc_type: type[BaseException],
        exc_value: BaseException,
        exc_traceback: TracebackType | None,
    ) -> None:
        if not issubclass(exc_type, KeyboardInterrupt):
            self._capture(exc_value, "python.excepthook", "fatal")
        self._previous_excepthook(exc_type, exc_value, exc_traceback)

    def _threading_excepthook(self, args: threading.ExceptHookArgs) -> None:
        if args.exc_value is not None and not issubclass(args.exc_type, SystemExit):
            self._capture(args.exc_value, "python.threading_excepthook", "error")
        self._previous_threading_excepthook(args)

    def _capture(self, error: BaseException, mechanism: str, level: str) -> None:
        try:
            self._client.issue(
                f"evt_python_process_{uuid4().hex}",
                datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                create_issue_attributes_from_exception(
                    error,
                    level=level,
                    mechanism=mechanism,
                    handled=False,
                ),
            )
        except Exception as capture_error:
            # The original failure must still reach the previous hook.
            self._notify(capture_error)
            return
        self._flush_within_timeout()

    def _flush_within_timeout(self) -> None:
        # The flush runs on a daemon thread so a stalled intake cannot hold the process open.
        def flush() -> None:
            try:
                self._client.flush(self._transport)
            except Exception as flush_error:
                self._notify(flush_error)

        worker = threading.Thread(target=flush, name="logbrew-process-error-flush", daemon=True)
        worker.start()
        worker.join(self._flush_timeout_seconds)

    def _notify(self, error: BaseException) -> None:
        if self._on_capture_error is None:
            return
        # A failing observer must not hide the crash.
        with suppress(Exception):
            self._on_capture_error(error)


def install_process_error_capture(
    client: LogBrewClient,
    *,
    transport: Transport | None = None,
    flush_timeout_seconds: float = DEFAULT_FLUSH_TIMEOUT_SECONDS,
    on_capture_error: Callable[[BaseException], None] | None = None,
) -> ProcessErrorCapture:
    """Report uncaught exceptions in the main thread and in other threads.

    The previous hooks still run afterwards, so Python prints the traceback and exits as before.
    """
    if not isinstance(client, LogBrewClient):
        raise SdkError("configuration_error", "process error capture client must be a LogBrewClient")
    if transport is not None and not callable(getattr(transport, "send", None)):
        raise SdkError("configuration_error", "process error capture transport.send must be callable")
    if (
        isinstance(flush_timeout_seconds, bool)
        or not isinstance(flush_timeout_seconds, (int, float))
        or not 0 <= flush_timeout_seconds <= MAX_FLUSH_TIMEOUT_SECONDS
    ):
        raise SdkError(
            "configuration_error",
            f"flush_timeout_seconds must be a number from 0 to {MAX_FLUSH_TIMEOUT_SECONDS:g}",
        )
    if on_capture_error is not None and not callable(on_capture_error):
        raise SdkError("configuration_error", "on_capture_error must be callable")
    with _install_lock:
        if _installed:
            raise SdkError("configuration_error", "process error capture is already installed")
        capture = ProcessErrorCapture(client, transport, float(flush_timeout_seconds), on_capture_error)
        sys.excepthook = capture._excepthook
        threading.excepthook = capture._threading_excepthook
        _installed.append(capture)
    return capture


__all__: list[str] = ["ProcessErrorCapture", "install_process_error_capture"]
