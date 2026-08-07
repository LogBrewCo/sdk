from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

GENERATOR_SPEC = importlib.util.spec_from_file_location(
    "generate_brand_assets",
    SCRIPTS / "generate_brand_assets.py",
)
assert GENERATOR_SPEC is not None
generate_brand_assets = importlib.util.module_from_spec(GENERATOR_SPEC)
assert GENERATOR_SPEC.loader is not None
GENERATOR_SPEC.loader.exec_module(generate_brand_assets)

CHECKER_SPEC = importlib.util.spec_from_file_location(
    "check_brand_assets",
    SCRIPTS / "check_brand_assets.py",
)
assert CHECKER_SPEC is not None
check_brand_assets = importlib.util.module_from_spec(CHECKER_SPEC)
assert CHECKER_SPEC.loader is not None
CHECKER_SPEC.loader.exec_module(check_brand_assets)


class BrandAssetTests(unittest.TestCase):
    def test_manifest_and_guarded_inventory_are_current(self) -> None:
        check_brand_assets.check()

    def test_svg_derivatives_are_exactly_reproducible(self) -> None:
        for relative, (presentation, size) in generate_brand_assets.SVG_DERIVATIVES.items():
            with self.subTest(relative=relative):
                self.assertEqual(
                    (ROOT / relative).read_bytes(),
                    generate_brand_assets.derive_svg(presentation, size),
                )

    def test_png_decoder_normalizes_rgb_and_rgba_outputs(self) -> None:
        rgb = ROOT / "assets/brand/logbrew-logo-espresso-bg-128.png"
        rgba = ROOT / "assets/brand/logbrew-logo-transparent-128.png"
        rgb_width, rgb_height, rgb_type, rgb_pixels = (
            generate_brand_assets.normalized_png_pixels(rgb.read_bytes())
        )
        rgba_width, rgba_height, rgba_type, rgba_pixels = (
            generate_brand_assets.normalized_png_pixels(rgba.read_bytes())
        )
        self.assertEqual((rgb_width, rgb_height, rgb_type), (128, 128, 2))
        self.assertEqual((rgba_width, rgba_height, rgba_type), (128, 128, 6))
        self.assertEqual(len(rgb_pixels), 128 * 128 * 4)
        self.assertEqual(len(rgba_pixels), 128 * 128 * 4)


if __name__ == "__main__":
    unittest.main()
