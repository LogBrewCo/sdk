#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any


ALLOWED_TYPES = {"release", "environment", "issue", "log", "span", "action", "metric"}
SDK_KEYS = {"name", "language", "version"}
EVENT_KEYS = {"type", "timestamp", "id", "attributes"}
REQUIRED_ATTRIBUTES = {
    "release": {"version"},
    "environment": {"name"},
    "issue": {"title", "level"},
    "log": {"message", "level"},
    "span": {"name", "traceId", "spanId", "status"},
    "action": {"name", "status"},
    "metric": {"name", "kind", "value", "unit", "temporality"},
}
ENUMS = {
    ("issue", "level"): {"info", "warning", "error", "critical"},
    ("log", "level"): {"debug", "info", "warning", "error"},
    ("span", "status"): {"ok", "error"},
    ("action", "status"): {"queued", "running", "success", "failure"},
    ("metric", "kind"): {"counter", "gauge", "histogram"},
}
METRIC_TEMPORALITIES_BY_KIND = {
    "counter": {"delta", "cumulative"},
    "gauge": {"instant"},
    "histogram": {"delta", "cumulative"},
}
NON_NEGATIVE_METRIC_KINDS = {"counter", "histogram"}
OPTIONAL_ATTRIBUTES = {
    "release": {"commit", "notes", "metadata"},
    "environment": {"region", "metadata"},
    "issue": {"message", "metadata", "stackFrames"},
    "log": {"logger", "metadata"},
    "span": {"parentSpanId", "durationMs", "metadata", "events", "links"},
    "action": {"metadata"},
    "metric": {"metadata"},
}
REQUIRED_STRING_ATTRIBUTES = {
    event_type: required_attributes - {"value"}
    for event_type, required_attributes in REQUIRED_ATTRIBUTES.items()
}
OPTIONAL_STRING_ATTRIBUTES = {
    ("release", "commit"): True,
    ("release", "notes"): False,
    ("environment", "region"): False,
    ("issue", "message"): False,
    ("log", "logger"): False,
    ("span", "parentSpanId"): True,
}
TRACE_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{32}$")
SPAN_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{16}$")
DEBUG_ID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
ZERO_TRACE_ID = "0" * 32
ZERO_SPAN_ID = "0" * 16


class ValidationError(Exception):
    pass


def _parse_timestamp(value: str) -> None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(f"invalid timestamp: {value}") from exc
    if parsed.tzinfo is None:
        raise ValidationError(f"timestamp must include a timezone offset: {value}")


def _require_non_empty_string(obj: dict[str, Any], key: str) -> None:
    value = obj.get(key)
    if not isinstance(value, str) or not value:
        raise ValidationError(f"{key} must be a non-empty string")


def _reject_unknown_keys(obj: dict[str, Any], allowed_keys: set[str], label: str) -> None:
    extra_keys = set(obj) - allowed_keys
    if extra_keys:
        extras = ", ".join(sorted(extra_keys))
        raise ValidationError(f"{label} has unsupported fields: {extras}")


def _validate_metadata(index: int, attributes: dict[str, Any]) -> None:
    metadata = attributes.get("metadata")
    if metadata is None:
        return
    if not isinstance(metadata, dict):
        raise ValidationError(f"event {index} attribute metadata must be an object")
    for key, value in metadata.items():
        if not isinstance(key, str):
            raise ValidationError(f"event {index} metadata keys must be strings")
        if not isinstance(value, (str, int, float, bool)) and value is not None:
            raise ValidationError(
                f"event {index} metadata value for {key} must be a string, number, boolean, or null"
            )


def _validate_span_events(index: int, attributes: dict[str, Any]) -> None:
    events = attributes.get("events")
    if events is None:
        return
    if not isinstance(events, list):
        raise ValidationError(f"event {index} span events must be an array")
    if len(events) > 8:
        raise ValidationError(f"event {index} span events must contain at most 8 entries")
    for event_index, event in enumerate(events):
        if not isinstance(event, dict):
            raise ValidationError(f"event {index} span event {event_index} must be an object")
        _reject_unknown_keys(event, {"name", "timestamp", "metadata"}, f"event {index} span event {event_index}")
        name = event.get("name")
        if not isinstance(name, str) or not name:
            raise ValidationError(f"event {index} span event {event_index} name must be a non-empty string")
        timestamp = event.get("timestamp")
        if timestamp is not None:
            if not isinstance(timestamp, str) or not timestamp:
                raise ValidationError(f"event {index} span event {event_index} timestamp must be a non-empty string")
            _parse_timestamp(timestamp)
        metadata = event.get("metadata")
        if metadata is None:
            continue
        if not isinstance(metadata, dict):
            raise ValidationError(f"event {index} span event {event_index} metadata must be an object")
        for key, value in metadata.items():
            if not isinstance(key, str):
                raise ValidationError(f"event {index} span event {event_index} metadata keys must be strings")
            if not isinstance(value, (str, int, float, bool)) and value is not None:
                raise ValidationError(
                    f"event {index} span event {event_index} metadata value for {key} "
                    "must be a string, number, boolean, or null"
                )


def _validate_span_links(index: int, attributes: dict[str, Any]) -> None:
    links = attributes.get("links")
    if links is None:
        return
    if not isinstance(links, list):
        raise ValidationError(f"event {index} span links must be an array")
    if len(links) > 8:
        raise ValidationError(f"event {index} span links must contain at most 8 entries")
    for link_index, link in enumerate(links):
        if not isinstance(link, dict):
            raise ValidationError(f"event {index} span link {link_index} must be an object")
        _reject_unknown_keys(link, {"traceId", "spanId", "sampled", "metadata"}, f"event {index} span link {link_index}")
        trace_id = link.get("traceId")
        if not isinstance(trace_id, str) or not TRACE_ID_PATTERN.fullmatch(trace_id):
            raise ValidationError(f"event {index} span link {link_index} traceId must be 32 hex characters")
        if trace_id.lower() == ZERO_TRACE_ID:
            raise ValidationError(f"event {index} span link {link_index} traceId must not be all zeros")
        span_id = link.get("spanId")
        if not isinstance(span_id, str) or not SPAN_ID_PATTERN.fullmatch(span_id):
            raise ValidationError(f"event {index} span link {link_index} spanId must be 16 hex characters")
        if span_id.lower() == ZERO_SPAN_ID:
            raise ValidationError(f"event {index} span link {link_index} spanId must not be all zeros")
        if "sampled" in link and not isinstance(link["sampled"], bool):
            raise ValidationError(f"event {index} span link {link_index} sampled must be a boolean")
        metadata = link.get("metadata")
        if metadata is None:
            continue
        if not isinstance(metadata, dict):
            raise ValidationError(f"event {index} span link {link_index} metadata must be an object")
        for key, value in metadata.items():
            if not isinstance(key, str):
                raise ValidationError(f"event {index} span link {link_index} metadata keys must be strings")
            if not isinstance(value, (str, int, float, bool)) and value is not None:
                raise ValidationError(
                    f"event {index} span link {link_index} metadata value for {key} "
                    "must be a string, number, boolean, or null"
                )


def _validate_issue_stack_frames(index: int, attributes: dict[str, Any]) -> None:
    frames = attributes.get("stackFrames")
    if frames is None:
        return
    if not isinstance(frames, list) or not 1 <= len(frames) <= 32:
        raise ValidationError(f"event {index} issue stackFrames must contain 1-32 entries")
    for frame_index, frame in enumerate(frames):
        label = f"event {index} issue stack frame {frame_index}"
        if not isinstance(frame, dict):
            raise ValidationError(f"{label} must be an object")
        _reject_unknown_keys(frame, {"filename", "line", "column", "debugId"}, label)
        filename = frame.get("filename")
        if (
            not isinstance(filename, str)
            or not filename
            or len(filename) > 2_048
            or "?" in filename
            or "#" in filename
            or any(ord(character) <= 31 or ord(character) == 127 for character in filename)
        ):
            raise ValidationError(f"{label} filename is invalid")
        for coordinate in ("line", "column"):
            value = frame.get(coordinate)
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or not 1 <= value <= 2_147_483_647
            ):
                raise ValidationError(f"{label} {coordinate} must be a positive integer")
        debug_id = frame.get("debugId")
        if debug_id is not None and (
            not isinstance(debug_id, str) or DEBUG_ID_PATTERN.fullmatch(debug_id) is None
        ):
            raise ValidationError(f"{label} debugId must be a UUID")


def _validate_optional_attributes(index: int, event_type: str, attributes: dict[str, Any]) -> None:
    for (expected_type, key), require_non_empty in OPTIONAL_STRING_ATTRIBUTES.items():
        if expected_type != event_type or key not in attributes:
            continue
        value = attributes[key]
        if not isinstance(value, str):
            raise ValidationError(f"event {index} attribute {key} must be a string")
        if require_non_empty and not value:
            raise ValidationError(f"event {index} attribute {key} must be a non-empty string")


def _validate_metric_attributes(index: int, attributes: dict[str, Any]) -> None:
    value = attributes["value"]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValidationError(f"event {index} attribute value must be a finite number")

    kind = attributes["kind"]
    temporality = attributes["temporality"]
    allowed_temporalities = METRIC_TEMPORALITIES_BY_KIND[kind]
    if temporality not in allowed_temporalities:
        allowed_display = ", ".join(sorted(allowed_temporalities))
        raise ValidationError(
            f"event {index} attribute temporality for {kind} must be one of: {allowed_display}"
        )
    if kind in NON_NEGATIVE_METRIC_KINDS and value < 0:
        raise ValidationError(f"event {index} attribute value for {kind} must be non-negative")


def validate_payload(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise ValidationError("payload must be an object")
    _reject_unknown_keys(payload, {"sdk", "events"}, "payload")

    sdk = payload.get("sdk")
    if not isinstance(sdk, dict):
        raise ValidationError("sdk must be an object")
    _reject_unknown_keys(sdk, SDK_KEYS, "sdk")
    for key in SDK_KEYS:
        _require_non_empty_string(sdk, key)

    events = payload.get("events")
    if not isinstance(events, list) or not events:
        raise ValidationError("events must be a non-empty array")

    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise ValidationError(f"event {index} must be an object")
        _reject_unknown_keys(event, EVENT_KEYS, f"event {index}")
        _require_non_empty_string(event, "type")
        _require_non_empty_string(event, "timestamp")
        _require_non_empty_string(event, "id")

        event_type = event["type"]
        if event_type not in ALLOWED_TYPES:
            raise ValidationError(f"event {index} has unsupported type: {event_type}")
        _parse_timestamp(event["timestamp"])

        attributes = event.get("attributes")
        if not isinstance(attributes, dict):
            raise ValidationError(f"event {index} attributes must be an object")

        missing = REQUIRED_ATTRIBUTES[event_type] - attributes.keys()
        if missing:
            missing_keys = ", ".join(sorted(missing))
            raise ValidationError(f"event {index} missing attributes: {missing_keys}")

        for key in REQUIRED_STRING_ATTRIBUTES[event_type]:
            if not isinstance(attributes.get(key), str) or not attributes[key]:
                raise ValidationError(f"event {index} attribute {key} must be a non-empty string")

        allowed_attribute_keys = REQUIRED_ATTRIBUTES[event_type] | OPTIONAL_ATTRIBUTES[event_type]
        _reject_unknown_keys(attributes, allowed_attribute_keys, f"event {index} attributes")

        for enum_key, allowed_values in ENUMS.items():
            if enum_key[0] != event_type:
                continue
            value = attributes.get(enum_key[1])
            if value not in allowed_values:
                allowed_display = ", ".join(sorted(allowed_values))
                raise ValidationError(
                    f"event {index} attribute {enum_key[1]} must be one of: {allowed_display}"
                )

        if event_type == "span" and "durationMs" in attributes:
            duration = attributes["durationMs"]
            if isinstance(duration, bool) or not isinstance(duration, (int, float)) or duration < 0:
                raise ValidationError(f"event {index} attribute durationMs must be a non-negative number")

        if event_type == "span":
            _validate_span_events(index, attributes)
            _validate_span_links(index, attributes)

        if event_type == "issue":
            _validate_issue_stack_frames(index, attributes)

        if event_type == "metric":
            _validate_metric_attributes(index, attributes)

        _validate_optional_attributes(index, event_type, attributes)
        _validate_metadata(index, attributes)


def _result_payload(ok: bool, message: str, fixture: Path) -> dict[str, Any]:
    return {
        "ok": ok,
        "fixture": str(fixture),
        "message": message,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate LogBrew public SDK fixtures.")
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--expect-invalid", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args()

    def emit(ok: bool, message: str) -> int:
        if args.json_output:
            print(json.dumps(_result_payload(ok=ok, message=message, fixture=args.fixture)))
        else:
            print(message)
        return 0 if ok else 1

    try:
        payload = json.loads(args.fixture.read_text())
    except FileNotFoundError:
        return emit(False, f"fixture not found: {args.fixture}")
    except json.JSONDecodeError as exc:
        return emit(False, f"invalid JSON: {exc.msg}")

    try:
        validate_payload(payload)
    except ValidationError as exc:
        if args.expect_invalid:
            return emit(True, f"invalid as expected: {exc}")
        return emit(False, f"validation failed: {exc}")

    if args.expect_invalid:
        return emit(False, "expected fixture to be invalid, but validation passed")

    return emit(True, "valid")


if __name__ == "__main__":
    raise SystemExit(main())
