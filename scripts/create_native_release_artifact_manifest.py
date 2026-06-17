#!/usr/bin/env python3
"""Create a dry-run manifest for native and mobile release artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


SCRIPT_VERSION = "0.1.0"
SUPPORTED_ARTIFACT_TYPES = ("ios_dsym", "android_proguard_mapping")
PROGUARD_CLASS_MAPPING_RE = re.compile(r"^\s*[^#\s].+?\s+->\s+[^:]+:\s*$")


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


def build_artifact_entry(artifact_type: str, path: Path, root: Path) -> dict[str, Any]:
    if artifact_type == "ios_dsym":
        return build_ios_dsym_artifact(path, root)
    if artifact_type == "android_proguard_mapping":
        return build_android_proguard_mapping_artifact(path, root)
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
        help="Release artifact in TYPE=PATH form. Supported types: ios_dsym, android_proguard_mapping.",
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
