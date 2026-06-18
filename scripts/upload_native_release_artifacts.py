#!/usr/bin/env python3
"""Upload native/mobile release artifacts to a loopback fake intake.

This is a transport verifier for SDK release-artifact readiness. It is
intentionally loopback-only until the backend-owned upload contract exists.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from release_artifact_upload_common import (  # noqa: E402
    DEFAULT_TOKEN_ENV,
    SCRIPT_VERSION,
    UploadValidationError,
    byte_size,
    encode_multipart,
    endpoint_without_query,
    read_manifest,
    require_loopback_endpoint,
    safe_resolve,
    sha256_file,
    upload_with_retries,
)


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def require_ready_native_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("artifactType") != "native_debug_symbol_manifest":
        raise UploadValidationError("only native_debug_symbol_manifest uploads are supported by this verifier")
    validation = manifest.get("validation")
    if not isinstance(validation, dict) or validation.get("status") != "ready":
        raise UploadValidationError("manifest validation status must be ready before upload")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise UploadValidationError("manifest must contain at least one native/mobile release artifact")


def artifact_regular_files(path: Path, root: Path, display_path: str) -> list[Path]:
    if path.is_symlink():
        raise UploadValidationError(f"artifact path is a symbolic link: {display_path}")
    if path.is_file():
        return [path]
    if not path.is_dir():
        raise UploadValidationError(f"artifact path is neither a file nor directory: {display_path}")

    files: list[Path] = []
    for candidate in sorted(path.rglob("*")):
        if candidate.is_symlink():
            raise UploadValidationError(f"artifact contains a symbolic link: {relative(candidate, root)}")
        if candidate.is_file():
            files.append(candidate)
    if not files:
        raise UploadValidationError(f"artifact contains no regular files: {display_path}")
    return files


def reject_symlink_path_components(path: Path, root: Path, display_path: str) -> None:
    try:
        relative_parts = path.relative_to(root).parts
    except ValueError:
        return
    current = root
    for part in relative_parts:
        current = current / part
        if current.is_symlink():
            raise UploadValidationError(f"artifact path uses a symbolic link: {display_path}")


def tree_sha256(path: Path, root: Path, files: list[Path]) -> str:
    if path.is_file():
        return sha256_file(path)

    digest = hashlib.sha256()
    for file_path in files:
        digest.update(relative(file_path, root).encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(file_path).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(file_path.stat().st_size).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def require_int_field(payload: dict[str, Any], field: str) -> int:
    value = payload.get(field)
    if type(value) is not int or value < 0:
        raise UploadValidationError(f"artifact is missing valid {field}")
    return value


def require_native_artifact_files(artifact: dict[str, Any], artifact_root: Path) -> list[Path]:
    for field in ("path", "artifactSha256", "byteSize", "fileCount"):
        if artifact.get(field) in (None, ""):
            raise UploadValidationError(f"artifact is missing {field}")

    artifact_validation = artifact.get("validation")
    if not isinstance(artifact_validation, dict) or artifact_validation.get("status") != "ready":
        raise UploadValidationError(f"artifact validation status must be ready: {artifact['path']}")

    display_path = str(artifact["path"])
    raw_path = artifact_root / display_path
    reject_symlink_path_components(raw_path, artifact_root, display_path)

    path = safe_resolve(raw_path, artifact_root)
    if path is None:
        raise UploadValidationError("artifact path resolves outside the artifact root")
    if not path.exists():
        raise UploadValidationError(f"artifact path is missing: {display_path}")

    files = artifact_regular_files(path, artifact_root, display_path)
    expected_file_count = require_int_field(artifact, "fileCount")
    if len(files) != expected_file_count:
        raise UploadValidationError(f"artifact file count changed after manifest creation: {display_path}")

    expected_size = require_int_field(artifact, "byteSize")
    current_size = sum(byte_size(file_path) for file_path in files)
    if current_size != expected_size:
        raise UploadValidationError(f"artifact byte size changed after manifest creation: {display_path}")

    expected_sha = str(artifact["artifactSha256"])
    if tree_sha256(path, artifact_root, files) != expected_sha:
        raise UploadValidationError(f"artifact sha256 changed after manifest creation: {display_path}")
    return files


def collect_artifact_files(manifest: dict[str, Any], artifact_root: Path) -> list[tuple[str, Path]]:
    require_ready_native_manifest(manifest)
    artifact_root = artifact_root.resolve()
    files: list[tuple[str, Path]] = []
    for artifact_index, artifact in enumerate(manifest["artifacts"]):
        if not isinstance(artifact, dict):
            raise UploadValidationError("artifact entries must be JSON objects")
        artifact_files = require_native_artifact_files(artifact, artifact_root)
        for file_index, file_path in enumerate(artifact_files):
            files.append((f"artifact_{artifact_index}_file_{file_index}", file_path))
    return files


def build_report(
    *,
    endpoint: str,
    manifest: dict[str, Any],
    files: list[tuple[str, Path]],
    dry_run: bool,
) -> dict[str, Any]:
    artifacts = manifest.get("artifacts", [])
    return {
        "uploader": {"name": "logbrew-native-release-artifact-upload-verifier", "version": SCRIPT_VERSION},
        "endpoint": endpoint_without_query(endpoint),
        "dryRun": dry_run,
        "release": manifest.get("release"),
        "environment": manifest.get("environment"),
        "service": manifest.get("service"),
        "artifactType": manifest.get("artifactType"),
        "artifactTypes": [
            artifact.get("artifactType") for artifact in artifacts if isinstance(artifact, dict)
        ],
        "artifactCount": len(artifacts),
        "filePartCount": len(files),
        "totalArtifactBytes": sum(
            int(artifact.get("byteSize", 0)) for artifact in artifacts if isinstance(artifact, dict)
        ),
    }


def exit_code_for_status(status: str) -> int:
    return {
        "uploaded": 0,
        "dry_run": 0,
        "auth_missing": 2,
        "auth_failed": 3,
        "validation_failed": 4,
    }.get(status, 5)


def parse_non_negative_int(value: str) -> int:
    try:
        parsed = int(value, 10)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a non-negative integer") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    return parsed


def parse_non_negative_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a non-negative number") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be a non-negative number")
    return parsed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Upload a ready native/mobile release-artifact manifest and its local files to a loopback fake intake. "
            "This verifier does not claim backend release-artifact support."
        )
    )
    parser.add_argument("--artifact-root", required=True, type=Path, help="Directory used to create the manifest.")
    parser.add_argument("--manifest", required=True, type=Path, help="Ready native/mobile release-artifact manifest JSON.")
    parser.add_argument("--endpoint", required=True, help="Loopback fake-intake endpoint URL.")
    parser.add_argument(
        "--token-env",
        default=DEFAULT_TOKEN_ENV,
        help=f"Environment variable containing the fake-intake release-artifact token. Default: {DEFAULT_TOKEN_ENV}.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Validate files and print the upload plan without network.")
    parser.add_argument("--max-retries", type=parse_non_negative_int, default=2, help="Retryable upload retries. Default: 2.")
    parser.add_argument(
        "--retry-delay",
        type=parse_non_negative_float,
        default=0.25,
        help="Seconds to wait between retryable upload attempts. Default: 0.25.",
    )
    parser.add_argument(
        "--timeout",
        type=parse_non_negative_float,
        default=5.0,
        help="HTTP timeout in seconds per upload attempt. Default: 5.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        require_loopback_endpoint(args.endpoint)
        artifact_root = args.artifact_root.resolve()
        if not artifact_root.is_dir():
            raise UploadValidationError(f"artifact root does not exist: {artifact_root}")
        manifest = read_manifest(args.manifest)
        files = collect_artifact_files(manifest, artifact_root)
        report = build_report(endpoint=args.endpoint, manifest=manifest, files=files, dry_run=args.dry_run)
    except UploadValidationError as exc:
        print(
            json.dumps(
                {
                    "status": "validation_failed",
                    "validation": {"errors": [str(exc)]},
                    "uploader": {"name": "logbrew-native-release-artifact-upload-verifier", "version": SCRIPT_VERSION},
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 1

    if args.dry_run:
        report.update({"status": "dry_run", "attempts": [], "retryCount": 0})
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    token = os.environ.get(args.token_env, "").strip()
    if not token:
        report.update({"status": "auth_missing", "attempts": [], "retryCount": 0})
        print(json.dumps(report, indent=2, sort_keys=True))
        return exit_code_for_status("auth_missing")

    body, boundary = encode_multipart(manifest, files)
    upload_report = upload_with_retries(
        endpoint=args.endpoint,
        token=token,
        body=body,
        boundary=boundary,
        max_retries=args.max_retries,
        retry_delay_seconds=args.retry_delay,
        timeout_seconds=args.timeout,
    )
    report.update(upload_report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return exit_code_for_status(str(report["status"]))


if __name__ == "__main__":
    raise SystemExit(main())
