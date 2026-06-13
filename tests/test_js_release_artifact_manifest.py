from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "create_js_release_artifact_manifest.py"
SPEC = importlib.util.spec_from_file_location("create_js_release_artifact_manifest", MODULE_PATH)
assert SPEC is not None
create_js_release_artifact_manifest = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(create_js_release_artifact_manifest)


class JavaScriptReleaseArtifactManifestTests(unittest.TestCase):
    def test_valid_build_manifest_is_ready_and_strips_prefix_query(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            assets_dir = build_dir / "assets"
            assets_dir.mkdir(parents=True)
            (assets_dir / "app.js").write_text(
                'console.log("ok");\n//# debugId=abc123\n//# sourceMappingURL=app.js.map?cache=1#frag\n',
                encoding="utf-8",
            )
            (assets_dir / "app.js.map").write_text(
                json.dumps(
                    {
                        "version": 3,
                        "file": "app.js",
                        "sources": ["../src/app.ts"],
                        "names": [],
                        "mappings": "AAAA",
                        "debug_id": "abc123",
                    }
                ),
                encoding="utf-8",
            )

            manifest = create_js_release_artifact_manifest.create_manifest(
                build_dir=build_dir,
                release="1.2.3",
                environment="production",
                service="checkout-web",
                minified_path_prefix="https://cdn.example/assets?cache=placeholder#hash",
                repository_url="https://github.com/example/app",
                commit_sha="abc123def456",
            )

        self.assertEqual(manifest["validation"]["status"], "ready")
        self.assertEqual(manifest["release"], "1.2.3")
        self.assertEqual(manifest["environment"], "production")
        self.assertEqual(manifest["service"], "checkout-web")
        self.assertEqual(manifest["git"]["commitSha"], "abc123def456")
        self.assertEqual(len(manifest["artifacts"]), 1)
        artifact = manifest["artifacts"][0]
        self.assertEqual(artifact["debugId"], "abc123")
        self.assertEqual(
            artifact["minifiedSource"]["minifiedUrl"],
            "https://cdn.example/assets/assets/app.js",
        )
        self.assertEqual(artifact["sourceMap"]["sourceCount"], 1)
        serialized = json.dumps(manifest)
        self.assertNotIn("cache=placeholder", serialized)
        self.assertNotIn("#hash", serialized)

    def test_missing_source_map_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            build_dir.mkdir()
            (build_dir / "app.js").write_text(
                'console.log("ok");\n//# sourceMappingURL=app.js.map\n',
                encoding="utf-8",
            )

            manifest = create_js_release_artifact_manifest.create_manifest(
                build_dir=build_dir,
                release="1.2.3",
                environment="production",
                service="checkout-web",
                minified_path_prefix="/assets",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn("app.js: source map file is missing: app.js.map", manifest["validation"]["errors"])

    def test_sources_content_is_blocked_by_default_and_allowed_explicitly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            build_dir.mkdir()
            (build_dir / "app.js").write_text(
                'console.log("ok");\n//# sourceMappingURL=app.js.map\n',
                encoding="utf-8",
            )
            (build_dir / "app.js.map").write_text(
                json.dumps(
                    {
                        "version": 3,
                        "sources": ["src/app.ts"],
                        "sourcesContent": ["console.log('private source')"],
                        "names": [],
                        "mappings": "AAAA",
                    }
                ),
                encoding="utf-8",
            )

            blocked = create_js_release_artifact_manifest.create_manifest(
                build_dir=build_dir,
                release="1.2.3",
                environment="production",
                service="checkout-web",
                minified_path_prefix="/assets",
            )
            allowed = create_js_release_artifact_manifest.create_manifest(
                build_dir=build_dir,
                release="1.2.3",
                environment="production",
                service="checkout-web",
                minified_path_prefix="/assets",
                allow_sources_content=True,
            )

        self.assertEqual(blocked["validation"]["status"], "blocked")
        self.assertTrue(any("sourcesContent" in error for error in blocked["validation"]["errors"]))
        self.assertEqual(allowed["validation"]["status"], "ready")
        self.assertTrue(any("sourcesContent" in warning for warning in allowed["validation"]["warnings"]))
        self.assertNotIn("private source", json.dumps(allowed))

    def test_mismatched_debug_ids_block_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            build_dir.mkdir()
            (build_dir / "app.js").write_text(
                'console.log("ok");\n//# debugId=minified-id\n//# sourceMappingURL=app.js.map\n',
                encoding="utf-8",
            )
            (build_dir / "app.js.map").write_text(
                json.dumps(
                    {
                        "version": 3,
                        "sources": ["src/app.ts"],
                        "names": [],
                        "mappings": "AAAA",
                        "debug_id": "map-id",
                    }
                ),
                encoding="utf-8",
            )

            manifest = create_js_release_artifact_manifest.create_manifest(
                build_dir=build_dir,
                release="1.2.3",
                environment="production",
                service="checkout-web",
                minified_path_prefix="/assets",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "app.js: minified source debugId does not match source map debugId",
            manifest["validation"]["errors"],
        )

    def test_cli_prints_blocked_manifest_and_nonzero_exit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "dist"
            build_dir.mkdir()
            (build_dir / "app.js").write_text("console.log('ok');\n", encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "--build-dir",
                    str(build_dir),
                    "--release",
                    "1.2.3",
                    "--environment",
                    "production",
                    "--service",
                    "checkout-web",
                    "--minified-path-prefix",
                    "/assets",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertEqual(result.returncode, 1)
        manifest = json.loads(result.stdout)
        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
