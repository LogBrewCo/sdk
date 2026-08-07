#!/usr/bin/env python3
"""Verify the public canonical LogBrew brand source and guarded outputs."""

from __future__ import annotations

import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from brand_asset_lib import (
    BRAND_ROOT,
    MASTER_SVG,
    PNG_DERIVATIVES,
    REPO_ROOT,
    SVG_DERIVATIVES,
    normalized_png_pixels,
)


MANIFEST_PATH = BRAND_ROOT / "manifest.json"
IMAGE_SUFFIXES = {".png", ".svg"}


def fail(message: str) -> None:
    raise ValueError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def geometry_sha256(root: ET.Element) -> str:
    geometry = {
        "groups": [
            element.attrib.get("transform")
            for element in root.iter()
            if element.tag.endswith("g")
        ],
        "paths": [
            [element.attrib.get("fill"), element.attrib.get("d")]
            for element in root.iter()
            if element.tag.endswith("path")
        ],
        "viewBox": root.attrib.get("viewBox"),
    }
    serialized = json.dumps(
        geometry,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(serialized).hexdigest()


def check_svg(path: Path, asset: dict[str, object], geometry_digest: str) -> None:
    root = ET.parse(path).getroot()
    expected_size = str(asset["width"])
    if root.attrib.get("width") != expected_size or root.attrib.get("height") != expected_size:
        fail(f"brand SVG output dimensions drifted: {path.relative_to(REPO_ROOT)}")
    if root.attrib.get("viewBox") != "0 0 1600 1600":
        fail(f"brand SVG viewBox drifted: {path.relative_to(REPO_ROOT)}")
    if any(element.tag.endswith("image") for element in root.iter()):
        fail(f"brand SVG must remain true vector: {path.relative_to(REPO_ROOT)}")
    if geometry_sha256(root) != geometry_digest:
        fail(f"brand SVG mug geometry drifted: {path.relative_to(REPO_ROOT)}")

    rects = [element for element in root.iter() if element.tag.endswith("rect")]
    if asset["presentation"] == "espresso_app_icon":
        expected_rect = {"width": "1600", "height": "1600", "fill": "#3C2B24"}
        if len(rects) != 1 or rects[0].attrib != expected_rect:
            fail(f"brand SVG espresso background drifted: {path.relative_to(REPO_ROOT)}")
    elif rects:
        fail(f"transparent brand SVG gained a background: {path.relative_to(REPO_ROOT)}")


def check_png(path: Path, asset: dict[str, object]) -> None:
    width, height, color_type, _pixels = normalized_png_pixels(path.read_bytes())
    expected_color_type = 2 if asset["kind"] == "png_rgb" else 6
    expected = (asset["width"], asset["height"], expected_color_type)
    if (width, height, color_type) != expected:
        fail(f"brand PNG dimensions or alpha contract drifted: {path.relative_to(REPO_ROOT)}")


def check_asset(asset: dict[str, object], geometry_digest: str) -> Path:
    relative = Path(str(asset["path"]))
    path = REPO_ROOT / relative
    if not path.is_file():
        fail(f"missing approved brand asset: {relative}")
    if sha256(path) != asset["sha256"]:
        fail(f"brand asset digest drifted: {relative}")
    if asset["kind"] == "svg":
        check_svg(path, asset, geometry_digest)
    else:
        check_png(path, asset)
    return path


def check_generation_inventory(assets: list[dict[str, object]]) -> None:
    generated = set(SVG_DERIVATIVES) | set(PNG_DERIVATIVES)
    declared = {
        str(asset["path"])
        for asset in assets
        if asset["generation"] in {"svg_derivative", "rsvg"}
    }
    if declared != generated:
        fail("manifest generation inventory does not match the generator")
    canonical = [asset for asset in assets if asset["generation"] == "canonical_source"]
    if len(canonical) != 1 or REPO_ROOT / str(canonical[0]["path"]) != MASTER_SVG:
        fail("brand inventory must have one canonical SVG source")


def check_exact_copies(copies: list[list[str]]) -> None:
    for source_relative, target_relative in copies:
        source = REPO_ROOT / source_relative
        target = REPO_ROOT / target_relative
        if source.read_bytes() != target.read_bytes():
            fail(f"exact brand copy drifted: {source_relative} != {target_relative}")


def check_inventory(expected: set[Path], legacy_hashes: set[str]) -> None:
    candidates = {
        path
        for path in BRAND_ROOT.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    }
    for path in candidates:
        if sha256(path) in legacy_hashes:
            fail(f"legacy brand artwork returned: {path.relative_to(REPO_ROOT)}")
    if candidates == expected:
        return
    unexpected = sorted(path.relative_to(REPO_ROOT).as_posix() for path in candidates - expected)
    missing = sorted(path.relative_to(REPO_ROOT).as_posix() for path in expected - candidates)
    fail(f"brand asset inventory drifted: unexpected={unexpected}, missing={missing}")


def check() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        fail("brand manifest has an unsupported schemaVersion")
    if REPO_ROOT / manifest["canonicalSource"] != MASTER_SVG:
        fail("brand manifest canonical source drifted")
    assets = manifest["assets"]
    if not isinstance(assets, list):
        fail("brand manifest assets must be a list")
    geometry_digest = str(manifest["canonicalGeometrySha256"])
    expected = {check_asset(asset, geometry_digest) for asset in assets}
    check_generation_inventory(assets)
    check_exact_copies(manifest["exactCopies"])
    check_inventory(expected, set(manifest["legacySha256"]))


def main() -> int:
    try:
        check()
    except (OSError, ValueError, ET.ParseError) as error:
        print(f"brand asset check failed: {error}", file=sys.stderr)
        return 1
    print("brand assets ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
