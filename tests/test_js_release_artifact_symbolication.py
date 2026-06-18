from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SYMBOLICATION_MODULE_PATH = ROOT / "scripts" / "verify_js_release_artifact_symbolication.py"
MANIFEST_MODULE_PATH = ROOT / "scripts" / "create_js_release_artifact_manifest.py"

SYMBOLICATION_SPEC = importlib.util.spec_from_file_location(
    "verify_js_release_artifact_symbolication",
    SYMBOLICATION_MODULE_PATH,
)
assert SYMBOLICATION_SPEC is not None
verify_js_release_artifact_symbolication = importlib.util.module_from_spec(SYMBOLICATION_SPEC)
assert SYMBOLICATION_SPEC.loader is not None
SYMBOLICATION_SPEC.loader.exec_module(verify_js_release_artifact_symbolication)

MANIFEST_SPEC = importlib.util.spec_from_file_location("create_js_release_artifact_manifest", MANIFEST_MODULE_PATH)
assert MANIFEST_SPEC is not None
create_js_release_artifact_manifest = importlib.util.module_from_spec(MANIFEST_SPEC)
assert MANIFEST_SPEC.loader is not None
MANIFEST_SPEC.loader.exec_module(create_js_release_artifact_manifest)


class JavaScriptReleaseArtifactSymbolicationTests(unittest.TestCase):
    def create_ready_manifest(
        self,
        tmp: str,
        *,
        source: str = "src/main.js",
        sources_content: bool = False,
    ) -> tuple[Path, dict[str, object]]:
        build_dir = Path(tmp) / "dist"
        build_dir.mkdir()
        js_path = build_dir / "app.js"
        map_path = build_dir / "app.js.map"
        debug_id = "11111111-2222-4333-8444-555555555555"
        js_path.write_text(
            f'function checkout(){{throw new Error("checkout exploded")}}\n'
            f"//# debugId={debug_id}\n"
            f"//# sourceMappingURL=app.js.map\n",
            encoding="utf-8",
        )
        source_map: dict[str, object] = {
            "version": 3,
            "file": "app.js",
            "sources": [source],
            "names": ["checkout"],
            "mappings": "AAAAA",
            "debug_id": debug_id,
        }
        if sources_content:
            source_map["sourcesContent"] = ['throw new Error("checkout exploded")']
        map_path.write_text(json.dumps(source_map), encoding="utf-8")
        manifest = create_js_release_artifact_manifest.create_manifest(
            build_dir=build_dir,
            release="2026.06.18",
            environment="production",
            service="checkout-web",
            minified_path_prefix="https://cdn.example/assets?cache=ignored#fragment",
            allow_sources_content=sources_content,
        )
        self.assertEqual(manifest["validation"]["status"], "ready")
        return build_dir, manifest

    def test_decode_vlq_values_and_mapping_segments(self) -> None:
        self.assertEqual(verify_js_release_artifact_symbolication.decode_vlq_values("AAAAA"), [0, 0, 0, 0, 0])
        lines = verify_js_release_artifact_symbolication.decoded_mapping_segments("AAAAA")
        self.assertEqual(lines, [[(0, 0, 0, 0, 0)]])

    def test_parse_stack_frame_accepts_v8_function_and_plain_frames(self) -> None:
        frame = verify_js_release_artifact_symbolication.parse_stack_frame(
            "    at checkout (https://cdn.example/assets/app.js?cache=ignored#fragment:1:1)"
        )
        self.assertEqual(frame["function"], "checkout")
        self.assertEqual(frame["filename"], "https://cdn.example/assets/app.js?cache=ignored#fragment")
        self.assertEqual(frame["line"], 1)
        self.assertEqual(frame["column"], 1)

        plain = verify_js_release_artifact_symbolication.parse_stack_frame("at app:///react-native/main.jsbundle:2:3")
        self.assertIsNone(plain["function"])
        self.assertEqual(plain["filename"], "app:///react-native/main.jsbundle")

    def test_symbolicates_ready_manifest_without_echoing_query_or_source_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir, manifest = self.create_ready_manifest(tmp)
            report = verify_js_release_artifact_symbolication.verify_symbolication(
                build_dir,
                manifest,
                "at checkout (https://cdn.example/assets/app.js?cache=ignored#fragment:1:1)",
            )
            serialized = json.dumps(report)

            self.assertEqual(report["status"], "resolved")
            self.assertEqual(report["debugId"], "11111111-2222-4333-8444-555555555555")
            self.assertEqual(report["generated"]["minifiedUrl"], "https://cdn.example/assets/app.js")
            self.assertEqual(report["original"]["source"], "src/main.js")
            self.assertEqual(report["original"]["line"], 1)
            self.assertEqual(report["original"]["column"], 1)
            self.assertEqual(report["original"]["name"], "checkout")
            self.assertNotIn("cache=ignored", serialized)
            self.assertNotIn("fragment", serialized)
            self.assertNotIn("checkout exploded", serialized)
            self.assertNotIn(tmp, serialized)

    def test_symbolicates_local_absolute_frame_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir, manifest = self.create_ready_manifest(tmp)
            report = verify_js_release_artifact_symbolication.verify_symbolication(
                build_dir,
                manifest,
                f"at checkout ({build_dir / 'app.js'}:1:1)",
            )

            self.assertEqual(report["status"], "resolved")
            self.assertEqual(report["generated"]["path"], "app.js")

    def test_sources_content_is_rejected_for_symbolication_proof(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir, manifest = self.create_ready_manifest(tmp, sources_content=True)

            with self.assertRaisesRegex(
                verify_js_release_artifact_symbolication.SymbolicationValidationError,
                "sourcesContent",
            ):
                verify_js_release_artifact_symbolication.verify_symbolication(
                    build_dir,
                    manifest,
                    "at checkout (https://cdn.example/assets/app.js:1:1)",
                )

    def test_absolute_original_source_is_rejected_for_symbolication_proof(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir, manifest = self.create_ready_manifest(tmp, source=f"{tmp}/src/main.js")

            with self.assertRaisesRegex(
                verify_js_release_artifact_symbolication.SymbolicationValidationError,
                "source path must be stripped",
            ):
                verify_js_release_artifact_symbolication.verify_symbolication(
                    build_dir,
                    manifest,
                    "at checkout (https://cdn.example/assets/app.js:1:1)",
                )


if __name__ == "__main__":
    unittest.main()
