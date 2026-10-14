# Copyright (c) 2026 LogBrew
"""Keep log identity separate from caller-controlled record attributes."""

from __future__ import annotations

import os
from functools import partial
from threading import RLock
from typing import TYPE_CHECKING
from uuid import uuid4
from weakref import ReferenceType, ref

if TYPE_CHECKING:
    import logging


class _RecordIdCache:
    def __init__(self) -> None:
        self.lock = RLock()
        self.records: dict[int, tuple[ReferenceType[logging.LogRecord], str]] = {}


_cache = _RecordIdCache()


def _release_record(identity: int, reference: ReferenceType[logging.LogRecord]) -> None:
    with _cache.lock:
        cached = _cache.records.get(identity)
        if cached is not None and cached[0] is reference:
            del _cache.records[identity]


def _reset_lock() -> None:
    # Preserve inherited record identities without inheriting another thread's lock.
    _cache.lock = RLock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_lock)


def log_record_identity(record: logging.LogRecord) -> str:
    """Identify this live record across concurrent handlers.

    Returns:
        An opaque event ID stable until this record is collected.

    """
    identity = id(record)
    with _cache.lock:
        cached = _cache.records.get(identity)
        if cached is not None and cached[0]() is record:
            return cached[1]
        event_id = f"evt_log_{uuid4().hex}"
        _cache.records[identity] = (ref(record, partial(_release_record, identity)), event_id)
        return event_id
