"""Run packaged examples for installed SDK users."""

from __future__ import annotations

import argparse
from collections.abc import Callable

from . import agent_timeline, readme_example, real_user_smoke


def _example_runners() -> dict[str, Callable[[], int]]:
    return {
        "agent-timeline": agent_timeline.main,
        "readme-example": readme_example.main,
        "real-user-smoke": real_user_smoke.main,
    }


def _example_commands() -> dict[str, str]:
    commands = {
        name: f"python -m logbrew_sdk.examples {name}" for name in sorted(_example_runners())
    }
    commands["default (real-user-smoke)"] = "python -m logbrew_sdk.examples"
    return commands


def _help_epilog() -> str:
    lines = ["Packaged examples:"]
    lines.extend(
        f"  {example} -> {command}" for example, command in _example_commands().items()
    )
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the packaged LogBrew SDK examples that ship with the installed Python package.",
        epilog=_help_epilog(),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "example",
        nargs="?",
        choices=sorted(_example_runners()),
        default="real-user-smoke",
        help="packaged example to run (default: real-user-smoke)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="print the available packaged example names and exit",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.list:
        for example, command in _example_commands().items():
            print(f"{example} -> {command}")
        return 0

    return _example_runners()[args.example]()


if __name__ == "__main__":
    raise SystemExit(main())
