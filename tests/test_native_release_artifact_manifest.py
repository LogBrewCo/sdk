from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "create_native_release_artifact_manifest.py"
SPEC = importlib.util.spec_from_file_location("create_native_release_artifact_manifest", MODULE_PATH)
assert SPEC is not None
create_native_release_artifact_manifest = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(create_native_release_artifact_manifest)


class NativeReleaseArtifactManifestTests(unittest.TestCase):
    def create_dsym(self, root: Path) -> Path:
        dsym = root / "ios" / "Checkout.app.dSYM"
        dwarf_dir = dsym / "Contents" / "Resources" / "DWARF"
        dwarf_dir.mkdir(parents=True)
        (dwarf_dir / "Checkout").write_bytes(b"fake dwarf object")
        (dsym / "Contents" / "Info.plist").write_text("<plist version=\"1.0\" />\n", encoding="utf-8")
        return dsym

    def create_mapping(self, root: Path) -> Path:
        mapping = root / "android" / "mapping.txt"
        mapping.parent.mkdir(parents=True)
        mapping.write_text(
            "com.example.Checkout -> a:\n"
            "    void placeOrder() -> a\n",
            encoding="utf-8",
        )
        return mapping

    def test_ready_manifest_keeps_paths_relative_and_omits_symbol_contents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            dsym = self.create_dsym(artifact_root)
            mapping = self.create_mapping(artifact_root)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[
                    ("ios_dsym", dsym),
                    ("android_proguard_mapping", mapping),
                ],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
                repository_url="https://github.com/example/mobile",
                commit_sha="abc123def456",
            )

        self.assertEqual(manifest["validation"]["status"], "ready")
        self.assertEqual(manifest["artifactType"], "native_debug_symbol_manifest")
        self.assertEqual(manifest["git"]["commitSha"], "abc123def456")
        self.assertEqual(
            [artifact["artifactType"] for artifact in manifest["artifacts"]],
            ["ios_dsym", "android_proguard_mapping"],
        )
        dsym_artifact = manifest["artifacts"][0]
        mapping_artifact = manifest["artifacts"][1]
        self.assertEqual(dsym_artifact["path"], "ios/Checkout.app.dSYM")
        self.assertEqual(dsym_artifact["fileCount"], 2)
        self.assertEqual(
            dsym_artifact["dsym"]["dwarfFiles"][0]["path"],
            "ios/Checkout.app.dSYM/Contents/Resources/DWARF/Checkout",
        )
        self.assertTrue(dsym_artifact["artifactId"].startswith("lbw_ios_dsym_"))
        self.assertEqual(mapping_artifact["path"], "android/mapping.txt")
        self.assertEqual(mapping_artifact["proguard"]["classMappingCount"], 1)
        self.assertTrue(mapping_artifact["artifactId"].startswith("lbw_android_proguard_mapping_"))
        serialized = json.dumps(manifest)
        self.assertNotIn(tmp, serialized)
        self.assertNotIn("com.example.Checkout", serialized)
        self.assertNotIn("fake dwarf object", serialized)

    def test_missing_dsym_dwarf_directory_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            dsym = artifact_root / "ios" / "Checkout.app.dSYM"
            (dsym / "Contents").mkdir(parents=True)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("ios_dsym", dsym)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "ios/Checkout.app.dSYM: dSYM bundle is missing Contents/Resources/DWARF",
            manifest["validation"]["errors"],
        )

    def test_mapping_without_class_mappings_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            mapping = artifact_root / "android" / "mapping.txt"
            mapping.parent.mkdir(parents=True)
            mapping.write_text("# compiler: R8\n", encoding="utf-8")

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("android_proguard_mapping", mapping)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "android/mapping.txt: ProGuard/R8 mapping file has no class mapping entries",
            manifest["validation"]["errors"],
        )

    def test_cli_prints_blocked_manifest_and_nonzero_exit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            mapping = artifact_root / "android" / "mapping.txt"
            mapping.parent.mkdir(parents=True)
            mapping.write_text("# compiler: R8\n", encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "--artifact-root",
                    str(artifact_root),
                    "--release",
                    "2026.06.17",
                    "--environment",
                    "production",
                    "--service",
                    "checkout-mobile",
                    "--artifact",
                    f"android_proguard_mapping={mapping}",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertEqual(result.returncode, 1)
        manifest = json.loads(result.stdout)
        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertEqual(result.stderr, "")

    def test_artifact_paths_must_stay_inside_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            outside = Path(tmp) / "mapping.txt"
            artifact_root.mkdir()
            outside.write_text("com.example.App -> a:\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "artifact path must stay inside artifact root"):
                create_native_release_artifact_manifest.create_manifest(
                    artifact_root=artifact_root,
                    artifacts=[("android_proguard_mapping", outside)],
                    release="2026.06.17",
                    environment="production",
                    service="checkout-mobile",
                )

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink support required")
    def test_direct_artifact_symlink_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            target = self.create_mapping(artifact_root)
            symlink = artifact_root / "android" / "mapping-link.txt"
            os.symlink(target.name, symlink)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("android_proguard_mapping", symlink)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "android/mapping-link.txt: symbolic links are not accepted in release artifacts: android/mapping-link.txt",
            manifest["validation"]["errors"],
        )


if __name__ == "__main__":
    unittest.main()
