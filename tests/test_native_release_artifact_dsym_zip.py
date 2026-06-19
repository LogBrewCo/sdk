from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from tests.native_macho_fixture import DEFAULT_MACHO_DEBUG_PAYLOAD, DEFAULT_MACHO_UUID, write_dsym_zip


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "create_native_release_artifact_manifest.py"
SPEC = importlib.util.spec_from_file_location("create_native_release_artifact_manifest", MODULE_PATH)
assert SPEC is not None
create_native_release_artifact_manifest = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(create_native_release_artifact_manifest)


class NativeReleaseArtifactDsymZipTests(unittest.TestCase):
    def test_ios_dsym_zip_extracts_uuid_metadata_without_symbol_contents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            dsym_archive = artifact_root / "ios" / "Checkout.dSYMs.zip"
            write_dsym_zip(dsym_archive)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("ios_dsym", dsym_archive)],
                release="2026.06.19",
                environment="production",
                service="checkout-ios",
            )

        serialized = json.dumps(manifest)
        artifact = manifest["artifacts"][0]
        dsym = artifact["dsym"]
        dwarf_file = dsym["dwarfFiles"][0]

        self.assertEqual(manifest["validation"]["status"], "ready")
        self.assertEqual(artifact["path"], "ios/Checkout.dSYMs.zip")
        self.assertEqual(artifact["fileCount"], 1)
        self.assertEqual(dsym["bundleName"], "Checkout.app.dSYM")
        self.assertEqual(dsym["bundleCount"], 1)
        self.assertEqual(dsym["archiveFormat"], "zip")
        self.assertTrue(dsym["hasInfoPlist"])
        self.assertEqual(dsym["uuidCount"], 1)
        self.assertEqual(
            dwarf_file["path"],
            "ios/Checkout.dSYMs.zip!Payload/Checkout.app.dSYM/Contents/Resources/DWARF/Checkout",
        )
        self.assertEqual(
            dwarf_file["uuids"],
            [{"uuid": "C8469F85-B060-3085-B69D-E46C645560EA", "arch": "arm64"}],
        )
        self.assertNotIn(tmp, serialized)
        self.assertNotIn(DEFAULT_MACHO_DEBUG_PAYLOAD.decode("ascii", errors="ignore"), serialized)
        self.assertNotIn(DEFAULT_MACHO_UUID.hex(), serialized)

    def test_ios_dsym_zip_blocks_unsafe_entry_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            dsym_archive = artifact_root / "ios" / "Checkout.dSYMs.zip"
            dsym_archive.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(dsym_archive, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("../Checkout.app.dSYM/Contents/Resources/DWARF/Checkout", b"not used")

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("ios_dsym", dsym_archive)],
                release="2026.06.19",
                environment="production",
                service="checkout-ios",
            )

        serialized = json.dumps(manifest)
        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "ios/Checkout.dSYMs.zip: dSYM archive contains unsafe entry paths",
            manifest["validation"]["errors"],
        )
        self.assertNotIn("../Checkout", serialized)


if __name__ == "__main__":
    unittest.main()
