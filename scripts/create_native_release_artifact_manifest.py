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


SCRIPT_VERSION = "0.1.0"
SUPPORTED_ARTIFACT_TYPES = ("ios_dsym", "android_proguard_mapping", "android_native_symbols")
PROGUARD_CLASS_MAPPING_RE = re.compile(r"^\s*[^#\s].+?\s+->\s+[^:]+:\s*$")
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


def require_non_empty(label: str, value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{label} is required")
    return normalized


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def align_offset(value: int, alignment: int) -> int:
    alignment = max(alignment, 1)
    return value + ((alignment - (value % alignment)) % alignment)


def read_bytes(path: Path, offset: int, size: int) -> bytes:
    if offset < 0 or size < 0:
        raise ValueError("ELF offset and size must be non-negative")
    with path.open("rb") as handle:
        handle.seek(offset)
        payload = handle.read(size)
    if len(payload) != size:
        raise ValueError("ELF section data is truncated")
    return payload


def c_string(payload: bytes, offset: int) -> str:
    if offset >= len(payload):
        return ""
    end = payload.find(b"\0", offset)
    if end == -1:
        end = len(payload)
    return payload[offset:end].decode("ascii", errors="replace")


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
    return any(section["name"] == name and section["type"] != SHT_NOBITS and section["size"] > 0 for section in sections)


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


def android_native_symbol_candidates(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    return sorted(candidate for candidate in path.rglob("*.so") if candidate.is_file())


def validate_no_symlinks(path: Path, root: Path) -> list[str]:
    if not path.exists():
        return []
    candidates = [path, *path.rglob("*")] if path.is_dir() else [path]
    return [
        f"symbolic links are not accepted in release artifacts: {relative(candidate, root)}"
        for candidate in candidates
        if candidate.is_symlink()
    ]


def build_ios_dsym_artifact(path: Path, root: Path) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    details: dict[str, Any] = {}

    if not path.exists():
        errors.append("dSYM bundle is missing")
    elif not path.is_dir():
        errors.append("dSYM artifact must be a directory")
    elif not path.name.endswith(".dSYM"):
        errors.append("dSYM artifact directory must end with .dSYM")
    else:
        symlink_errors = validate_no_symlinks(path, root)
        errors.extend(symlink_errors)
        if symlink_errors:
            dwarf_files: list[Path] = []
        else:
            dwarf_dir = path / "Contents" / "Resources" / "DWARF"
            if not dwarf_dir.is_dir():
                errors.append("dSYM bundle is missing Contents/Resources/DWARF")
                dwarf_files = []
            else:
                dwarf_files = sorted(candidate for candidate in dwarf_dir.iterdir() if candidate.is_file())
                if not dwarf_files:
                    errors.append("dSYM DWARF directory has no object files")
                for dwarf_file in dwarf_files:
                    if dwarf_file.stat().st_size == 0:
                        errors.append(f"{relative(dwarf_file, root)}: DWARF object file is empty")
        info_plist = path / "Contents" / "Info.plist"
        has_info_plist = False if symlink_errors else info_plist.is_file()
        if not has_info_plist:
            warnings.append("dSYM Info.plist is missing; platform tooling may reject this bundle")
        warnings.append("UUID extraction is not performed; this dry run validates dSYM structure only")
        details["dsym"] = {
            "bundleName": path.name,
            "dwarfFiles": [
                {
                    "path": relative(dwarf_file, root),
                    "byteSize": dwarf_file.stat().st_size,
                }
                for dwarf_file in dwarf_files
            ],
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


def build_android_proguard_mapping_artifact(path: Path, root: Path) -> dict[str, Any]:
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
        if symlink_errors:
            lines: list[str] = []
            class_mapping_count = 0
        else:
            size = path.stat().st_size
            if size == 0:
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


def build_android_native_symbols_artifact(path: Path, root: Path) -> dict[str, Any]:
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
        candidates = [] if symlink_errors else android_native_symbol_candidates(path)
        if not candidates and not symlink_errors:
            errors.append("Android native symbols artifact contains no .so files")
        for candidate in candidates:
            rel_path = relative(candidate, root)
            if candidate.stat().st_size == 0:
                errors.append(f"{rel_path}: ELF file is empty")
                continue

            metadata, metadata_error = read_elf_metadata(candidate)
            if metadata_error:
                errors.append(f"{rel_path}: {metadata_error}")
                continue
            if not metadata.get("isElf"):
                errors.append(f"{rel_path}: not an ELF file")
                continue
            if metadata["elfTypeCode"] not in {ELF_TYPE_EXEC, ELF_TYPE_DYN}:
                errors.append(f"{rel_path}: unsupported ELF type {metadata['elfType']}")
                continue
            if str(metadata["arch"]).startswith("unknown("):
                errors.append(f"{rel_path}: unsupported ELF architecture {metadata['arch']}")
                continue

            symbol_source = elf_symbol_source(metadata)
            has_identifier = bool(metadata["gnuBuildId"] or metadata["goBuildId"] or metadata["fileSha256"])
            if not has_identifier:
                errors.append(f"{rel_path}: ELF file has no build ID or code hash")
                continue
            if symbol_source == "none":
                errors.append(f"{rel_path}: ELF file has no debug info or symbol tables")
                continue
            if symbol_source == "dynamic_symbol_table":
                warnings.append(
                    f"{rel_path}: only dynamic symbols found; full symbolication usually needs unstripped symbols"
                )
            if not metadata["gnuBuildId"] and not metadata["goBuildId"]:
                warnings.append(f"{rel_path}: no ELF build ID found; dry run falls back to file hash")

            symbol_file = {
                "path": rel_path,
                "byteSize": candidate.stat().st_size,
                "elfClass": metadata["elfClass"],
                "elfType": metadata["elfType"],
                "arch": metadata["arch"],
                "symbolSource": symbol_source,
                "hasCode": metadata["hasCode"],
            }
            if metadata["gnuBuildId"]:
                symbol_file["gnuBuildId"] = metadata["gnuBuildId"]
            if metadata["goBuildId"]:
                symbol_file["goBuildId"] = metadata["goBuildId"]
            if metadata["fileSha256"]:
                symbol_file["fileSha256"] = metadata["fileSha256"]
            symbol_files.append(symbol_file)

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


def build_artifact_entry(artifact_type: str, path: Path, root: Path) -> dict[str, Any]:
    if artifact_type == "ios_dsym":
        return build_ios_dsym_artifact(path, root)
    if artifact_type == "android_proguard_mapping":
        return build_android_proguard_mapping_artifact(path, root)
    if artifact_type == "android_native_symbols":
        return build_android_native_symbols_artifact(path, root)
    raise ValueError(f"unsupported artifact type: {artifact_type}")


def create_manifest(
    *,
    artifact_root: Path,
    artifacts: list[tuple[str, Path]],
    release: str,
    environment: str,
    service: str,
    repository_url: str | None = None,
    commit_sha: str | None = None,
) -> dict[str, Any]:
    release = require_non_empty("release", release)
    environment = require_non_empty("environment", environment)
    service = require_non_empty("service", service)
    artifact_root = Path(os.path.abspath(artifact_root))
    if not artifact_root.is_dir():
        raise ValueError(f"artifact root does not exist: {artifact_root}")

    if not artifacts:
        artifact_entries: list[dict[str, Any]] = []
        errors = ["at least one release artifact is required"]
    else:
        artifact_entries = [
            build_artifact_entry(artifact_type, safe_resolve(path, artifact_root), artifact_root)
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
            "ios_dsym, android_proguard_mapping, android_native_symbols."
        ),
    )
    parser.add_argument("--repository-url", help="Optional app-owned source repository URL.")
    parser.add_argument("--commit-sha", help="Optional app-owned commit SHA for source links.")
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
        )
    except ValueError as exc:
        print(f"manifest validation failed: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 1 if manifest["validation"]["status"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
