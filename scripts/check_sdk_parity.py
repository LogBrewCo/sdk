#!/usr/bin/env python3

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any, Sequence


def _comparison_events(
    expected_events: Any,
    actual_events: Any,
    *,
    allow_additive_context: bool,
) -> Any:
    if not allow_additive_context:
        return actual_events

    comparable_events = copy.deepcopy(actual_events)
    if not isinstance(expected_events, list) or not isinstance(comparable_events, list):
        return comparable_events

    for expected_event, actual_event in zip(expected_events, comparable_events):
        if not isinstance(expected_event, dict) or not isinstance(actual_event, dict):
            continue
        expected_attributes = expected_event.get("attributes")
        actual_attributes = actual_event.get("attributes")
        if not isinstance(actual_attributes, dict):
            continue
        if isinstance(expected_attributes, dict) and "context" in expected_attributes:
            continue
        if isinstance(actual_attributes.get("context"), dict):
            del actual_attributes["context"]

    return comparable_events


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare emitted SDK events with the canonical fixture.",
    )
    parser.add_argument(
        "--allow-additive-context",
        action="store_true",
        help=(
            "permit a schema-validated attributes.context object when the "
            "expected event has no context"
        ),
    )
    parser.add_argument("expected_fixture", type=Path)
    parser.add_argument("payloads", type=Path, nargs="+")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)

    expected_payload = json.loads(args.expected_fixture.read_text())
    expected_events = expected_payload["events"]

    for payload_path in args.payloads:
        payload = json.loads(payload_path.read_text())
        actual_events = payload.get("events")
        comparable_events = _comparison_events(
            expected_events,
            actual_events,
            allow_additive_context=args.allow_additive_context,
        )
        if comparable_events != expected_events:
            print(f"parity failed for {payload_path}", file=sys.stderr)
            return 1

    print("sdk parity ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
