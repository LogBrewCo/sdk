"""Validation and merge rules for the shared privacy-bounded telemetry context."""

from __future__ import annotations

import re
import sys
from collections.abc import Mapping
from typing import Any, Literal, TypedDict, cast

if sys.version_info >= (3, 11):
    from typing import NotRequired
else:  # pragma: no cover - exercised by the Python 3.10 CI lane
    from typing_extensions import NotRequired

from logbrew_sdk._errors import SdkError

CONTEXT_SCHEMA_VERSION = 1
MAX_CONTEXT_ID_LENGTH = 200
MAX_CONTEXT_STRING_LENGTH = 256
MAX_CONTEXT_TAGS = 32
MAX_CONTEXT_TAG_KEY_LENGTH = 64
MAX_CONTEXT_TAG_VALUE_LENGTH = 256
TRACE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)
SPAN_ID_PATTERN = re.compile(r"^[0-9a-f]{16}$", re.IGNORECASE)
ZERO_TRACE_ID = "0" * 32
ZERO_SPAN_ID = "0" * 16
TAG_KEY_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
CONTEXT_KEYS = frozenset({"schemaVersion", "resource", "trace", "session", "subject", "tags"})
RESOURCE_FIELDS = {
    "service": ("name", "version"),
    "deployment": ("environment", "release"),
    "runtime": ("name", "version"),
    "framework": ("name", "version"),
    "operatingSystem": ("name", "version", "build"),
    "device": ("family", "model", "architecture"),
    "application": ("name", "version", "build"),
}
RESOURCE_NAME_REQUIRED = frozenset({"service", "runtime", "framework", "operatingSystem"})


class TelemetryNamedVersion(TypedDict):
    name: str
    version: NotRequired[str]


class TelemetryDeployment(TypedDict, total=False):
    environment: str
    release: str


class TelemetryOperatingSystem(TypedDict):
    name: str
    version: NotRequired[str]
    build: NotRequired[str]


class TelemetryDevice(TypedDict, total=False):
    family: str
    model: str
    architecture: str


class TelemetryApplication(TypedDict, total=False):
    name: str
    version: str
    build: str


class TelemetryResource(TypedDict, total=False):
    service: TelemetryNamedVersion
    deployment: TelemetryDeployment
    runtime: TelemetryNamedVersion
    framework: TelemetryNamedVersion
    operatingSystem: TelemetryOperatingSystem
    device: TelemetryDevice
    application: TelemetryApplication


class TelemetryTraceContext(TypedDict):
    traceId: str
    spanId: NotRequired[str]
    parentSpanId: NotRequired[str]
    sampled: NotRequired[bool]


class TelemetrySessionContext(TypedDict):
    id: str
    previousId: NotRequired[str]


class TelemetrySubjectContext(TypedDict):
    id: str
    kind: Literal["anonymous", "user"]


class TelemetryContext(TypedDict):
    schemaVersion: Literal[1]
    resource: NotRequired[TelemetryResource]
    trace: NotRequired[TelemetryTraceContext]
    session: NotRequired[TelemetrySessionContext]
    subject: NotRequired[TelemetrySubjectContext]
    tags: NotRequired[dict[str, str]]


def validate_telemetry_context(
    context: Mapping[str, Any] | None,
    *,
    label: str = "telemetry context",
) -> TelemetryContext | None:
    """Validate, normalize, and detach one versioned telemetry context."""

    if context is None:
        return None
    source = _require_mapping(context, label)
    _reject_unknown_fields(source, CONTEXT_KEYS, label)
    if source.get("schemaVersion") != CONTEXT_SCHEMA_VERSION:
        raise _invalid(f"{label} schemaVersion must be {CONTEXT_SCHEMA_VERSION}")

    normalized: dict[str, Any] = {"schemaVersion": CONTEXT_SCHEMA_VERSION}
    sections = (
        ("resource", _normalize_resource(source.get("resource"), f"{label} resource")),
        ("trace", _normalize_trace(source.get("trace"), f"{label} trace")),
        ("session", _normalize_session(source.get("session"), f"{label} session")),
        ("subject", _normalize_subject(source.get("subject"), f"{label} subject")),
        ("tags", _normalize_tags(source.get("tags"), f"{label} tags")),
    )
    normalized.update({key: value for key, value in sections if value is not None})
    if len(normalized) == 1:
        raise _invalid(f"{label} must include resource, trace, session, subject, or tags")
    return cast(TelemetryContext, normalized)


def merge_telemetry_contexts(
    base: Mapping[str, Any] | None,
    override: Mapping[str, Any] | None,
) -> TelemetryContext | None:
    """Merge client and event contexts with deterministic field-level override semantics."""

    normalized_base = validate_telemetry_context(base, label="client telemetry context")
    normalized_override = validate_telemetry_context(override, label="event telemetry context")
    if normalized_base is None:
        return normalized_override
    if normalized_override is None:
        return normalized_base

    merged: dict[str, Any] = {"schemaVersion": CONTEXT_SCHEMA_VERSION}
    resource = _merge_resources(normalized_base.get("resource"), normalized_override.get("resource"))
    if resource is not None:
        merged["resource"] = resource
    trace = normalized_override.get("trace") or normalized_base.get("trace")
    session = normalized_override.get("session") or normalized_base.get("session")
    subject = normalized_override.get("subject") or normalized_base.get("subject")
    if trace is not None:
        merged["trace"] = dict(trace)
    if session is not None:
        merged["session"] = dict(session)
    if subject is not None:
        merged["subject"] = dict(subject)

    base_tags = normalized_base.get("tags")
    override_tags = normalized_override.get("tags")
    if base_tags is not None or override_tags is not None:
        merged["tags"] = {**(base_tags or {}), **(override_tags or {})}
    return validate_telemetry_context(merged, label="merged telemetry context")


def _normalize_resource(value: Any, label: str) -> dict[str, dict[str, str]] | None:
    if value is None:
        return None
    resource = _require_mapping(value, label)
    _reject_unknown_fields(resource, frozenset(RESOURCE_FIELDS), label)
    normalized: dict[str, dict[str, str]] = {}
    for kind, fields in RESOURCE_FIELDS.items():
        section = resource.get(kind)
        if section is None:
            continue
        normalized[kind] = _normalize_resource_section(kind, section, fields, f"{label} {kind}")
    if not normalized:
        raise _invalid(f"{label} must not be empty")
    return normalized


def _normalize_resource_section(
    kind: str,
    value: Any,
    fields: tuple[str, ...],
    label: str,
) -> dict[str, str]:
    section = _require_mapping(value, label)
    _reject_unknown_fields(section, frozenset(fields), label)
    normalized = {
        field: _bounded_string(section[field], f"{label} {field}")
        for field in fields
        if field in section
    }
    if kind in RESOURCE_NAME_REQUIRED and "name" not in normalized:
        raise _invalid(f"{label} name is required")
    if not normalized:
        raise _invalid(f"{label} must not be empty")
    return normalized


def _normalize_trace(value: Any, label: str) -> dict[str, Any] | None:
    if value is None:
        return None
    trace = _require_mapping(value, label)
    _reject_unknown_fields(trace, frozenset({"traceId", "spanId", "parentSpanId", "sampled"}), label)
    normalized: dict[str, Any] = {
        "traceId": _normalized_hex_id(
            trace.get("traceId"),
            TRACE_ID_PATTERN,
            ZERO_TRACE_ID,
            f"{label} traceId",
            32,
        )
    }
    for key in ("spanId", "parentSpanId"):
        if key in trace:
            normalized[key] = _normalized_hex_id(
                trace[key],
                SPAN_ID_PATTERN,
                ZERO_SPAN_ID,
                f"{label} {key}",
                16,
            )
    if "sampled" in trace:
        if not isinstance(trace["sampled"], bool):
            raise _invalid(f"{label} sampled must be a boolean")
        normalized["sampled"] = trace["sampled"]
    return normalized


def _normalize_session(value: Any, label: str) -> dict[str, str] | None:
    if value is None:
        return None
    session = _require_mapping(value, label)
    _reject_unknown_fields(session, frozenset({"id", "previousId"}), label)
    session_id = _bounded_string(session.get("id"), f"{label} id", MAX_CONTEXT_ID_LENGTH)
    normalized = {"id": session_id}
    if "previousId" in session:
        previous_id = _bounded_string(session["previousId"], f"{label} previousId", MAX_CONTEXT_ID_LENGTH)
        if previous_id == session_id:
            raise _invalid(f"{label} previousId must differ from id")
        normalized["previousId"] = previous_id
    return normalized


def _normalize_subject(value: Any, label: str) -> dict[str, str] | None:
    if value is None:
        return None
    subject = _require_mapping(value, label)
    _reject_unknown_fields(subject, frozenset({"id", "kind"}), label)
    subject_id = _bounded_string(subject.get("id"), f"{label} id", MAX_CONTEXT_ID_LENGTH)
    kind = subject.get("kind")
    if kind not in {"anonymous", "user"}:
        raise _invalid(f"{label} kind must be anonymous or user")
    return {"id": subject_id, "kind": cast(str, kind)}


def _normalize_tags(value: Any, label: str) -> dict[str, str] | None:
    if value is None:
        return None
    tags = _require_mapping(value, label)
    if not 1 <= len(tags) <= MAX_CONTEXT_TAGS:
        raise _invalid(f"{label} must contain 1-{MAX_CONTEXT_TAGS} entries")
    if any(not isinstance(key, str) for key in tags):
        raise _invalid(f"{label} key is invalid")
    normalized: dict[str, str] = {}
    for key in sorted(tags):
        if len(key) > MAX_CONTEXT_TAG_KEY_LENGTH or TAG_KEY_PATTERN.fullmatch(key) is None:
            raise _invalid(f"{label} key is invalid")
        normalized[key] = _bounded_string(tags[key], f"{label} value for {key}", MAX_CONTEXT_TAG_VALUE_LENGTH)
    return normalized


def _merge_resources(
    base: Mapping[str, Any] | None,
    override: Mapping[str, Any] | None,
) -> dict[str, dict[str, str]] | None:
    if base is None:
        return None if override is None else {key: dict(value) for key, value in override.items()}
    if override is None:
        return {key: dict(value) for key, value in base.items()}
    merged: dict[str, dict[str, str]] = {}
    for key in RESOURCE_FIELDS:
        base_section = base.get(key)
        override_section = override.get(key)
        if base_section is not None or override_section is not None:
            merged[key] = {**(base_section or {}), **(override_section or {})}
    return merged


def _bounded_string(value: Any, label: str, max_length: int = MAX_CONTEXT_STRING_LENGTH) -> str:
    if not isinstance(value, str):
        raise _invalid(f"{label} must be a string")
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > max_length
        or any(ord(character) <= 31 or 127 <= ord(character) <= 159 for character in normalized)
    ):
        raise _invalid(f"{label} is invalid")
    return normalized


def _normalized_hex_id(
    value: Any,
    pattern: re.Pattern[str],
    zero: str,
    label: str,
    width: int,
) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None or value.lower() == zero:
        raise _invalid(f"{label} must be {width} non-zero hex characters")
    return value.lower()


def _require_mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _invalid(f"{label} must be an object")
    return cast(Mapping[str, Any], value)


def _reject_unknown_fields(value: Mapping[str, Any], allowed: frozenset[str], label: str) -> None:
    unknown = sorted(str(key) for key in value if key not in allowed)
    if unknown:
        raise _invalid(f"{label} has unsupported fields: {', '.join(unknown)}")


def _invalid(message: str) -> SdkError:
    return SdkError("validation_error", message)
