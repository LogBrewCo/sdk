#!/usr/bin/env python3
"""Print the newest stable npm release of each package that is at least 1 hour old.

A framework that publishes several packages in sequence can move `latest` before
the rest of its release reaches the registry. Smoke tests install the newest
release that has had 1 hour to arrive, so a release in progress cannot fail them.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

MINIMUM_AGE = timedelta(hours=1)
NPM_TIMEOUT_SECONDS = 120
MAX_PARALLEL_LOOKUPS = 4
STABLE_VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")
VERSION_CORE = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?")


class RegistryError(Exception):
    """The registry cannot name a settled stable release."""


def version_core(match: re.Match[str]) -> tuple[int, int, int]:
    return int(match[1]), int(match[2]), int(match[3])


def publish_time(value: str) -> datetime:
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RegistryError(f"invalid publish time {value!r}") from error
    if moment.tzinfo is None:
        raise RegistryError(f"publish time {value!r} has no time zone")
    return moment


def settled_version(document: object, now: datetime) -> str:
    if not isinstance(document, dict):
        raise RegistryError("the package document is not a JSON object")
    times, versions, tags = document.get("time"), document.get("versions"), document.get("dist-tags")
    if isinstance(versions, str):
        versions = [versions]
    if not (isinstance(times, dict) and isinstance(versions, list) and isinstance(tags, dict)):
        raise RegistryError("the package document has no release times, versions, or dist-tags")
    latest = tags.get("latest")
    latest_match = VERSION_CORE.fullmatch(latest) if isinstance(latest, str) else None
    if latest_match is None:
        raise RegistryError("the package has no valid latest dist-tag")
    ceiling = version_core(latest_match)
    cutoff = now - MINIMUM_AGE
    candidates: list[tuple[tuple[int, int, int], str]] = []
    for version in versions:
        match = STABLE_VERSION.fullmatch(version) if isinstance(version, str) else None
        published = times.get(version) if match else None
        if match is None or not isinstance(published, str) or version_core(match) > ceiling:
            continue
        if publish_time(published) <= cutoff:
            candidates.append((version_core(match), match[0]))
    if not candidates:
        raise RegistryError(f"no stable release up to {latest} is at least 1 hour old")
    return max(candidates)[1]


def read_document(package: str) -> object:
    try:
        result = subprocess.run(
            ["npm", "view", package, "time", "versions", "dist-tags", "--json"],
            capture_output=True,
            text=True,
            timeout=NPM_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RegistryError(f"npm view did not finish: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[:1] or ["no error output"]
        raise RegistryError(f"npm view exited with status {result.returncode}: {detail[0]}")
    try:
        document: object = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RegistryError("npm view printed invalid JSON") from error
    return document


def resolve(package: str) -> str:
    try:
        return settled_version(read_document(package), datetime.now(timezone.utc))
    except RegistryError as error:
        raise RegistryError(f"cannot resolve a settled {package} release from the npm registry: {error}") from error


def main(packages: list[str]) -> int:
    if not packages:
        print("usage: npm_settled_versions.py PACKAGE...", file=sys.stderr)
        return 2
    try:
        with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL_LOOKUPS, len(packages))) as executor:
            versions = list(executor.map(resolve, packages))
    except RegistryError as error:
        print(error, file=sys.stderr)
        return 1
    print(*versions)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
