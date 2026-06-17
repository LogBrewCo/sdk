from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.native_elf_fixture import DEFAULT_DEBUG_PAYLOAD, write_android_elf_symbol
from tests.native_macho_fixture import (
    DEFAULT_MACHO_DEBUG_PAYLOAD,
    DEFAULT_MACHO_UUID,
    DEFAULT_MACHO_X86_UUID,
    write_fat_macho_dwarf,
    write_macho_dwarf,
)


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
        write_macho_dwarf(dwarf_dir / "Checkout")
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

    def create_android_native_symbols(
        self,
        root: Path,
        *,
        build_id: bytes = bytes.fromhex("32cc7f54d61dc2d4022a4dc58fdec1f4"),
        include_build_id: bool = True,
        include_debug_info: bool = True,
        include_symtab: bool = True,
        include_dynsym: bool = False,
        include_code: bool = True,
    ) -> Path:
        symbols_dir = root / "android" / "symbols"
        write_android_elf_symbol(
            symbols_dir / "lib" / "arm64-v8a" / "libcheckout.so",
            build_id=build_id,
            include_build_id=include_build_id,
            include_debug_info=include_debug_info,
            include_symtab=include_symtab,
            include_dynsym=include_dynsym,
            include_code=include_code,
        )
        return symbols_dir

    def test_ready_manifest_keeps_paths_relative_and_omits_symbol_contents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            dsym = self.create_dsym(artifact_root)
            mapping = self.create_mapping(artifact_root)
            native_symbols = self.create_android_native_symbols(artifact_root)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[
                    ("ios_dsym", dsym),
                    ("android_proguard_mapping", mapping),
                    ("android_native_symbols", native_symbols),
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
            ["ios_dsym", "android_proguard_mapping", "android_native_symbols"],
        )
        self.assertEqual(
            manifest["supportedArtifactTypes"],
            ["ios_dsym", "android_proguard_mapping", "android_native_symbols"],
        )
        dsym_artifact = manifest["artifacts"][0]
        mapping_artifact = manifest["artifacts"][1]
        native_artifact = manifest["artifacts"][2]
        self.assertEqual(dsym_artifact["path"], "ios/Checkout.app.dSYM")
        self.assertEqual(dsym_artifact["fileCount"], 2)
        self.assertEqual(
            dsym_artifact["dsym"]["dwarfFiles"][0]["path"],
            "ios/Checkout.app.dSYM/Contents/Resources/DWARF/Checkout",
        )
        self.assertEqual(dsym_artifact["dsym"]["uuidCount"], 1)
        self.assertEqual(dsym_artifact["dsym"]["dwarfFiles"][0]["uuidCount"], 1)
        self.assertEqual(
            dsym_artifact["dsym"]["dwarfFiles"][0]["uuids"],
            [{"uuid": "C8469F85-B060-3085-B69D-E46C645560EA", "arch": "arm64"}],
        )
        self.assertTrue(dsym_artifact["artifactId"].startswith("lbw_ios_dsym_"))
        self.assertEqual(mapping_artifact["path"], "android/mapping.txt")
        self.assertEqual(mapping_artifact["proguard"]["classMappingCount"], 1)
        self.assertTrue(mapping_artifact["artifactId"].startswith("lbw_android_proguard_mapping_"))
        native_symbols_details = native_artifact["androidNativeSymbols"]
        self.assertEqual(native_artifact["path"], "android/symbols")
        self.assertEqual(native_symbols_details["symbolFileCount"], 1)
        self.assertEqual(native_symbols_details["architectures"], ["arm64-v8a"])
        native_file = native_symbols_details["files"][0]
        self.assertEqual(native_file["path"], "android/symbols/lib/arm64-v8a/libcheckout.so")
        self.assertEqual(native_file["elfClass"], 64)
        self.assertEqual(native_file["elfType"], "DYN")
        self.assertEqual(native_file["arch"], "arm64-v8a")
        self.assertEqual(native_file["symbolSource"], "debug_info")
        self.assertEqual(native_file["gnuBuildId"], "32cc7f54d61dc2d4022a4dc58fdec1f4")
        self.assertTrue(native_artifact["artifactId"].startswith("lbw_android_native_symbols_"))
        serialized = json.dumps(manifest)
        self.assertNotIn(tmp, serialized)
        self.assertNotIn("com.example.Checkout", serialized)
        self.assertNotIn(DEFAULT_MACHO_DEBUG_PAYLOAD.decode("ascii", errors="ignore"), serialized)
        self.assertNotIn(DEFAULT_MACHO_UUID.hex(), serialized)
        self.assertNotIn(DEFAULT_DEBUG_PAYLOAD.decode("ascii", errors="ignore"), serialized)

    def test_dsym_without_macho_uuid_warns_without_blocking_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            dsym = artifact_root / "ios" / "Checkout.app.dSYM"
            dwarf_dir = dsym / "Contents" / "Resources" / "DWARF"
            write_macho_dwarf(dwarf_dir / "Checkout", include_uuid=False)
            (dsym / "Contents" / "Info.plist").write_text("<plist version=\"1.0\" />\n", encoding="utf-8")

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("ios_dsym", dsym)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "ready")
        self.assertEqual(manifest["artifacts"][0]["dsym"]["uuidCount"], 0)
        self.assertIn(
            "ios/Checkout.app.dSYM: dSYM UUIDs were not found; "
            "symbolication upload will need valid Mach-O DWARF objects",
            manifest["validation"]["warnings"],
        )
        self.assertTrue(
            any("Mach-O UUID was not found" in warning for warning in manifest["validation"]["warnings"])
        )

    def test_dsym_fat_macho_extracts_per_arch_uuids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            dsym = artifact_root / "ios" / "Checkout.app.dSYM"
            dwarf_dir = dsym / "Contents" / "Resources" / "DWARF"
            write_fat_macho_dwarf(dwarf_dir / "Checkout")
            (dsym / "Contents" / "Info.plist").write_text("<plist version=\"1.0\" />\n", encoding="utf-8")

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("ios_dsym", dsym)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "ready")
        dwarf_file = manifest["artifacts"][0]["dsym"]["dwarfFiles"][0]
        self.assertEqual(manifest["artifacts"][0]["dsym"]["uuidCount"], 2)
        self.assertEqual(dwarf_file["uuidCount"], 2)
        self.assertEqual(
            dwarf_file["uuids"],
            [
                {"uuid": "C8469F85-B060-3085-B69D-E46C645560EA", "arch": "arm64"},
                {"uuid": "7A7B4FB7-CD1C-3F8D-B821-DD02295CBEEF", "arch": "x86_64"},
            ],
        )
        serialized = json.dumps(manifest)
        self.assertNotIn(DEFAULT_MACHO_UUID.hex(), serialized)
        self.assertNotIn(DEFAULT_MACHO_X86_UUID.hex(), serialized)

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

    def test_android_native_symbol_without_build_id_or_code_hash_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            native_symbols = self.create_android_native_symbols(
                artifact_root,
                include_build_id=False,
                include_code=False,
            )

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("android_native_symbols", native_symbols)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "android/symbols: android/symbols/lib/arm64-v8a/libcheckout.so: ELF file has no build ID or code hash",
            manifest["validation"]["errors"],
        )

    def test_android_native_symbol_without_symbol_sections_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            native_symbols = self.create_android_native_symbols(
                artifact_root,
                include_debug_info=False,
                include_symtab=False,
            )

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("android_native_symbols", native_symbols)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "android/symbols: android/symbols/lib/arm64-v8a/libcheckout.so: ELF file has no debug info or symbol tables",
            manifest["validation"]["errors"],
        )

    def test_android_native_symbol_non_elf_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "android" / "symbols"
            symbols_dir.mkdir(parents=True)
            (symbols_dir / "libbad.so").write_bytes(b"not an elf file")

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("android_native_symbols", symbols_dir)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "android/symbols: android/symbols/libbad.so: not an ELF file",
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
