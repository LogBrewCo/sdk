from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
MODULE_PATH = SCRIPTS_DIR / "prepare_js_release_artifact_debug_ids.py"
sys.path.insert(0, str(SCRIPTS_DIR))
SPEC = importlib.util.spec_from_file_location("prepare_js_release_artifact_debug_ids", MODULE_PATH)
assert SPEC is not None
prepare_js_release_artifact_debug_ids = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(prepare_js_release_artifact_debug_ids)


DEBUG_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class JavaScriptReleaseArtifactDebugIdTests(unittest.TestCase):
    def write_build(self, build_dir: Path, js_source: str, source_map: dict[str, object]) -> None:
        build_dir.mkdir(parents=True)
        (build_dir / "app.js").write_text(js_source, encoding="utf-8")
        (build_dir / "app.js.map").write_text(json.dumps(source_map), encoding="utf-8")

    def test_dry_run_plans_matching_debug_ids_without_writing_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            self.write_build(
                build_dir,
                'console.log("ok");\n//# sourceMappingURL=app.js.map\n',
                {"version": 3, "sources": ["src/app.ts"], "names": [], "mappings": "AAAA"},
            )
            original_js = (build_dir / "app.js").read_text(encoding="utf-8")

            plan = prepare_js_release_artifact_debug_ids.create_debug_id_plan(build_dir=build_dir)

            self.assertEqual(plan["validation"]["status"], "ready")
            self.assertFalse(plan["writeApplied"])
            artifact = plan["artifacts"][0]
            self.assertRegex(artifact["debugId"], DEBUG_ID_RE)
            self.assertEqual(artifact["changes"], ["minifiedSource.debugId", "sourceMap.debug_id"])
            self.assertEqual((build_dir / "app.js").read_text(encoding="utf-8"), original_js)

    def test_write_injects_debug_id_before_source_mapping_url_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            self.write_build(
                build_dir,
                'console.log("ok");\n//# sourceMappingURL=app.js.map\n',
                {"version": 3, "sources": ["src/app.ts"], "names": [], "mappings": "AAAA"},
            )

            written = prepare_js_release_artifact_debug_ids.create_debug_id_plan(build_dir=build_dir, write=True)
            second = prepare_js_release_artifact_debug_ids.create_debug_id_plan(build_dir=build_dir)

            self.assertTrue(written["writeApplied"])
            debug_id = written["artifacts"][0]["debugId"]
            self.assertEqual(second["validation"]["status"], "ready")
            self.assertEqual(second["artifacts"][0]["debugId"], debug_id)
            self.assertEqual(second["artifacts"][0]["changes"], [])

            js_lines = (build_dir / "app.js").read_text(encoding="utf-8").splitlines()
            self.assertEqual(js_lines[-2], f"//# debugId={debug_id}")
            self.assertEqual(js_lines[-1], "//# sourceMappingURL=app.js.map")
            source_map = json.loads((build_dir / "app.js.map").read_text(encoding="utf-8"))
            self.assertEqual(source_map["debug_id"], debug_id)

    def test_write_preserves_one_line_minified_source_before_source_mapping_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            self.write_build(
                build_dir,
                'console.log("ok");//# sourceMappingURL=app.js.map\n',
                {"version": 3, "sources": ["src/app.ts"], "names": [], "mappings": "AAAA"},
            )

            written = prepare_js_release_artifact_debug_ids.create_debug_id_plan(build_dir=build_dir, write=True)

            debug_id = written["artifacts"][0]["debugId"]
            js_lines = (build_dir / "app.js").read_text(encoding="utf-8").splitlines()
            self.assertEqual(js_lines[0], 'console.log("ok");')
            self.assertEqual(js_lines[1], f"//# debugId={debug_id}")
            self.assertEqual(js_lines[2], "//# sourceMappingURL=app.js.map")

    def test_existing_source_map_debug_id_is_added_to_minified_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            self.write_build(
                build_dir,
                'console.log("ok");\n//# sourceMappingURL=app.js.map\n',
                {
                    "version": 3,
                    "sources": ["src/app.ts"],
                    "names": [],
                    "mappings": "AAAA",
                    "debug_id": "map-debug-id",
                },
            )

            plan = prepare_js_release_artifact_debug_ids.create_debug_id_plan(build_dir=build_dir, write=True)

            self.assertEqual(plan["validation"]["status"], "ready")
            self.assertEqual(plan["artifacts"][0]["debugId"], "map-debug-id")
            self.assertEqual(plan["artifacts"][0]["changes"], ["minifiedSource.debugId"])
            self.assertIn("debugId=map-debug-id", (build_dir / "app.js").read_text(encoding="utf-8"))

    def test_mismatched_debug_ids_block_without_partial_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            self.write_build(
                build_dir,
                'console.log("ok");\n//# debugId=js-id\n//# sourceMappingURL=app.js.map\n',
                {
                    "version": 3,
                    "sources": ["src/app.ts"],
                    "names": [],
                    "mappings": "AAAA",
                    "debug_id": "map-id",
                },
            )
            original_js = (build_dir / "app.js").read_text(encoding="utf-8")

            plan = prepare_js_release_artifact_debug_ids.create_debug_id_plan(build_dir=build_dir, write=True)

            self.assertFalse(plan["writeApplied"])
            self.assertEqual(plan["validation"]["status"], "blocked")
            self.assertIn(
                "app.js: minified source debugId does not match source map debugId",
                plan["validation"]["errors"],
            )
            self.assertEqual((build_dir / "app.js").read_text(encoding="utf-8"), original_js)

    def test_cli_prints_blocked_plan_and_nonzero_exit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            build_dir.mkdir()
            (build_dir / "app.js").write_text("console.log('ok');\n", encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(MODULE_PATH), "--build-dir", str(build_dir)],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertEqual(result.returncode, 1)
        plan = json.loads(result.stdout)
        self.assertEqual(plan["validation"]["status"], "blocked")
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
