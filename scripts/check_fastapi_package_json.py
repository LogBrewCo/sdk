#!/usr/bin/env python3
"""Validate FastAPI package smoke JSON without depending on serialization whitespace."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, NoReturn


class JsonCheckError(ValueError):
    pass


def _reject_non_finite(_value: str) -> NoReturn:
    raise JsonCheckError("non-finite JSON value is invalid")


def _load_document(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as handle:
            document = json.load(handle, parse_constant=_reject_non_finite)
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise JsonCheckError("invalid JSON document") from None
    if not isinstance(document, dict):
        raise JsonCheckError("JSON document must be an object")
    return document


def _check_event_kinds(document: dict[str, Any], expected_kinds: tuple[str, ...]) -> None:
    if not expected_kinds or any(not kind for kind in expected_kinds):
        raise JsonCheckError("event-kind expectations are invalid")
    events = document.get("events")
    if not isinstance(events, list) or not events:
        raise JsonCheckError("events must be a non-empty array")
    actual_kinds: set[str] = set()
    for event in events:
        if not isinstance(event, dict) or not isinstance(event.get("type"), str) or not event["type"]:
            raise JsonCheckError("event type is missing or invalid")
        actual_kinds.add(event["type"])
    if not set(expected_kinds).issubset(actual_kinds):
        raise JsonCheckError("required event kind is missing")


def _check_fields(document: dict[str, Any], expectations: tuple[str, ...]) -> None:
    if not expectations:
        raise JsonCheckError("field expectations are missing")
    for expectation in expectations:
        key, separator, encoded_expected = expectation.partition("=")
        if not separator or not key or not encoded_expected:
            raise JsonCheckError("field expectation is invalid")
        try:
            expected = json.loads(encoded_expected, parse_constant=_reject_non_finite)
        except json.JSONDecodeError:
            raise JsonCheckError("field expectation is invalid") from None
        if key not in document:
            raise JsonCheckError("required field is missing")
        actual = document[key]
        if type(actual) is not type(expected) or actual != expected:
            raise JsonCheckError("required field value changed")


def main(arguments: list[str]) -> int:
    if len(arguments) < 3:
        print("fastapi package JSON check failed: invalid checker arguments", file=sys.stderr)
        return 2
    mode = arguments[0]
    expectations = tuple(arguments[1:-1])
    path = Path(arguments[-1])
    try:
        document = _load_document(path)
        if mode == "event-kinds":
            _check_event_kinds(document, expectations)
        elif mode == "fields":
            _check_fields(document, expectations)
        else:
            raise JsonCheckError("checker mode is invalid")
    except JsonCheckError as error:
        print(f"fastapi package JSON check failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
