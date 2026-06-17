#!/usr/bin/env python3
"""Validate the Rust Actix request middleware preview payload."""

from __future__ import annotations

import sys

from check_rust_framework_request_payload import validate_payload


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: check_rust_actix_payload.py STDOUT_JSON STDERR_JSON")

    validate_payload(
        sys.argv[1], sys.argv[2], framework="actix-web", route_template="/checkout/{cart_id}"
    )
    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
