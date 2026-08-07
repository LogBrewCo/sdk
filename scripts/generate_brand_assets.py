#!/usr/bin/env python3
"""Generate every plain LogBrew logo and app/store raster from one SVG source."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from brand_asset_lib import (
    PNG_DERIVATIVES,
    REPO_ROOT,
    SVG_DERIVATIVES,
    derive_svg,
    normalized_png_pixels,
    render_png,
)


def expected_outputs() -> dict[Path, bytes]:
    outputs = {
        REPO_ROOT / relative: derive_svg(presentation, size)
        for relative, (presentation, size) in SVG_DERIVATIVES.items()
    }
    rendered: dict[tuple[str, int], bytes] = {}
    for relative, (presentation, size) in PNG_DERIVATIVES.items():
        key = (presentation, size)
        rendered.setdefault(key, render_png(derive_svg(presentation, 1600), size))
        outputs[REPO_ROOT / relative] = rendered[key]
    return outputs


def check_outputs(outputs: dict[Path, bytes]) -> list[str]:
    failures: list[str] = []
    for path, expected in outputs.items():
        relative = path.relative_to(REPO_ROOT)
        if not path.is_file():
            failures.append(f"missing generated brand asset: {relative}")
            continue
        actual = path.read_bytes()
        if path.suffix == ".png":
            if normalized_png_pixels(actual) != normalized_png_pixels(expected):
                failures.append(f"generated brand pixels drifted: {relative}")
        elif actual != expected:
            failures.append(f"generated brand vector drifted: {relative}")
    return failures


def write_outputs(outputs: dict[Path, bytes]) -> None:
    for path, content in outputs.items():
        path.write_bytes(content)
        print(f"generated {path.relative_to(REPO_ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()
    try:
        outputs = expected_outputs()
        if args.check:
            failures = check_outputs(outputs)
            if failures:
                for failure in failures:
                    print(f"- {failure}", file=sys.stderr)
                return 1
            print("generated brand assets match the canonical SVG")
        else:
            write_outputs(outputs)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"brand asset generation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
