"""Opt-in transactional event persistence for one owner process."""

from __future__ import annotations

import importlib
import os
import sqlite3
import stat
import weakref
from contextlib import suppress
from pathlib import Path
from typing import Any, Literal

from logbrew_sdk._errors import SdkError
from logbrew_sdk._event_queue import QueuedEvent
from logbrew_sdk._persistence_crypto import PersistenceCrypto, QueueState

_DATABASE_NAME = "events.sqlite3"
_LOCK_NAME = ".lock"
_ALLOWED_ENTRIES = {_LOCK_NAME, _DATABASE_NAME, f"{_DATABASE_NAME}-journal"}
_EXPECTED_TABLES = {"events", "queue_state"}
_PendingOperation = tuple[Literal["append", "ack", "purge"], int]


class PersistentEventQueue:
    """Authenticated encrypted SQLite queue for one process and one directory."""

    def __init__(
        self,
        *,
        directory: str | os.PathLike[str],
        sdk_json: str,
        max_queue_size: int,
        max_queue_bytes: int,
        max_batch_bytes: int,
        encryption_key: bytes | bytearray | memoryview,
    ) -> None:
        self._owner_pid = os.getpid()
        self._path = _validated_path(directory)
        self._sdk_json = sdk_json
        self._crypto = PersistenceCrypto(key=encryption_key, sdk_json=sdk_json)
        self._max_queue_size = max_queue_size
        self._max_queue_bytes = max_queue_bytes
        self._max_batch_bytes = max_batch_bytes
        self._directory_fd = -1
        self._lock_fd = -1
        self._directory_identity: tuple[int, int] | None = None
        self._lock_identity: tuple[int, int] | None = None
        self._database_identity: tuple[int, int] | None = None
        self._connection: sqlite3.Connection | None = None
        self._pending_confirmation: _PendingOperation | None = None
        self._closed = False

        try:
            self._open()
        except SdkError:
            self._close_handles()
            raise
        except Exception:
            self._close_handles()
            raise SdkError("persistent_queue_error", "persistent queue is unavailable") from None

    @property
    def count(self) -> int:
        self._ensure_ready()
        state = self._read_state(check_count=True)
        return state.last_admitted - state.accepted_through

    @property
    def byte_count(self) -> int:
        self._ensure_ready()
        return self._read_state(check_count=True).pending_bytes

    def append(self, *, record_id: str, event_json: str, byte_count: int) -> QueuedEvent:
        self._ensure_ready()
        connection = self._require_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            state = self._read_state(check_count=True)
            if (
                state.last_admitted - state.accepted_through >= self._max_queue_size
                or state.pending_bytes + byte_count > self._max_queue_bytes
            ):
                raise SdkError("persistent_queue_error", "persistent queue exceeds configured limits")
            sequence = state.last_admitted + 1
            event = QueuedEvent(
                sequence=sequence,
                record_id=record_id,
                json=event_json,
                byte_count=byte_count,
            )
            nonce, ciphertext = self._crypto.encrypt_event(event)
            connection.execute(
                "INSERT INTO events(sequence, nonce, ciphertext) VALUES (?, ?, ?)",
                (sequence, nonce, ciphertext),
            )
            self._write_state(
                QueueState(
                    accepted_through=state.accepted_through,
                    last_admitted=sequence,
                    pending_bytes=state.pending_bytes + byte_count,
                )
            )
            self._commit_transaction(
                pending=("append", sequence),
                message="persistent event admission could not be confirmed",
            )
        except SdkError:
            with suppress(sqlite3.Error):
                connection.rollback()
            raise
        except sqlite3.Error:
            with suppress(sqlite3.Error):
                connection.rollback()
            raise SdkError("persistent_queue_error", "persistent event admission failed") from None
        return event

    def snapshot(self, *, through_sequence: int | None = None) -> tuple[QueuedEvent, ...]:
        self._ensure_ready()
        state = self._read_state(check_count=True)
        upper = state.last_admitted if through_sequence is None else min(through_sequence, state.last_admitted)
        if upper <= state.accepted_through:
            return ()
        records = self._read_records(through_sequence=upper)
        expected = tuple(range(state.accepted_through + 1, upper + 1))
        if tuple(record.sequence for record in records) != expected:
            raise _integrity_error()
        return records

    def last_sequence(self) -> int | None:
        self._ensure_ready()
        state = self._read_state(check_count=True)
        return None if state.last_admitted == state.accepted_through else state.last_admitted

    def acknowledge(self, through_sequence: int) -> int:
        self._ensure_ready()
        connection = self._require_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            state = self._read_state(check_count=True)
            if through_sequence <= state.accepted_through or through_sequence > state.last_admitted:
                raise _integrity_error()
            accepted = self._read_records(through_sequence=through_sequence)
            expected = tuple(range(state.accepted_through + 1, through_sequence + 1))
            if tuple(record.sequence for record in accepted) != expected:
                raise _integrity_error()
            accepted_bytes = sum(record.byte_count for record in accepted)
            self._write_state(
                QueueState(
                    accepted_through=through_sequence,
                    last_admitted=state.last_admitted,
                    pending_bytes=state.pending_bytes - accepted_bytes,
                )
            )
            connection.execute("DELETE FROM events WHERE sequence <= ?", (through_sequence,))
            self._commit_transaction(
                pending=("ack", through_sequence),
                message="accepted event prefix could not be confirmed",
            )
        except SdkError:
            with suppress(sqlite3.Error):
                connection.rollback()
            raise
        except sqlite3.Error:
            with suppress(sqlite3.Error):
                connection.rollback()
            raise SdkError("persistent_queue_error", "accepted event prefix could not be stored") from None
        return len(accepted)

    def purge(self) -> int:
        self._ensure_ready()
        connection = self._require_connection()
        try:
            connection.execute("BEGIN IMMEDIATE")
            state = self._read_state(check_count=True)
            removed = state.last_admitted - state.accepted_through
            self._write_state(
                QueueState(
                    accepted_through=state.last_admitted,
                    last_admitted=state.last_admitted,
                    pending_bytes=0,
                )
            )
            connection.execute("DELETE FROM events")
            self._commit_transaction(
                pending=("purge", state.last_admitted),
                message="persistent queue purge could not be confirmed",
            )
        except SdkError:
            with suppress(sqlite3.Error):
                connection.rollback()
            raise
        except sqlite3.Error:
            with suppress(sqlite3.Error):
                connection.rollback()
            raise SdkError("persistent_queue_error", "persistent queue purge failed") from None
        return removed

    def recover(self) -> int:
        """Revalidate authenticated state and return the pending event count."""

        self._ensure_ready()
        state = self._validate_recovery()
        return state.last_admitted - state.accepted_through

    def close(self) -> None:
        self._assert_owner()
        if self._closed:
            return
        self._closed = True
        self._close_handles()

    def _open(self) -> None:
        if (
            os.name != "posix"
            or not hasattr(os, "O_NOFOLLOW")
            or not hasattr(os, "getuid")
        ):
            raise SdkError("persistence_unsupported", "encrypted persistence requires a supported POSIX runtime")
        lock_module = _lock_module()
        parent = self._path.parent
        parent_fd = _open_directory_components(parent)
        created = False
        try:
            try:
                os.mkdir(self._path.name, 0o700, dir_fd=parent_fd)
                created = True
            except FileExistsError:
                pass
            if created:
                os.fsync(parent_fd)
            self._directory_fd = os.open(
                self._path.name,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _no_follow_flag() | _close_on_exec_flag(),
                dir_fd=parent_fd,
            )
        finally:
            os.close(parent_fd)

        directory_stat = os.fstat(self._directory_fd)
        _validate_owned_entry(directory_stat, expected_mode=0o700, kind="directory")
        self._directory_identity = (directory_stat.st_dev, directory_stat.st_ino)
        self._validate_entries()

        self._lock_fd = os.open(
            _LOCK_NAME,
            os.O_RDWR | os.O_CREAT | _no_follow_flag() | _close_on_exec_flag(),
            0o600,
            dir_fd=self._directory_fd,
        )
        lock_stat = os.fstat(self._lock_fd)
        _validate_owned_entry(lock_stat, expected_mode=0o600, kind="file")
        self._lock_identity = (lock_stat.st_dev, lock_stat.st_ino)
        try:
            lock_module.flock(self._lock_fd, lock_module.LOCK_EX | lock_module.LOCK_NB)
        except OSError:
            raise SdkError("persistent_queue_error", "persistent queue already has an owner") from None

        database_fd = os.open(
            _DATABASE_NAME,
            os.O_RDWR | os.O_CREAT | _no_follow_flag() | _close_on_exec_flag(),
            0o600,
            dir_fd=self._directory_fd,
        )
        try:
            database_stat = os.fstat(database_fd)
            _validate_owned_entry(database_stat, expected_mode=0o600, kind="file")
            self._database_identity = (database_stat.st_dev, database_stat.st_ino)
            os.fsync(database_fd)
            os.fsync(self._directory_fd)
        finally:
            os.close(database_fd)

        self._connection = self._connect()
        self._initialize_schema()
        self._validate_recovery()
        self._validate_entries()
        if hasattr(os, "register_at_fork"):
            weak_self = weakref.ref(self)
            os.register_at_fork(after_in_child=lambda: _release_inherited_lock(weak_self))

    def _connect(self) -> sqlite3.Connection:
        self._assert_storage_identity()
        connection = sqlite3.connect(
            self._path / _DATABASE_NAME,
            timeout=0,
            isolation_level=None,
            check_same_thread=False,
        )
        try:
            self._assert_storage_identity()
            journal_mode = connection.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
            if str(journal_mode).lower() != "delete":
                raise sqlite3.DatabaseError("unexpected journal mode")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA secure_delete=ON")
            connection.execute("PRAGMA busy_timeout=0")
            connection.execute("PRAGMA trusted_schema=OFF")
        except Exception:
            connection.close()
            raise
        return connection

    def _initialize_schema(self) -> None:
        connection = self._require_connection()
        existing_tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        if existing_tables and existing_tables != _EXPECTED_TABLES:
            raise SdkError("persistent_queue_error", "persistent queue schema is incompatible")
        if not existing_tables:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "CREATE TABLE queue_state ("
                "id INTEGER PRIMARY KEY CHECK(id = 1), "
                "nonce BLOB NOT NULL CHECK(length(nonce) = 12), "
                "ciphertext BLOB NOT NULL CHECK(length(ciphertext) > 0)"
                ")"
            )
            connection.execute(
                "CREATE TABLE events ("
                "sequence INTEGER PRIMARY KEY CHECK(sequence > 0), "
                "nonce BLOB NOT NULL CHECK(length(nonce) = 12), "
                "ciphertext BLOB NOT NULL CHECK(length(ciphertext) > 0)"
                ")"
            )
            nonce, ciphertext = self._crypto.encrypt_state(
                QueueState(accepted_through=0, last_admitted=0, pending_bytes=0)
            )
            connection.execute(
                "INSERT INTO queue_state(id, nonce, ciphertext) VALUES (1, ?, ?)",
                (nonce, ciphertext),
            )
            self._commit_transaction(
                pending=("purge", 0),
                message="persistent queue initialization could not be confirmed",
            )

        queue_state_sql = (
            "CREATE TABLE queue_state ("
            "id INTEGER PRIMARY KEY CHECK(id = 1), "
            "nonce BLOB NOT NULL CHECK(length(nonce) = 12), "
            "ciphertext BLOB NOT NULL CHECK(length(ciphertext) > 0)"
            ")"
        )
        events_sql = (
            "CREATE TABLE events ("
            "sequence INTEGER PRIMARY KEY CHECK(sequence > 0), "
            "nonce BLOB NOT NULL CHECK(length(nonce) = 12), "
            "ciphertext BLOB NOT NULL CHECK(length(ciphertext) > 0)"
            ")"
        )
        actual_sql = {
            row[0]: " ".join(str(row[1]).split())
            for row in connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'queue_state')"
            ).fetchall()
        }
        if actual_sql != {
            "events": " ".join(events_sql.split()),
            "queue_state": " ".join(queue_state_sql.split()),
        }:
            raise SdkError("persistent_queue_error", "persistent queue schema is incompatible")
        event_columns = [row[1] for row in connection.execute("PRAGMA table_info(events)").fetchall()]
        state_columns = [row[1] for row in connection.execute("PRAGMA table_info(queue_state)").fetchall()]
        if event_columns != ["sequence", "nonce", "ciphertext"] or state_columns != [
            "id",
            "nonce",
            "ciphertext",
        ]:
            raise SdkError("persistent_queue_error", "persistent queue schema is incompatible")
        state_rows = int(connection.execute("SELECT COUNT(*) FROM queue_state").fetchone()[0])
        if state_rows != 1:
            raise _integrity_error()

    def _validate_recovery(self) -> QueueState:
        try:
            connection = self._require_connection()
            check = connection.execute("PRAGMA quick_check").fetchone()
            if check != ("ok",):
                raise _integrity_error()
            state = self._read_state(check_count=True)
            records = self._read_records()
            expected = tuple(range(state.accepted_through + 1, state.last_admitted + 1))
            if tuple(record.sequence for record in records) != expected:
                raise _integrity_error()
            if (
                len(records) > self._max_queue_size
                or sum(record.byte_count for record in records) > self._max_queue_bytes
            ):
                raise _integrity_error()
            if sum(record.byte_count for record in records) != state.pending_bytes:
                raise _integrity_error()
            prefix_bytes = len(f'{{"sdk":{self._sdk_json},"events":['.encode()) + 2
            if any(prefix_bytes + record.byte_count > self._max_batch_bytes for record in records):
                raise _integrity_error()
            return state
        except SdkError:
            raise
        except sqlite3.Error:
            raise _read_error() from None

    def _validate_entries(self) -> None:
        try:
            entries = set(os.listdir(self._directory_fd))
            if entries - _ALLOWED_ENTRIES:
                raise SdkError("persistent_queue_error", "persistent queue directory contains unexpected entries")
            for name in entries:
                entry_stat = os.stat(name, dir_fd=self._directory_fd, follow_symlinks=False)
                _validate_owned_entry(entry_stat, expected_mode=0o600, kind="file")
        except SdkError:
            raise
        except OSError:
            raise SdkError("persistent_queue_error", "persistent queue file boundary changed") from None

    def _ensure_ready(self) -> None:
        self._assert_owner()
        if self._closed:
            raise SdkError("persistent_queue_error", "persistent queue is closed")
        if self._pending_confirmation is not None:
            self._confirm_pending_operation()
        self._assert_storage_identity()

    def _confirm_pending_operation(self) -> None:
        pending = self._pending_confirmation
        if pending is None:
            return
        try:
            if self._connection is None:
                self._connection = self._connect()
                self._initialize_schema()
            state = self._validate_recovery()
            operation, value = pending
            if operation == "append":
                if state.last_admitted < value:
                    self._pending_confirmation = None
                    return
                row = self._require_connection().execute(
                    "SELECT sequence, nonce, ciphertext FROM events WHERE sequence = ?",
                    (value,),
                ).fetchone()
                if row is None:
                    raise _integrity_error()
                self._crypto.decrypt_event(*row)
            elif operation == "ack":
                if state.accepted_through < value:
                    self._pending_confirmation = None
                    return
            elif state.accepted_through != state.last_admitted:
                self._pending_confirmation = None
                return
            os.fsync(self._directory_fd)
            self._assert_storage_identity()
        except Exception:
            self._discard_connection()
            raise SdkError(
                "persistence_commit_error",
                "persistent queue durability is still unconfirmed",
            ) from None
        self._pending_confirmation = None

    def _read_state(self, *, check_count: bool) -> QueueState:
        try:
            rows = self._require_connection().execute(
                "SELECT nonce, ciphertext FROM queue_state WHERE id = 1"
            ).fetchall()
            if len(rows) != 1:
                raise _integrity_error()
            state = self._crypto.decrypt_state(*rows[0])
            if check_count:
                count = int(self._require_connection().execute("SELECT COUNT(*) FROM events").fetchone()[0])
                if count != state.last_admitted - state.accepted_through:
                    raise _integrity_error()
            return state
        except SdkError:
            raise
        except sqlite3.Error:
            raise _read_error() from None

    def _write_state(self, state: QueueState) -> None:
        nonce, ciphertext = self._crypto.encrypt_state(state)
        cursor = self._require_connection().execute(
            "UPDATE queue_state SET nonce = ?, ciphertext = ? WHERE id = 1",
            (nonce, ciphertext),
        )
        if cursor.rowcount != 1:
            raise _integrity_error()

    def _read_records(self, *, through_sequence: int | None = None) -> tuple[QueuedEvent, ...]:
        try:
            if through_sequence is None:
                rows = self._require_connection().execute(
                    "SELECT sequence, nonce, ciphertext FROM events ORDER BY sequence"
                ).fetchall()
            else:
                rows = self._require_connection().execute(
                    "SELECT sequence, nonce, ciphertext FROM events WHERE sequence <= ? ORDER BY sequence",
                    (through_sequence,),
                ).fetchall()
            return tuple(self._crypto.decrypt_event(*row) for row in rows)
        except SdkError:
            raise
        except sqlite3.Error:
            raise _read_error() from None

    def _commit_transaction(self, *, pending: _PendingOperation, message: str) -> None:
        try:
            self._require_connection().commit()
            os.fsync(self._directory_fd)
            self._assert_storage_identity()
        except (OSError, SdkError, sqlite3.Error):
            self._pending_confirmation = pending
            self._discard_connection()
            raise SdkError("persistence_commit_error", message) from None

    def _assert_owner(self) -> None:
        if os.getpid() != self._owner_pid:
            raise SdkError(
                "process_ownership_error",
                "persistent queue cannot be used from an inherited process",
            )

    def _assert_directory_identity(self) -> None:
        if self._directory_identity is None:
            raise SdkError("persistent_queue_error", "persistent queue is unavailable")
        try:
            current = os.stat(self._path, follow_symlinks=False)
        except OSError:
            raise SdkError("persistent_queue_error", "persistent queue directory identity changed") from None
        if stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino) != self._directory_identity:
            raise SdkError("persistent_queue_error", "persistent queue directory identity changed")

    def _assert_lock_identity(self) -> None:
        if self._lock_identity is None or self._lock_fd < 0:
            raise SdkError("persistent_queue_error", "persistent queue is unavailable")
        try:
            current = os.stat(_LOCK_NAME, dir_fd=self._directory_fd, follow_symlinks=False)
            held = os.fstat(self._lock_fd)
            _validate_owned_entry(current, expected_mode=0o600, kind="file")
            _validate_owned_entry(held, expected_mode=0o600, kind="file")
        except SdkError:
            raise
        except OSError:
            raise SdkError("persistent_queue_error", "persistent queue lock identity changed") from None
        current_identity = (current.st_dev, current.st_ino)
        if current_identity != self._lock_identity or (held.st_dev, held.st_ino) != self._lock_identity:
            raise SdkError("persistent_queue_error", "persistent queue lock identity changed")

    def _assert_database_identity(self) -> None:
        if self._database_identity is None:
            raise SdkError("persistent_queue_error", "persistent queue is unavailable")
        try:
            current = os.stat(self._path / _DATABASE_NAME, follow_symlinks=False)
            _validate_owned_entry(current, expected_mode=0o600, kind="file")
        except SdkError:
            raise
        except OSError:
            raise SdkError("persistent_queue_error", "persistent queue database identity changed") from None
        if (current.st_dev, current.st_ino) != self._database_identity:
            raise SdkError("persistent_queue_error", "persistent queue database identity changed")

    def _assert_storage_identity(self) -> None:
        self._assert_directory_identity()
        self._assert_lock_identity()
        self._assert_database_identity()
        self._validate_entries()

    def _require_connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise SdkError("persistent_queue_error", "persistent queue is unavailable")
        return self._connection

    def _discard_connection(self) -> None:
        connection = self._connection
        self._connection = None
        if connection is not None:
            with suppress(Exception):
                connection.close()

    def _close_handles(self) -> None:
        self._discard_connection()
        if self._lock_fd >= 0:
            with suppress(Exception):
                lock_module = _lock_module()
                lock_module.flock(self._lock_fd, lock_module.LOCK_UN)
            with suppress(OSError):
                os.close(self._lock_fd)
            self._lock_fd = -1
        if self._directory_fd >= 0:
            with suppress(OSError):
                os.close(self._directory_fd)
            self._directory_fd = -1


def _validated_path(directory: str | os.PathLike[str]) -> Path:
    try:
        raw_path = os.fspath(directory)
    except TypeError:
        raise SdkError(
            "configuration_error",
            "persistent queue directory must be a normalized absolute path",
        ) from None
    if not isinstance(raw_path, str) or not raw_path:
        raise SdkError(
            "configuration_error",
            "persistent queue directory must be a normalized absolute path",
        )
    path = Path(raw_path)
    if not path.is_absolute() or raw_path != os.path.normpath(raw_path):
        raise SdkError(
            "configuration_error",
            "persistent queue directory must be a normalized absolute path",
        )

    current = Path(path.anchor)
    for component in path.parts[1:-1]:
        current /= component
        try:
            component_stat = os.lstat(current)
        except OSError:
            raise SdkError(
                "persistent_queue_error",
                "persistent queue parent directory is unavailable",
            ) from None
        if stat.S_ISLNK(component_stat.st_mode):
            raise SdkError("persistent_queue_error", "persistent queue path must not contain symlinks")
        if not stat.S_ISDIR(component_stat.st_mode):
            raise SdkError(
                "persistent_queue_error",
                "persistent queue parent directory is unavailable",
            )
    if path.exists() or path.is_symlink():
        final_stat = os.lstat(path)
        if stat.S_ISLNK(final_stat.st_mode):
            raise SdkError("persistent_queue_error", "persistent queue path must not contain symlinks")
        if not stat.S_ISDIR(final_stat.st_mode):
            raise SdkError("persistent_queue_error", "persistent queue path must be a directory")
    return path


def _open_directory_components(path: Path) -> int:
    current_fd = -1
    try:
        current_fd = os.open(
            path.anchor,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _no_follow_flag() | _close_on_exec_flag(),
        )
        for component in path.parts[1:]:
            next_fd = os.open(
                component,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _no_follow_flag() | _close_on_exec_flag(),
                dir_fd=current_fd,
            )
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except OSError:
        if current_fd >= 0:
            with suppress(OSError):
                os.close(current_fd)
        raise SdkError("persistent_queue_error", "persistent queue parent directory is unavailable") from None


def _validate_owned_entry(entry_stat: os.stat_result, *, expected_mode: int, kind: str) -> None:
    if kind == "directory" and not stat.S_ISDIR(entry_stat.st_mode):
        raise SdkError("persistent_queue_error", "persistent queue path must be a directory")
    if kind == "file" and not stat.S_ISREG(entry_stat.st_mode):
        raise SdkError("persistent_queue_error", "persistent queue contains an unsafe file")
    if kind == "file" and entry_stat.st_nlink != 1:
        raise SdkError("persistent_queue_error", "persistent queue contains an unsafe file")
    if hasattr(os, "getuid") and entry_stat.st_uid != os.getuid():
        raise SdkError("persistent_queue_error", "persistent queue entries must belong to the current user")
    if stat.S_IMODE(entry_stat.st_mode) != expected_mode:
        target = "directory" if kind == "directory" else "files"
        raise SdkError("persistent_queue_error", f"persistent queue {target} must be owner-only")


def _lock_module() -> Any:
    try:
        return importlib.import_module("fcntl")
    except ImportError:
        raise SdkError("configuration_error", "persistent queues require a POSIX runtime") from None


def _release_inherited_lock(weak_queue: weakref.ReferenceType[PersistentEventQueue]) -> None:
    queue = weak_queue()
    if queue is None or queue._lock_fd < 0:
        return
    with suppress(OSError):
        os.close(queue._lock_fd)
    queue._lock_fd = -1


def _no_follow_flag() -> int:
    return getattr(os, "O_NOFOLLOW", 0)


def _close_on_exec_flag() -> int:
    return getattr(os, "O_CLOEXEC", 0)


def _integrity_error() -> SdkError:
    return SdkError(
        "persistence_integrity_error",
        "persistent queue authentication or continuity check failed",
    )


def _read_error() -> SdkError:
    return SdkError("persistent_queue_error", "persistent queue read failed")
