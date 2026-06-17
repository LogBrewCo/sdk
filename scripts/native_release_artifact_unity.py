"""Unity symbol helpers for native release-artifact dry runs."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any


UNITY_BUILD_ID_FILE_NAME = "build_id"
UNITY_IL2CPP_MAPPING_FILE_NAME = "LineNumberMappings.json"
UNITY_BUILD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def unity_native_symbol_candidates(path: Path) -> list[Path]:
    return sorted(candidate for candidate in path.rglob("*.so") if candidate.is_file())


def read_unity_build_id(path: Path) -> tuple[str, str | None]:
    try:
        value = path.read_text(encoding="utf-8", errors="strict").strip()
    except UnicodeDecodeError:
        return "", "Unity build_id must be UTF-8 text"
    except OSError as exc:
        return "", str(exc)

    if not value:
        return "", "Unity build_id file is empty"
    if not UNITY_BUILD_ID_RE.fullmatch(value):
        return "", "Unity build_id must be 1-128 ASCII letters, numbers, dot, underscore, colon, or dash"
    return value, None


def il2cpp_mapping_entry(path: Path, rel_path: str) -> tuple[dict[str, Any] | None, str | None]:
    try:
        with path.open("rb") as handle:
            head = handle.read(4096)
    except OSError as exc:
        return None, str(exc)

    if path.stat().st_size == 0:
        return None, "IL2CPP mapping file is empty"
    if b"\0" in head:
        return None, "IL2CPP mapping file must be text JSON"
    if not head.lstrip().startswith((b"{", b"[")):
        return None, "IL2CPP mapping file must be JSON object or array data"
    return {
        "path": rel_path,
        "byteSize": path.stat().st_size,
        "symbolFormat": "il2cpp_mapping",
        "fileName": UNITY_IL2CPP_MAPPING_FILE_NAME,
    }, None
