"""ELF helpers for native release-artifact dry runs."""

from __future__ import annotations

import struct
from pathlib import Path
from typing import Any

from native_release_artifact_io import align_offset, c_string, read_bytes, sha256_file


ELF_CLASS_32 = 1
ELF_CLASS_64 = 2
ELF_DATA_LITTLE_ENDIAN = 1
ELF_DATA_BIG_ENDIAN = 2
ELF_VERSION_CURRENT = 1
ELF_TYPE_EXEC = 2
ELF_TYPE_DYN = 3
ELF_MACHINE_ARCHES = {
    3: "x86",
    40: "armeabi-v7a",
    62: "x86_64",
    183: "arm64-v8a",
}
ELF_TYPES = {
    ELF_TYPE_EXEC: "EXEC",
    ELF_TYPE_DYN: "DYN",
}
SHT_PROGBITS = 1
SHT_SYMTAB = 2
SHT_STRTAB = 3
SHT_NOTE = 7
SHT_NOBITS = 8
SHT_DYNSYM = 11
NT_GNU_BUILD_ID = 3
NT_GO_BUILD_ID = 4
ELF_HEADER_SIZE_32 = 52
ELF_HEADER_SIZE_64 = 64
ELF_SECTION_HEADER_SIZE_32 = 40
ELF_SECTION_HEADER_SIZE_64 = 64


def parse_elf_header(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    header_start = read_bytes(path, 0, min(ELF_HEADER_SIZE_64, path.stat().st_size))
    if len(header_start) < 16 or header_start[:4] != b"\x7fELF":
        return None, "not an ELF file"

    elf_class = header_start[4]
    data_encoding = header_start[5]
    ident_version = header_start[6]
    if elf_class not in (ELF_CLASS_32, ELF_CLASS_64):
        return None, f"unsupported ELF class: {elf_class}"
    if data_encoding not in (ELF_DATA_LITTLE_ENDIAN, ELF_DATA_BIG_ENDIAN):
        return None, f"unsupported ELF endianness: {data_encoding}"
    if ident_version != ELF_VERSION_CURRENT:
        return None, f"unsupported ELF version: {ident_version}"

    is_64_bit = elf_class == ELF_CLASS_64
    header_size = ELF_HEADER_SIZE_64 if is_64_bit else ELF_HEADER_SIZE_32
    section_header_size = ELF_SECTION_HEADER_SIZE_64 if is_64_bit else ELF_SECTION_HEADER_SIZE_32
    if path.stat().st_size < header_size:
        return None, "ELF header is truncated"

    endian_prefix = "<" if data_encoding == ELF_DATA_LITTLE_ENDIAN else ">"
    header_format = "HHIQQQIHHHHHH" if is_64_bit else "HHIIIIIHHHHHH"
    unpacked = struct.unpack_from(endian_prefix + header_format, read_bytes(path, 0, header_size), 16)
    (
        elf_type_code,
        machine_code,
        file_version,
        _entry,
        _program_header_offset,
        section_header_offset,
        _flags,
        elf_header_size,
        _program_header_entry_size,
        _program_header_count,
        section_header_entry_size,
        section_header_count,
        section_name_index,
    ) = unpacked

    if file_version != ELF_VERSION_CURRENT:
        return None, f"unsupported ELF file version: {file_version}"
    if elf_header_size != header_size:
        return None, f"unexpected ELF header size: {elf_header_size}"
    if section_header_count and section_header_entry_size != section_header_size:
        return None, f"unexpected ELF section header size: {section_header_entry_size}"
    if section_header_count == 0 or section_name_index == 0xFFFF:
        return None, "ELF extended section tables are not supported by this dry run"

    return {
        "elfClass": 64 if is_64_bit else 32,
        "littleEndian": data_encoding == ELF_DATA_LITTLE_ENDIAN,
        "endianPrefix": endian_prefix,
        "elfTypeCode": elf_type_code,
        "elfType": ELF_TYPES.get(elf_type_code, f"unknown({elf_type_code})"),
        "machineCode": machine_code,
        "arch": ELF_MACHINE_ARCHES.get(machine_code, f"unknown({machine_code})"),
        "sectionHeaderOffset": int(section_header_offset),
        "sectionHeaderEntrySize": section_header_entry_size,
        "sectionHeaderCount": section_header_count,
        "sectionNameIndex": section_name_index,
    }, None


def parse_elf_section_headers(path: Path, header: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    count = int(header["sectionHeaderCount"])
    entry_size = int(header["sectionHeaderEntrySize"])
    offset = int(header["sectionHeaderOffset"])
    table_size = count * entry_size
    if offset <= 0:
        return [], "ELF section header table is missing"
    if offset + table_size > path.stat().st_size:
        return [], "ELF section header table is truncated"

    section_format = "IIQQQQIIQQ" if header["elfClass"] == 64 else "IIIIIIIIII"
    sections: list[dict[str, Any]] = []
    file_size = path.stat().st_size
    table = read_bytes(path, offset, table_size)
    for index in range(count):
        values = struct.unpack_from(header["endianPrefix"] + section_format, table, index * entry_size)
        (
            name_offset,
            section_type,
            _flags,
            _address,
            section_offset,
            section_size,
            _link,
            _info,
            alignment,
            _entry_size,
        ) = values
        if section_type != SHT_NOBITS and int(section_offset) + int(section_size) > file_size:
            return [], "ELF section data is truncated"
        sections.append(
            {
                "nameOffset": int(name_offset),
                "type": int(section_type),
                "offset": int(section_offset),
                "size": int(section_size),
                "alignment": int(alignment),
                "name": "",
            }
        )

    section_name_index = int(header["sectionNameIndex"])
    if section_name_index >= len(sections):
        return [], "ELF section name table index is invalid"
    name_section = sections[section_name_index]
    if name_section["type"] != SHT_STRTAB:
        return [], "ELF section name table is missing"
    names = read_bytes(path, name_section["offset"], name_section["size"])
    for section in sections:
        section["name"] = c_string(names, section["nameOffset"])
    return sections, None


def parse_elf_note_payload(payload: bytes, little_endian: bool, alignment: int) -> list[dict[str, Any]]:
    endian_prefix = "<" if little_endian else ">"
    notes: list[dict[str, Any]] = []
    offset = 0
    while offset + 12 <= len(payload):
        name_size, desc_size, note_type = struct.unpack_from(endian_prefix + "III", payload, offset)
        name_offset = offset + 12
        desc_offset = align_offset(name_offset + name_size, alignment)
        desc_end = desc_offset + desc_size
        if desc_end > len(payload):
            break
        name = payload[name_offset : name_offset + name_size].rstrip(b"\0").decode("ascii", errors="replace")
        notes.append({"type": note_type, "name": name, "desc": payload[desc_offset:desc_end]})
        offset = align_offset(desc_end, alignment)
    return notes


def elf_build_ids(path: Path, sections: list[dict[str, Any]], little_endian: bool) -> tuple[str, str]:
    gnu_build_id = ""
    go_build_id = ""
    for section in sections:
        if section["type"] != SHT_NOTE:
            continue
        if section["name"] not in {".note.gnu.build-id", ".note.go.buildid"}:
            continue
        payload = read_bytes(path, section["offset"], section["size"])
        for note in parse_elf_note_payload(payload, little_endian, section["alignment"]):
            if section["name"] == ".note.gnu.build-id" and (
                note["type"] == NT_GNU_BUILD_ID or note["name"] == "GNU"
            ):
                gnu_build_id = note["desc"].hex()
            if section["name"] == ".note.go.buildid" and (
                note["type"] == NT_GO_BUILD_ID or note["name"] == "Go"
            ):
                go_build_id = note["desc"].decode("ascii", errors="replace")
    return gnu_build_id, go_build_id


def has_non_empty_section(sections: list[dict[str, Any]], name: str) -> bool:
    return any(
        section["name"] == name and section["type"] != SHT_NOBITS and section["size"] > 0
        for section in sections
    )


def read_elf_metadata(path: Path) -> tuple[dict[str, Any], str | None]:
    try:
        header, header_error = parse_elf_header(path)
        if header_error:
            return {"isElf": header is not None}, header_error
        assert header is not None
        sections, section_error = parse_elf_section_headers(path, header)
        if section_error:
            return {"isElf": True, **header}, section_error
        gnu_build_id, go_build_id = elf_build_ids(path, sections, header["littleEndian"])
        has_debug_info = has_non_empty_section(sections, ".debug_info") or has_non_empty_section(
            sections, ".zdebug_info"
        )
        has_symbol_table = has_non_empty_section(sections, ".symtab")
        has_dynamic_symbol_table = has_non_empty_section(sections, ".dynsym")
        has_code = any(
            section["name"] == ".text" and section["type"] == SHT_PROGBITS
            for section in sections
        )
        return {
            "isElf": True,
            "elfClass": header["elfClass"],
            "elfType": header["elfType"],
            "elfTypeCode": header["elfTypeCode"],
            "arch": header["arch"],
            "gnuBuildId": gnu_build_id,
            "goBuildId": go_build_id,
            "fileSha256": sha256_file(path) if has_code else "",
            "hasDebugInfo": has_debug_info,
            "hasSymbolTable": has_symbol_table,
            "hasDynamicSymbolTable": has_dynamic_symbol_table,
            "hasCode": has_code,
        }, None
    except OSError as exc:
        return {"isElf": False}, str(exc)
    except (struct.error, ValueError) as exc:
        return {"isElf": True}, str(exc)


def elf_symbol_source(metadata: dict[str, Any]) -> str:
    if metadata.get("hasDebugInfo"):
        return "debug_info"
    if metadata.get("hasSymbolTable"):
        return "symbol_table"
    if metadata.get("hasDynamicSymbolTable"):
        return "dynamic_symbol_table"
    return "none"


def symbol_source_priority(symbol_source: str) -> int:
    return {
        "debug_info": 3,
        "symbol_table": 2,
        "dynamic_symbol_table": 1,
    }.get(symbol_source, 0)


def android_symbol_identity(symbol_file: dict[str, Any]) -> str:
    identifier = symbol_file.get("gnuBuildId") or symbol_file.get("goBuildId") or symbol_file.get("fileSha256")
    return f"{symbol_file['arch']}:{identifier}"


def dedupe_android_symbol_files(
    symbol_files: list[dict[str, Any]],
    warnings: list[str],
) -> list[dict[str, Any]]:
    by_identity: dict[str, dict[str, Any]] = {}
    for symbol_file in symbol_files:
        identity = android_symbol_identity(symbol_file)
        existing = by_identity.get(identity)
        if existing is None:
            by_identity[identity] = symbol_file
            continue

        new_priority = symbol_source_priority(str(symbol_file["symbolSource"]))
        existing_priority = symbol_source_priority(str(existing["symbolSource"]))
        if new_priority > existing_priority:
            warnings.append(
                f"{symbol_file['path']}: duplicate Android native symbol identity {identity}; "
                f"keeping this file because it has richer symbols"
            )
            by_identity[identity] = symbol_file
        else:
            warnings.append(
                f"{symbol_file['path']}: duplicate Android native symbol identity {identity}; "
                f"skipping this file"
            )
    return sorted(by_identity.values(), key=lambda symbol_file: str(symbol_file["path"]))


def android_native_symbol_candidates(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    return sorted(candidate for candidate in path.rglob("*.so") if candidate.is_file())
