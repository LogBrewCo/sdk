#!/usr/bin/env python3
"""Create a dry-run manifest for native and mobile release artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from native_release_artifact_elf import (  # noqa: E402
    android_native_symbol_candidates,
    dedupe_android_symbol_files,
    validated_elf_symbol_file,
)
from native_release_artifact_io import align_offset, read_bytes, sha256_file  # noqa: E402
from native_release_artifact_pe import (  # noqa: E402
    associated_pdb_candidates,
    breakpad_symbol_candidates,
    dedupe_pe_symbol_files,
    pe_symbol_candidates,
    read_breakpad_metadata,
    read_pe_codeview_metadata,
    read_portable_pdb_metadata,
)
from native_release_artifact_unity import (  # noqa: E402
    UNITY_BUILD_ID_FILE_NAME,
    UNITY_IL2CPP_MAPPING_FILE_NAME,
    il2cpp_mapping_entry,
    read_unity_build_id,
    unity_native_symbol_candidates,
)

SCRIPT_VERSION = "0.1.0"
PROGUARD_CLASS_MAPPING_RE = re.compile(r"^\s*[^#\s].+?\s+->\s+[^:]+:\s*$")
DEFAULT_MAX_SYMBOL_FILES = 500
DEFAULT_MAX_SYMBOL_FILE_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
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


def require_non_empty(label: str, value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{label} is required")
    return normalized


def iter_regular_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    return sorted(candidate for candidate in path.rglob("*") if candidate.is_file())


def tree_sha256(path: Path, root: Path) -> str:
    if path.is_file():
        return sha256_file(path)

    digest = hashlib.sha256()
    for file_path in iter_regular_files(path):
        digest.update(relative(file_path, root).encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(file_path).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(file_path.stat().st_size).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def byte_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(file_path.stat().st_size for file_path in iter_regular_files(path))


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def artifact_status(errors: list[str]) -> str:
    return "blocked" if errors else "ready"


def positive_limit(label: str, value: int | None, default: int) -> int:
    if value is None:
        return default
    if value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def release_artifact_limits(
    *,
    max_symbol_files: int | None = None,
    max_symbol_file_bytes: int | None = None,
    max_artifact_bytes: int | None = None,
) -> dict[str, int]:
    return {
        "maxSymbolFiles": positive_limit("max_symbol_files", max_symbol_files, DEFAULT_MAX_SYMBOL_FILES),
        "maxSymbolFileBytes": positive_limit(
            "max_symbol_file_bytes",
            max_symbol_file_bytes,
            DEFAULT_MAX_SYMBOL_FILE_BYTES,
        ),
        "maxArtifactBytes": positive_limit("max_artifact_bytes", max_artifact_bytes, DEFAULT_MAX_ARTIFACT_BYTES),
    }


def validate_artifact_byte_limit(label: str, path: Path, errors: list[str], limits: dict[str, int]) -> None:
    if not path.exists():
        return
    size = byte_size(path)
    max_size = limits["maxArtifactBytes"]
    if size > max_size:
        errors.append(f"{label} artifact is {size} bytes; maximum is {max_size} bytes")


def enforce_symbol_file_limits(
    label: str,
    candidates: list[Path],
    root: Path,
    errors: list[str],
    limits: dict[str, int],
) -> list[Path]:
    max_count = limits["maxSymbolFiles"]
    if len(candidates) > max_count:
        errors.append(f"{label} contains {len(candidates)} symbol files; maximum is {max_count}")
        return []

    max_file_size = limits["maxSymbolFileBytes"]
    accepted: list[Path] = []
    for candidate in candidates:
        size = candidate.stat().st_size
        if size > max_file_size:
            errors.append(
                f"{relative(candidate, root)}: symbol file is {size} bytes; maximum is {max_file_size} bytes"
            )
            continue
        accepted.append(candidate)
    return accepted


def safe_resolve(candidate: Path, root: Path) -> Path:
    resolved_root = Path(os.path.abspath(root))
    candidate_path = candidate if candidate.is_absolute() else resolved_root / candidate
    resolved = Path(os.path.abspath(candidate_path))
    try:
        resolved.relative_to(resolved_root)
    except ValueError as exc:
        raise ValueError(f"artifact path must stay inside artifact root: {candidate}") from exc
    return resolved


def artifact_id(artifact_type: str, digest: str) -> str:
    return f"lbw_{artifact_type}_{digest[:32]}"


def format_uuid(uuid_bytes: bytes) -> str:
    value = uuid_bytes.hex().upper()
    return f"{value[:8]}-{value[8:12]}-{value[12:16]}-{value[16:20]}-{value[20:]}"


def base_artifact_entry(
    *,
    artifact_type: str,
    path: Path,
    root: Path,
    errors: list[str],
    warnings: list[str],
    details: dict[str, Any],
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "artifactType": artifact_type,
        "path": relative(path, root),
        "validation": {
            "status": artifact_status(errors),
            "errors": errors,
            "warnings": warnings,
        },
        **details,
    }
    if not errors and path.exists():
        digest = tree_sha256(path, root)
        entry.update(
            {
                "artifactId": artifact_id(artifact_type, digest),
                "artifactSha256": digest,
                "byteSize": byte_size(path),
                "fileCount": len(iter_regular_files(path)),
            }
        )
    return entry


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


def validate_no_symlinks(path: Path, root: Path) -> list[str]:
    if not path.exists():
        return []
    candidates = [path, *path.rglob("*")] if path.is_dir() else [path]
    return [
        f"symbolic links are not accepted in release artifacts: {relative(candidate, root)}"
        for candidate in candidates
        if candidate.is_symlink()
    ]


def build_ios_dsym_artifact(path: Path, root: Path, limits: dict[str, int]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    details: dict[str, Any] = {}
    dwarf_file_entries: list[dict[str, Any]] = []
    uuid_count = 0

    if not path.exists():
        errors.append("dSYM bundle is missing")
    elif not path.is_dir():
        errors.append("dSYM artifact must be a directory")
    elif not path.name.endswith(".dSYM"):
        errors.append("dSYM artifact directory must end with .dSYM")
    else:
        symlink_errors = validate_no_symlinks(path, root)
        errors.extend(symlink_errors)
        if not symlink_errors:
            validate_artifact_byte_limit("dSYM", path, errors, limits)
        if symlink_errors:
            dwarf_files: list[Path] = []
        else:
            dwarf_dir = path / "Contents" / "Resources" / "DWARF"
            if not dwarf_dir.is_dir():
                errors.append("dSYM bundle is missing Contents/Resources/DWARF")
                dwarf_files = []
            else:
                dwarf_files = sorted(candidate for candidate in dwarf_dir.iterdir() if candidate.is_file())
                found_dwarf_files = bool(dwarf_files)
                dwarf_files = enforce_symbol_file_limits("dSYM DWARF directory", dwarf_files, root, errors, limits)
                if not found_dwarf_files:
                    errors.append("dSYM DWARF directory has no object files")
                for dwarf_file in dwarf_files:
                    rel_path = relative(dwarf_file, root)
                    if dwarf_file.stat().st_size == 0:
                        errors.append(f"{rel_path}: DWARF object file is empty")
                        continue
                    uuid_entries, uuid_error = macho_uuids(dwarf_file)
                    dwarf_file_entry: dict[str, Any] = {
                        "path": rel_path,
                        "byteSize": dwarf_file.stat().st_size,
                    }
                    if uuid_entries:
                        dwarf_file_entry["uuids"] = uuid_entries
                        dwarf_file_entry["uuidCount"] = len(uuid_entries)
                        uuid_count += len(uuid_entries)
                    else:
                        warnings.append(f"{rel_path}: Mach-O UUID was not found ({uuid_error})")
                    dwarf_file_entries.append(dwarf_file_entry)
        info_plist = path / "Contents" / "Info.plist"
        has_info_plist = False if symlink_errors else info_plist.is_file()
        if not has_info_plist:
            warnings.append("dSYM Info.plist is missing; platform tooling may reject this bundle")
        if dwarf_files and uuid_count == 0:
            warnings.append("dSYM UUIDs were not found; symbolication upload will need valid Mach-O DWARF objects")
        details["dsym"] = {
            "bundleName": path.name,
            "uuidCount": uuid_count,
            "dwarfFiles": dwarf_file_entries,
            "hasInfoPlist": has_info_plist,
        }

    return base_artifact_entry(
        artifact_type="ios_dsym",
        path=path,
        root=root,
        errors=errors,
        warnings=warnings,
        details=details,
    )


def build_android_proguard_mapping_artifact(path: Path, root: Path, limits: dict[str, int]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    details: dict[str, Any] = {}

    if not path.exists():
        errors.append("ProGuard/R8 mapping file is missing")
    elif not path.is_file():
        errors.append("ProGuard/R8 mapping artifact must be a file")
    else:
        symlink_errors = validate_no_symlinks(path, root)
        errors.extend(symlink_errors)
        if not symlink_errors:
            validate_artifact_byte_limit("ProGuard/R8 mapping", path, errors, limits)
        if symlink_errors:
            lines: list[str] = []
            class_mapping_count = 0
        else:
            size = path.stat().st_size
            if size > limits["maxSymbolFileBytes"]:
                errors.append(
                    f"{relative(path, root)}: symbol file is {size} bytes; "
                    f"maximum is {limits['maxSymbolFileBytes']} bytes"
                )
                lines = []
                class_mapping_count = 0
            elif size == 0:
                errors.append("ProGuard/R8 mapping file is empty")
                lines = []
                class_mapping_count = 0
            else:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
                class_mapping_count = sum(1 for line in lines if PROGUARD_CLASS_MAPPING_RE.match(line))
                if class_mapping_count == 0:
                    errors.append("ProGuard/R8 mapping file has no class mapping entries")
        if path.name != "mapping.txt":
            warnings.append("ProGuard/R8 mapping files are conventionally named mapping.txt")
        details["proguard"] = {
            "mappingFileName": path.name,
            "lineCount": len(lines),
            "classMappingCount": class_mapping_count,
        }

    return base_artifact_entry(
        artifact_type="android_proguard_mapping",
        path=path,
        root=root,
        errors=errors,
        warnings=warnings,
        details=details,
    )


def build_android_native_symbols_artifact(path: Path, root: Path, limits: dict[str, int]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    symbol_files: list[dict[str, Any]] = []

    if not path.exists():
        errors.append("Android native symbols artifact is missing")
    elif not path.is_file() and not path.is_dir():
        errors.append("Android native symbols artifact must be a .so file or directory")
    else:
        symlink_errors = validate_no_symlinks(path, root)
        errors.extend(symlink_errors)
        if not symlink_errors:
            validate_artifact_byte_limit("Android native symbols", path, errors, limits)
        candidates = [] if symlink_errors else android_native_symbol_candidates(path)
        found_candidates = bool(candidates)
        candidates = enforce_symbol_file_limits("Android native symbols artifact", candidates, root, errors, limits)
        if not found_candidates and not symlink_errors:
            errors.append("Android native symbols artifact contains no .so files")
        for candidate in candidates:
            rel_path = relative(candidate, root)
            symbol_file, candidate_errors, candidate_warnings = validated_elf_symbol_file(candidate, rel_path)
            errors.extend(candidate_errors)
            warnings.extend(candidate_warnings)
            if symbol_file:
                symbol_files.append(symbol_file)
        symbol_files = dedupe_android_symbol_files(symbol_files, warnings)

    details = {
        "androidNativeSymbols": {
            "symbolFileCount": len(symbol_files),
            "architectures": sorted({str(symbol_file["arch"]) for symbol_file in symbol_files}),
            "files": symbol_files,
        }
    }

    return base_artifact_entry(
        artifact_type="android_native_symbols",
        path=path,
        root=root,
        errors=errors,
        warnings=warnings,
        details=details,
    )


def build_unity_symbols_artifact(path: Path, root: Path, limits: dict[str, int]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    build_id = ""
    native_symbol_files: list[dict[str, Any]] = []
    il2cpp_mapping_file: dict[str, Any] | None = None

    if not path.exists():
        errors.append("Unity symbols artifact is missing")
    elif not path.is_dir():
        errors.append("Unity symbols artifact must be a directory")
    else:
        symlink_errors = validate_no_symlinks(path, root)
        errors.extend(symlink_errors)
        if not symlink_errors:
            validate_artifact_byte_limit("Unity symbols", path, errors, limits)

        build_id_path = path / UNITY_BUILD_ID_FILE_NAME
        mapping_path = path / UNITY_IL2CPP_MAPPING_FILE_NAME
        native_candidates = [] if symlink_errors else unity_native_symbol_candidates(path)
        upload_candidates = list(native_candidates)
        if not symlink_errors and mapping_path.is_file():
            upload_candidates.append(mapping_path)

        if not symlink_errors:
            if not build_id_path.is_file():
                errors.append(f"Unity symbols artifact is missing {UNITY_BUILD_ID_FILE_NAME}")
            elif build_id_path.stat().st_size > limits["maxSymbolFileBytes"]:
                errors.append(
                    f"{relative(build_id_path, root)}: build_id file is {build_id_path.stat().st_size} bytes; "
                    f"maximum is {limits['maxSymbolFileBytes']} bytes"
                )
            else:
                build_id, build_id_error = read_unity_build_id(build_id_path)
                if build_id_error:
                    errors.append(f"{relative(build_id_path, root)}: {build_id_error}")

        found_upload_candidates = bool(upload_candidates)
        accepted_candidates = enforce_symbol_file_limits("Unity symbols artifact", upload_candidates, root, errors, limits)
        accepted_paths = set(accepted_candidates)
        if not found_upload_candidates and not symlink_errors:
            errors.append(f"Unity symbols artifact contains no .so files or {UNITY_IL2CPP_MAPPING_FILE_NAME}")

        for candidate in native_candidates:
            if candidate not in accepted_paths:
                continue
            rel_path = relative(candidate, root)
            symbol_file, candidate_errors, candidate_warnings = validated_elf_symbol_file(candidate, rel_path)
            errors.extend(candidate_errors)
            warnings.extend(candidate_warnings)
            if symbol_file:
                native_symbol_files.append({"symbolFormat": "elf", **symbol_file})
        native_symbol_files = dedupe_android_symbol_files(native_symbol_files, warnings, label="Unity native symbol")

        if mapping_path.is_file() and mapping_path in accepted_paths:
            mapping_entry, mapping_error = il2cpp_mapping_entry(mapping_path, relative(mapping_path, root))
            if mapping_error:
                errors.append(f"{relative(mapping_path, root)}: {mapping_error}")
            else:
                il2cpp_mapping_file = mapping_entry
        elif not symlink_errors:
            warnings.append(
                f"{UNITY_IL2CPP_MAPPING_FILE_NAME} is missing; managed Unity stack deobfuscation will be incomplete"
            )

    files = [*native_symbol_files]
    if il2cpp_mapping_file:
        files.append(il2cpp_mapping_file)
    details = {
        "unitySymbols": {
            "buildId": build_id,
            "symbolFileCount": len(files),
            "nativeSymbolFileCount": len(native_symbol_files),
            "il2cppMappingFileCount": 1 if il2cpp_mapping_file else 0,
            "architectures": sorted({str(symbol_file["arch"]) for symbol_file in native_symbol_files}),
            "files": files,
        }
    }

    return base_artifact_entry(
        artifact_type="unity_symbols",
        path=path,
        root=root,
        errors=errors,
        warnings=warnings,
        details=details,
    )


def build_breakpad_symbols_artifact(path: Path, root: Path, limits: dict[str, int]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    symbol_files: list[dict[str, Any]] = []

    if not path.exists():
        errors.append("Breakpad symbols artifact is missing")
    elif not path.is_file() and not path.is_dir():
        errors.append("Breakpad symbols artifact must be a .sym file or directory")
    else:
        symlink_errors = validate_no_symlinks(path, root)
        errors.extend(symlink_errors)
        if not symlink_errors:
            validate_artifact_byte_limit("Breakpad symbols", path, errors, limits)
        candidates = [] if symlink_errors else breakpad_symbol_candidates(path)
        found_candidates = bool(candidates)
        candidates = enforce_symbol_file_limits("Breakpad symbols artifact", candidates, root, errors, limits)
        if not found_candidates and not symlink_errors:
            errors.append("Breakpad symbols artifact contains no .sym files")
        for candidate in candidates:
            rel_path = relative(candidate, root)
            if candidate.stat().st_size == 0:
                errors.append(f"{rel_path}: Breakpad symbol file is empty")
                continue
            metadata, metadata_error = read_breakpad_metadata(candidate)
            if metadata_error:
                errors.append(f"{rel_path}: {metadata_error}")
                continue
            if str(metadata["arch"]).startswith("unknown("):
                warnings.append(f"{rel_path}: Breakpad MODULE CPU is not mapped: {metadata['cpu']}")
            symbol_files.append({"path": rel_path, "byteSize": candidate.stat().st_size, **metadata})
        symbol_files = dedupe_pe_symbol_files(symbol_files, warnings, label="Breakpad symbol")

    details = {
        "breakpadSymbols": {
            "symbolFileCount": len(symbol_files),
            "architectures": sorted({str(symbol_file["arch"]) for symbol_file in symbol_files}),
            "files": symbol_files,
        }
    }

    return base_artifact_entry(
        artifact_type="breakpad_symbols",
        path=path,
        root=root,
        errors=errors,
        warnings=warnings,
        details=details,
    )


def build_dotnet_pdb_artifact(path: Path, root: Path, limits: dict[str, int]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    symbol_files: list[dict[str, Any]] = []

    if not path.exists():
        errors.append("PDB symbols artifact is missing")
    elif not path.is_file() and not path.is_dir():
        errors.append("PDB symbols artifact must be a .dll/.exe PE file or directory")
    else:
        symlink_errors = validate_no_symlinks(path, root)
        errors.extend(symlink_errors)
        if not symlink_errors:
            validate_artifact_byte_limit("PDB symbols", path, errors, limits)
        candidates = [] if symlink_errors else pe_symbol_candidates(path)
        found_candidates = bool(candidates)
        candidates = enforce_symbol_file_limits("PDB symbols artifact", candidates, root, errors, limits)
        if not found_candidates and not symlink_errors:
            errors.append("PDB symbols artifact contains no .dll or .exe PE files")
        for candidate in candidates:
            rel_path = relative(candidate, root)
            if candidate.stat().st_size == 0:
                errors.append(f"{rel_path}: PE file is empty")
                continue
            metadata, metadata_error = read_pe_codeview_metadata(candidate)
            if metadata_error:
                errors.append(f"{rel_path}: {metadata_error}")
                continue
            if not metadata.get("isPe"):
                errors.append(f"{rel_path}: not a PE file")
                continue
            if str(metadata["arch"]).startswith("unknown("):
                warnings.append(f"{rel_path}: PE machine architecture is not mapped: {metadata['arch']}")

            pdb_candidates = associated_pdb_candidates(candidate, metadata["pdbFileName"])
            pdb_path = next((candidate_path for candidate_path in pdb_candidates if candidate_path.is_file()), None)
            if pdb_path is None:
                errors.append(f"{rel_path}: associated PDB file was not found")
                continue
            if pdb_path.stat().st_size == 0:
                errors.append(f"{relative(pdb_path, root)}: PDB file is empty")
                continue
            if pdb_path.stat().st_size > limits["maxSymbolFileBytes"]:
                errors.append(
                    f"{relative(pdb_path, root)}: symbol file is {pdb_path.stat().st_size} bytes; "
                    f"maximum is {limits['maxSymbolFileBytes']} bytes"
                )
                continue
            pdb_metadata, pdb_metadata_error = read_portable_pdb_metadata(pdb_path)
            if pdb_metadata_error:
                errors.append(f"{relative(pdb_path, root)}: {pdb_metadata_error}")
                continue
            if pdb_metadata.get("pdbFormat") == "portable_pdb":
                pdb_payload_debug_id = str(pdb_metadata["pdbDebugId"])
                if pdb_payload_debug_id != metadata["pdbDebugId"]:
                    errors.append(
                        f"{relative(pdb_path, root)}: Portable PDB debug ID {pdb_payload_debug_id} "
                        f"does not match PE CodeView debug ID {metadata['pdbDebugId']}"
                    )
                    continue
            else:
                warnings.append(
                    f"{relative(pdb_path, root)}: PDB payload format is not recognized; "
                    "PE CodeView identity could not be cross-checked"
                )

            symbol_file = {
                "path": rel_path,
                "byteSize": candidate.stat().st_size,
                "peClass": metadata["peClass"],
                "arch": metadata["arch"],
                "pdbGuid": metadata["pdbGuid"],
                "pdbAge": metadata["pdbAge"],
                "pdbDebugId": metadata["pdbDebugId"],
                "pdbFileName": metadata["pdbFileName"],
                "pdbPath": relative(pdb_path, root),
                "pdbByteSize": pdb_path.stat().st_size,
                "pdbFormat": pdb_metadata["pdbFormat"],
                "symbolSource": metadata["symbolSource"],
            }
            if pdb_metadata.get("pdbFormat") == "portable_pdb":
                symbol_file["pdbPayloadDebugId"] = pdb_metadata["pdbDebugId"]
            symbol_files.append(symbol_file)
        symbol_files = dedupe_pe_symbol_files(symbol_files, warnings, label="PDB symbol")

    details = {
        "dotnetPdb": {
            "symbolFileCount": len(symbol_files),
            "architectures": sorted({str(symbol_file["arch"]) for symbol_file in symbol_files}),
            "files": symbol_files,
        }
    }

    return base_artifact_entry(
        artifact_type="dotnet_pdb",
        path=path,
        root=root,
        errors=errors,
        warnings=warnings,
        details=details,
    )


ARTIFACT_BUILDERS = {
    "ios_dsym": build_ios_dsym_artifact,
    "android_proguard_mapping": build_android_proguard_mapping_artifact,
    "android_native_symbols": build_android_native_symbols_artifact,
    "unity_symbols": build_unity_symbols_artifact,
    "breakpad_symbols": build_breakpad_symbols_artifact,
    "dotnet_pdb": build_dotnet_pdb_artifact,
}
SUPPORTED_ARTIFACT_TYPES = tuple(ARTIFACT_BUILDERS)


def build_artifact_entry(artifact_type: str, path: Path, root: Path, limits: dict[str, int]) -> dict[str, Any]:
    builder = ARTIFACT_BUILDERS.get(artifact_type)
    if builder is None:
        raise ValueError(f"unsupported artifact type: {artifact_type}")
    return builder(path, root, limits)


def create_manifest(
    *,
    artifact_root: Path,
    artifacts: list[tuple[str, Path]],
    release: str,
    environment: str,
    service: str,
    repository_url: str | None = None,
    commit_sha: str | None = None,
    max_symbol_files: int | None = None,
    max_symbol_file_bytes: int | None = None,
    max_artifact_bytes: int | None = None,
) -> dict[str, Any]:
    release = require_non_empty("release", release)
    environment = require_non_empty("environment", environment)
    service = require_non_empty("service", service)
    limits = release_artifact_limits(
        max_symbol_files=max_symbol_files,
        max_symbol_file_bytes=max_symbol_file_bytes,
        max_artifact_bytes=max_artifact_bytes,
    )
    artifact_root = Path(os.path.abspath(artifact_root))
    if not artifact_root.is_dir():
        raise ValueError(f"artifact root does not exist: {artifact_root}")

    if not artifacts:
        artifact_entries: list[dict[str, Any]] = []
        errors = ["at least one release artifact is required"]
    else:
        artifact_entries = [
            build_artifact_entry(artifact_type, safe_resolve(path, artifact_root), artifact_root, limits)
            for artifact_type, path in artifacts
        ]
        errors = []

    warnings: list[str] = []
    for artifact in artifact_entries:
        rel_path = artifact["path"]
        errors.extend(f"{rel_path}: {message}" for message in artifact["validation"]["errors"])
        warnings.extend(f"{rel_path}: {message}" for message in artifact["validation"]["warnings"])

    git = {}
    if repository_url:
        git["repositoryUrl"] = repository_url.strip()
    if commit_sha:
        git["commitSha"] = commit_sha.strip()

    return {
        "manifestVersion": 1,
        "release": release,
        "environment": environment,
        "service": service,
        "artifactType": "native_debug_symbol_manifest",
        "supportedArtifactTypes": list(SUPPORTED_ARTIFACT_TYPES),
        "uploader": {
            "name": "logbrew-native-release-artifact-manifest",
            "version": SCRIPT_VERSION,
        },
        "limits": limits,
        **({"git": git} if git else {}),
        "artifacts": artifact_entries,
        "validation": {
            "status": artifact_status(errors),
            "errors": errors,
            "warnings": warnings,
        },
    }


def parse_artifact_spec(value: str) -> tuple[str, Path]:
    artifact_type, separator, artifact_path = value.partition("=")
    if not separator:
        raise ValueError("artifact must use TYPE=PATH syntax")
    artifact_type = artifact_type.strip()
    if artifact_type not in SUPPORTED_ARTIFACT_TYPES:
        supported = ", ".join(SUPPORTED_ARTIFACT_TYPES)
        raise ValueError(f"unsupported artifact type: {artifact_type}; supported types: {supported}")
    return artifact_type, Path(require_non_empty("artifact path", artifact_path))


def parse_positive_int(value: str) -> int:
    try:
        parsed = int(value, 10)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a LogBrew dry-run manifest for native/mobile debug-symbol artifacts."
    )
    parser.add_argument("--artifact-root", default=Path("."), type=Path, help="Root directory for artifact paths.")
    parser.add_argument("--release", required=True, help="Application release version or id.")
    parser.add_argument("--environment", required=True, help="Deployment environment, such as production.")
    parser.add_argument("--service", required=True, help="Service or app name.")
    parser.add_argument(
        "--artifact",
        action="append",
        required=True,
        help=(
            "Release artifact in TYPE=PATH form. Supported types: "
            f"{', '.join(SUPPORTED_ARTIFACT_TYPES)}."
        ),
    )
    parser.add_argument("--repository-url", help="Optional app-owned source repository URL.")
    parser.add_argument("--commit-sha", help="Optional app-owned commit SHA for source links.")
    parser.add_argument(
        "--max-symbol-files",
        type=parse_positive_int,
        default=DEFAULT_MAX_SYMBOL_FILES,
        help=f"Maximum candidate symbol files per artifact before the dry run blocks. Default: {DEFAULT_MAX_SYMBOL_FILES}.",
    )
    parser.add_argument(
        "--max-symbol-file-bytes",
        type=parse_positive_int,
        default=DEFAULT_MAX_SYMBOL_FILE_BYTES,
        help=(
            "Maximum bytes for any individual symbol/debug file before the dry run blocks. "
            f"Default: {DEFAULT_MAX_SYMBOL_FILE_BYTES}."
        ),
    )
    parser.add_argument(
        "--max-artifact-bytes",
        type=parse_positive_int,
        default=DEFAULT_MAX_ARTIFACT_BYTES,
        help=(
            "Maximum total bytes for a single release artifact before the dry run blocks. "
            f"Default: {DEFAULT_MAX_ARTIFACT_BYTES}."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        artifacts = [parse_artifact_spec(spec) for spec in args.artifact]
        manifest = create_manifest(
            artifact_root=args.artifact_root,
            artifacts=artifacts,
            release=args.release,
            environment=args.environment,
            service=args.service,
            repository_url=args.repository_url,
            commit_sha=args.commit_sha,
            max_symbol_files=args.max_symbol_files,
            max_symbol_file_bytes=args.max_symbol_file_bytes,
            max_artifact_bytes=args.max_artifact_bytes,
        )
    except ValueError as exc:
        print(f"manifest validation failed: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 1 if manifest["validation"]["status"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
