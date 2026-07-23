#!/usr/bin/env python3
"""Verify selected NuGet installs came from the exact bound package bytes."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path


class VerificationError(ValueError):
    """Raised when installed package provenance is not exact."""


def package_hash(path: Path) -> str:
    try:
        if path.is_symlink() or not path.is_file():
            raise VerificationError
        return base64.b64encode(hashlib.sha512(path.read_bytes()).digest()).decode("ascii")
    except OSError as error:
        raise VerificationError from error


def load_json(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise VerificationError from error
    if not isinstance(payload, dict):
        raise VerificationError
    return payload


def verify_package(
    bound_dir: Path,
    source_dir: Path,
    packages_dir: Path,
    libraries: dict[str, object],
    package_id: str,
    version: str,
    filename: str,
) -> None:
    expected_hash = package_hash(bound_dir / filename)
    library = libraries.get(f"{package_id}/{version}")
    if (
        not isinstance(library, dict)
        or library.get("type") != "package"
        or library.get("sha512") != expected_hash
    ):
        raise VerificationError
    package_name = package_id.lower()
    package_dir = packages_dir / package_name / version
    hash_path = package_dir / f"{package_name}.{version}.nupkg.sha512"
    metadata = load_json(package_dir / ".nupkg.metadata")
    try:
        installed_hash = hash_path.read_text(encoding="utf-8").strip()
        source = metadata.get("source")
        source_path = Path(source) if isinstance(source, str) else None
        if (
            installed_hash != expected_hash
            or metadata.get("contentHash") != expected_hash
            or source_path is None
            or not source_path.is_absolute()
            or source_path.resolve(strict=True) != source_dir.resolve(strict=True)
        ):
            raise VerificationError
    except OSError as error:
        raise VerificationError from error


def verify(args: argparse.Namespace) -> None:
    if args.bound_dir.resolve(strict=True) == args.source_dir.resolve(strict=True):
        raise VerificationError
    assets = load_json(args.assets)
    libraries = assets.get("libraries")
    if not isinstance(libraries, dict):
        raise VerificationError
    verify_package(
        args.bound_dir,
        args.source_dir,
        args.packages_dir,
        libraries,
        "LogBrew",
        args.core_version,
        "0.nupkg",
    )
    verify_package(
        args.bound_dir,
        args.source_dir,
        args.packages_dir,
        libraries,
        "LogBrew.HttpClient",
        args.httpclient_version,
        "1.nupkg",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bound-dir", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--packages-dir", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--core-version", required=True)
    parser.add_argument("--httpclient-version", required=True)
    args = parser.parse_args()
    try:
        verify(args)
    except VerificationError:
        print("NuGet receipt provenance verification failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
