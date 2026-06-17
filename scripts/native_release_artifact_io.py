"""Shared binary-file helpers for native release-artifact dry runs."""

from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_bytes(path: Path, offset: int, size: int) -> bytes:
    if offset < 0 or size < 0:
        raise ValueError("file offset and size must be non-negative")
    with path.open("rb") as handle:
        handle.seek(offset)
        payload = handle.read(size)
    if len(payload) != size:
        raise ValueError("file data is truncated")
    return payload


def align_offset(value: int, alignment: int) -> int:
    alignment = max(alignment, 1)
    return value + ((alignment - (value % alignment)) % alignment)


def c_string(payload: bytes, offset: int, *, encoding: str = "ascii") -> str:
    if offset >= len(payload):
        return ""
    end = payload.find(b"\0", offset)
    if end == -1:
        end = len(payload)
    return payload[offset:end].decode(encoding, errors="replace")
