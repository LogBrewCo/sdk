#!/usr/bin/env python3

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: check_sdk_parity.py <expected-fixture> <payload> [<payload> ...]", file=sys.stderr)
        return 2

    expected_fixture = Path(sys.argv[1])
    expected_payload = json.loads(expected_fixture.read_text())
    expected_events = expected_payload["events"]

    for payload_arg in sys.argv[2:]:
        payload_path = Path(payload_arg)
        payload = json.loads(payload_path.read_text())
        actual_events = payload.get("events")
        if actual_events != expected_events:
            print(f"parity failed for {payload_path}", file=sys.stderr)
            return 1

    print("sdk parity ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
