from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from native_elf_fixture import write_android_elf_symbol  # noqa: E402
from native_unity_fixture import write_unity_symbols_zip  # noqa: E402

MANIFEST_MODULE_PATH = ROOT / "scripts" / "create_native_release_artifact_manifest.py"
UPLOAD_MODULE_PATH = ROOT / "scripts" / "upload_native_release_artifacts.py"

MANIFEST_SPEC = importlib.util.spec_from_file_location("create_native_release_artifact_manifest", MANIFEST_MODULE_PATH)
assert MANIFEST_SPEC is not None
create_native_release_artifact_manifest = importlib.util.module_from_spec(MANIFEST_SPEC)
assert MANIFEST_SPEC.loader is not None
MANIFEST_SPEC.loader.exec_module(create_native_release_artifact_manifest)

UPLOAD_SPEC = importlib.util.spec_from_file_location("upload_native_release_artifacts", UPLOAD_MODULE_PATH)
assert UPLOAD_SPEC is not None
upload_native_release_artifacts = importlib.util.module_from_spec(UPLOAD_SPEC)
assert UPLOAD_SPEC.loader is not None
UPLOAD_SPEC.loader.exec_module(upload_native_release_artifacts)


class NativeReleaseArtifactUploadTests(unittest.TestCase):
    def create_ready_manifest(self, tmp: str) -> tuple[Path, dict[str, object], Path, Path]:
        artifact_root = Path(tmp) / "artifacts"
        mapping_file = artifact_root / "android" / "mapping.txt"
        native_symbols_dir = artifact_root / "android" / "symbols"
        native_so = native_symbols_dir / "lib" / "arm64-v8a" / "libcheckout.so"
        mapping_file.parent.mkdir(parents=True)
        native_so.parent.mkdir(parents=True)
        mapping_file.write_text(
            "com.example.Checkout -> a:\n    void placeOrder() -> a\n",
            encoding="utf-8",
        )
        write_android_elf_symbol(native_so)
        manifest = create_native_release_artifact_manifest.create_manifest(
            artifact_root=artifact_root,
            release="2026.06.18",
            environment="production",
            service="checkout-mobile",
            artifacts=[
                ("android_proguard_mapping", mapping_file),
                ("android_native_symbols", native_symbols_dir),
            ],
        )
        self.assertEqual(manifest["validation"]["status"], "ready")
        return artifact_root, manifest, mapping_file, native_so

    def test_collect_artifact_files_verifies_hashes_sizes_and_tree_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root, manifest, _mapping_file, native_so = self.create_ready_manifest(tmp)
            files = upload_native_release_artifacts.collect_artifact_files(manifest, artifact_root)

            self.assertEqual([name for name, _ in files], ["artifact_0_file_0", "artifact_1_file_0"])

            native_so.write_bytes(native_so.read_bytes() + b"tampered")
            with self.assertRaisesRegex(
                upload_native_release_artifacts.UploadValidationError,
                "artifact byte size changed after manifest creation|artifact sha256 changed after manifest creation",
            ):
                upload_native_release_artifacts.collect_artifact_files(manifest, artifact_root)

    def test_blocked_manifest_is_rejected_before_upload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root, manifest, _mapping_file, _native_so = self.create_ready_manifest(tmp)
            manifest["validation"] = {"status": "blocked", "errors": ["native symbols missing build id"]}

            with self.assertRaisesRegex(
                upload_native_release_artifacts.UploadValidationError,
                "manifest validation status must be ready",
            ):
                upload_native_release_artifacts.collect_artifact_files(manifest, artifact_root)

    def test_endpoint_must_be_loopback(self) -> None:
        with self.assertRaisesRegex(upload_native_release_artifacts.UploadValidationError, "loopback-only"):
            upload_native_release_artifacts.require_loopback_endpoint("https://example.com/upload")
        with self.assertRaisesRegex(upload_native_release_artifacts.UploadValidationError, "loopback-only"):
            upload_native_release_artifacts.require_loopback_endpoint("https://127.example.com/upload")

        upload_native_release_artifacts.require_loopback_endpoint("http://127.0.0.1:4319/upload?token=ignored")
        upload_native_release_artifacts.require_loopback_endpoint("http://[::1]:4319/upload?token=ignored")
        self.assertEqual(
            upload_native_release_artifacts.endpoint_without_query("http://127.0.0.1:4319/upload?token=ignored#frag"),
            "http://127.0.0.1:4319/upload",
        )

    def test_multipart_uses_basename_file_headers_and_redacted_manifest_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root, manifest, _mapping_file, _native_so = self.create_ready_manifest(tmp)
            files = upload_native_release_artifacts.collect_artifact_files(manifest, artifact_root)
            body, boundary = upload_native_release_artifacts.encode_multipart(manifest, files)
            serialized = body.decode("utf-8", errors="replace")

            self.assertTrue(boundary.startswith("logbrew-"))
            self.assertIn('name="manifest"; filename="manifest.json"', serialized)
            self.assertIn('name="artifact_0_file_0"; filename="mapping.txt"', serialized)
            self.assertIn('name="artifact_1_file_0"; filename="libcheckout.so"', serialized)
            self.assertNotIn(tmp, serialized)
            self.assertNotIn("com.example.Checkout", json.dumps(manifest))

    def test_unity_zip_upload_uses_single_basename_file_part(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            unity_archive = artifact_root / "unity" / "symbols.zip"
            write_unity_symbols_zip(unity_archive)
            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                release="2026.06.18",
                environment="production",
                service="checkout-unity",
                artifacts=[("unity_symbols", unity_archive)],
            )
            self.assertEqual(manifest["validation"]["status"], "ready")

            files = upload_native_release_artifacts.collect_artifact_files(manifest, artifact_root)
            report = upload_native_release_artifacts.build_report(
                endpoint="http://127.0.0.1:4319/upload?ignored=query",
                manifest=manifest,
                files=files,
                dry_run=False,
            )
            body, _boundary = upload_native_release_artifacts.encode_multipart(manifest, files)
            serialized = body.decode("utf-8", errors="replace")

            self.assertEqual([(name, path.name) for name, path in files], [("artifact_0_file_0", "symbols.zip")])
            self.assertEqual(report["artifactTypes"], ["unity_symbols"])
            self.assertEqual(report["artifactCount"], 1)
            self.assertEqual(report["filePartCount"], 1)
            self.assertEqual(report["endpoint"], "http://127.0.0.1:4319/upload")
            self.assertIn('name="artifact_0_file_0"; filename="symbols.zip"', serialized)
            self.assertNotIn(tmp, serialized)
            self.assertNotIn("Checkout.PlaceOrder", json.dumps(manifest))

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink support is required")
    def test_artifact_symlink_is_rejected_before_upload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root, manifest, mapping_file, _native_so = self.create_ready_manifest(tmp)
            os.symlink(mapping_file, artifact_root / "android" / "symbols" / "linked-mapping.txt")

            with self.assertRaisesRegex(
                upload_native_release_artifacts.UploadValidationError,
                "symbolic link",
            ):
                upload_native_release_artifacts.collect_artifact_files(manifest, artifact_root)


if __name__ == "__main__":
    unittest.main()
