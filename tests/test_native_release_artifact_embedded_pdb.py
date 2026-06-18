from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from tests.native_pe_fixture import (
    DEFAULT_PDB_AGE,
    DEFAULT_PDB_GUID,
    DEFAULT_PDB_PATH,
    DEFAULT_PDB_PAYLOAD_MARKER,
    portable_pdb_payload,
    write_pe_with_codeview,
)


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "create_native_release_artifact_manifest.py"
SPEC = importlib.util.spec_from_file_location("create_native_release_artifact_manifest", MODULE_PATH)
assert SPEC is not None
create_native_release_artifact_manifest = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(create_native_release_artifact_manifest)


class NativeReleaseArtifactEmbeddedPdbTests(unittest.TestCase):
    def test_dotnet_pdb_embedded_portable_pdb_allows_missing_sibling_pdb(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "windows" / "symbols"
            write_pe_with_codeview(
                symbols_dir / "checkout.dll",
                embedded_pdb_payload=portable_pdb_payload(),
            )

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("dotnet_pdb", symbols_dir)],
                release="2026.06.18",
                environment="production",
                service="checkout-mobile",
            )

        artifact = manifest["artifacts"][0]
        serialized = json.dumps(manifest)
        self.assertEqual(manifest["validation"]["status"], "ready")
        symbol_file = artifact["dotnetPdb"]["files"][0]
        self.assertEqual(symbol_file["pdbFormat"], "embedded_portable_pdb")
        self.assertEqual(symbol_file["pdbPayloadDebugId"], f"{DEFAULT_PDB_GUID}_{DEFAULT_PDB_AGE}")
        self.assertNotIn("pdbPath", symbol_file)
        self.assertNotIn(DEFAULT_PDB_PATH, serialized)
        self.assertNotIn(DEFAULT_PDB_PAYLOAD_MARKER.decode("ascii"), serialized)

    def test_dotnet_pdb_embedded_portable_pdb_debug_id_mismatch_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "windows" / "symbols"
            write_pe_with_codeview(
                symbols_dir / "checkout.dll",
                embedded_pdb_payload=portable_pdb_payload(
                    pdb_guid="11112222-3333-4444-5555-666677778888",
                    pdb_age=7,
                ),
            )

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("dotnet_pdb", symbols_dir)],
                release="2026.06.18",
                environment="production",
                service="checkout-mobile",
            )

        serialized = json.dumps(manifest)
        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "windows/symbols: windows/symbols/checkout.dll: embedded Portable PDB debug ID "
            f"11112222-3333-4444-5555-666677778888_7 does not match PE CodeView debug ID "
            f"{DEFAULT_PDB_GUID}_{DEFAULT_PDB_AGE}",
            manifest["validation"]["errors"],
        )
        self.assertNotIn(DEFAULT_PDB_PAYLOAD_MARKER.decode("ascii"), serialized)

    def test_dotnet_pdb_malformed_embedded_portable_pdb_blocks_manifest_without_payload_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "windows" / "symbols"
            write_pe_with_codeview(
                symbols_dir / "checkout.dll",
                embedded_pdb_payload=b"BSJB" + DEFAULT_PDB_PAYLOAD_MARKER,
            )

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("dotnet_pdb", symbols_dir)],
                release="2026.06.18",
                environment="production",
                service="checkout-mobile",
            )

        serialized = json.dumps(manifest)
        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "windows/symbols: windows/symbols/checkout.dll: "
            "embedded Portable PDB metadata root is truncated",
            manifest["validation"]["errors"],
        )
        self.assertNotIn(DEFAULT_PDB_PAYLOAD_MARKER.decode("ascii"), serialized)


if __name__ == "__main__":
    unittest.main()
