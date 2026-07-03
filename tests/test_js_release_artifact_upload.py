from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_MODULE_PATH = ROOT / "scripts" / "create_js_release_artifact_manifest.py"
UPLOAD_MODULE_PATH = ROOT / "scripts" / "upload_js_release_artifacts.py"

MANIFEST_SPEC = importlib.util.spec_from_file_location("create_js_release_artifact_manifest", MANIFEST_MODULE_PATH)
assert MANIFEST_SPEC is not None
create_js_release_artifact_manifest = importlib.util.module_from_spec(MANIFEST_SPEC)
assert MANIFEST_SPEC.loader is not None
MANIFEST_SPEC.loader.exec_module(create_js_release_artifact_manifest)

UPLOAD_SPEC = importlib.util.spec_from_file_location("upload_js_release_artifacts", UPLOAD_MODULE_PATH)
assert UPLOAD_SPEC is not None
upload_js_release_artifacts = importlib.util.module_from_spec(UPLOAD_SPEC)
assert UPLOAD_SPEC.loader is not None
UPLOAD_SPEC.loader.exec_module(upload_js_release_artifacts)


class JavaScriptReleaseArtifactUploadTests(unittest.TestCase):
    def create_ready_manifest(self, tmp: str) -> tuple[Path, dict[str, object]]:
        build_dir = Path(tmp) / "dist"
        build_dir.mkdir()
        (build_dir / "app.js").write_text(
            'console.log("ok");\n//# debugId=upload-debug-id\n//# sourceMappingURL=app.js.map\n',
            encoding="utf-8",
        )
        (build_dir / "app.js.map").write_text(
            json.dumps(
                {
                    "version": 3,
                    "file": "app.js",
                    "sources": ["src/app.ts"],
                    "names": [],
                    "mappings": "AAAA",
                    "debug_id": "upload-debug-id",
                }
            ),
            encoding="utf-8",
        )
        manifest = create_js_release_artifact_manifest.create_manifest(
            build_dir=build_dir,
            release="1.2.3",
            environment="production",
            service="checkout-web",
            minified_path_prefix="https://cdn.example/assets",
        )
        self.assertEqual(manifest["validation"]["status"], "ready")
        return build_dir, manifest

    def test_collect_artifact_files_verifies_hashes_and_sizes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir, manifest = self.create_ready_manifest(tmp)
            files = upload_js_release_artifacts.collect_artifact_files(manifest, build_dir)

            self.assertEqual([name for name, _ in files], ["minified_source_0", "source_map_0"])

            (build_dir / "app.js.map").write_text("tampered", encoding="utf-8")
            with self.assertRaisesRegex(
                upload_js_release_artifacts.UploadValidationError,
                "sourceMap byte size changed after manifest creation|sourceMap sha256 changed after manifest creation",
            ):
                upload_js_release_artifacts.collect_artifact_files(manifest, build_dir)

    def test_blocked_manifest_is_rejected_before_upload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir, manifest = self.create_ready_manifest(tmp)
            manifest["validation"] = {"status": "blocked", "errors": ["source map contains sourcesContent"]}

            with self.assertRaisesRegex(
                upload_js_release_artifacts.UploadValidationError,
                "manifest validation status must be ready",
            ):
                upload_js_release_artifacts.collect_artifact_files(manifest, build_dir)

    def test_endpoint_must_be_loopback(self) -> None:
        with self.assertRaisesRegex(upload_js_release_artifacts.UploadValidationError, "loopback-only"):
            upload_js_release_artifacts.require_loopback_endpoint("https://example.com/upload")
        with self.assertRaisesRegex(upload_js_release_artifacts.UploadValidationError, "loopback-only"):
            upload_js_release_artifacts.require_loopback_endpoint("https://127.example.com/upload")

        upload_js_release_artifacts.require_loopback_endpoint("http://127.0.0.1:4319/upload?marker=ignored")
        upload_js_release_artifacts.require_loopback_endpoint("http://[::1]:4319/upload?marker=ignored")
        self.assertEqual(
            upload_js_release_artifacts.endpoint_without_query("http://127.0.0.1:4319/upload?marker=ignored#frag"),
            "http://127.0.0.1:4319/upload",
        )

    def test_hosted_endpoint_requires_explicit_opt_in_and_https(self) -> None:
        with self.assertRaisesRegex(upload_js_release_artifacts.UploadValidationError, "--allow-hosted"):
            upload_js_release_artifacts.require_upload_endpoint(
                "https://api.logbrew.com/api/release-artifacts",
                allow_hosted=False,
            )

        upload_js_release_artifacts.require_upload_endpoint(
            "https://api.logbrew.com/api/release-artifacts",
            allow_hosted=True,
        )

        with self.assertRaisesRegex(upload_js_release_artifacts.UploadValidationError, "https"):
            upload_js_release_artifacts.require_upload_endpoint(
                "http://api.logbrew.com/api/release-artifacts",
                allow_hosted=True,
            )
        with self.assertRaisesRegex(upload_js_release_artifacts.UploadValidationError, "query strings or fragments"):
            upload_js_release_artifacts.require_upload_endpoint(
                "https://api.logbrew.com/api/release-artifacts?marker=placeholder",
                allow_hosted=True,
            )
        with self.assertRaisesRegex(upload_js_release_artifacts.UploadValidationError, "embedded auth values"):
            upload_js_release_artifacts.require_upload_endpoint(
                "https://user:pass@api.logbrew.com/api/release-artifacts",
                allow_hosted=True,
            )

    def test_multipart_uses_basename_file_headers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            build_dir, manifest = self.create_ready_manifest(tmp)
            files = upload_js_release_artifacts.collect_artifact_files(manifest, build_dir)
            body, boundary = upload_js_release_artifacts.encode_multipart(manifest, files)
            serialized = body.decode("utf-8", errors="replace")

            self.assertTrue(boundary.startswith("logbrew-"))
            self.assertIn('name="manifest"; filename="manifest.json"', serialized)
            self.assertIn('name="minified_source_0"; filename="app.js"', serialized)
            self.assertIn('name="source_map_0"; filename="app.js.map"', serialized)
            self.assertNotIn(tmp, serialized)

    def test_status_classification_matches_upload_policy(self) -> None:
        self.assertEqual(upload_js_release_artifacts.classify_http_status(202), "uploaded")
        self.assertEqual(upload_js_release_artifacts.classify_http_status(401), "auth_failed")
        self.assertEqual(upload_js_release_artifacts.classify_http_status(403), "auth_failed")
        self.assertEqual(upload_js_release_artifacts.classify_http_status(400), "validation_failed")
        self.assertEqual(upload_js_release_artifacts.classify_http_status(413), "validation_failed")
        self.assertEqual(upload_js_release_artifacts.classify_http_status(429), "retryable_error")
        self.assertEqual(upload_js_release_artifacts.classify_http_status(503), "retryable_error")


if __name__ == "__main__":
    unittest.main()
