"""PE, PDB, and Breakpad helpers for native release-artifact dry runs."""

from __future__ import annotations

import os
import re
import struct
import zlib
from pathlib import Path
from typing import Any

from native_release_artifact_io import align_offset, c_string, read_bytes


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
PE_DEBUG_TYPE_EMBEDDED_PORTABLE_PDB = 17
PE_CODEVIEW_PDB70_SIGNATURE = b"RSDS"
PE_CODEVIEW_PDB70_SIZE = 24
PE_EMBEDDED_PORTABLE_PDB_SIGNATURE = b"MPDB"
PE_EMBEDDED_PORTABLE_PDB_HEADER_SIZE = 8
PE_MACHINE_ARCHES = {
    0x014C: "x86",
    0x8664: "x64",
    0x01C0: "arm32",
    0xAA64: "arm64",
}
PE_CANDIDATE_SUFFIXES = {".dll", ".exe"}
PORTABLE_PDB_SIGNATURE = b"BSJB"
PORTABLE_PDB_ROOT_HEADER_SIZE = 16
PORTABLE_PDB_STREAM_HEADER_SIZE = 8
PORTABLE_PDB_STREAM_NAME_SCAN_LIMIT = 256
PORTABLE_PDB_PDB_STREAM_HEADER_SIZE = 32
PORTABLE_PDB_MAX_STREAMS = 64
PORTABLE_PDB_MAX_EMBEDDED_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
WINDOWS_PDB_SIGNATURE = b"Microsoft C/C++ MSF 7.00\r\n\x1a\x44\x53\x00\x00\x00"
WINDOWS_PDB_RAW_HEADER_SIZE = len(WINDOWS_PDB_SIGNATURE) + 20
WINDOWS_PDB_MIN_PAGE_SIZE = 0x100
WINDOWS_PDB_MAX_PAGE_SIZE = 128 * 0x10000
WINDOWS_PDB_MAX_DIRECTORY_BYTES = 16 * 1024 * 1024
WINDOWS_PDB_MAX_STREAMS = 65535
WINDOWS_PDB_PDB_STREAM = 1
WINDOWS_PDB_DBI_STREAM = 3
WINDOWS_PDB_INFO_STREAM_MIN_SIZE = 32
WINDOWS_PDB_DBI_AGE_OFFSET = 8
WINDOWS_PDB_DBI_AGE_SIZE = 12
SYMBOL_SOURCE_PRIORITY = {
    "debug_info": 3,
    "symbol_table": 2,
    "dynamic_symbol_table": 1,
}


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
        metadata: dict[str, Any] | None = None
        embedded_metadata: dict[str, Any] | None = None
        embedded_error: str | None = None
        for entry_offset in range(0, debug_size - PE_DEBUG_DIRECTORY_SIZE + 1, PE_DEBUG_DIRECTORY_SIZE):
            debug_type = struct.unpack_from("<I", debug_payload, entry_offset + 12)[0]
            data_size = struct.unpack_from("<I", debug_payload, entry_offset + 16)[0]
            data_rva = struct.unpack_from("<I", debug_payload, entry_offset + 20)[0]
            data_raw = struct.unpack_from("<I", debug_payload, entry_offset + 24)[0]
            data_offset = data_raw or rva_to_file_offset(data_rva, sections, file_size)
            if debug_type == PE_DEBUG_TYPE_CODEVIEW:
                if data_offset is None or data_offset + data_size > file_size:
                    return {"isPe": True}, "PE CodeView record points outside the file"
                codeview = read_bytes(path, data_offset, data_size)
                if len(codeview) < PE_CODEVIEW_PDB70_SIZE or codeview[:4] != PE_CODEVIEW_PDB70_SIGNATURE:
                    return {"isPe": True}, "PE CodeView record is not PDB70/RSDS"
                pdb_guid = format_codeview_guid(codeview[4:20])
                pdb_age = struct.unpack_from("<I", codeview, 20)[0]
                pdb_filename = basename_only(c_string(codeview, 24, encoding="utf-8"))
                if not pdb_filename:
                    return {"isPe": True}, "PE CodeView PDB filename is empty"
                metadata = {
                    "isPe": True,
                    "peClass": pe_class,
                    "arch": PE_MACHINE_ARCHES.get(machine, f"unknown({machine})"),
                    "pdbGuid": pdb_guid,
                    "pdbAge": pdb_age,
                    "pdbFileName": pdb_filename,
                    "pdbDebugId": f"{pdb_guid}_{pdb_age}",
                    "symbolSource": "debug_info",
                }
                continue
            if debug_type == PE_DEBUG_TYPE_EMBEDDED_PORTABLE_PDB:
                if data_offset is None or data_offset + data_size > file_size:
                    embedded_error = "embedded Portable PDB record points outside the file"
                    continue
                embedded_metadata, embedded_error = read_embedded_portable_pdb_metadata(
                    path,
                    data_offset,
                    data_size,
                )
        if metadata is None:
            return {"isPe": True}, "PE file has no CodeView PDB debug information"
        if embedded_error:
            return metadata, embedded_error
        if embedded_metadata:
            metadata["embeddedPortablePdb"] = embedded_metadata
        return metadata, None
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


def read_embedded_portable_pdb_metadata(
    path: Path,
    offset: int,
    size: int,
) -> tuple[dict[str, Any], str | None]:
    try:
        if size < PE_EMBEDDED_PORTABLE_PDB_HEADER_SIZE:
            return {}, "embedded Portable PDB debug data is truncated"
        payload = read_bytes(path, offset, size)
        if payload[:4] != PE_EMBEDDED_PORTABLE_PDB_SIGNATURE:
            return {}, "embedded Portable PDB signature is invalid"
        uncompressed_size = struct.unpack_from("<I", payload, 4)[0]
        if uncompressed_size > PORTABLE_PDB_MAX_EMBEDDED_UNCOMPRESSED_BYTES:
            return {}, (
                f"embedded Portable PDB is {uncompressed_size} bytes when decompressed; "
                f"maximum is {PORTABLE_PDB_MAX_EMBEDDED_UNCOMPRESSED_BYTES} bytes"
            )
        try:
            decompressor = zlib.decompressobj(wbits=-15)
            decompressed = decompressor.decompress(
                payload[PE_EMBEDDED_PORTABLE_PDB_HEADER_SIZE:],
                uncompressed_size + 1,
            )
            if len(decompressed) <= uncompressed_size:
                decompressed += decompressor.flush(uncompressed_size + 1 - len(decompressed))
        except zlib.error as exc:
            return {}, f"embedded Portable PDB could not be decompressed: {exc}"
        if not decompressor.eof or len(decompressed) != uncompressed_size:
            return {}, "embedded Portable PDB decompressed size does not match its header"
        metadata, metadata_error = read_portable_pdb_metadata_payload(decompressed)
        if metadata_error:
            return {}, f"embedded {metadata_error}"
        if metadata.get("pdbFormat") != "portable_pdb":
            return {}, "embedded Portable PDB payload is not a Portable PDB"
        return {
            **metadata,
            "pdbFormat": "embedded_portable_pdb",
            "compressedByteSize": len(payload) - PE_EMBEDDED_PORTABLE_PDB_HEADER_SIZE,
            "uncompressedByteSize": uncompressed_size,
        }, None
    except (OSError, struct.error, ValueError) as exc:
        return {}, str(exc)


def read_portable_pdb_metadata_payload(payload: bytes) -> tuple[dict[str, Any], str | None]:
    try:
        file_size = len(payload)
        if file_size < 4:
            return {"pdbFormat": "unrecognized"}, None
        if payload[:4] != PORTABLE_PDB_SIGNATURE:
            return {"pdbFormat": "unrecognized"}, None
        if file_size < PORTABLE_PDB_ROOT_HEADER_SIZE:
            return {"pdbFormat": "portable_pdb"}, "Portable PDB metadata root is truncated"

        header = payload[:PORTABLE_PDB_ROOT_HEADER_SIZE]
        version_length = struct.unpack_from("<I", header, 12)[0]
        streams_header_offset = PORTABLE_PDB_ROOT_HEADER_SIZE + version_length
        if streams_header_offset + 4 > file_size:
            return {"pdbFormat": "portable_pdb"}, "Portable PDB metadata root is truncated"

        streams_header = payload[streams_header_offset : streams_header_offset + 4]
        stream_count = struct.unpack_from("<H", streams_header, 2)[0]
        if stream_count <= 0:
            return {"pdbFormat": "portable_pdb"}, "Portable PDB stream directory is empty"
        if stream_count > PORTABLE_PDB_MAX_STREAMS:
            return {"pdbFormat": "portable_pdb"}, (
                f"Portable PDB stream directory has {stream_count} streams; maximum is {PORTABLE_PDB_MAX_STREAMS}"
            )

        stream_header_offset = streams_header_offset + 4
        for _ in range(stream_count):
            if stream_header_offset + PORTABLE_PDB_STREAM_HEADER_SIZE > file_size:
                return {"pdbFormat": "portable_pdb"}, "Portable PDB stream header is truncated"
            stream_header = payload[stream_header_offset : stream_header_offset + PORTABLE_PDB_STREAM_HEADER_SIZE]
            stream_offset, stream_size = struct.unpack_from("<II", stream_header, 0)
            name_offset = stream_header_offset + PORTABLE_PDB_STREAM_HEADER_SIZE
            name_limit = min(file_size, name_offset + PORTABLE_PDB_STREAM_NAME_SCAN_LIMIT)
            name_probe = payload[name_offset:name_limit]
            terminator = name_probe.find(b"\0")
            if terminator < 0:
                return {"pdbFormat": "portable_pdb"}, "Portable PDB stream name is unterminated"
            name_bytes = name_probe[:terminator]
            try:
                stream_name = name_bytes.decode("utf-8")
            except UnicodeDecodeError:
                return {"pdbFormat": "portable_pdb"}, "Portable PDB stream name is not UTF-8"
            name_end = name_offset + terminator
            stream_header_offset = align_offset(name_end + 1, 4)
            if stream_header_offset > file_size:
                return {"pdbFormat": "portable_pdb"}, "Portable PDB stream header is truncated"
            if stream_offset + stream_size > file_size:
                return {"pdbFormat": "portable_pdb"}, f"Portable PDB stream {stream_name or '<empty>'} points outside the file"

            if stream_name != "#Pdb":
                continue
            if stream_size < PORTABLE_PDB_PDB_STREAM_HEADER_SIZE:
                return {"pdbFormat": "portable_pdb"}, "Portable PDB #Pdb stream is truncated"
            pdb_stream_header = payload[stream_offset : stream_offset + PORTABLE_PDB_PDB_STREAM_HEADER_SIZE]
            pdb_guid = format_codeview_guid(pdb_stream_header[:16])
            pdb_age = struct.unpack_from("<I", pdb_stream_header, 16)[0]
            return {
                "pdbFormat": "portable_pdb",
                "pdbGuid": pdb_guid,
                "pdbAge": pdb_age,
                "pdbDebugId": f"{pdb_guid}_{pdb_age}",
            }, None

        return {"pdbFormat": "portable_pdb"}, "Portable PDB #Pdb stream is missing"
    except (struct.error, ValueError) as exc:
        return {"pdbFormat": "portable_pdb"}, str(exc)


def windows_pdb_pages_needed(byte_count: int, page_size: int) -> int:
    return (byte_count + page_size - 1) // page_size


def validate_windows_pdb_page_number(page_number: int, max_page: int, label: str) -> None:
    if page_number == 0 or page_number > max_page:
        raise ValueError(f"Windows PDB {label} page {page_number} is outside the file")


def read_windows_pdb_page(payload: bytes, page_number: int, page_size: int, max_page: int, label: str) -> bytes:
    validate_windows_pdb_page_number(page_number, max_page, label)
    offset = page_number * page_size
    if offset + page_size > len(payload):
        raise ValueError(f"Windows PDB {label} page {page_number} is truncated")
    return payload[offset : offset + page_size]


def read_windows_pdb_stream_payload(payload: bytes, page_size: int, max_page: int, pages: list[int], size: int) -> bytes:
    stream = bytearray()
    for page_number in pages:
        stream += read_windows_pdb_page(payload, page_number, page_size, max_page, "stream")
    return bytes(stream[:size])


def parse_windows_pdb_stream_directory(
    payload: bytes,
    page_size: int,
    max_page: int,
    directory_size: int,
) -> list[tuple[int, list[int]] | None]:
    directory_page_count = windows_pdb_pages_needed(directory_size, page_size)
    directory_page_list_byte_count = directory_page_count * 4
    directory_page_list_page_count = windows_pdb_pages_needed(directory_page_list_byte_count, page_size)
    page_list_header_offset = WINDOWS_PDB_RAW_HEADER_SIZE
    if page_list_header_offset + directory_page_list_page_count * 4 > min(page_size, len(payload)):
        raise ValueError("Windows PDB stream directory page list is truncated")

    directory_page_list_pages = [
        struct.unpack_from("<I", payload, page_list_header_offset + index * 4)[0]
        for index in range(directory_page_list_page_count)
    ]
    directory_page_list = bytearray()
    for page_number in directory_page_list_pages:
        directory_page_list += read_windows_pdb_page(
            payload,
            page_number,
            page_size,
            max_page,
            "stream directory page-list",
        )
    directory_page_list = directory_page_list[:directory_page_list_byte_count]

    directory_pages = [
        struct.unpack_from("<I", directory_page_list, index * 4)[0] for index in range(directory_page_count)
    ]
    directory = bytearray()
    for page_number in directory_pages:
        directory += read_windows_pdb_page(payload, page_number, page_size, max_page, "stream directory")
    directory = directory[:directory_size]
    if len(directory) < 4:
        raise ValueError("Windows PDB stream directory is truncated")

    stream_count = struct.unpack_from("<I", directory, 0)[0]
    if stream_count > WINDOWS_PDB_MAX_STREAMS:
        raise ValueError(
            f"Windows PDB stream directory has {stream_count} streams; maximum is {WINDOWS_PDB_MAX_STREAMS}"
        )
    sizes_offset = 4
    stream_pages_offset = sizes_offset + stream_count * 4
    if stream_pages_offset > len(directory):
        raise ValueError("Windows PDB stream directory is truncated")

    stream_sizes = [
        struct.unpack_from("<I", directory, sizes_offset + index * 4)[0] for index in range(stream_count)
    ]
    streams: list[tuple[int, list[int]] | None] = []
    page_cursor = stream_pages_offset
    for stream_size in stream_sizes:
        if stream_size == 0xFFFFFFFF:
            streams.append(None)
            continue
        page_count = windows_pdb_pages_needed(stream_size, page_size)
        if page_cursor + page_count * 4 > len(directory):
            raise ValueError("Windows PDB stream directory page references are truncated")
        pages = [struct.unpack_from("<I", directory, page_cursor + index * 4)[0] for index in range(page_count)]
        page_cursor += page_count * 4
        for page_number in pages:
            validate_windows_pdb_page_number(page_number, max_page, "stream")
        streams.append((stream_size, pages))
    return streams


def read_windows_pdb_stream(
    payload: bytes,
    page_size: int,
    max_page: int,
    streams: list[tuple[int, list[int]] | None],
    stream_index: int,
) -> bytes | None:
    if len(streams) <= stream_index or streams[stream_index] is None:
        return None
    stream_size, pages = streams[stream_index]
    return read_windows_pdb_stream_payload(payload, page_size, max_page, pages, stream_size)


def read_windows_pdb_metadata_payload(payload: bytes) -> tuple[dict[str, Any], str | None]:
    try:
        file_size = len(payload)
        if file_size < WINDOWS_PDB_RAW_HEADER_SIZE:
            return {"pdbFormat": "windows_pdb"}, "Windows PDB MSF header is truncated"
        page_size, _free_page_map, pages_used, directory_size, _reserved = struct.unpack_from(
            "<IIIII",
            payload,
            len(WINDOWS_PDB_SIGNATURE),
        )
        if (
            page_size.bit_count() != 1
            or page_size < WINDOWS_PDB_MIN_PAGE_SIZE
            or page_size > WINDOWS_PDB_MAX_PAGE_SIZE
        ):
            return {"pdbFormat": "windows_pdb"}, f"Windows PDB page size is invalid: {page_size}"
        if directory_size <= 0:
            return {"pdbFormat": "windows_pdb"}, "Windows PDB stream directory is empty"
        if directory_size > WINDOWS_PDB_MAX_DIRECTORY_BYTES:
            return {"pdbFormat": "windows_pdb"}, (
                f"Windows PDB stream directory is {directory_size} bytes; "
                f"maximum is {WINDOWS_PDB_MAX_DIRECTORY_BYTES} bytes"
            )
        if page_size > file_size:
            return {"pdbFormat": "windows_pdb"}, "Windows PDB page size is larger than the file"

        streams = parse_windows_pdb_stream_directory(payload, page_size, pages_used, directory_size)
        pdb_info = read_windows_pdb_stream(payload, page_size, pages_used, streams, WINDOWS_PDB_PDB_STREAM)
        if pdb_info is None:
            return {"pdbFormat": "windows_pdb"}, "Windows PDB information stream is missing"
        if len(pdb_info) < WINDOWS_PDB_INFO_STREAM_MIN_SIZE:
            return {"pdbFormat": "windows_pdb"}, "Windows PDB information stream is truncated"

        pdb_info_age = struct.unpack_from("<I", pdb_info, 8)[0]
        pdb_guid = format_codeview_guid(pdb_info[12:28])
        pdb_age = pdb_info_age
        dbi_stream = read_windows_pdb_stream(payload, page_size, pages_used, streams, WINDOWS_PDB_DBI_STREAM)
        if dbi_stream is not None:
            if len(dbi_stream) < WINDOWS_PDB_DBI_AGE_SIZE:
                return {"pdbFormat": "windows_pdb"}, "Windows PDB debug information stream is truncated"
            dbi_age = struct.unpack_from("<I", dbi_stream, WINDOWS_PDB_DBI_AGE_OFFSET)[0]
            if dbi_age != 0:
                pdb_age = dbi_age

        return {
            "pdbFormat": "windows_pdb",
            "pdbGuid": pdb_guid,
            "pdbAge": pdb_age,
            "pdbDebugId": f"{pdb_guid}_{pdb_age}",
        }, None
    except (struct.error, ValueError) as exc:
        return {"pdbFormat": "windows_pdb"}, str(exc)


def read_pdb_metadata_payload(payload: bytes) -> tuple[dict[str, Any], str | None]:
    if payload.startswith(WINDOWS_PDB_SIGNATURE):
        return read_windows_pdb_metadata_payload(payload)
    return read_portable_pdb_metadata_payload(payload)


def read_pdb_metadata(path: Path) -> tuple[dict[str, Any], str | None]:
    try:
        return read_pdb_metadata_payload(path.read_bytes())
    except OSError as exc:
        return {"pdbFormat": "unrecognized"}, str(exc)


def symbol_source_priority(symbol_source: str | None) -> int:
    return SYMBOL_SOURCE_PRIORITY.get(symbol_source or "", 0)


def pe_symbol_identity(symbol_file: dict[str, Any]) -> str:
    if "pdbDebugId" in symbol_file:
        return str(symbol_file["pdbDebugId"])
    if "guid" in symbol_file and "age" in symbol_file:
        return f"{symbol_file['guid']}_{symbol_file['age']}"
    return str(symbol_file["path"])


def dedupe_pe_symbol_files(
    symbol_files: list[dict[str, Any]],
    warnings: list[str],
    *,
    label: str,
) -> list[dict[str, Any]]:
    by_identity: dict[str, dict[str, Any]] = {}
    for symbol_file in symbol_files:
        identity = pe_symbol_identity(symbol_file)
        existing = by_identity.get(identity)
        if not existing:
            by_identity[identity] = symbol_file
            continue

        new_priority = symbol_source_priority(str(symbol_file.get("symbolSource", "")))
        existing_priority = symbol_source_priority(str(existing.get("symbolSource", "")))
        if new_priority > existing_priority:
            warnings.append(
                f"{symbol_file['path']}: duplicate {label} identity {identity}; "
                f"keeping this file because it has richer symbols"
            )
            by_identity[identity] = symbol_file
            continue

        warnings.append(
            f"{symbol_file['path']}: duplicate {label} identity {identity}; "
            f"skipping this file because {existing['path']} is at least as complete"
        )
    return sorted(by_identity.values(), key=lambda symbol_file: str(symbol_file["path"]))
