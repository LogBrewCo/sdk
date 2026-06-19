"""Mach-O and dSYM helpers for native release-artifact dry runs."""

from __future__ import annotations

import struct
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from native_release_artifact_io import read_bytes


MACHO_MAGIC_32_LE = b"\xce\xfa\xed\xfe"
MACHO_MAGIC_32_BE = b"\xfe\xed\xfa\xce"
MACHO_MAGIC_64_LE = b"\xcf\xfa\xed\xfe"
MACHO_MAGIC_64_BE = b"\xfe\xed\xfa\xcf"
FAT_MAGIC_32_BE = b"\xca\xfe\xba\xbe"
FAT_MAGIC_32_LE = b"\xbe\xba\xfe\xca"
FAT_MAGIC_64_BE = b"\xca\xfe\xba\xbf"
FAT_MAGIC_64_LE = b"\xbf\xba\xfe\xca"
LC_UUID = 0x1B
MACHO_CPU_ARCHES = {
    7: "i386",
    12: "armv7",
    0x01000007: "x86_64",
    0x0100000C: "arm64",
}
DSYM_ARCHIVE_SUFFIXES = {".zip"}


@dataclass(frozen=True)
class DsymArchiveInspection:
    bundle_names: list[str]
    has_info_plist: bool
    dwarf_files: list[dict[str, Any]]
    uuid_count: int
    errors: list[str]
    warnings: list[str]


def format_uuid(uuid_bytes: bytes) -> str:
    value = uuid_bytes.hex().upper()
    return f"{value[:8]}-{value[8:12]}-{value[12:16]}-{value[16:20]}-{value[20:]}"


def parse_macho_slice(path: Path, offset: int, size: int) -> tuple[dict[str, str] | None, str | None]:
    if offset < 0 or size < 4 or offset + size > path.stat().st_size:
        return None, "Mach-O slice is truncated"
    magic = read_bytes(path, offset, 4)
    if magic == MACHO_MAGIC_64_LE:
        endian_prefix = "<"
        is_64_bit = True
    elif magic == MACHO_MAGIC_64_BE:
        endian_prefix = ">"
        is_64_bit = True
    elif magic == MACHO_MAGIC_32_LE:
        endian_prefix = "<"
        is_64_bit = False
    elif magic == MACHO_MAGIC_32_BE:
        endian_prefix = ">"
        is_64_bit = False
    else:
        return None, "not a Mach-O object"

    header_size = 32 if is_64_bit else 28
    if size < header_size:
        return None, "Mach-O header is truncated"
    header = read_bytes(path, offset, header_size)
    cputype, _cpusubtype, _filetype, command_count, command_size, _flags = struct.unpack_from(
        endian_prefix + "IIIIII", header, 4
    )
    command_offset = offset + header_size
    command_end = command_offset + command_size
    if command_end > offset + size or command_end > path.stat().st_size:
        return None, "Mach-O load commands are truncated"

    for _ in range(command_count):
        if command_offset + 8 > command_end:
            return None, "Mach-O load command is truncated"
        command_header = read_bytes(path, command_offset, 8)
        command, command_byte_size = struct.unpack_from(endian_prefix + "II", command_header)
        if command_byte_size < 8 or command_offset + command_byte_size > command_end:
            return None, "Mach-O load command size is invalid"
        if command == LC_UUID:
            if command_byte_size < 24:
                return None, "Mach-O UUID load command is truncated"
            uuid_bytes = read_bytes(path, command_offset + 8, 16)
            return {
                "uuid": format_uuid(uuid_bytes),
                "arch": MACHO_CPU_ARCHES.get(cputype, f"unknown({cputype})"),
            }, None
        command_offset += command_byte_size

    return None, "Mach-O UUID load command is missing"


def parse_fat_macho(path: Path, magic: bytes) -> tuple[list[dict[str, str]], str | None]:
    if magic == FAT_MAGIC_32_BE:
        endian_prefix = ">"
        is_64_bit = False
    elif magic == FAT_MAGIC_32_LE:
        endian_prefix = "<"
        is_64_bit = False
    elif magic == FAT_MAGIC_64_BE:
        endian_prefix = ">"
        is_64_bit = True
    elif magic == FAT_MAGIC_64_LE:
        endian_prefix = "<"
        is_64_bit = True
    else:
        return [], "not a fat Mach-O object"

    arch_count = struct.unpack_from(endian_prefix + "I", read_bytes(path, 4, 4))[0]
    entry_size = 32 if is_64_bit else 20
    table_offset = 8
    if table_offset + arch_count * entry_size > path.stat().st_size:
        return [], "fat Mach-O architecture table is truncated"

    entries: list[tuple[int, int]] = []
    table = read_bytes(path, table_offset, arch_count * entry_size)
    for index in range(arch_count):
        entry_offset = index * entry_size
        if is_64_bit:
            _cputype, _cpusubtype, slice_offset, slice_size, _align, _reserved = struct.unpack_from(
                endian_prefix + "IIQQII", table, entry_offset
            )
        else:
            _cputype, _cpusubtype, slice_offset, slice_size, _align = struct.unpack_from(
                endian_prefix + "IIIII", table, entry_offset
            )
        entries.append((int(slice_offset), int(slice_size)))

    uuids: list[dict[str, str]] = []
    errors: list[str] = []
    for slice_offset, slice_size in entries:
        uuid_entry, error = parse_macho_slice(path, slice_offset, slice_size)
        if uuid_entry:
            uuids.append(uuid_entry)
        elif error:
            errors.append(error)
    if uuids:
        return uuids, None
    return [], "; ".join(errors) if errors else "fat Mach-O object has no UUIDs"


def macho_uuids(path: Path) -> tuple[list[dict[str, str]], str | None]:
    if path.stat().st_size < 4:
        return [], "Mach-O object is truncated"
    magic = read_bytes(path, 0, 4)
    if magic in {FAT_MAGIC_32_BE, FAT_MAGIC_32_LE, FAT_MAGIC_64_BE, FAT_MAGIC_64_LE}:
        return parse_fat_macho(path, magic)
    uuid_entry, error = parse_macho_slice(path, 0, path.stat().st_size)
    return ([uuid_entry] if uuid_entry else []), error


def is_dsym_archive(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in DSYM_ARCHIVE_SUFFIXES


def safe_zip_entry_name(info: zipfile.ZipInfo) -> str | None:
    if info.is_dir():
        return None
    name = info.filename
    if not name or "\0" in name or "\\" in name:
        return ""
    path = PurePosixPath(name)
    if path.is_absolute():
        return ""
    parts = path.parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        return ""
    if parts[0].endswith(":"):
        return ""
    return path.as_posix()


def archive_display_path(archive_rel_path: str, entry_name: str) -> str:
    return f"{archive_rel_path}!{entry_name}"


def dsym_entry_info(entry_name: str) -> tuple[str | None, tuple[str, ...]]:
    parts = PurePosixPath(entry_name).parts
    for index, part in enumerate(parts):
        if part.endswith(".dSYM"):
            return part, tuple(parts[index + 1 :])
    return None, ()


def inspect_dsym_zip(
    path: Path,
    *,
    archive_rel_path: str,
    max_symbol_files: int,
    max_symbol_file_bytes: int,
) -> DsymArchiveInspection:
    errors: list[str] = []
    warnings: list[str] = []
    bundle_names: set[str] = set()
    info_plist_bundles: set[str] = set()
    dwarf_files: list[dict[str, Any]] = []
    uuid_count = 0

    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        return DsymArchiveInspection([], False, [], 0, ["dSYM archive is not a valid ZIP file"], [])
    except OSError as exc:
        return DsymArchiveInspection([], False, [], 0, [str(exc)], [])

    with archive:
        entries: dict[str, zipfile.ZipInfo] = {}
        unsafe_entry_found = False
        for info in archive.infolist():
            safe_name = safe_zip_entry_name(info)
            if safe_name == "":
                unsafe_entry_found = True
                continue
            if safe_name is not None:
                entries[safe_name] = info

        if unsafe_entry_found:
            errors.append("dSYM archive contains unsafe entry paths")

        dwarf_entries: list[tuple[str, str, zipfile.ZipInfo]] = []
        for entry_name, info in sorted(entries.items()):
            bundle_name, suffix = dsym_entry_info(entry_name)
            if bundle_name is None:
                continue
            bundle_names.add(bundle_name)
            if suffix == ("Contents", "Info.plist"):
                info_plist_bundles.add(bundle_name)
            elif len(suffix) == 4 and suffix[:3] == ("Contents", "Resources", "DWARF"):
                dwarf_entries.append((bundle_name, entry_name, info))

        if not bundle_names:
            errors.append("dSYM archive contains no .dSYM bundles")
        if not dwarf_entries:
            errors.append("dSYM archive contains no DWARF object files")
        if len(dwarf_entries) > max_symbol_files:
            errors.append(f"dSYM archive contains {len(dwarf_entries)} DWARF object files; maximum is {max_symbol_files}")
            dwarf_entries = []

        with tempfile.TemporaryDirectory(prefix="logbrew-dsym-") as temp_dir:
            temp_root = Path(temp_dir)
            for index, (bundle_name, entry_name, info) in enumerate(dwarf_entries):
                display_path = archive_display_path(archive_rel_path, entry_name)
                if info.file_size == 0:
                    errors.append(f"{display_path}: DWARF object file is empty")
                    continue
                if info.file_size > max_symbol_file_bytes:
                    errors.append(
                        f"{display_path}: symbol file is {info.file_size} bytes; "
                        f"maximum is {max_symbol_file_bytes} bytes"
                    )
                    continue

                extracted_path = temp_root / f"{index}.dwarf"
                with archive.open(info) as source, extracted_path.open("wb") as target:
                    target.write(source.read())
                uuid_entries, uuid_error = macho_uuids(extracted_path)
                dwarf_file_entry: dict[str, Any] = {
                    "path": display_path,
                    "byteSize": info.file_size,
                    "bundleName": bundle_name,
                }
                if uuid_entries:
                    dwarf_file_entry["uuids"] = uuid_entries
                    dwarf_file_entry["uuidCount"] = len(uuid_entries)
                    uuid_count += len(uuid_entries)
                else:
                    warnings.append(f"{display_path}: Mach-O UUID was not found ({uuid_error})")
                dwarf_files.append(dwarf_file_entry)

    ordered_bundle_names = sorted(bundle_names)
    has_info_plist = bool(ordered_bundle_names) and all(bundle in info_plist_bundles for bundle in ordered_bundle_names)
    if ordered_bundle_names and not has_info_plist:
        warnings.append("dSYM Info.plist is missing; platform tooling may reject this bundle")
    if dwarf_files and uuid_count == 0:
        warnings.append("dSYM UUIDs were not found; symbolication upload will need valid Mach-O DWARF objects")
    return DsymArchiveInspection(ordered_bundle_names, has_info_plist, dwarf_files, uuid_count, errors, warnings)
