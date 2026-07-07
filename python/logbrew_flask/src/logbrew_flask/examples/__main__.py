from __future__ import annotations

import argparse
import runpy

EXAMPLES = {
    "readme-example": "logbrew_flask.examples.readme_example",
    "real-user-smoke": "logbrew_flask.examples.real_user_smoke",
    "outbound-http": "logbrew_flask.examples.outbound_http",
    "dependency-spans": "logbrew_flask.examples.dependency_spans",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run packaged logbrew-flask examples.")
    parser.add_argument("example", nargs="?", default="real-user-smoke", choices=sorted(EXAMPLES))
    parser.add_argument("--list", action="store_true", help="List available examples and exit.")
    args = parser.parse_args()

    if args.list:
        print("readme-example -> python -m logbrew_flask.examples readme-example")
        print("real-user-smoke -> python -m logbrew_flask.examples real-user-smoke")
        print("outbound-http -> python -m logbrew_flask.examples outbound-http")
        print("dependency-spans -> python -m logbrew_flask.examples dependency-spans")
        print("default (real-user-smoke) -> python -m logbrew_flask.examples")
        return

    runpy.run_module(EXAMPLES[args.example], run_name="__main__")


if __name__ == "__main__":
    main()
