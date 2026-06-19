from __future__ import annotations

import struct
import tempfile
import zipfile
from pathlib import Path


DEFAULT_MACHO_UUID = bytes.fromhex("c8469f85b0603085b69de46c645560ea")
DEFAULT_MACHO_X86_UUID = bytes.fromhex("7a7b4fb7cd1c3f8db821dd02295cbeef")
DEFAULT_MACHO_DEBUG_PAYLOAD = b"macho-debug-payload"
LC_UUID = 0x1B
MACHO_CPU_TYPE_X86_64 = 0x01000007
MACHO_CPU_TYPE_ARM64 = 0x0100000C
MACHO_FILETYPE_DSYM = 0x0A
MACHO_MAGIC_64_LE = b"\xcf\xfa\xed\xfe"
FAT_MAGIC_32_BE = b"\xca\xfe\xba\xbe"


def macho_payload(
    *,
    uuid: bytes = DEFAULT_MACHO_UUID,
    cpu_type: int = MACHO_CPU_TYPE_ARM64,
    include_uuid: bool = True,
) -> bytes:
    load_commands = bytearray()
    if include_uuid:
        load_commands.extend(struct.pack("<II", LC_UUID, 24))
        load_commands.extend(uuid)
    header = MACHO_MAGIC_64_LE + struct.pack(
        "<IIIIIII",
        cpu_type,
        0,
        MACHO_FILETYPE_DSYM,
        1 if include_uuid else 0,
        len(load_commands),
        0,
        0,
    )
    return header + load_commands + DEFAULT_MACHO_DEBUG_PAYLOAD


def write_macho_dwarf(
    output_path: Path,
    *,
    uuid: bytes = DEFAULT_MACHO_UUID,
    cpu_type: int = MACHO_CPU_TYPE_ARM64,
    include_uuid: bool = True,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(macho_payload(uuid=uuid, cpu_type=cpu_type, include_uuid=include_uuid))


def aligned(value: int, alignment: int) -> int:
    return value + ((alignment - (value % alignment)) % alignment)


def write_fat_macho_dwarf(output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    arm64_slice = macho_payload(uuid=DEFAULT_MACHO_UUID, cpu_type=MACHO_CPU_TYPE_ARM64)
    x86_slice = macho_payload(uuid=DEFAULT_MACHO_X86_UUID, cpu_type=MACHO_CPU_TYPE_X86_64)
    table_size = 8 + 2 * 20
    arm64_offset = aligned(table_size, 8)
    x86_offset = aligned(arm64_offset + len(arm64_slice), 8)
    header = bytearray()
    header.extend(FAT_MAGIC_32_BE)
    header.extend(struct.pack(">I", 2))
    header.extend(struct.pack(">IIIII", MACHO_CPU_TYPE_ARM64, 0, arm64_offset, len(arm64_slice), 3))
    header.extend(struct.pack(">IIIII", MACHO_CPU_TYPE_X86_64, 0, x86_offset, len(x86_slice), 3))
    payload = bytearray(x86_offset + len(x86_slice))
    payload[: len(header)] = header
    payload[arm64_offset : arm64_offset + len(arm64_slice)] = arm64_slice
    payload[x86_offset : x86_offset + len(x86_slice)] = x86_slice
    output_path.write_bytes(payload)


def write_dsym_zip(archive_path: Path, *, include_info_plist: bool = True) -> None:
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        dwarf_path = Path(tmp) / "Checkout.app.dSYM" / "Contents" / "Resources" / "DWARF" / "Checkout"
        write_macho_dwarf(dwarf_path)
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(dwarf_path, "Payload/Checkout.app.dSYM/Contents/Resources/DWARF/Checkout")
            if include_info_plist:
                archive.writestr("Payload/Checkout.app.dSYM/Contents/Info.plist", "<plist version=\"1.0\" />\n")
