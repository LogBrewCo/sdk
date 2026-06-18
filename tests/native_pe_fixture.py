from __future__ import annotations

import struct
from pathlib import Path


DEFAULT_PDB_GUID = "00112233-4455-6677-8899-AABBCCDDEEFF"
DEFAULT_PDB_AGE = 42
DEFAULT_PDB_PATH = r"C:\Users\dev\checkout.pdb"
DEFAULT_PDB_PAYLOAD_MARKER = b"portable-pdb-symbol-bytes"
PE_DOS_HEADER_SIZE = 64
PE_OFFSET = 0x80
PE_SECTION_RAW_OFFSET = 0x200
PE_SECTION_RVA = 0x1000
PE_OPTIONAL_HEADER64_SIZE = 240
PE_SECTION_HEADER_SIZE = 40
PE_DEBUG_DIRECTORY_SIZE = 28
PE_MACHINE_AMD64 = 0x8664
PE_MAGIC64 = 0x20B
PE_DIRECTORY_ENTRY_DEBUG = 6
PE_DATA_DIRECTORY64_OFFSET = 112
PE_DEBUG_TYPE_CODEVIEW = 2


def codeview_guid_bytes(guid: str) -> bytes:
    parts = guid.split("-")
    return (
        int(parts[0], 16).to_bytes(4, "little")
        + int(parts[1], 16).to_bytes(2, "little")
        + int(parts[2], 16).to_bytes(2, "little")
        + bytes.fromhex(parts[3] + parts[4])
    )


def write_pe_with_codeview(
    output_path: Path,
    *,
    pdb_guid: str = DEFAULT_PDB_GUID,
    pdb_age: int = DEFAULT_PDB_AGE,
    pdb_path: str = DEFAULT_PDB_PATH,
    include_codeview: bool = True,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    codeview = b""
    if include_codeview:
        codeview = b"RSDS" + codeview_guid_bytes(pdb_guid) + struct.pack("<I", pdb_age)
        codeview += pdb_path.encode("utf-8") + b"\0"

    debug_directory_rva = PE_SECTION_RVA
    codeview_rva = PE_SECTION_RVA + PE_DEBUG_DIRECTORY_SIZE
    codeview_offset = PE_SECTION_RAW_OFFSET + PE_DEBUG_DIRECTORY_SIZE
    debug_directory = struct.pack(
        "<IIHHIIII",
        0,
        0,
        0,
        0,
        PE_DEBUG_TYPE_CODEVIEW,
        len(codeview),
        codeview_rva,
        codeview_offset,
    )
    section_payload = debug_directory + codeview if include_codeview else b""
    section_raw_size = max(0x200, len(section_payload))

    payload = bytearray(PE_SECTION_RAW_OFFSET + section_raw_size)
    dos = bytearray(PE_DOS_HEADER_SIZE)
    dos[:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, PE_OFFSET)
    payload[:PE_DOS_HEADER_SIZE] = dos
    payload[PE_OFFSET : PE_OFFSET + 4] = b"PE\0\0"

    file_header_offset = PE_OFFSET + 4
    struct.pack_into(
        "<HHIIIHH",
        payload,
        file_header_offset,
        PE_MACHINE_AMD64,
        1,
        0,
        0,
        0,
        PE_OPTIONAL_HEADER64_SIZE,
        0x2022,
    )

    optional_header_offset = file_header_offset + 20
    struct.pack_into("<H", payload, optional_header_offset, PE_MAGIC64)
    debug_data_directory_offset = optional_header_offset + PE_DATA_DIRECTORY64_OFFSET + (
        PE_DIRECTORY_ENTRY_DEBUG * 8
    )
    struct.pack_into(
        "<II",
        payload,
        debug_data_directory_offset,
        debug_directory_rva if include_codeview else 0,
        PE_DEBUG_DIRECTORY_SIZE if include_codeview else 0,
    )

    section_header_offset = optional_header_offset + PE_OPTIONAL_HEADER64_SIZE
    payload[section_header_offset : section_header_offset + 8] = b".rdata\0\0"
    struct.pack_into(
        "<IIIIIIHHI",
        payload,
        section_header_offset + 8,
        len(section_payload),
        PE_SECTION_RVA,
        section_raw_size,
        PE_SECTION_RAW_OFFSET,
        0,
        0,
        0,
        0,
        0x40000040,
    )
    payload[PE_SECTION_RAW_OFFSET : PE_SECTION_RAW_OFFSET + len(section_payload)] = section_payload
    output_path.write_bytes(payload)


def write_pdb(
    output_path: Path,
    *,
    pdb_guid: str = DEFAULT_PDB_GUID,
    pdb_age: int = DEFAULT_PDB_AGE,
) -> None:
    write_portable_pdb(output_path, pdb_guid=pdb_guid, pdb_age=pdb_age)


def write_portable_pdb(
    output_path: Path,
    *,
    pdb_guid: str = DEFAULT_PDB_GUID,
    pdb_age: int = DEFAULT_PDB_AGE,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    version = b"LogBrew fixture v1\0"
    version += b"\0" * ((4 - (len(version) % 4)) % 4)
    stream_name = b"#Pdb\0"
    stream_name += b"\0" * ((4 - (len(stream_name) % 4)) % 4)
    stream_directory_offset = 16 + len(version) + 4
    pdb_stream_offset = stream_directory_offset + 8 + len(stream_name)
    pdb_stream = codeview_guid_bytes(pdb_guid) + struct.pack("<I", pdb_age)
    pdb_stream += struct.pack("<IQ", 0, 0)
    payload = bytearray()
    payload += b"BSJB"
    payload += struct.pack("<HHII", 1, 1, 0, len(version))
    payload += version
    payload += struct.pack("<HH", 0, 1)
    payload += struct.pack("<II", pdb_stream_offset, len(pdb_stream))
    payload += stream_name
    payload += pdb_stream
    payload += DEFAULT_PDB_PAYLOAD_MARKER
    output_path.write_bytes(payload)
