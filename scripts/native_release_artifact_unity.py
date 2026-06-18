"""Unity symbol helpers for native release-artifact dry runs."""

from __future__ import annotations

import re
import shutil
import tempfile
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

from native_release_artifact_elf import dedupe_android_symbol_files, validated_elf_symbol_file


UNITY_BUILD_ID_FILE_NAME = "build_id"
UNITY_IL2CPP_MAPPING_FILE_NAME = "LineNumberMappings.json"
UNITY_BUILD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
UNITY_SYMBOLS_ARCHIVE_SUFFIXES = {".zip"}


@dataclass(frozen=True)
class UnityArchiveNativeCandidate:
    extracted_path: Path
    display_path: str


@dataclass(frozen=True)
class UnityArchiveInspection:
    build_id: str
    native_candidates: list[UnityArchiveNativeCandidate]
    il2cpp_mapping_file: dict[str, Any] | None
    upload_candidate_count: int
    errors: list[str]
    warnings: list[str]


@dataclass(frozen=True)
class UnityArchiveValidation:
    build_id: str
    native_symbol_files: list[dict[str, Any]]
    il2cpp_mapping_file: dict[str, Any] | None
    archive_format: str
    errors: list[str]
    warnings: list[str]


def unity_native_symbol_candidates(path: Path) -> list[Path]:
    return sorted(candidate for candidate in path.rglob("*.so") if candidate.is_file())


def is_unity_symbols_archive(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in UNITY_SYMBOLS_ARCHIVE_SUFFIXES


def unity_build_id_from_bytes(payload: bytes) -> tuple[str, str | None]:
    try:
        value = payload.decode("utf-8", errors="strict").strip()
    except UnicodeDecodeError:
        return "", "Unity build_id must be UTF-8 text"

    if not value:
        return "", "Unity build_id file is empty"
    if not UNITY_BUILD_ID_RE.fullmatch(value):
        return "", "Unity build_id must be 1-128 ASCII letters, numbers, dot, underscore, colon, or dash"
    return value, None


def read_unity_build_id(path: Path) -> tuple[str, str | None]:
    try:
        payload = path.read_bytes()
    except OSError as exc:
        return "", str(exc)
    return unity_build_id_from_bytes(payload)


def il2cpp_mapping_metadata(
    *,
    rel_path: str,
    byte_size: int,
    head: bytes,
) -> tuple[dict[str, Any] | None, str | None]:
    if byte_size == 0:
        return None, "IL2CPP mapping file is empty"
    if b"\0" in head:
        return None, "IL2CPP mapping file must be text JSON"
    if not head.lstrip().startswith((b"{", b"[")):
        return None, "IL2CPP mapping file must be JSON object or array data"
    return {
        "path": rel_path,
        "byteSize": byte_size,
        "symbolFormat": "il2cpp_mapping",
        "fileName": UNITY_IL2CPP_MAPPING_FILE_NAME,
    }, None


def il2cpp_mapping_entry(path: Path, rel_path: str) -> tuple[dict[str, Any] | None, str | None]:
    try:
        with path.open("rb") as handle:
            head = handle.read(4096)
    except OSError as exc:
        return None, str(exc)
    return il2cpp_mapping_metadata(rel_path=rel_path, byte_size=path.stat().st_size, head=head)


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


def single_archive_file_by_name(
    entries: dict[str, zipfile.ZipInfo],
    file_name: str,
) -> tuple[tuple[str, zipfile.ZipInfo] | None, bool]:
    matches = [(name, info) for name, info in entries.items() if PurePosixPath(name).name == file_name]
    if len(matches) == 1:
        return matches[0], False
    return None, len(matches) > 1


@contextmanager
def inspect_unity_symbols_zip(
    path: Path,
    *,
    archive_rel_path: str,
    max_symbol_file_bytes: int,
) -> Iterator[UnityArchiveInspection]:
    errors: list[str] = []
    warnings: list[str] = []
    build_id = ""
    native_candidates: list[UnityArchiveNativeCandidate] = []
    il2cpp_mapping_file: dict[str, Any] | None = None

    with tempfile.TemporaryDirectory(prefix="logbrew-unity-symbols-") as temp_dir:
        try:
            archive = zipfile.ZipFile(path)
        except zipfile.BadZipFile:
            yield UnityArchiveInspection(build_id, [], None, 0, ["Unity symbols archive is not a valid ZIP file"], [])
            return
        except OSError as exc:
            yield UnityArchiveInspection(build_id, [], None, 0, [str(exc)], [])
            return

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
                errors.append("Unity symbols archive contains unsafe entry paths")

            build_id_entry, duplicate_build_id = single_archive_file_by_name(entries, UNITY_BUILD_ID_FILE_NAME)
            if duplicate_build_id:
                errors.append(f"Unity symbols archive contains multiple {UNITY_BUILD_ID_FILE_NAME} files")
            elif build_id_entry is None:
                errors.append(f"Unity symbols archive is missing {UNITY_BUILD_ID_FILE_NAME}")
            else:
                build_id_name, build_id_info = build_id_entry
                if build_id_info.file_size > max_symbol_file_bytes:
                    errors.append(
                        f"{archive_display_path(archive_rel_path, build_id_name)}: build_id file is "
                        f"{build_id_info.file_size} bytes; maximum is {max_symbol_file_bytes} bytes"
                    )
                else:
                    value, build_id_error = unity_build_id_from_bytes(archive.read(build_id_info))
                    if build_id_error:
                        errors.append(f"{archive_display_path(archive_rel_path, build_id_name)}: {build_id_error}")
                    else:
                        build_id = value

            mapping_entry, duplicate_mapping = single_archive_file_by_name(entries, UNITY_IL2CPP_MAPPING_FILE_NAME)
            if duplicate_mapping:
                errors.append(f"Unity symbols archive contains multiple {UNITY_IL2CPP_MAPPING_FILE_NAME} files")
            elif mapping_entry is None:
                warnings.append(
                    f"{UNITY_IL2CPP_MAPPING_FILE_NAME} is missing; managed Unity stack deobfuscation will be incomplete"
                )
            else:
                mapping_name, mapping_info = mapping_entry
                display_path = archive_display_path(archive_rel_path, mapping_name)
                if mapping_info.file_size > max_symbol_file_bytes:
                    errors.append(
                        f"{display_path}: symbol file is {mapping_info.file_size} bytes; "
                        f"maximum is {max_symbol_file_bytes} bytes"
                    )
                else:
                    with archive.open(mapping_info) as handle:
                        head = handle.read(4096)
                    mapping_file, mapping_error = il2cpp_mapping_metadata(
                        rel_path=display_path,
                        byte_size=mapping_info.file_size,
                        head=head,
                    )
                    if mapping_error:
                        errors.append(f"{display_path}: {mapping_error}")
                    else:
                        il2cpp_mapping_file = mapping_file

            temp_root = Path(temp_dir)
            for entry_name, info in sorted(entries.items()):
                if not entry_name.endswith(".so"):
                    continue
                display_path = archive_display_path(archive_rel_path, entry_name)
                if info.file_size > max_symbol_file_bytes:
                    errors.append(
                        f"{display_path}: symbol file is {info.file_size} bytes; "
                        f"maximum is {max_symbol_file_bytes} bytes"
                    )
                    continue
                extracted_path = temp_root / f"{len(native_candidates)}.so"
                with archive.open(info) as source, extracted_path.open("wb") as target:
                    shutil.copyfileobj(source, target)
                native_candidates.append(UnityArchiveNativeCandidate(extracted_path, display_path))

        upload_candidate_count = len(native_candidates) + (1 if il2cpp_mapping_file else 0)
        yield UnityArchiveInspection(
            build_id=build_id,
            native_candidates=native_candidates,
            il2cpp_mapping_file=il2cpp_mapping_file,
            upload_candidate_count=upload_candidate_count,
            errors=errors,
            warnings=warnings,
        )


def validated_unity_symbols_zip(
    path: Path,
    *,
    archive_rel_path: str,
    max_symbol_files: int,
    max_symbol_file_bytes: int,
) -> UnityArchiveValidation:
    native_symbol_files: list[dict[str, Any]] = []
    il2cpp_mapping_file: dict[str, Any] | None = None

    with inspect_unity_symbols_zip(
        path,
        archive_rel_path=archive_rel_path,
        max_symbol_file_bytes=max_symbol_file_bytes,
    ) as archive:
        errors = [f"{archive_rel_path}: {error}" for error in archive.errors]
        warnings = list(archive.warnings)
        build_id = archive.build_id
        if archive.upload_candidate_count > max_symbol_files:
            errors.append(
                f"Unity symbols artifact contains {archive.upload_candidate_count} symbol files; "
                f"maximum is {max_symbol_files}"
            )
        else:
            for candidate in archive.native_candidates:
                symbol_file, candidate_errors, candidate_warnings = validated_elf_symbol_file(
                    candidate.extracted_path,
                    candidate.display_path,
                )
                errors.extend(candidate_errors)
                warnings.extend(candidate_warnings)
                if symbol_file:
                    native_symbol_files.append({"symbolFormat": "elf", **symbol_file})
            il2cpp_mapping_file = archive.il2cpp_mapping_file
        native_symbol_files = dedupe_android_symbol_files(
            native_symbol_files,
            warnings,
            label="Unity native symbol",
        )
        if archive.upload_candidate_count == 0:
            errors.append(f"Unity symbols artifact contains no .so files or {UNITY_IL2CPP_MAPPING_FILE_NAME}")

    return UnityArchiveValidation(
        build_id=build_id,
        native_symbol_files=native_symbol_files,
        il2cpp_mapping_file=il2cpp_mapping_file,
        archive_format="zip",
        errors=errors,
        warnings=warnings,
    )
