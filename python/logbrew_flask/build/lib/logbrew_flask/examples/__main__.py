# Copyright (c) 2026 LogBrew
"""Run or list the installed Flask examples."""

from __future__ import annotations

import argparse
import runpy
import sys

EXAMPLES = {
    "readme-example": "logbrew_flask.examples.readme_example",
    "real-user-smoke": "logbrew_flask.examples.real_user_smoke",
    "outbound-http": "logbrew_flask.examples.outbound_http",
    "dependency-spans": "logbrew_flask.examples.dependency_spans",
}


def main() -> None:
    """Select one example, or print the available commands without running it."""
    parser = argparse.ArgumentParser(description="Run packaged logbrew-flask examples.")
    parser.add_argument("example", nargs="?", default="real-user-smoke", choices=sorted(EXAMPLES))
    parser.add_argument("--list", action="store_true", help="List available examples and exit.")
    args = parser.parse_args()

    if args.list:
        for name in EXAMPLES:
            sys.stdout.write(f"{name} -> python -m logbrew_flask.examples {name}\n")
        sys.stdout.write("default (real-user-smoke) -> python -m logbrew_flask.examples\n")
        return

    runpy.run_module(EXAMPLES[args.example], run_name="__main__")


if __name__ == "__main__":
    main()
