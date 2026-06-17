"""PE, PDB, and Breakpad helpers for native release-artifact dry runs."""

from __future__ import annotations

import os
import re
import struct
from pathlib import Path
from typing import Any

from native_release_artifact_io import c_string, read_bytes


BREAKPAD_IDENTIFIER_RE = re.compile(r"^[0-9A-F]+$")
BREAKPAD_CPU_ARCHES = {
    "x86": "x86",
    "x86_64": "x86_64",
    "amd64": "x86_64",
    "x64": "x86_64",
    "arm64": "arm64",
    "aarch64": "arm64",
    "arm": "armv7",
    "armv7": "armv7",
    "arm32": "armv7",
}

PE_DOS_HEADER_SIZE = 64
PE_DOS_SIGNATURE = b"MZ"
PE_LFANEW_OFFSET = 0x3C
PE_SIGNATURE = b"PE\0\0"
PE_FILE_HEADER_SIZE = 20
PE_OPTIONAL_HEADER32_MAGIC = 0x10B
PE_OPTIONAL_HEADER64_MAGIC = 0x20B
PE_DATA_DIRECTORY32_OFFSET = 96
PE_DATA_DIRECTORY64_OFFSET = 112
PE_DATA_DIRECTORY_SIZE = 8
PE_DIRECTORY_ENTRY_DEBUG = 6
PE_SECTION_HEADER_SIZE = 40
PE_DEBUG_DIRECTORY_SIZE = 28
PE_DEBUG_TYPE_CODEVIEW = 2
PE_CODEVIEW_PDB70_SIGNATURE = b"RSDS"
PE_CODEVIEW_PDB70_SIZE = 24
PE_MACHINE_ARCHES = {
    0x014C: "x86",
    0x8664: "x64",
    0x01C0: "arm32",
    0xAA64: "arm64",
}
PE_CANDIDATE_SUFFIXES = {".dll", ".exe"}


def breakpad_symbol_candidates(path: Path) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix.lower() == ".sym" else []
    return sorted(candidate for candidate in path.rglob("*.sym") if candidate.is_file())


def breakpad_guid(guid_hex: str) -> str:
    return f"{guid_hex[:8]}-{guid_hex[8:12]}-{guid_hex[12:16]}-{guid_hex[16:20]}-{guid_hex[20:]}"


def basename_only(name: str) -> str:
    return name.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1] or "unknown"


def parse_breakpad_header(line: str) -> tuple[str, str, str, str]:
    if not line.startswith("MODULE "):
        raise ValueError("first non-empty line must be a Breakpad MODULE header")
    parts = line.split()
    if len(parts) < 5:
        raise ValueError("Breakpad MODULE header is malformed")
    module_os, cpu, identifier = parts[1], parts[2], parts[3].upper()
    if len(identifier) <= 32:
        raise ValueError("Breakpad MODULE identifier must contain GUID and age")
    if not BREAKPAD_IDENTIFIER_RE.fullmatch(identifier):
        raise ValueError("Breakpad MODULE identifier must be hexadecimal")
    int(identifier[32:], 16)
    return module_os, cpu, identifier, basename_only(" ".join(parts[4:]))


def read_breakpad_metadata(path: Path) -> tuple[dict[str, Any], str | None]:
    header: tuple[str, str, str, str] | None = None
    has_file_records = False
    try:
        with path.open("rb") as handle:
            for raw_line in handle:
                line = raw_line.rstrip(b"\r\n")
                if any(byte > 127 for byte in line):
                    return {}, "Breakpad .sym files must be ASCII encoded"
                text = line.decode("ascii").strip()
                if not header:
                    if not text:
                        continue
                    header = parse_breakpad_header(text)
                    continue
                if text.startswith("FILE "):
                    has_file_records = True
                    break
                if text.startswith(("FUNC ", "PUBLIC ")):
                    break
        if not header:
            return {}, "Breakpad symbol file is missing MODULE header"
        module_os, cpu, identifier, module_name = header
        guid_hex = identifier[:32]
        age_hex = identifier[32:]
        return {
            "moduleOs": module_os,
            "cpu": cpu,
            "arch": BREAKPAD_CPU_ARCHES.get(cpu.lower(), f"unknown({cpu})"),
            "moduleId": identifier,
            "guid": breakpad_guid(guid_hex),
            "age": int(age_hex, 16),
            "moduleName": module_name,
            "symbolSource": "debug_info" if has_file_records else "symbol_table",
        }, None
    except (OSError, ValueError) as exc:
        return {}, str(exc)


def pe_symbol_candidates(path: Path) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix.lower() in PE_CANDIDATE_SUFFIXES else []
    return sorted(
        candidate
        for candidate in path.rglob("*")
        if candidate.is_file() and candidate.suffix.lower() in PE_CANDIDATE_SUFFIXES
    )


def format_codeview_guid(payload: bytes) -> str:
    if len(payload) != 16:
        raise ValueError("CodeView GUID is truncated")
    data1 = struct.unpack_from("<I", payload, 0)[0]
    data2 = struct.unpack_from("<H", payload, 4)[0]
    data3 = struct.unpack_from("<H", payload, 6)[0]
    data4 = payload[8:]
    return (
        f"{data1:08X}-{data2:04X}-{data3:04X}-"
        f"{data4[:2].hex().upper()}-{data4[2:].hex().upper()}"
    )


def rva_to_file_offset(rva: int, sections: list[dict[str, int]], file_size: int) -> int | None:
    for section in sections:
        start = section["virtualAddress"]
        size = max(section["virtualSize"], section["rawSize"])
        if start <= rva < start + size:
            offset = section["rawPointer"] + (rva - start)
            return offset if 0 <= offset < file_size else None
    return rva if 0 <= rva < file_size else None


def read_pe_sections(path: Path, offset: int, count: int) -> list[dict[str, int]]:
    sections: list[dict[str, int]] = []
    table = read_bytes(path, offset, count * PE_SECTION_HEADER_SIZE)
    for index in range(count):
        section_offset = index * PE_SECTION_HEADER_SIZE
        virtual_size = struct.unpack_from("<I", table, section_offset + 8)[0]
        virtual_address = struct.unpack_from("<I", table, section_offset + 12)[0]
        raw_size = struct.unpack_from("<I", table, section_offset + 16)[0]
        raw_pointer = struct.unpack_from("<I", table, section_offset + 20)[0]
        sections.append(
            {
                "virtualSize": virtual_size,
                "virtualAddress": virtual_address,
                "rawSize": raw_size,
                "rawPointer": raw_pointer,
            }
        )
    return sections


def read_pe_codeview_metadata(path: Path) -> tuple[dict[str, Any], str | None]:
    try:
        file_size = path.stat().st_size
        if file_size < PE_DOS_HEADER_SIZE:
            return {"isPe": False}, "PE DOS header is truncated"
        dos_header = read_bytes(path, 0, PE_DOS_HEADER_SIZE)
        if dos_header[:2] != PE_DOS_SIGNATURE:
            return {"isPe": False}, "not a PE file"
        pe_offset = struct.unpack_from("<I", dos_header, PE_LFANEW_OFFSET)[0]
        if pe_offset + 4 + PE_FILE_HEADER_SIZE > file_size:
            return {"isPe": True}, "PE header is truncated"
        if read_bytes(path, pe_offset, 4) != PE_SIGNATURE:
            return {"isPe": False}, "invalid PE signature"

        file_header_offset = pe_offset + 4
        file_header = read_bytes(path, file_header_offset, PE_FILE_HEADER_SIZE)
        machine = struct.unpack_from("<H", file_header, 0)[0]
        section_count = struct.unpack_from("<H", file_header, 2)[0]
        optional_header_size = struct.unpack_from("<H", file_header, 16)[0]
        optional_header_offset = file_header_offset + PE_FILE_HEADER_SIZE
        if optional_header_size < PE_DATA_DIRECTORY64_OFFSET + PE_DATA_DIRECTORY_SIZE:
            return {"isPe": True}, "PE optional header is truncated"
        optional_header = read_bytes(path, optional_header_offset, optional_header_size)
        magic = struct.unpack_from("<H", optional_header, 0)[0]
        if magic == PE_OPTIONAL_HEADER32_MAGIC:
            directory_offset = PE_DATA_DIRECTORY32_OFFSET
            pe_class = 32
        elif magic == PE_OPTIONAL_HEADER64_MAGIC:
            directory_offset = PE_DATA_DIRECTORY64_OFFSET
            pe_class = 64
        else:
            return {"isPe": True}, f"unsupported PE optional header magic: {magic}"
        debug_directory_offset = directory_offset + PE_DIRECTORY_ENTRY_DEBUG * PE_DATA_DIRECTORY_SIZE
        if debug_directory_offset + PE_DATA_DIRECTORY_SIZE > optional_header_size:
            return {"isPe": True}, "PE debug directory entry is missing"
        debug_rva, debug_size = struct.unpack_from("<II", optional_header, debug_directory_offset)
        if debug_rva == 0 or debug_size == 0:
            return {
                "isPe": True,
                "peClass": pe_class,
                "arch": PE_MACHINE_ARCHES.get(machine, f"unknown({machine})"),
            }, "PE file has no CodeView PDB debug information"

        sections_offset = optional_header_offset + optional_header_size
        sections = read_pe_sections(path, sections_offset, section_count)
        debug_offset = rva_to_file_offset(debug_rva, sections, file_size)
        if debug_offset is None or debug_offset + debug_size > file_size:
            return {"isPe": True}, "PE debug directory points outside the file"
        debug_payload = read_bytes(path, debug_offset, debug_size)
        for entry_offset in range(0, debug_size - PE_DEBUG_DIRECTORY_SIZE + 1, PE_DEBUG_DIRECTORY_SIZE):
            debug_type = struct.unpack_from("<I", debug_payload, entry_offset + 12)[0]
            if debug_type != PE_DEBUG_TYPE_CODEVIEW:
                continue
            codeview_size = struct.unpack_from("<I", debug_payload, entry_offset + 16)[0]
            codeview_rva = struct.unpack_from("<I", debug_payload, entry_offset + 20)[0]
            codeview_raw = struct.unpack_from("<I", debug_payload, entry_offset + 24)[0]
            codeview_offset = codeview_raw or rva_to_file_offset(codeview_rva, sections, file_size)
            if codeview_offset is None or codeview_offset + codeview_size > file_size:
                return {"isPe": True}, "PE CodeView record points outside the file"
            codeview = read_bytes(path, codeview_offset, codeview_size)
            if len(codeview) < PE_CODEVIEW_PDB70_SIZE or codeview[:4] != PE_CODEVIEW_PDB70_SIGNATURE:
                return {"isPe": True}, "PE CodeView record is not PDB70/RSDS"
            pdb_guid = format_codeview_guid(codeview[4:20])
            pdb_age = struct.unpack_from("<I", codeview, 20)[0]
            pdb_filename = basename_only(c_string(codeview, 24, encoding="utf-8"))
            if not pdb_filename:
                return {"isPe": True}, "PE CodeView PDB filename is empty"
            return {
                "isPe": True,
                "peClass": pe_class,
                "arch": PE_MACHINE_ARCHES.get(machine, f"unknown({machine})"),
                "pdbGuid": pdb_guid,
                "pdbAge": pdb_age,
                "pdbFileName": pdb_filename,
                "pdbDebugId": f"{pdb_guid}_{pdb_age}",
                "symbolSource": "debug_info",
            }, None
        return {"isPe": True}, "PE file has no CodeView PDB debug information"
    except (OSError, struct.error, ValueError) as exc:
        return {"isPe": False}, str(exc)


def associated_pdb_candidates(pe_path: Path, pdb_file_name: str) -> list[Path]:
    candidates = [pe_path.parent / basename_only(pdb_file_name), pe_path.with_suffix(".pdb")]
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = os.path.normcase(str(candidate))
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique
