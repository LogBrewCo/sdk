from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from tests.native_elf_fixture import write_android_elf_symbol


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "create_native_release_artifact_manifest.py"
SPEC = importlib.util.spec_from_file_location("create_native_release_artifact_manifest", MODULE_PATH)
assert SPEC is not None
create_native_release_artifact_manifest = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(create_native_release_artifact_manifest)


class UnityArchiveReleaseArtifactTests(unittest.TestCase):
    def write_unity_zip(self, archive_path: Path, *, include_mapping: bool = True) -> None:
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            so_path = Path(tmp) / "libil2cpp.sym.so"
            write_android_elf_symbol(so_path)
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("symbols/build_id", "checkout-unity-2026.06.18\n")
                archive.write(so_path, "symbols/arm64-v8a/libil2cpp.sym.so")
                if include_mapping:
                    archive.writestr(
                        "symbols/LineNumberMappings.json",
                        "{\n"
                        "  \"files\": [\"/Users/dev/checkout/Assets/Scripts/Checkout.cs\"],\n"
                        "  \"methods\": [\"Checkout.PlaceOrder\"]\n"
                        "}\n",
                    )

    def create_manifest_for(self, artifact_root: Path, archive_path: Path) -> dict[str, object]:
        return create_native_release_artifact_manifest.create_manifest(
            artifact_root=artifact_root,
            artifacts=[("unity_symbols", archive_path)],
            release="2026.06.18",
            environment="production",
            service="checkout-unity",
        )

    def test_unity_symbols_zip_is_validated_without_leaking_mapping_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            archive_path = artifact_root / "unity" / "symbols.zip"
            self.write_unity_zip(archive_path)
            archive_size = archive_path.stat().st_size

            manifest = self.create_manifest_for(artifact_root, archive_path)

        self.assertEqual(manifest["validation"]["status"], "ready")
        artifact = manifest["artifacts"][0]
        self.assertEqual(artifact["path"], "unity/symbols.zip")
        self.assertEqual(artifact["fileCount"], 1)
        self.assertEqual(artifact["byteSize"], archive_size)
        self.assertEqual(artifact["unitySymbols"]["archiveFormat"], "zip")
        self.assertEqual(artifact["unitySymbols"]["buildId"], "checkout-unity-2026.06.18")
        self.assertEqual(artifact["unitySymbols"]["symbolFileCount"], 2)
        self.assertEqual(artifact["unitySymbols"]["nativeSymbolFileCount"], 1)
        self.assertEqual(artifact["unitySymbols"]["il2cppMappingFileCount"], 1)
        self.assertEqual(
            artifact["unitySymbols"]["files"][0]["path"],
            "unity/symbols.zip!symbols/arm64-v8a/libil2cpp.sym.so",
        )
        self.assertEqual(
            artifact["unitySymbols"]["files"][1]["path"],
            "unity/symbols.zip!symbols/LineNumberMappings.json",
        )
        serialized = json.dumps(manifest, sort_keys=True)
        self.assertNotIn("/Users/dev/checkout", serialized)
        self.assertNotIn("Checkout.PlaceOrder", serialized)

    def test_unity_symbols_zip_blocks_unsafe_entry_paths_without_echoing_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            archive_path = artifact_root / "unity" / "symbols.zip"
            archive_path.parent.mkdir(parents=True)
            unsafe_entry_name = "/".join(("..", "outside", "build_id"))
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(unsafe_entry_name, "checkout-unity-2026.06.18\n")
                archive.writestr("symbols/LineNumberMappings.json", "{}\n")

            manifest = self.create_manifest_for(artifact_root, archive_path)

        self.assertEqual(manifest["validation"]["status"], "blocked")
        errors = manifest["artifacts"][0]["validation"]["errors"]
        self.assertIn("unity/symbols.zip: Unity symbols archive contains unsafe entry paths", errors)
        serialized = json.dumps(manifest, sort_keys=True)
        self.assertNotIn(unsafe_entry_name, serialized)


if __name__ == "__main__":
    unittest.main()
