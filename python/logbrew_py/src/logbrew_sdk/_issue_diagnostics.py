"""Privacy-bounded validation and traceback projection for issue diagnostics."""

from __future__ import annotations

import builtins
import math
import os
import re
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from logbrew_sdk._errors import SdkError

MAX_ISSUE_STACK_FRAMES = 32
MAX_ISSUE_BREADCRUMBS = 64
MAX_ISSUE_EXCEPTIONS = 8
MAX_EXCEPTION_TYPE_LENGTH = 256
MAX_EXCEPTION_MESSAGE_LENGTH = 1_024
MAX_MECHANISM_TYPE_LENGTH = 64
MAX_STACK_FILENAME_LENGTH = 2048
MAX_STACK_FUNCTION_LENGTH = 256
MAX_STACK_MODULE_LENGTH = 512
MAX_BREADCRUMB_NAME_LENGTH = 64
MAX_BREADCRUMB_MESSAGE_LENGTH = 512
MAX_BREADCRUMB_DATA_FIELDS = 8
MAX_BREADCRUMB_DATA_STRING_LENGTH = 256
MAX_STACK_COORDINATE = 2_147_483_647

_MACHINE_NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,63}$")
_DATA_KEY_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_DEBUG_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_RFC3339_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
_WINDOWS_ABSOLUTE_PATH_PATTERN = re.compile(r"^[A-Za-z]:[\\/]")
_PYTHON_MODULE_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")
_BREADCRUMB_LEVEL_ALIASES = {
    "trace": "debug",
    "debug": "debug",
    "info": "info",
    "log": "info",
    "warn": "warning",
    "warning": "warning",
    "error": "error",
    "fatal": "critical",
    "critical": "critical",
}
_EXCEPTION_RELATIONSHIPS = {
    "reported",
    "cause",
    "context",
    "aggregate_member",
    "suppressed",
}
_EXCEPTION_MESSAGE_STATES = {"captured", "truncated", "redacted", "not_captured"}
_EXCEPTION_STACK_STATES = {"captured", "truncated", "not_captured"}


def validate_issue_diagnostics(attributes: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and detach the structured diagnostic fields on one issue."""

    diagnostics: dict[str, Any] = {}
    if "exception" in attributes:
        diagnostics["exception"] = _validate_exception(attributes["exception"])
    if "stackFrames" in attributes:
        diagnostics["stackFrames"] = validate_issue_stack_frames(attributes["stackFrames"])
    if "exceptionChain" in attributes:
        diagnostics["exceptionChain"] = _validate_exception_chain(
            attributes["exceptionChain"],
            diagnostics.get("exception"),
            diagnostics.get("stackFrames"),
        )
    if "breadcrumbs" in attributes:
        diagnostics["breadcrumbs"] = _validate_breadcrumbs(attributes["breadcrumbs"])
    if "breadcrumbsTruncated" in attributes:
        truncated = attributes["breadcrumbsTruncated"]
        if not isinstance(truncated, bool):
            raise SdkError("validation_error", "issue breadcrumbsTruncated must be a boolean")
        if truncated:
            diagnostics["breadcrumbsTruncated"] = True
    return diagnostics


def validate_issue_stack_frames(stack_frames: Any) -> list[dict[str, Any]]:
    """Validate, sanitize, and detach an explicit issue stack-frame snapshot."""

    if not isinstance(stack_frames, list) or not 1 <= len(stack_frames) <= MAX_ISSUE_STACK_FRAMES:
        raise SdkError(
            "validation_error",
            f"issue stackFrames must contain 1-{MAX_ISSUE_STACK_FRAMES} frames",
        )
    return [_validate_stack_frame(frame) for frame in stack_frames]


def issue_stack_frames_from_exception(error: BaseException) -> list[dict[str, Any]]:
    """Project traceback code identity without source lines, locals, or absolute paths."""

    return _issue_stack_projection(error, include_stack_frames=True)[0]


def issue_exception_chain_from_exception(
    error: BaseException,
    *,
    mechanism: str,
    handled: bool,
    include_stack_frames: bool = True,
) -> dict[str, Any]:
    """Project one bounded parent-first exception tree without locals or source text."""

    if not isinstance(error, BaseException):
        raise SdkError("validation_error", "issue error must be an exception")
    if not isinstance(include_stack_frames, bool):
        raise SdkError("validation_error", "include_stack_frames must be a boolean")

    entries: list[dict[str, Any]] = []
    seen: set[int] = set()
    truncated = False

    def append_exception(
        current: BaseException,
        *,
        parent_id: int | None,
        relationship: str,
        mechanism_type: str,
        mechanism_handled: bool,
    ) -> None:
        nonlocal truncated
        identity = id(current)
        if identity in seen or len(entries) >= MAX_ISSUE_EXCEPTIONS:
            truncated = True
            return
        seen.add(identity)

        entry_id = len(entries)
        message, message_state = _exception_message(current)
        stack_frames, stack_state = _issue_stack_projection(
            current,
            include_stack_frames=include_stack_frames,
        )
        module = _safe_exception_module(current)
        entry: dict[str, Any] = {
            "id": entry_id,
            **({"parentId": parent_id} if parent_id is not None else {}),
            "relationship": relationship,
            "type": safe_issue_exception_type(current),
            **({"message": message} if message is not None else {}),
            "messageState": message_state,
            **({"module": module} if module is not None else {}),
            "mechanism": {"type": mechanism_type, "handled": mechanism_handled},
            **({"stackFrames": stack_frames} if stack_frames else {}),
            "stackFramesState": stack_state,
        }
        entries.append(entry)

        cause = getattr(current, "__cause__", None)
        suppress_context = bool(getattr(current, "__suppress_context__", False))
        context = getattr(current, "__context__", None)
        if isinstance(cause, BaseException):
            append_exception(
                cause,
                parent_id=entry_id,
                relationship="cause",
                mechanism_type="python.cause",
                mechanism_handled=True,
            )
        elif not suppress_context and isinstance(context, BaseException):
            append_exception(
                context,
                parent_id=entry_id,
                relationship="context",
                mechanism_type="python.context",
                mechanism_handled=True,
            )

        for member in _exception_group_members(current):
            append_exception(
                member,
                parent_id=entry_id,
                relationship="aggregate_member",
                mechanism_type="python.aggregate_member",
                mechanism_handled=True,
            )

    append_exception(
        error,
        parent_id=None,
        relationship="reported",
        mechanism_type=mechanism,
        mechanism_handled=handled,
    )
    return {"entries": entries, "truncated": truncated}


def _issue_stack_projection(
    error: BaseException,
    *,
    include_stack_frames: bool,
) -> tuple[list[dict[str, Any]], str]:
    if not include_stack_frames:
        return [], "not_captured"

    frames: list[dict[str, Any]] = []
    traceback = error.__traceback__
    while traceback is not None:
        frame = traceback.tb_frame
        filename = _sanitize_frame_filename(frame.f_code.co_filename, always_basename=True)
        function_name = _safe_generated_function(frame.f_code.co_name)
        module_name = _safe_generated_module(frame.f_globals.get("__name__"))
        line = traceback.tb_lineno
        frames.append(
            {
                "filename": filename or "unknown.py",
                "line": line if 1 <= line <= MAX_STACK_COORDINATE else 1,
                "column": 1,
                **({"function": function_name} if function_name is not None else {}),
                **({"module": module_name} if module_name is not None else {}),
            }
        )
        traceback = traceback.tb_next

    most_recent_first = list(reversed(frames))[:MAX_ISSUE_STACK_FRAMES]
    validated = [_validate_stack_frame(frame) for frame in most_recent_first]
    if not validated:
        return [], "not_captured"
    return validated, "truncated" if len(frames) > MAX_ISSUE_STACK_FRAMES else "captured"


def _exception_message(error: BaseException) -> tuple[str | None, str]:
    try:
        message = " ".join(str(error).split())
    except Exception:
        return None, "not_captured"
    if not message:
        return None, "not_captured"
    if len(message) > MAX_EXCEPTION_MESSAGE_LENGTH:
        return message[:MAX_EXCEPTION_MESSAGE_LENGTH], "truncated"
    return message, "captured"


def _safe_exception_module(error: BaseException) -> str | None:
    module = getattr(type(error), "__module__", None)
    if module in {None, "builtins", "__builtins__"} or not isinstance(module, str):
        return None
    return (
        module
        if _valid_bounded_text(module, MAX_STACK_MODULE_LENGTH, reject_location_text=True)
        else None
    )


def _exception_group_members(error: BaseException) -> tuple[BaseException, ...]:
    group_type = getattr(builtins, "BaseExceptionGroup", None)
    if not isinstance(group_type, type) or not isinstance(error, group_type):
        return ()
    members = getattr(error, "exceptions", ())
    return tuple(member for member in members if isinstance(member, BaseException))


def safe_issue_exception_type(error: BaseException) -> str:
    """Return a schema-safe exception class name without using exception content."""

    if not isinstance(error, BaseException):
        raise SdkError("validation_error", "issue error must be an exception")
    name = type(error).__name__
    if name.isidentifier() and _valid_bounded_text(
        name,
        MAX_EXCEPTION_TYPE_LENGTH,
        reject_location_text=True,
    ):
        return name
    return "Exception"


def _validate_exception(value: Any) -> dict[str, Any]:
    exception = _require_object("issue exception", value)
    _reject_unknown_keys("issue exception", exception, {"type", "mechanism"})
    exception_type = _bounded_text(
        "issue exception type",
        exception.get("type"),
        MAX_EXCEPTION_TYPE_LENGTH,
        reject_location_text=True,
    )
    validated: dict[str, Any] = {"type": exception_type}
    if "mechanism" in exception:
        validated["mechanism"] = _validate_mechanism(exception["mechanism"])
    return validated


def _validate_exception_chain(
    value: Any,
    legacy_exception: Any,
    legacy_stack_frames: Any,
) -> dict[str, Any]:
    chain = _require_object("issue exceptionChain", value)
    _reject_unknown_keys("issue exceptionChain", chain, {"entries", "truncated"})
    entries = chain.get("entries")
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_ISSUE_EXCEPTIONS:
        raise SdkError(
            "validation_error",
            f"issue exceptionChain entries must contain 1-{MAX_ISSUE_EXCEPTIONS} exceptions",
        )
    truncated = chain.get("truncated")
    if not isinstance(truncated, bool):
        raise SdkError("validation_error", "issue exceptionChain truncated must be a boolean")
    validated_entries = [
        _validate_exception_chain_entry(entry, entry_index)
        for entry_index, entry in enumerate(entries)
    ]
    reported = validated_entries[0]
    reported_exception = {
        key: reported[key] for key in ("type", "mechanism") if key in reported
    }
    if legacy_exception != reported_exception:
        raise SdkError(
            "validation_error",
            "issue exceptionChain reported exception must match exception",
        )
    reported_frames = reported.get("stackFrames")
    if reported["stackFramesState"] == "not_captured":
        if legacy_stack_frames is not None:
            raise SdkError(
                "validation_error",
                "issue exceptionChain reported stack must match stackFrames",
            )
    elif reported_frames != legacy_stack_frames:
        raise SdkError(
            "validation_error",
            "issue exceptionChain reported stack must match stackFrames",
        )
    return {"entries": validated_entries, "truncated": truncated}


def _validate_exception_chain_entry(value: Any, entry_index: int) -> dict[str, Any]:
    label = f"issue exceptionChain entry {entry_index}"
    entry = _require_object(label, value)
    _reject_unknown_keys(
        label,
        entry,
        {
            "id",
            "parentId",
            "relationship",
            "type",
            "message",
            "messageState",
            "module",
            "mechanism",
            "stackFrames",
            "stackFramesState",
        },
    )
    entry_id = entry.get("id")
    if isinstance(entry_id, bool) or entry_id != entry_index:
        raise SdkError(
            "validation_error",
            f"{label} id must be the contiguous parent-first index",
        )
    relationship = entry.get("relationship")
    parent_id = entry.get("parentId")
    if entry_index == 0:
        if relationship != "reported" or parent_id is not None:
            raise SdkError(
                "validation_error",
                f"{label} must be the parentless reported exception",
            )
    elif (
        relationship not in _EXCEPTION_RELATIONSHIPS - {"reported"}
        or isinstance(parent_id, bool)
        or not isinstance(parent_id, int)
        or not 0 <= parent_id < entry_index
    ):
        raise SdkError("validation_error", f"{label} must reference an earlier parent")

    validated: dict[str, Any] = {
        "id": entry_id,
        **({"parentId": parent_id} if parent_id is not None else {}),
        "relationship": relationship,
        "type": _bounded_text(
            f"{label} type",
            entry.get("type"),
            MAX_EXCEPTION_TYPE_LENGTH,
            reject_location_text=True,
        ),
    }
    if "module" in entry:
        validated["module"] = _bounded_text(
            f"{label} module",
            entry["module"],
            MAX_STACK_MODULE_LENGTH,
            reject_location_text=True,
        )
    if "mechanism" in entry:
        validated["mechanism"] = _validate_mechanism(entry["mechanism"])

    message_state = entry.get("messageState")
    if message_state not in _EXCEPTION_MESSAGE_STATES:
        raise SdkError("validation_error", f"{label} messageState is invalid")
    if message_state in {"captured", "truncated"}:
        validated["message"] = _bounded_text(
            f"{label} message",
            entry.get("message"),
            MAX_EXCEPTION_MESSAGE_LENGTH,
        )
    elif "message" in entry:
        raise SdkError(
            "validation_error",
            f"{label} message must be absent for {message_state}",
        )
    validated["messageState"] = message_state

    stack_state = entry.get("stackFramesState")
    if stack_state not in _EXCEPTION_STACK_STATES:
        raise SdkError("validation_error", f"{label} stackFramesState is invalid")
    if stack_state in {"captured", "truncated"}:
        validated["stackFrames"] = validate_issue_stack_frames(entry.get("stackFrames"))
    elif "stackFrames" in entry:
        raise SdkError(
            "validation_error",
            f"{label} stackFrames must be absent for {stack_state}",
        )
    validated["stackFramesState"] = stack_state
    return validated


def _validate_mechanism(value: Any) -> dict[str, Any]:
    mechanism = _require_object("issue exception mechanism", value)
    _reject_unknown_keys("issue exception mechanism", mechanism, {"type", "handled"})
    mechanism_type = mechanism.get("type")
    if not isinstance(mechanism_type, str) or _MACHINE_NAME_PATTERN.fullmatch(mechanism_type) is None:
        raise SdkError(
            "validation_error",
            "issue exception mechanism type must be a stable machine name",
        )
    if len(mechanism_type) > MAX_MECHANISM_TYPE_LENGTH:
        raise SdkError(
            "validation_error",
            f"issue exception mechanism type must be at most {MAX_MECHANISM_TYPE_LENGTH} characters",
        )
    handled = mechanism.get("handled")
    if not isinstance(handled, bool):
        raise SdkError(
            "validation_error",
            "issue exception mechanism handled must be a boolean",
        )
    return {"type": mechanism_type, "handled": handled}


def _validate_stack_frame(value: Any) -> dict[str, Any]:
    frame = _require_object("issue stack frame", value)
    _reject_unknown_keys(
        "issue stack frame",
        frame,
        {"filename", "line", "column", "function", "module", "inApp", "debugId"},
    )
    filename_value = frame.get("filename")
    if not isinstance(filename_value, str):
        raise SdkError("validation_error", "issue stack frame filename is invalid")
    filename = _sanitize_frame_filename(filename_value)
    if not _valid_bounded_text(filename, MAX_STACK_FILENAME_LENGTH):
        raise SdkError("validation_error", "issue stack frame filename is invalid")

    line = _positive_coordinate("line", frame.get("line"))
    column = _positive_coordinate("column", frame.get("column"))
    validated: dict[str, Any] = {"filename": filename, "line": line, "column": column}

    if "function" in frame:
        validated["function"] = _bounded_text(
            "issue stack frame function",
            frame["function"],
            MAX_STACK_FUNCTION_LENGTH,
        )
    if "module" in frame:
        validated["module"] = _bounded_text(
            "issue stack frame module",
            frame["module"],
            MAX_STACK_MODULE_LENGTH,
            reject_location_text=True,
        )
    if "inApp" in frame:
        in_app = frame["inApp"]
        if not isinstance(in_app, bool):
            raise SdkError("validation_error", "issue stack frame inApp must be a boolean")
        validated["inApp"] = in_app
    if "debugId" in frame:
        debug_id = frame["debugId"]
        if not isinstance(debug_id, str) or _DEBUG_ID_PATTERN.fullmatch(debug_id.strip()) is None:
            raise SdkError("validation_error", "issue stack frame debugId is invalid")
        validated["debugId"] = debug_id.strip().lower()
    return validated


def _validate_breadcrumbs(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_ISSUE_BREADCRUMBS:
        raise SdkError(
            "validation_error",
            f"issue breadcrumbs must contain 1-{MAX_ISSUE_BREADCRUMBS} entries",
        )
    return [_validate_breadcrumb(breadcrumb) for breadcrumb in value]


def _validate_breadcrumb(value: Any) -> dict[str, Any]:
    breadcrumb = _require_object("issue breadcrumb", value)
    _reject_unknown_keys(
        "issue breadcrumb",
        breadcrumb,
        {"timestamp", "type", "category", "level", "message", "data"},
    )
    timestamp = _rfc3339_timestamp(breadcrumb.get("timestamp"))
    category = _machine_name("issue breadcrumb category", breadcrumb.get("category"))
    validated: dict[str, Any] = {"timestamp": timestamp, "category": category}
    if "type" in breadcrumb:
        validated["type"] = _machine_name("issue breadcrumb type", breadcrumb["type"])
    if "level" in breadcrumb:
        level = breadcrumb["level"]
        normalized = _BREADCRUMB_LEVEL_ALIASES.get(level) if isinstance(level, str) else None
        if normalized is None:
            allowed = ", ".join(_BREADCRUMB_LEVEL_ALIASES)
            raise SdkError(
                "validation_error",
                f"issue breadcrumb level must be one of: {allowed}",
            )
        validated["level"] = normalized
    if "message" in breadcrumb:
        validated["message"] = _bounded_text(
            "issue breadcrumb message",
            breadcrumb["message"],
            MAX_BREADCRUMB_MESSAGE_LENGTH,
        )
    if "data" in breadcrumb:
        validated["data"] = _validate_breadcrumb_data(breadcrumb["data"])
    return validated


def _validate_breadcrumb_data(value: Any) -> dict[str, Any]:
    data = _require_object("issue breadcrumb data", value)
    if len(data) > MAX_BREADCRUMB_DATA_FIELDS:
        raise SdkError(
            "validation_error",
            f"issue breadcrumb data must contain at most {MAX_BREADCRUMB_DATA_FIELDS} fields",
        )
    validated: dict[str, Any] = {}
    for key, item in data.items():
        if _DATA_KEY_PATTERN.fullmatch(key) is None:
            raise SdkError(
                "validation_error",
                "issue breadcrumb data keys must be stable machine names",
            )
        if isinstance(item, str):
            validated[key] = _bounded_text(
                f"issue breadcrumb data value for {key}",
                item,
                MAX_BREADCRUMB_DATA_STRING_LENGTH,
            )
        elif (
            item is None
            or isinstance(item, bool)
            or (isinstance(item, (int, float)) and math.isfinite(item))
        ):
            validated[key] = item
        else:
            raise SdkError(
                "validation_error",
                f"issue breadcrumb data value for {key} must be a finite primitive",
            )
    return validated


def _positive_coordinate(label: str, value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_STACK_COORDINATE:
        raise SdkError(
            "validation_error",
            f"issue stack frame {label} must be a positive integer",
        )
    return value


def _machine_name(label: str, value: Any) -> str:
    if not isinstance(value, str) or _MACHINE_NAME_PATTERN.fullmatch(value) is None:
        raise SdkError("validation_error", f"{label} must be a stable machine name")
    if len(value) > MAX_BREADCRUMB_NAME_LENGTH:
        raise SdkError(
            "validation_error",
            f"{label} must be at most {MAX_BREADCRUMB_NAME_LENGTH} characters",
        )
    return value


def _rfc3339_timestamp(value: Any) -> str:
    if not isinstance(value, str) or _RFC3339_PATTERN.fullmatch(value) is None:
        raise SdkError(
            "validation_error",
            "issue breadcrumb timestamp must be RFC 3339 with an explicit timezone",
        )
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError as error:
        raise SdkError(
            "validation_error",
            "issue breadcrumb timestamp must be a valid RFC 3339 date-time",
        ) from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise SdkError(
            "validation_error",
            "issue breadcrumb timestamp must include a timezone",
        )
    return value


def _bounded_text(
    label: str,
    value: Any,
    maximum_length: int,
    *,
    reject_location_text: bool = False,
) -> str:
    if not _valid_bounded_text(value, maximum_length, reject_location_text=reject_location_text):
        raise SdkError(
            "validation_error",
            f"{label} is invalid or exceeds {maximum_length} characters",
        )
    assert isinstance(value, str)
    return value


def _valid_bounded_text(
    value: Any,
    maximum_length: int,
    *,
    reject_location_text: bool = False,
) -> bool:
    return bool(
        isinstance(value, str)
        and value.strip()
        and len(value) <= maximum_length
        and not _has_control_character(value)
        and not (reject_location_text and ("?" in value or "#" in value))
    )


def _safe_generated_identity(
    value: Any,
    maximum_length: int,
    *,
    reject_location_text: bool = False,
) -> str | None:
    if not _valid_bounded_text(value, maximum_length, reject_location_text=reject_location_text):
        return None
    assert isinstance(value, str)
    return value.strip()


def _safe_generated_function(value: Any) -> str | None:
    function_name = _safe_generated_identity(value, MAX_STACK_FUNCTION_LENGTH)
    if function_name is None or any(marker in function_name for marker in ("/", "\\", "?", "#")):
        return None
    return function_name


def _safe_generated_module(value: Any) -> str | None:
    module_name = _safe_generated_identity(
        value,
        MAX_STACK_MODULE_LENGTH,
        reject_location_text=True,
    )
    if module_name is None or _PYTHON_MODULE_PATTERN.fullmatch(module_name) is None:
        return None
    return module_name


def _sanitize_frame_filename(value: str, *, always_basename: bool = False) -> str:
    filename = value.strip().split("?", 1)[0].split("#", 1)[0]
    if filename.startswith("file://"):
        filename = filename[len("file://") :]
    if always_basename or os.path.isabs(filename) or _WINDOWS_ABSOLUTE_PATH_PATTERN.match(filename):
        filename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    return filename


def _require_object(label: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SdkError("validation_error", f"{label} must be an object")
    if not all(isinstance(key, str) for key in value):
        raise SdkError("validation_error", f"{label} keys must be strings")
    return value


def _reject_unknown_keys(label: str, value: Mapping[str, Any], allowed: set[str]) -> None:
    unknown = sorted(set(value).difference(allowed))
    if unknown:
        raise SdkError(
            "validation_error",
            f"{label} has unsupported fields: {', '.join(unknown)}",
        )


def _has_control_character(value: str) -> bool:
    return any(ord(character) <= 31 or 127 <= ord(character) <= 159 for character in value)
