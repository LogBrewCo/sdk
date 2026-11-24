#!/usr/bin/env python3
"""Run the capture probes of packages whose dependencies changed, and compare with the record.

capture_matrix.py check hashes dependency manifests with their version numbers masked and leaves
out lockfiles, so a dependency update that changes only versions passes it without a probe run.
This tool covers that gap on a pull request:

- `affected REVISION` prints each package (and its probe family) that uses a dependency manifest
  or lockfile changed between REVISION and HEAD.
- `compare PACKAGE...` runs those probes the way `capture_matrix.py generate` does and fails when a
  package sends a different set of signals than quality/capture-matrix.json records. It writes
  nothing.

It lives apart from capture_matrix.py because every record hashes that file: selection and
comparison do not change what a probe measures, so a change here leaves the records current.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import capture_matrix

# Lockfile directories outside the packages that a family setup installs from.
FAMILY_LOCKFILES: dict[str, tuple[str, ...]] = {"js": ("scripts/lockfiles/npm/capture-matrix-js",)}


def _is_dependency_file(name: str) -> bool:
    return (
        name in capture_matrix.DEPENDENCY_MANIFESTS
        or name in capture_matrix.LOCKFILES
        or name.endswith(capture_matrix.MANIFEST_SUFFIXES)
    )


def affected(changed: list[str], probes: dict[str, capture_matrix.Probe]) -> list[capture_matrix.Probe]:
    """Probes that use a dependency manifest or lockfile in `changed` (paths relative to the root).

    A probe uses the files in its own directory, its inputs, and its family's lockfile directories.
    A package directory nested in one of these belongs to that package, as in input_hash.
    """
    root = capture_matrix.ROOT
    dependency_files = [path for path in changed if _is_dependency_file(Path(path).name)]
    chosen = []
    for probe in probes.values():
        others = [package for package in probes if package not in (probe.package, *probe.inputs)]
        excluded = [
            f"{prefix}/" for other in others for prefix in (other, probes[other].directory.relative_to(root).as_posix())
        ]
        used = [
            f"{directory}/"
            for directory in (
                probe.directory.relative_to(root).as_posix(),
                *probe.inputs,
                *FAMILY_LOCKFILES.get(probe.family, ()),
            )
        ]
        if any(
            path.startswith(directory)
            and not any(path.startswith(nested) for nested in excluded if nested.startswith(directory))
            for path in dependency_files
            for directory in used
        ):
            chosen.append(probe)
    return chosen


def changed_since(revision: str) -> list[str]:
    listing = subprocess.run(
        ["git", "diff", "--name-only", "-z", revision, "HEAD"],
        cwd=capture_matrix.ROOT,
        capture_output=True,
        check=True,
    ).stdout
    return sorted(set(os.fsdecode(listing).split("\0")) - {""})


def compare_signals(results: dict[str, Any], recorded: dict[str, Any]) -> int:
    """Fail when a package sends a different set of signals than its record."""
    differences = []
    for package, row in sorted(results.items()):
        before = recorded.get(package, {}).get("signals", {})
        differences += [
            f"{package}: {signal} was {before.get(signal, 'not recorded')}, now {value}"
            for signal, value in row["signals"].items()
            if before.get(signal) != value
        ]
    if differences:
        print("\n".join(differences), file=sys.stderr)
        print(
            "These packages send different signals than their record. Fix the cause, or record it with "
            "tools/capture-matrix/capture_matrix.py generate.",
            file=sys.stderr,
        )
        return 1
    print(f"captured signals match the record for {len(results)} packages")
    return 0


def measure_packages(selected: list[str], verbose: bool) -> dict[str, Any]:
    """Run the selected probes the way capture_matrix.py generate does."""
    probes = capture_matrix.load_probes()
    unknown = [package for package in selected if package not in probes]
    if unknown:
        raise SystemExit(f"no probe for {unknown}")
    chosen = [probes[package] for package in selected]
    work_root = Path(tempfile.mkdtemp(prefix="logbrew-capture-compare-"))
    results: dict[str, Any] = {}
    try:
        with capture_matrix.Collector() as collector:
            for family in sorted({probe.family for probe in chosen}):
                work = work_root / family
                work.mkdir(parents=True, exist_ok=True)
                capture_matrix.setup_family(family, work)
                for probe in (probe for probe in chosen if probe.family == family):
                    results[probe.package] = capture_matrix.measure(probe, probes, work, collector, verbose)
                    row = results[probe.package]
                    print(f"{probe.package}\t{row['share']}%\t{row['events']}")
    finally:
        shutil.rmtree(work_root, ignore_errors=True)
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    select = commands.add_parser("affected", help="print each package whose dependency files changed")
    select.add_argument("revision")
    select.add_argument(
        "--github-output",
        action="store_true",
        help="also write packages= and families= (space-padded) to the file that GITHUB_OUTPUT names",
    )
    run = commands.add_parser("compare", help="run probes and fail when their signals differ from the record")
    run.add_argument("packages", nargs="*")
    run.add_argument("--verbose", action="store_true", help="print probe output")
    args = parser.parse_args()
    if args.command == "compare":
        if not args.packages:
            print("no packages to compare")
            return 0
        return compare_signals(measure_packages(args.packages, args.verbose), capture_matrix.read_matrix()["packages"])
    chosen = affected(changed_since(args.revision), capture_matrix.load_probes())
    for probe in chosen:
        print(f"{probe.package}\t{probe.family}")
    if args.github_output:
        families = sorted({probe.family for probe in chosen})
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"packages={' '.join(probe.package for probe in chosen)}\n")
            output.write(f"families= {' '.join(families)} \n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
