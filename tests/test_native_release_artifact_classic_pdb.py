from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from tests.native_pe_fixture import (
    DEFAULT_CLASSIC_PDB_PAYLOAD_MARKER,
    DEFAULT_PDB_AGE,
    DEFAULT_PDB_GUID,
    DEFAULT_PDB_PATH,
    write_classic_pdb,
    write_pe_with_codeview,
)


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "create_native_release_artifact_manifest.py"
SPEC = importlib.util.spec_from_file_location("create_native_release_artifact_manifest", MODULE_PATH)
assert SPEC is not None
create_native_release_artifact_manifest = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(create_native_release_artifact_manifest)


class NativeReleaseArtifactClassicPdbTests(unittest.TestCase):
    def test_dotnet_pdb_classic_windows_pdb_cross_checks_codeview_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "windows" / "symbols"
            write_pe_with_codeview(symbols_dir / "checkout.dll")
            write_classic_pdb(symbols_dir / "checkout.pdb")

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("dotnet_pdb", symbols_dir)],
                release="2026.06.18",
                environment="production",
                service="checkout-mobile",
            )

        artifact = manifest["artifacts"][0]
        symbol_file = artifact["dotnetPdb"]["files"][0]
        serialized = json.dumps(manifest)
        self.assertEqual(manifest["validation"]["status"], "ready")
        self.assertEqual(symbol_file["pdbFormat"], "windows_pdb")
        self.assertEqual(symbol_file["pdbPayloadDebugId"], f"{DEFAULT_PDB_GUID}_{DEFAULT_PDB_AGE}")
        self.assertEqual(symbol_file["pdbPath"], "windows/symbols/checkout.pdb")
        self.assertNotIn(DEFAULT_PDB_PATH, serialized)
        self.assertNotIn(DEFAULT_CLASSIC_PDB_PAYLOAD_MARKER.decode("ascii"), serialized)

    def test_dotnet_pdb_classic_windows_pdb_prefers_dbi_age_for_codeview_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "windows" / "symbols"
            write_pe_with_codeview(symbols_dir / "checkout.dll")
            write_classic_pdb(symbols_dir / "checkout.pdb", pdb_age=99, dbi_age=DEFAULT_PDB_AGE)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("dotnet_pdb", symbols_dir)],
                release="2026.06.18",
                environment="production",
                service="checkout-mobile",
            )

        symbol_file = manifest["artifacts"][0]["dotnetPdb"]["files"][0]
        self.assertEqual(manifest["validation"]["status"], "ready")
        self.assertEqual(symbol_file["pdbPayloadDebugId"], f"{DEFAULT_PDB_GUID}_{DEFAULT_PDB_AGE}")

    def test_dotnet_pdb_classic_windows_pdb_debug_id_mismatch_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "windows" / "symbols"
            write_pe_with_codeview(symbols_dir / "checkout.dll")
            write_classic_pdb(
                symbols_dir / "checkout.pdb",
                pdb_guid="11112222-3333-4444-5555-666677778888",
                pdb_age=7,
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
            "windows/symbols: windows/symbols/checkout.pdb: "
            f"Windows PDB debug ID 11112222-3333-4444-5555-666677778888_7 "
            f"does not match PE CodeView debug ID {DEFAULT_PDB_GUID}_{DEFAULT_PDB_AGE}",
            manifest["validation"]["errors"],
        )
        self.assertNotIn(DEFAULT_CLASSIC_PDB_PAYLOAD_MARKER.decode("ascii"), serialized)

    def test_dotnet_pdb_malformed_classic_windows_pdb_blocks_without_payload_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "windows" / "symbols"
            write_pe_with_codeview(symbols_dir / "checkout.dll")
            pdb_path = symbols_dir / "checkout.pdb"
            pdb_path.parent.mkdir(parents=True, exist_ok=True)
            private_marker = b"classic-marker"
            pdb_path.write_bytes(
                b"Microsoft C/C++ MSF 7.00\r\n\x1a\x44\x53\x00\x00\x00"
                + private_marker
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
            "windows/symbols: windows/symbols/checkout.pdb: Windows PDB MSF header is truncated",
            manifest["validation"]["errors"],
        )
        self.assertNotIn(private_marker.decode("ascii"), serialized)


if __name__ == "__main__":
    unittest.main()
