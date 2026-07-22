"""Immutable ordered event records used by Python delivery queues."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class QueuedEvent:
    """One compact event record with a stable local delivery sequence."""

    sequence: int
    record_id: str
    json: str
    byte_count: int


class EventQueue(Protocol):
    """Ordered queue operations used by memory and persistent delivery."""

    @property
    def count(self) -> int: ...

    @property
    def byte_count(self) -> int: ...

    def append(self, *, record_id: str, event_json: str, byte_count: int) -> QueuedEvent: ...

    def snapshot(self, *, through_sequence: int | None = None) -> tuple[QueuedEvent, ...]: ...

    def last_sequence(self) -> int | None: ...

    def acknowledge(self, through_sequence: int) -> int: ...

    def purge(self) -> int: ...

    def recover(self) -> int: ...

    def close(self) -> None: ...


class MemoryEventQueue:
    """Process-local ordered queue; callers provide synchronization."""

    def __init__(self) -> None:
        self._records: list[QueuedEvent] = []
        self._next_sequence = 1
        self._byte_count = 0

    @property
    def count(self) -> int:
        return len(self._records)

    @property
    def byte_count(self) -> int:
        return self._byte_count

    def append(self, *, record_id: str, event_json: str, byte_count: int) -> QueuedEvent:
        record = QueuedEvent(
            sequence=self._next_sequence,
            record_id=record_id,
            json=event_json,
            byte_count=byte_count,
        )
        self._next_sequence += 1
        self._records.append(record)
        self._byte_count += byte_count
        return record

    def snapshot(self, *, through_sequence: int | None = None) -> tuple[QueuedEvent, ...]:
        if through_sequence is None:
            return tuple(self._records)
        return tuple(record for record in self._records if record.sequence <= through_sequence)

    def last_sequence(self) -> int | None:
        return None if not self._records else self._records[-1].sequence

    def acknowledge(self, through_sequence: int) -> int:
        split = 0
        removed_bytes = 0
        for record in self._records:
            if record.sequence > through_sequence:
                break
            split += 1
            removed_bytes += record.byte_count
        if split:
            del self._records[:split]
            self._byte_count -= removed_bytes
        return split

    def purge(self) -> int:
        removed = len(self._records)
        self._records.clear()
        self._byte_count = 0
        return removed

    def recover(self) -> int:
        return len(self._records)

    def close(self) -> None:
        return
