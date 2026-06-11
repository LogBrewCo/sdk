"""Agent-readable timeline helpers for product and network milestones."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

from logbrew_sdk import (
    ACTION_STATUSES,
    ActionAttributes,
    Metadata,
    MetadataValue,
    SdkError,
    compact_metadata,
    require_allowed_value,
    require_non_empty,
)

HTTP_METHOD_PATTERN = re.compile(r"^[A-Z][A-Z0-9_-]*$")


def create_product_action_attributes(
    action: str | Mapping[str, Any],
    *,
    metadata: Mapping[str, Any] | None = None,
) -> ActionAttributes:
    """Build privacy-safe action attributes for app-owned product milestones."""

    details = product_action_details(action)
    timeline_metadata = {
        "routeTemplate": sanitize_route_template(details.get("routeTemplate")),
        "sessionId": string_or_none(details.get("sessionId")),
        "traceId": string_or_none(details.get("traceId")),
        "screen": string_or_none(details.get("screen")),
        "funnel": string_or_none(details.get("funnel")),
        "step": string_or_none(details.get("step")),
    }
    return {
        "name": details["name"],
        "status": details["status"],
        "metadata": compact_metadata(
            {
                "source": "product.action",
                **dict(compact_metadata(metadata) or {}),
                **dict(compact_metadata(details.get("metadata")) or {}),
                **drop_none_values(timeline_metadata),
            }
        )
        or {},
    }


def create_network_milestone_attributes(
    request: str | Mapping[str, Any],
    *,
    metadata: Mapping[str, Any] | None = None,
) -> ActionAttributes:
    """Build privacy-safe action attributes for app-owned network milestones."""

    details = network_milestone_details(request)
    timeline_metadata = {
        "routeTemplate": details["routeTemplate"],
        "method": details["method"],
        "statusCode": details.get("statusCode"),
        "durationMs": details.get("durationMs"),
        "sessionId": string_or_none(details.get("sessionId")),
        "traceId": string_or_none(details.get("traceId")),
    }
    return {
        "name": details["name"],
        "status": details["status"],
        "metadata": compact_metadata(
            {
                "source": "network.milestone",
                **dict(compact_metadata(metadata) or {}),
                **dict(compact_metadata(details.get("metadata")) or {}),
                **drop_none_values(timeline_metadata),
            }
        )
        or {},
    }


def product_action_details(action: str | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(action, str):
        require_non_empty("product action name", action)
        return {"name": action, "status": "success"}
    if not isinstance(action, Mapping):
        raise SdkError("validation_error", "product action must be a string or object")

    require_non_empty("product action name", action.get("name"))
    status = action.get("status", "success")
    require_allowed_value("product action status", status, ACTION_STATUSES)
    return {
        "funnel": action.get("funnel"),
        "metadata": action.get("metadata"),
        "name": action["name"],
        "routeTemplate": action.get("routeTemplate"),
        "screen": action.get("screen"),
        "sessionId": action.get("sessionId"),
        "status": status,
        "step": action.get("step"),
        "traceId": action.get("traceId"),
    }


def network_milestone_details(request: str | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(request, str):
        return network_milestone_details({"routeTemplate": request})
    if not isinstance(request, Mapping):
        raise SdkError("validation_error", "network milestone must be a string or object")

    route_template = sanitize_route_template(request.get("routeTemplate"))
    require_non_empty("network milestone routeTemplate", route_template)
    method = normalize_http_method(request.get("method"))
    status_code = status_code_or_none(request.get("statusCode"))
    status = request.get("status", status_from_status_code(status_code))
    require_allowed_value("network milestone status", status, ACTION_STATUSES)
    duration_ms = non_negative_number_or_none("network milestone durationMs", request.get("durationMs"))
    name = request.get("name")
    if not isinstance(name, str) or not name.strip():
        name = f"network.{method.lower()} {route_template}"

    return {
        "durationMs": duration_ms,
        "metadata": request.get("metadata"),
        "method": method,
        "name": name,
        "routeTemplate": route_template,
        "sessionId": request.get("sessionId"),
        "status": status,
        "statusCode": status_code,
        "traceId": request.get("traceId"),
    }


def sanitize_route_template(route_template: Any) -> str | None:
    if route_template is None:
        return None
    if not isinstance(route_template, str):
        raise SdkError("validation_error", "routeTemplate must be a string")
    trimmed = route_template.strip()
    if not trimmed:
        return ""
    parsed = urlsplit(trimmed)
    if parsed.scheme or parsed.netloc:
        return parsed.path or "/"
    return re.split(r"[?#]", trimmed, maxsplit=1)[0] or "/"


def normalize_http_method(method: Any) -> str:
    value = "GET" if method is None else method
    if not isinstance(value, str) or not value.strip():
        raise SdkError("validation_error", "network milestone method must be a non-empty string")
    normalized = value.strip().upper()
    if HTTP_METHOD_PATTERN.fullmatch(normalized) is None:
        raise SdkError("validation_error", "network milestone method must be a valid HTTP method")
    return normalized


def status_code_or_none(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 100 or value > 599:
        raise SdkError("validation_error", "network milestone statusCode must be an integer from 100 to 599")
    return value


def status_from_status_code(status_code: int | None) -> str:
    if status_code is not None and status_code >= 400:
        return "failure"
    return "success"


def non_negative_number_or_none(label: str, value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise SdkError("validation_error", f"{label} must be a non-negative number")
    return float(value) if isinstance(value, int) else value


def string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def drop_none_values(metadata: Mapping[str, MetadataValue | None]) -> Metadata:
    return {key: value for key, value in metadata.items() if value is not None}
