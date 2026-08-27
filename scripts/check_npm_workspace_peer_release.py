#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import NamedTuple
from urllib.parse import quote


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from check_npm_peer_compatibility import caret_range_allows  # noqa: E402


class WorkspacePackage(NamedTuple):
    directory: Path
    name: str
    version: str
    peer_dependencies: dict[str, str]


ArtifactIdentity = Callable[[WorkspacePackage], tuple[str, str | None]]


def load_workspace_package(directory: Path) -> WorkspacePackage:
    manifest_path = directory / "package.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read npm manifest {manifest_path}: {error}") from error

    name = manifest.get("name")
    version = manifest.get("version")
    peers = manifest.get("peerDependencies", {})
    if not isinstance(name, str) or not name:
        raise ValueError(f"{manifest_path}: name must be a non-empty string")
    if not isinstance(version, str) or not version:
        raise ValueError(f"{manifest_path}: version must be a non-empty string")
    if not isinstance(peers, dict) or any(
        not isinstance(peer_name, str) or not isinstance(peer_range, str)
        for peer_name, peer_range in peers.items()
    ):
        raise ValueError(f"{manifest_path}: peerDependencies must map names to ranges")
    return WorkspacePackage(
        directory=directory,
        name=name,
        version=version,
        peer_dependencies=dict(peers),
    )


def validate_release_plan(
    packages: Mapping[str, WorkspacePackage],
    selected_names: Sequence[str],
    artifact_identity: ArtifactIdentity,
) -> list[str]:
    failures: list[str] = []
    selected_positions: dict[str, int] = {}
    for index, name in enumerate(selected_names):
        if name in selected_positions:
            failures.append(f"selected npm package {name} appears more than once")
            continue
        selected_positions[name] = index
        if name not in packages:
            failures.append(f"selected npm package {name} is not in the workspace package set")

    identities: dict[str, tuple[str, str | None]] = {}
    for consumer_name in selected_names:
        consumer = packages.get(consumer_name)
        if consumer is None:
            continue
        for peer_name, peer_range in sorted(consumer.peer_dependencies.items()):
            peer = packages.get(peer_name)
            if peer is None:
                continue
            if not caret_range_allows(peer_range, peer.version):
                failures.append(
                    f"{consumer.name}@{consumer.version} peer {peer_name} range "
                    f"{peer_range!r} does not include workspace release {peer.version}"
                )
                continue

            peer_position = selected_positions.get(peer_name)
            if peer_position is not None:
                if peer_position >= selected_positions[consumer_name]:
                    failures.append(
                        f"{peer.name}@{peer.version} must publish before "
                        f"{consumer.name}@{consumer.version}"
                    )
                continue

            if peer_name not in identities:
                identities[peer_name] = artifact_identity(peer)
            local_shasum, published_shasum = identities[peer_name]
            if published_shasum is None:
                failures.append(
                    f"{consumer.name}@{consumer.version} requires {peer.name}@{peer.version}, "
                    "which is not published or could not be verified; include that peer "
                    "before its consumer"
                )
            elif local_shasum != published_shasum:
                failures.append(
                    f"{consumer.name}@{consumer.version} depends on unpublished workspace "
                    f"content for {peer.name}@{peer.version}; bump and include that peer "
                    "before its consumer"
                )
    return failures


def bun_pack_shasum(package: WorkspacePackage) -> str:
    with tempfile.TemporaryDirectory() as temp_dir:
        artifact = Path(temp_dir) / "package.tgz"
        try:
            result = subprocess.run(
                [
                    "bun",
                    "pm",
                    "pack",
                    "--filename",
                    str(artifact),
                    "--ignore-scripts",
                    "--quiet",
                ],
                cwd=package.directory,
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError(f"cannot pack {package.name}@{package.version}: {error}") from error
        if result.returncode != 0 or not artifact.is_file():
            raise RuntimeError(f"cannot pack {package.name}@{package.version}")
        return hashlib.sha1(artifact.read_bytes(), usedforsecurity=False).hexdigest()


def npm_registry_shasum(package: WorkspacePackage, registry: str) -> str | None:
    package_url = (
        f"{registry.rstrip('/')}/{quote(package.name, safe='@')}/"
        f"{quote(package.version, safe='')}"
    )
    try:
        result = subprocess.run(
            [
                "bun",
                "-e",
                """
const response = await fetch(process.argv[1]);
if (response.status === 404) process.exit(44);
if (!response.ok) process.exit(1);
const metadata = await response.json();
process.stdout.write(metadata?.dist?.shasum ?? "");
""",
                package_url,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(
            f"cannot verify {package.name}@{package.version}: {error}"
        ) from error
    if result.returncode == 44:
        return None
    if result.returncode != 0:
        raise RuntimeError(f"cannot verify {package.name}@{package.version}")
    shasum = result.stdout
    if not isinstance(shasum, str) or len(shasum) != 40:
        raise RuntimeError(
            f"npm view returned an invalid shasum for {package.name}@{package.version}"
        )
    return shasum


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Block npm releases that rely on unpublished workspace peer content."
    )
    parser.add_argument("--workspace-dir", action="append", required=True, type=Path)
    parser.add_argument("--selected-dir", action="append", required=True, type=Path)
    parser.add_argument("--registry", default="https://registry.npmjs.org")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace_packages = [
            load_workspace_package(directory) for directory in args.workspace_dir
        ]
        packages = {package.name: package for package in workspace_packages}
        if len(packages) != len(workspace_packages):
            raise ValueError("workspace npm package names must be unique")
        selected_packages = [
            load_workspace_package(directory) for directory in args.selected_dir
        ]
        selected_names = [package.name for package in selected_packages]

        def artifact_identity(package: WorkspacePackage) -> tuple[str, str | None]:
            return (
                bun_pack_shasum(package),
                npm_registry_shasum(package, args.registry),
            )

        failures = validate_release_plan(packages, selected_names, artifact_identity)
    except (RuntimeError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1

    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("npm workspace peer release plan ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
