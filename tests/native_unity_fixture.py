from __future__ import annotations

import tempfile
import zipfile
from pathlib import Path

try:
    from native_elf_fixture import write_android_elf_symbol
except ModuleNotFoundError:  # Imported as tests.native_unity_fixture.
    from tests.native_elf_fixture import write_android_elf_symbol


def write_unity_symbols_zip(
    archive_path: Path,
    *,
    include_mapping: bool = True,
    source_path: str = "Assets/Scripts/Checkout.cs",
    method_name: str = "Checkout.PlaceOrder",
) -> None:
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        unity_so = Path(tmp) / "libil2cpp.sym.so"
        write_android_elf_symbol(unity_so)
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("symbols/build_id", "checkout-unity-2026.06.18\n")
            archive.write(unity_so, "symbols/arm64-v8a/libil2cpp.sym.so")
            if include_mapping:
                archive.writestr(
                    "symbols/LineNumberMappings.json",
                    "{\n"
                    f"  \"files\": [\"{source_path}\"],\n"
                    f"  \"methods\": [\"{method_name}\"]\n"
                    "}\n",
                )
