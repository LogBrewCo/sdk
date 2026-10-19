"""Conservative automatic Python runtime context."""

from __future__ import annotations

import os
import platform
from collections.abc import Callable, Mapping
from functools import partial
from typing import Any, cast

from logbrew_sdk._telemetry_context import TelemetryContext, merge_telemetry_contexts

MAX_CONTEXT_STRING_LENGTH = 256
_ENVIRONMENT_RESOURCE_FIELDS = (
    ("LOGBREW_SERVICE_NAME", "service", "name"),
    ("LOGBREW_ENVIRONMENT", "deployment", "environment"),
    ("LOGBREW_RELEASE", "deployment", "release"),
)


def add_environment_resource_context(
    context: Mapping[str, Any] | None,
    environ: Mapping[str, str] = os.environ,
) -> Mapping[str, Any] | None:
    """Fill service, environment, and release from LOGBREW_* variables beneath explicit context."""

    resource: dict[str, dict[str, str]] = {}
    for variable, section, field in _ENVIRONMENT_RESOURCE_FIELDS:
        value = _bounded_probe(partial(environ.get, variable))
        if value is not None:
            resource.setdefault(section, {})[field] = value
    if not resource:
        return context
    return merge_telemetry_contexts({"schemaVersion": 1, "resource": resource}, context)


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
