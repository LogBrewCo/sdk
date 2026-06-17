from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path


DEFAULT_BUILD_ID = bytes.fromhex("32cc7f54d61dc2d4022a4dc58fdec1f4")
DEFAULT_DEBUG_PAYLOAD = b"\x01\x02raw-symbol-section"
ELF_HEADER_SIZE_64 = 64
ELF_MACHINE_AARCH64 = 183
ELF_TYPE_DYN = 3
SHT_NULL = 0
SHT_PROGBITS = 1
SHT_SYMTAB = 2
SHT_STRTAB = 3
SHT_NOTE = 7
SHT_DYNSYM = 11


@dataclass
class ElfSection:
    name: str
    section_type: int
    data: bytes
    alignment: int
    name_offset: int = 0
    offset: int = 0

    @property
    def size(self) -> int:
        return len(self.data)


def aligned(value: int, alignment: int) -> int:
    alignment = max(alignment, 1)
    return value + ((alignment - (value % alignment)) % alignment)


def gnu_build_id_note(build_id: bytes) -> bytes:
    name = b"GNU\0"
    payload = struct.pack("<III", len(name), len(build_id), 3)
    payload += name
    payload += b"\0" * (aligned(len(payload), 4) - len(payload))
    payload += build_id
    payload += b"\0" * (aligned(len(payload), 4) - len(payload))
    return payload


def write_android_elf_symbol(
    output_path: Path,
    *,
    build_id: bytes = DEFAULT_BUILD_ID,
    include_build_id: bool = True,
    include_debug_info: bool = True,
    include_symtab: bool = True,
    include_dynsym: bool = False,
    include_code: bool = True,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sections = [ElfSection("", SHT_NULL, b"", 0)]
    if include_build_id:
        sections.append(ElfSection(".note.gnu.build-id", SHT_NOTE, gnu_build_id_note(build_id), 4))
    if include_debug_info:
        sections.append(ElfSection(".debug_info", SHT_PROGBITS, DEFAULT_DEBUG_PAYLOAD, 1))
    if include_symtab:
        sections.append(ElfSection(".symtab", SHT_SYMTAB, b"\0" * 24, 8))
    if include_dynsym:
        sections.append(ElfSection(".dynsym", SHT_DYNSYM, b"\0" * 24, 8))
    if include_code:
        sections.append(ElfSection(".text", SHT_PROGBITS, b"\xc0\x03\x5f\xd6", 16))
    sections.append(ElfSection(".shstrtab", SHT_STRTAB, b"", 1))

    section_names = b"\0"
    for section in sections[1:]:
        section.name_offset = len(section_names)
        section_names += section.name.encode("ascii") + b"\0"
    sections[-1].data = section_names

    offset = ELF_HEADER_SIZE_64
    for index, section in enumerate(sections):
        if index == 0:
            continue
        offset = aligned(offset, section.alignment)
        section.offset = offset
        offset += section.size

    section_header_offset = aligned(offset, 8)
    ident = b"\x7fELF" + bytes([2, 1, 1, 0]) + b"\0" * 8
    payload = bytearray(section_header_offset)
    payload[:ELF_HEADER_SIZE_64] = struct.pack(
        "<16sHHIQQQIHHHHHH",
        ident,
        ELF_TYPE_DYN,
        ELF_MACHINE_AARCH64,
        1,
        0,
        0,
        section_header_offset,
        0,
        ELF_HEADER_SIZE_64,
        0,
        0,
        ELF_HEADER_SIZE_64,
        len(sections),
        len(sections) - 1,
    )
    for section in sections[1:]:
        payload[section.offset : section.offset + section.size] = section.data
    for section in sections:
        payload.extend(
            struct.pack(
                "<IIQQQQIIQQ",
                section.name_offset,
                section.section_type,
                0,
                0,
                section.offset,
                section.size,
                0,
                0,
                section.alignment,
                0,
            )
        )
    output_path.write_bytes(payload)
