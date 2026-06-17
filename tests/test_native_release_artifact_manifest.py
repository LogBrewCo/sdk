from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.native_breakpad_fixture import (
    DEFAULT_BREAKPAD_MODULE_ID,
    DEFAULT_BREAKPAD_SOURCE_PATH,
    DEFAULT_BREAKPAD_SYMBOL_NAME,
    write_breakpad_symbol,
)
from tests.native_elf_fixture import DEFAULT_DEBUG_PAYLOAD, write_android_elf_symbol
from tests.native_macho_fixture import (
    DEFAULT_MACHO_DEBUG_PAYLOAD,
    DEFAULT_MACHO_UUID,
    DEFAULT_MACHO_X86_UUID,
    write_fat_macho_dwarf,
    write_macho_dwarf,
)
from tests.native_pe_fixture import (
    DEFAULT_PDB_AGE,
    DEFAULT_PDB_GUID,
    DEFAULT_PDB_PATH,
    DEFAULT_PDB_PAYLOAD,
    write_pdb,
    write_pe_with_codeview,
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

    def create_breakpad_symbols(
        self,
        root: Path,
        *,
        module_id: str = DEFAULT_BREAKPAD_MODULE_ID,
        include_file_records: bool = True,
        cpu: str = "x86",
        module_name: str = "checkout.pdb",
    ) -> Path:
        symbols_dir = root / "native" / "breakpad"
        write_breakpad_symbol(
            symbols_dir / "checkout.sym",
            module_id=module_id,
            include_file_records=include_file_records,
            cpu=cpu,
            module_name=module_name,
        )
        return symbols_dir

    def create_dotnet_pdb_symbols(
        self,
        root: Path,
        *,
        include_pdb: bool = True,
        include_codeview: bool = True,
    ) -> Path:
        symbols_dir = root / "windows" / "symbols"
        pe_path = symbols_dir / "checkout.dll"
        write_pe_with_codeview(pe_path, include_codeview=include_codeview)
        if include_pdb:
            write_pdb(symbols_dir / "checkout.pdb")
        return symbols_dir

    def test_ready_manifest_keeps_paths_relative_and_omits_symbol_contents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            dsym = self.create_dsym(artifact_root)
            mapping = self.create_mapping(artifact_root)
            native_symbols = self.create_android_native_symbols(artifact_root)
            breakpad_symbols = self.create_breakpad_symbols(artifact_root)
            dotnet_pdb = self.create_dotnet_pdb_symbols(artifact_root)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[
                    ("ios_dsym", dsym),
                    ("android_proguard_mapping", mapping),
                    ("android_native_symbols", native_symbols),
                    ("breakpad_symbols", breakpad_symbols),
                    ("dotnet_pdb", dotnet_pdb),
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
        self.assertEqual(manifest["limits"]["maxSymbolFiles"], 500)
        self.assertEqual(manifest["limits"]["maxSymbolFileBytes"], 2147483648)
        self.assertEqual(manifest["limits"]["maxArtifactBytes"], 2147483648)
        self.assertEqual(
            [artifact["artifactType"] for artifact in manifest["artifacts"]],
            [
                "ios_dsym",
                "android_proguard_mapping",
                "android_native_symbols",
                "breakpad_symbols",
                "dotnet_pdb",
            ],
        )
        self.assertEqual(
            manifest["supportedArtifactTypes"],
            [
                "ios_dsym",
                "android_proguard_mapping",
                "android_native_symbols",
                "breakpad_symbols",
                "dotnet_pdb",
            ],
        )
        dsym_artifact = manifest["artifacts"][0]
        mapping_artifact = manifest["artifacts"][1]
        native_artifact = manifest["artifacts"][2]
        breakpad_artifact = manifest["artifacts"][3]
        dotnet_artifact = manifest["artifacts"][4]
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
        breakpad_details = breakpad_artifact["breakpadSymbols"]
        breakpad_file = breakpad_details["files"][0]
        self.assertEqual(breakpad_artifact["path"], "native/breakpad")
        self.assertEqual(breakpad_details["symbolFileCount"], 1)
        self.assertEqual(breakpad_details["architectures"], ["x86"])
        self.assertEqual(breakpad_file["path"], "native/breakpad/checkout.sym")
        self.assertEqual(breakpad_file["moduleOs"], "windows")
        self.assertEqual(breakpad_file["arch"], "x86")
        self.assertEqual(breakpad_file["moduleId"], "00112233445566778899AABBCCDDEEFF2A")
        self.assertEqual(breakpad_file["guid"], "00112233-4455-6677-8899-AABBCCDDEEFF")
        self.assertEqual(breakpad_file["age"], 42)
        self.assertEqual(breakpad_file["moduleName"], "checkout.pdb")
        self.assertEqual(breakpad_file["symbolSource"], "debug_info")
        self.assertTrue(breakpad_artifact["artifactId"].startswith("lbw_breakpad_symbols_"))
        dotnet_details = dotnet_artifact["dotnetPdb"]
        dotnet_file = dotnet_details["files"][0]
        self.assertEqual(dotnet_artifact["path"], "windows/symbols")
        self.assertEqual(dotnet_details["symbolFileCount"], 1)
        self.assertEqual(dotnet_details["architectures"], ["x64"])
        self.assertEqual(dotnet_file["path"], "windows/symbols/checkout.dll")
        self.assertEqual(dotnet_file["peClass"], 64)
        self.assertEqual(dotnet_file["arch"], "x64")
        self.assertEqual(dotnet_file["pdbGuid"], DEFAULT_PDB_GUID)
        self.assertEqual(dotnet_file["pdbAge"], DEFAULT_PDB_AGE)
        self.assertEqual(dotnet_file["pdbDebugId"], f"{DEFAULT_PDB_GUID}_{DEFAULT_PDB_AGE}")
        self.assertEqual(dotnet_file["pdbFileName"], "checkout.pdb")
        self.assertEqual(dotnet_file["pdbPath"], "windows/symbols/checkout.pdb")
        self.assertEqual(dotnet_file["symbolSource"], "debug_info")
        self.assertTrue(dotnet_artifact["artifactId"].startswith("lbw_dotnet_pdb_"))
        serialized = json.dumps(manifest)
        self.assertNotIn(tmp, serialized)
        self.assertNotIn("com.example.Checkout", serialized)
        self.assertNotIn(DEFAULT_MACHO_DEBUG_PAYLOAD.decode("ascii", errors="ignore"), serialized)
        self.assertNotIn(DEFAULT_MACHO_UUID.hex(), serialized)
        self.assertNotIn(DEFAULT_DEBUG_PAYLOAD.decode("ascii", errors="ignore"), serialized)
        self.assertNotIn(DEFAULT_BREAKPAD_SOURCE_PATH, serialized)
        self.assertNotIn(DEFAULT_BREAKPAD_SYMBOL_NAME, serialized)
        self.assertNotIn(DEFAULT_PDB_PATH, serialized)
        self.assertNotIn(DEFAULT_PDB_PAYLOAD.decode("ascii"), serialized)

    def test_android_native_symbol_file_count_limit_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "android" / "symbols"
            write_android_elf_symbol(symbols_dir / "lib" / "arm64-v8a" / "libcheckout.so")
            write_android_elf_symbol(
                symbols_dir / "lib" / "x86_64" / "libcheckout.so",
                build_id=bytes.fromhex("42cc7f54d61dc2d4022a4dc58fdec1f4"),
            )

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("android_native_symbols", symbols_dir)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
                max_symbol_files=1,
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "android/symbols: Android native symbols artifact contains 2 symbol files; maximum is 1",
            manifest["validation"]["errors"],
        )
        self.assertEqual(manifest["artifacts"][0]["androidNativeSymbols"]["symbolFileCount"], 0)

    def test_android_native_symbol_file_size_limit_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = self.create_android_native_symbols(artifact_root)
            symbol_file = symbols_dir / "lib" / "arm64-v8a" / "libcheckout.so"
            symbol_size = symbol_file.stat().st_size

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("android_native_symbols", symbols_dir)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
                max_symbol_file_bytes=symbol_size - 1,
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            f"android/symbols: android/symbols/lib/arm64-v8a/libcheckout.so: "
            f"symbol file is {symbol_size} bytes; maximum is {symbol_size - 1} bytes",
            manifest["validation"]["errors"],
        )
        self.assertEqual(manifest["artifacts"][0]["androidNativeSymbols"]["symbolFileCount"], 0)

    def test_android_native_artifact_size_limit_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = self.create_android_native_symbols(artifact_root)
            symbols_size = create_native_release_artifact_manifest.byte_size(symbols_dir)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("android_native_symbols", symbols_dir)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
                max_artifact_bytes=1,
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "android/symbols: Android native symbols artifact is "
            f"{symbols_size} bytes; maximum is 1 bytes",
            manifest["validation"]["errors"],
        )

    def test_android_native_duplicate_build_id_keeps_richer_symbols(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "android" / "symbols"
            build_id = bytes.fromhex("32cc7f54d61dc2d4022a4dc58fdec1f4")
            write_android_elf_symbol(
                symbols_dir / "lib" / "arm64-v8a" / "libcheckout-stripped.so",
                build_id=build_id,
                include_debug_info=False,
                include_symtab=False,
                include_dynsym=True,
            )
            write_android_elf_symbol(
                symbols_dir / "lib" / "arm64-v8a" / "libcheckout.so",
                build_id=build_id,
                include_debug_info=True,
                include_symtab=True,
                include_dynsym=False,
            )

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("android_native_symbols", symbols_dir)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "ready")
        artifact = manifest["artifacts"][0]
        self.assertEqual(artifact["androidNativeSymbols"]["symbolFileCount"], 1)
        self.assertEqual(
            artifact["androidNativeSymbols"]["files"][0]["path"],
            "android/symbols/lib/arm64-v8a/libcheckout.so",
        )
        self.assertTrue(
            any("duplicate Android native symbol identity" in warning for warning in artifact["validation"]["warnings"])
        )

    def test_breakpad_public_only_symbol_uses_symbol_table_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            breakpad_symbols = self.create_breakpad_symbols(artifact_root, include_file_records=False)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("breakpad_symbols", breakpad_symbols)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "ready")
        self.assertEqual(
            manifest["artifacts"][0]["breakpadSymbols"]["files"][0]["symbolSource"],
            "symbol_table",
        )

    def test_breakpad_module_name_drops_local_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            breakpad_symbols = self.create_breakpad_symbols(
                artifact_root,
                module_name="/workspace/mobile/checkout.pdb",
            )

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("breakpad_symbols", breakpad_symbols)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        serialized = json.dumps(manifest)
        self.assertEqual(manifest["validation"]["status"], "ready")
        self.assertEqual(
            manifest["artifacts"][0]["breakpadSymbols"]["files"][0]["moduleName"],
            "checkout.pdb",
        )
        self.assertNotIn("/workspace/mobile", serialized)

    def test_breakpad_without_module_header_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            symbols_dir = artifact_root / "native" / "breakpad"
            symbols_dir.mkdir(parents=True)
            (symbols_dir / "bad.sym").write_text("FILE 0 src/app/checkout.cpp\n", encoding="ascii")

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("breakpad_symbols", symbols_dir)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "native/breakpad: native/breakpad/bad.sym: "
            "first non-empty line must be a Breakpad MODULE header",
            manifest["validation"]["errors"],
        )

    def test_breakpad_malformed_identifier_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            breakpad_symbols = self.create_breakpad_symbols(artifact_root, module_id="001122")

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("breakpad_symbols", breakpad_symbols)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "native/breakpad: native/breakpad/checkout.sym: "
            "Breakpad MODULE identifier must contain GUID and age",
            manifest["validation"]["errors"],
        )

    def test_dotnet_pdb_missing_sibling_pdb_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            dotnet_pdb = self.create_dotnet_pdb_symbols(artifact_root, include_pdb=False)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("dotnet_pdb", dotnet_pdb)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "windows/symbols: windows/symbols/checkout.dll: associated PDB file was not found",
            manifest["validation"]["errors"],
        )

    def test_dotnet_pdb_without_codeview_blocks_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            dotnet_pdb = self.create_dotnet_pdb_symbols(artifact_root, include_codeview=False)

            manifest = create_native_release_artifact_manifest.create_manifest(
                artifact_root=artifact_root,
                artifacts=[("dotnet_pdb", dotnet_pdb)],
                release="2026.06.17",
                environment="production",
                service="checkout-mobile",
            )

        self.assertEqual(manifest["validation"]["status"], "blocked")
        self.assertIn(
            "windows/symbols: windows/symbols/checkout.dll: PE file has no CodeView PDB debug information",
            manifest["validation"]["errors"],
        )

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
            "android/symbols: android/symbols/lib/arm64-v8a/libcheckout.so: "
            "ELF file has no debug info or symbol tables",
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
