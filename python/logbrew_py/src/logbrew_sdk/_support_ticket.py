"""Local-only support ticket draft helpers for future backend routes."""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping
from typing import Any, Literal, Protocol, TypeAlias, TypedDict, TypeGuard
from urllib.parse import urlsplit

SupportTicketSource: TypeAlias = Literal["cli", "sdk", "website", "docs", "mobile"]
SupportTicketCategory: TypeAlias = Literal[
    "sdk_install_failure",
    "ingest_failure",
    "auth_failure",
    "project_setup",
    "dashboard_issue",
    "docs_confusion",
    "cli_issue",
    "mobile_issue",
    "billing_question",
    "other",
]
SupportDiagnosticsValue: TypeAlias = (
    str | int | float | bool | None | list["SupportDiagnosticsValue"] | dict[str, "SupportDiagnosticsValue"]
)


class SupportTicketDraft(TypedDict, total=False):
    """Planned support-ticket create payload built locally without opening a ticket."""

    project_id: str
    source: SupportTicketSource
    category: SupportTicketCategory
    title: str
    description: str
    environment: str
    runtime: str
    framework: str
    sdk_package: str
    sdk_version: str
    release: str
    trace_id: str
    event_id: str
    diagnostics: dict[str, SupportDiagnosticsValue]


class CreateSupportTicketDraft(Protocol):
    def __call__(
        self,
        *,
        source: SupportTicketSource,
        category: SupportTicketCategory,
        title: str,
        description: str,
        project_id: str | None = None,
        environment: str | None = None,
        runtime: str | None = None,
        framework: str | None = None,
        sdk_package: str | None = None,
        sdk_version: str | None = None,
        release: str | None = None,
        trace_id: str | None = None,
        event_id: str | None = None,
        diagnostics: Mapping[str, Any] | None = None,
    ) -> SupportTicketDraft: ...


SUPPORT_TICKET_SOURCES = {"cli", "sdk", "website", "docs", "mobile"}
SUPPORT_TICKET_CATEGORIES = {
    "sdk_install_failure",
    "ingest_failure",
    "auth_failure",
    "project_setup",
    "dashboard_issue",
    "docs_confusion",
    "cli_issue",
    "mobile_issue",
    "billing_question",
    "other",
}

_MAX_DEPTH = 5
_MAX_STRING_LENGTH = 500
_MAX_SEQUENCE_ITEMS = 20
_REDACTED = "[redacted]"


class _OmitValue:
    __slots__ = ()


_OMIT = _OmitValue()
_SanitizedValue: TypeAlias = SupportDiagnosticsValue | _OmitValue

_SENSITIVE_KEYS = {
    "apikey",
    "auth",
    "authorization",
    "authtoken",
    "bearer",
    "clientsecret",
    "connectionstring",
    "cookie",
    "credential",
    "credentials",
    "dsn",
    "password",
    "passwd",
    "privatekey",
    "refreshtoken",
    "secret",
    "session",
    "setcookie",
    "token",
}
_SENSITIVE_ASSIGNMENT_PATTERN = re.compile(
    r"(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\s*[:=]",
    re.IGNORECASE,
)
_TOKEN_PATTERN = re.compile(
    r"(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|"
    r"\blbw_ingest_[A-Za-z0-9._-]+|"
    r"\b(?:sk|pk|xox[abprs]?)-[A-Za-z0-9_-]{10,}|"
    r"\bAKIA[0-9A-Z]{16}\b)",
    re.IGNORECASE,
)
_URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
_POSIX_PATH_PATTERN = re.compile(r"(?<![\w.-])(?:/Users|/home|/var/folders|/private/var|/tmp)/[^\s\"'<>]+")
_WINDOWS_PATH_PATTERN = re.compile(r"\b[A-Za-z]:\\[^\s\"'<>]+")


def build_create_support_ticket_draft(
    *,
    sdk_error_type: type[Exception],
    require_allowed_value: Callable[[str, Any, set[str]], None],
    require_non_empty: Callable[[str, Any], None],
    require_trace_id: Callable[[Any], None],
) -> CreateSupportTicketDraft:
    def create_support_ticket_draft(
        *,
        source: SupportTicketSource,
        category: SupportTicketCategory,
        title: str,
        description: str,
        project_id: str | None = None,
        environment: str | None = None,
        runtime: str | None = None,
        framework: str | None = None,
        sdk_package: str | None = None,
        sdk_version: str | None = None,
        release: str | None = None,
        trace_id: str | None = None,
        event_id: str | None = None,
        diagnostics: Mapping[str, Any] | None = None,
    ) -> SupportTicketDraft:
        require_allowed_value("support ticket source", source, SUPPORT_TICKET_SOURCES)
        require_allowed_value("support ticket category", category, SUPPORT_TICKET_CATEGORIES)
        require_non_empty("support ticket title", title)
        require_non_empty("support ticket description", description)

        draft: SupportTicketDraft = {
            "source": source,
            "category": category,
            "title": title.strip(),
            "description": description.strip(),
        }
        project_id = _clean_optional_string("support ticket project_id", project_id, require_non_empty)
        if project_id is not None:
            draft["project_id"] = project_id
        environment = _clean_optional_string("support ticket environment", environment, require_non_empty)
        if environment is not None:
            draft["environment"] = environment
        runtime = _clean_optional_string("support ticket runtime", runtime, require_non_empty)
        if runtime is not None:
            draft["runtime"] = runtime
        framework = _clean_optional_string("support ticket framework", framework, require_non_empty)
        if framework is not None:
            draft["framework"] = framework
        sdk_package = _clean_optional_string("support ticket sdk_package", sdk_package, require_non_empty)
        if sdk_package is not None:
            draft["sdk_package"] = sdk_package
        sdk_version = _clean_optional_string("support ticket sdk_version", sdk_version, require_non_empty)
        if sdk_version is not None:
            draft["sdk_version"] = sdk_version
        release = _clean_optional_string("support ticket release", release, require_non_empty)
        if release is not None:
            draft["release"] = release
        if trace_id is not None:
            require_trace_id(trace_id)
            draft["trace_id"] = trace_id.lower()
        event_id = _clean_optional_string("support ticket event_id", event_id, require_non_empty)
        if event_id is not None:
            draft["event_id"] = event_id
        if diagnostics is not None:
            if not isinstance(diagnostics, Mapping):
                raise sdk_error_type("validation_error", "support ticket diagnostics must be an object")
            draft["diagnostics"] = _sanitize_diagnostics(diagnostics)
        return draft

    create_support_ticket_draft.__name__ = "create_support_ticket_draft"
    create_support_ticket_draft.__doc__ = (
        "Build a local-only, token-free support-ticket create payload draft without calling backend routes."
    )
    return create_support_ticket_draft


def _clean_optional_string(
    label: str,
    value: str | None,
    require_non_empty: Callable[[str, Any], None],
) -> str | None:
    if value is None:
        return None
    require_non_empty(label, value)
    return value.strip()


def _sanitize_diagnostics(diagnostics: Mapping[str, Any]) -> dict[str, SupportDiagnosticsValue]:
    safe: dict[str, SupportDiagnosticsValue] = {}
    for key, value in diagnostics.items():
        if not isinstance(key, str) or not key:
            continue
        if _is_sensitive_key(key):
            safe[key] = _REDACTED
            continue
        sanitized = _sanitize_value(value, 0)
        if _is_support_diagnostics_value(sanitized):
            safe[key] = sanitized
    return safe


def _sanitize_value(value: Any, depth: int) -> _SanitizedValue:
    if depth > _MAX_DEPTH:
        return _OMIT
    sanitized_primitive = _sanitize_primitive(value)
    if sanitized_primitive is not _OMIT:
        return sanitized_primitive
    if isinstance(value, BaseException):
        return {"type": type(value).__name__}
    if isinstance(value, Mapping):
        return _sanitize_mapping(value, depth)
    if isinstance(value, (list, tuple)):
        return _sanitize_sequence(value, depth)
    return _OMIT


def _sanitize_primitive(value: Any) -> _SanitizedValue:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else _OMIT
    if isinstance(value, str):
        return _sanitize_string(value)
    return _OMIT


def _sanitize_mapping(value: Mapping[Any, Any], depth: int) -> dict[str, SupportDiagnosticsValue]:
    safe: dict[str, SupportDiagnosticsValue] = {}
    for key, nested in value.items():
        if not isinstance(key, str) or not key:
            continue
        if _is_sensitive_key(key):
            safe[key] = _REDACTED
            continue
        sanitized = _sanitize_value(nested, depth + 1)
        if _is_support_diagnostics_value(sanitized):
            safe[key] = sanitized
    return safe


def _sanitize_sequence(value: list[Any] | tuple[Any, ...], depth: int) -> list[SupportDiagnosticsValue]:
    safe_items: list[SupportDiagnosticsValue] = []
    for item in value[:_MAX_SEQUENCE_ITEMS]:
        sanitized = _sanitize_value(item, depth + 1)
        if _is_support_diagnostics_value(sanitized):
            safe_items.append(sanitized)
    return safe_items


def _is_support_diagnostics_value(value: _SanitizedValue) -> TypeGuard[SupportDiagnosticsValue]:
    return not isinstance(value, _OmitValue)


def _is_sensitive_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    return normalized in _SENSITIVE_KEYS


def _sanitize_string(value: str) -> str:
    if _SENSITIVE_ASSIGNMENT_PATTERN.search(value) or _TOKEN_PATTERN.search(value):
        return _REDACTED
    sanitized = _URL_PATTERN.sub(_redact_url, value)
    sanitized = _POSIX_PATH_PATTERN.sub("[redacted-path]", sanitized)
    sanitized = _WINDOWS_PATH_PATTERN.sub("[redacted-path]", sanitized)
    if len(sanitized) > _MAX_STRING_LENGTH:
        return sanitized[: _MAX_STRING_LENGTH - 3] + "..."
    return sanitized


def _redact_url(match: re.Match[str]) -> str:
    parsed = urlsplit(match.group(0))
    path = parsed.path or ""
    return f"[redacted-url]{path}"
