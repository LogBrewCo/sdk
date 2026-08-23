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
    allow_additive_investigation_evidence: bool,
) -> Any:
    if not allow_additive_context and not allow_additive_investigation_evidence:
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
        if not isinstance(expected_attributes, dict):
            continue
        if (
            allow_additive_context
            and "context" not in expected_attributes
            and isinstance(actual_attributes.get("context"), dict)
        ):
            del actual_attributes["context"]
        if allow_additive_investigation_evidence:
            _remove_additive_investigation_evidence(
                expected_event.get("type"),
                expected_attributes,
                actual_attributes,
            )

    return comparable_events


def _remove_additive_investigation_evidence(
    event_type: Any,
    expected_attributes: dict[str, Any],
    actual_attributes: dict[str, Any],
) -> None:
    allowed_fields: dict[str, dict[str, type[Any]]] = {
        "issue": {
            "exception": dict,
            "exceptionChain": dict,
            "stackFrames": list,
            "breadcrumbs": list,
            "breadcrumbsTruncated": bool,
            "evidence": dict,
        },
        "span": {
            "events": list,
            "links": list,
        },
    }
    for field, expected_type in allowed_fields.get(event_type, {}).items():
        if field in expected_attributes:
            continue
        if isinstance(actual_attributes.get(field), expected_type):
            del actual_attributes[field]


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
    parser.add_argument(
        "--allow-additive-investigation-evidence",
        action="store_true",
        help=(
            "permit schema-validated optional issue diagnostics and span evidence "
            "when the expected event omits those fields"
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
            allow_additive_investigation_evidence=args.allow_additive_investigation_evidence,
        )
        if comparable_events != expected_events:
            print(f"parity failed for {payload_path}", file=sys.stderr)
            return 1

    print("sdk parity ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
