from __future__ import annotations

import argparse
import runpy

EXAMPLES = {
    "outbound-http": "logbrew_django.examples.outbound_http",
    "readme-example": "logbrew_django.examples.readme_example",
    "real-user-smoke": "logbrew_django.examples.real_user_smoke",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run packaged logbrew-django examples.")
    parser.add_argument("example", nargs="?", choices=sorted(EXAMPLES), default="real-user-smoke")
    parser.add_argument("--list", action="store_true", help="List packaged examples and commands.")
    args = parser.parse_args()

    if args.list:
        print("readme-example -> python -m logbrew_django.examples readme-example")
        print("outbound-http -> python -m logbrew_django.examples outbound-http")
        print("real-user-smoke -> python -m logbrew_django.examples real-user-smoke")
        print("default (real-user-smoke) -> python -m logbrew_django.examples")
        return 0

    runpy.run_module(EXAMPLES[args.example], run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
