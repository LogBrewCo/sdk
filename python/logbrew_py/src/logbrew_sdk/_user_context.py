"""Per-request user identity for the active request trace."""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Literal

from logbrew_sdk._errors import SdkError
from logbrew_sdk._telemetry_context import _normalize_subject
from logbrew_sdk._trace_context import get_active_logbrew_trace

MAX_TRACE_SCOPES = 1024
_lock = threading.Lock()
_subjects: OrderedDict[str, dict[str, str]] = OrderedDict()


def set_logbrew_user(user_id: str, *, kind: Literal["user", "anonymous"] = "user") -> bool:
    """Attach an opaque user ID to every event of the active request.

    Pass an app-owned opaque ID, not an email address or name. Outside a request trace the call does
    nothing and returns False, so one request's user can never reach another request's events.
    """
    try:
        subject = _normalize_subject({"id": user_id, "kind": kind}, "LogBrew user")
    except SdkError as error:
        raise SdkError("configuration_error", str(error.message)) from None
    trace = get_active_logbrew_trace()
    if trace is None or subject is None:
        return False
    with _lock:
        _subjects[trace.trace_id] = subject
        _subjects.move_to_end(trace.trace_id)
        if len(_subjects) > MAX_TRACE_SCOPES:
            _subjects.popitem(last=False)
    return True


def active_user_subject() -> dict[str, str] | None:
    """Return the user set for the active request trace, if any."""
    trace = get_active_logbrew_trace()
    if trace is None:
        return None
    with _lock:
        subject = _subjects.get(trace.trace_id)
        return dict(subject) if subject is not None else None
