"""Conservative automatic Python runtime context."""

from __future__ import annotations

import platform
from collections.abc import Callable, Mapping
from typing import Any, cast

from logbrew_sdk._telemetry_context import TelemetryContext, merge_telemetry_contexts

MAX_CONTEXT_STRING_LENGTH = 256


def add_python_runtime_context(context: Mapping[str, Any] | None) -> TelemetryContext:
    """Merge safe Python runtime defaults beneath explicit caller context."""

    merged = merge_telemetry_contexts(create_python_runtime_context(), context)
    assert merged is not None
    return merged


def create_python_runtime_context() -> TelemetryContext:
    """Capture only interpreter, OS release, and architecture identity."""

    runtime_name = _bounded_probe(platform.python_implementation) or "python"
    runtime: dict[str, str] = {"name": runtime_name}
    runtime_version = _bounded_probe(platform.python_version)
    if runtime_version is not None:
        runtime["version"] = runtime_version

    resource: dict[str, dict[str, str]] = {"runtime": runtime}
    operating_system_name = _bounded_probe(platform.system)
    if operating_system_name is not None:
        operating_system = {"name": operating_system_name}
        operating_system_version = _bounded_probe(platform.release)
        if operating_system_version is not None:
            operating_system["version"] = operating_system_version
        resource["operatingSystem"] = operating_system

    architecture = _bounded_probe(platform.machine)
    if architecture is not None:
        resource["device"] = {"architecture": architecture}
    return cast(TelemetryContext, {"schemaVersion": 1, "resource": resource})


def _bounded_probe(probe: Callable[[], Any]) -> str | None:
    try:
        value = probe()
    except Exception:
        return None
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > MAX_CONTEXT_STRING_LENGTH
        or any(ord(character) <= 31 or 127 <= ord(character) <= 159 for character in normalized)
    ):
        return None
    return normalized
