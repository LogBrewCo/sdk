#!/usr/bin/env python3
"""Plan an npm publication without mutating the public registry."""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable


DEFAULT_REGISTRY = "https://registry.npmjs.org"
MAX_METADATA_BYTES = 16 * 1024 * 1024
MAX_SELECTIONS = 64
NPM_NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$")


class PublicationPlanError(RuntimeError):
    """Raised when a safe npm publication plan cannot be established."""


@dataclass(frozen=True)
class Selection:
    """One immutable npm package version selected for publication."""

    name: str
    version: str

    @property
    def identity(self) -> str:
        """Return the conventional package-at-version identity."""

        return f"{self.name}@{self.version}"


def parse_selection(raw: str) -> Selection:
    """Parse and bound one ``name=version`` workflow argument."""

    name, separator, version = raw.partition("=")
    if not separator or not NPM_NAME.fullmatch(name):
        raise PublicationPlanError(f"invalid npm package selection: {raw!r}")
    if not version or len(version) > 128 or any(character.isspace() for character in version):
        raise PublicationPlanError(f"invalid npm package version for {name}")
    return Selection(name=name, version=version)


def normalized_registry(raw: str) -> str:
    """Require a bounded plain HTTPS registry URL without parameters."""

    parsed = urllib.parse.urlsplit(raw)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or "@" in parsed.netloc
        or parsed.query
        or parsed.fragment
    ):
        raise PublicationPlanError("npm registry must be a plain HTTPS URL")
    path = parsed.path.rstrip("/")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def package_metadata_url(registry: str, package_name: str) -> str:
    """Build the exact npm registry metadata URL for one package name."""

    encoded = urllib.parse.quote(package_name, safe="")
    return f"{registry}/{encoded}"


def read_package_metadata(
    registry: str,
    package_name: str,
    *,
    open_request: Callable[..., Any] = urllib.request.urlopen,
    timeout: float = 30.0,
) -> dict[str, Any] | None:
    """Read strict package metadata, returning ``None`` only for a real 404."""

    url = package_metadata_url(registry, package_name)
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.npm.install-v1+json, application/json",
            "User-Agent": "LogBrew npm publication planner",
        },
    )
    try:
        with open_request(request, timeout=timeout) as response:
            status = response.getcode()
            if status != 200:
                raise PublicationPlanError(
                    f"npm registry returned HTTP {status} for {package_name}"
                )
            raw = response.read(MAX_METADATA_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise PublicationPlanError(
            f"npm registry returned HTTP {error.code} for {package_name}"
        ) from error
    except (OSError, TimeoutError, urllib.error.URLError) as error:
        raise PublicationPlanError(
            f"npm registry lookup failed for {package_name}"
        ) from error

    if len(raw) > MAX_METADATA_BYTES:
        raise PublicationPlanError(f"npm registry metadata is too large for {package_name}")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PublicationPlanError(
            f"npm registry returned invalid JSON for {package_name}"
        ) from error
    if not isinstance(payload, dict) or payload.get("name") != package_name:
        raise PublicationPlanError(
            f"npm registry returned mismatched metadata for {package_name}"
        )
    versions = payload.get("versions")
    if not isinstance(versions, dict) or not all(
        isinstance(version, str) for version in versions
    ):
        raise PublicationPlanError(
            f"npm registry returned invalid versions metadata for {package_name}"
        )
    return payload


def plan_publication(
    selections: list[Selection],
    *,
    registry: str = DEFAULT_REGISTRY,
    open_request: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    """Return the complete immutable-version and initial-package preflight plan."""

    if not selections or len(selections) > MAX_SELECTIONS:
        raise PublicationPlanError(
            f"npm publication plan requires 1..{MAX_SELECTIONS} selections"
        )
    names = [selection.name for selection in selections]
    if len(names) != len(set(names)):
        raise PublicationPlanError("npm publication plan contains duplicate package names")

    registry = normalized_registry(registry)
    existing_versions: list[str] = []
    missing_package_pages: list[str] = []
    for selection in selections:
        metadata = read_package_metadata(
            registry,
            selection.name,
            open_request=open_request,
        )
        if metadata is None:
            missing_package_pages.append(selection.name)
            continue
        versions = metadata["versions"]
        if selection.version in versions:
            existing_versions.append(selection.identity)

    return {
        "schemaVersion": 1,
        "registry": registry,
        "selectedVersions": [selection.identity for selection in selections],
        "existingVersions": existing_versions,
        "missingPackagePages": missing_package_pages,
    }


def main(argv: list[str] | None = None) -> int:
    """Run the npm publication planner and emit one deterministic JSON receipt."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", default=DEFAULT_REGISTRY)
    parser.add_argument("--package", action="append", default=[])
    args = parser.parse_args(argv)
    try:
        selections = [parse_selection(raw) for raw in args.package]
        plan = plan_publication(selections, registry=args.registry)
    except PublicationPlanError as error:
        print(f"npm publication preflight failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(plan, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
