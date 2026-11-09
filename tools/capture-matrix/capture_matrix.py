#!/usr/bin/env python3
"""Measure which signals each SDK package sends, and check that the record is current.

Each package has a probe under tools/capture-matrix/probes/<package path>/: a probe.toml and a
small program that uses the package the way its README tells an app to, against a local
collector. `generate` runs the probes and writes quality/capture-matrix.json; `check` fails when
a package has no probe, or when a package, its probe, or this tool changed since the last run.

probe.toml holds `family` (families/<family>.sh installs the packages into a work directory once
per run), `run` (the command, run in a copy of the probe directory inside that work directory;
{work}, {sdk}, and {probe} expand), `method` (what the run does, one sentence), `inputs` (the
package directories whose files decide what it sends; default: the package itself), `parts`
(manifest directories that belong to this package), and `not_applicable` (signal = reason).

A probe follows these rules, so every row means the same thing:
- Set the package up as its README tells an app to: install, init, documented middleware,
  handlers, and logger integrations, documented opt-in capture options, the documented user hook,
  and release, environment, and service through the documented options or LOGBREW_* variables.
- Produce signals only through app activity: requests through the framework, an error thrown
  where the framework catches it, a message through the framework's logger (or the runtime logger
  the SDK documents when the framework has none). Never build an issue, log, span, or metric by
  hand, except in a core package whose documented API is the capture path; there an issue comes
  from the SDK's own helper for a thrown error.
- Send through the package's own transport to LOGBREW_CAPTURE_ENDPOINT, and flush before exit.
- Mark a signal not applicable only when the framework cannot produce it, with the reason.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import tomllib
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
TOOL = Path(__file__).resolve().parent
PROBES = TOOL / "probes"
FAMILIES = TOOL / "families"
MATRIX = ROOT / "quality" / "capture-matrix.json"
LANGUAGES = (
    "js",
    "python",
    "go",
    "ruby",
    "java",
    "kotlin",
    "php",
    "rust",
    "swift",
    "dotnet",
    "c",
    "cpp",
    "objc",
    "unity",
)
SKIP_DIRS = frozenset(
    [
        "node_modules",
        "examples",
        "example",
        "tests",
        "test",
        "fixtures",
        "benchmarks",
        "tools",
        "target",
        ".build",
        "vendor",
        "scripts",
        "spec",
        "build",
        "dist",
        "samples",
        "bin",
        "obj",
    ]
)
MANIFESTS = frozenset(
    [
        "package.json",
        "pyproject.toml",
        "go.mod",
        "Cargo.toml",
        "composer.json",
        "Package.swift",
        "build.gradle",
        "build.gradle.kts",
        "pom.xml",
        "CMakeLists.txt",
        "Makefile",
    ]
)
MANIFEST_SUFFIXES = (".gemspec", ".csproj", ".podspec", ".asmdef")
UNHASHED_DIRS = frozenset(
    {
        "node_modules",
        "tests",
        "test",
        "examples",
        "example",
        "build",
        "target",
        ".build",
        "obj",
        "bin",
        "dist",
        "vendor",
    }
)
UNHASHED_SUFFIXES = (".md",)
PROBE_TIMEOUT_SECONDS = 600
SETTLE_SECONDS = 1.0

Event = dict[str, Any]


def _context(event: Event, *path: str) -> Any:
    value: Any = event.get("attributes", {}).get("context", {})
    for key in path:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def _of(events: list[Event], *kinds: str) -> list[Event]:
    return [event for event in events if event.get("type") in kinds]


def _issues_with(events: list[Event], field: str) -> bool:
    return any(event["attributes"].get(field) for event in _of(events, "issue"))


def _trace_linked(events: list[Event]) -> bool:
    span_traces = {event["attributes"].get("traceId") for event in _of(events, "span")}
    return any(_context(event, "trace", "traceId") in span_traces for event in _of(events, "issue", "log"))


def _every_signal_has(*path: str) -> Callable[[list[Event]], bool]:
    def check(events: list[Event]) -> bool:
        signals = _of(events, "issue", "log", "span", "metric")
        return bool(signals) and all(_context(event, *path) for event in signals)

    return check


def _user(events: list[Event]) -> bool:
    def has_user(event: Event) -> bool:
        return bool(_context(event, "subject", "id") or _context(event, "subject", "kind"))

    return any(has_user(event) for event in _of(events, "issue", "span")) and all(map(has_user, _of(events, "issue")))


def _release(events: list[Event]) -> bool:
    signals = _of(events, "issue", "log", "span", "metric")
    return bool(signals) and all(
        _context(event, "resource", "deployment", "release") or _context(event, "resource", "application", "version")
        for event in signals
    )


# The signals a package can send, in matrix order. Each rule reads every event the probe's run sent.
SIGNALS: dict[str, tuple[str, Callable[[list[Event]], bool]]] = {
    "errors": ("an issue event for a failure", lambda events: bool(_of(events, "issue"))),
    "stack": (
        "an issue with structured stack frames",
        lambda events: _issues_with(events, "stackFrames") or _issues_with(events, "nativeStackFrames"),
    ),
    "breadcrumbs": ("an issue with the breadcrumbs that led to it", lambda events: _issues_with(events, "breadcrumbs")),
    "logs": ("a log event from the app's logger", lambda events: bool(_of(events, "log"))),
    "requests": ("a span for the request, job, message, or operation", lambda events: bool(_of(events, "span"))),
    "traces": ("an issue or log that shares a trace with a span", _trace_linked),
    "metrics": ("a metric event", lambda events: bool(_of(events, "metric"))),
    "user": ("an issue or span carries the user, and every issue does", _user),
    "session": (
        "an event that carries the session",
        lambda events: any(_context(event, "session", "id") for event in events),
    ),
    "release": ("every issue, log, span, and metric carries the release", _release),
    "environment": (
        "every issue, log, span, and metric carries the environment",
        _every_signal_has("resource", "deployment", "environment"),
    ),
    "service": (
        "every issue, log, span, and metric carries the service",
        _every_signal_has("resource", "service", "name"),
    ),
}


@dataclass(frozen=True)
class Probe:
    package: str
    family: str
    run: tuple[str, ...]
    inputs: tuple[str, ...]
    not_applicable: dict[str, str]
    parts: tuple[str, ...]
    method: str

    @property
    def directory(self) -> Path:
        return PROBES / self.package


def load_probes() -> dict[str, Probe]:
    probes: dict[str, Probe] = {}
    for path in sorted(PROBES.rglob("probe.toml")):
        package = path.parent.relative_to(PROBES).as_posix()
        data = tomllib.loads(path.read_text(encoding="utf-8"))
        not_applicable = dict(data.get("not_applicable", {}))
        unknown = set(not_applicable) - set(SIGNALS)
        if unknown:
            raise SystemExit(f"{path}: unknown signals in not_applicable: {sorted(unknown)}")
        if not (ROOT / package).is_dir():
            raise SystemExit(f"{path}: no package directory {package}")
        probes[package] = Probe(
            package=package,
            family=str(data["family"]),
            run=tuple(data["run"]),
            inputs=tuple(data.get("inputs", [package])),
            not_applicable=not_applicable,
            parts=tuple(data.get("parts", [])),
            method=str(data["method"]),
        )
    return probes


def package_directories() -> list[str]:
    """Directories with a package manifest, the way the scoreboard's SDK inventory finds them."""
    found: set[str] = set()

    def walk(directory: Path, depth: int) -> None:
        children = []
        for path in sorted(directory.iterdir()):
            if path.is_dir():
                if path.name not in SKIP_DIRS and not path.name.startswith("."):
                    children.append(path)
            elif path.name in MANIFESTS or path.name.endswith(MANIFEST_SUFFIXES):
                found.add(directory.relative_to(ROOT).as_posix())
        if depth < 4:
            for child in children:
                walk(child, depth + 1)

    for language in LANGUAGES:
        if (ROOT / language).is_dir():
            walk(ROOT / language, 1)
    return sorted(found - set(LANGUAGES))


def _hashed_files(directory: Path) -> Iterator[Path]:
    """Files git would commit, so ignored build output never makes a record stale on one machine only."""
    listing = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=directory,
        capture_output=True,
        check=True,
    ).stdout
    for name in sorted(set(os.fsdecode(listing).split("\0")) - {""}):
        path = directory / name
        if (
            path.is_file()
            and not UNHASHED_DIRS.intersection(Path(name).parts[:-1])
            and not name.endswith(UNHASHED_SUFFIXES)
        ):
            yield path


def input_hash(probe: Probe, probes: dict[str, Probe]) -> str:
    """One hash over this tool, the family setup, the probe, and the package's runtime inputs.

    A nested package's directory is left out of its parent's inputs unless the parent lists it.
    """
    others = [package for package in probes if package not in (probe.package, *probe.inputs)]
    excluded = tuple(
        f"{prefix}/" for other in others for prefix in (other, probes[other].directory.relative_to(ROOT).as_posix())
    )
    digest = hashlib.sha256()
    for root in (
        Path(__file__),
        FAMILIES / f"{probe.family}.sh",
        probe.directory,
        *(ROOT / item for item in probe.inputs),
    ):
        for path in [root] if root.is_file() else _hashed_files(root):
            relative = path.relative_to(ROOT).as_posix()
            if not relative.startswith(excluded):
                digest.update(f"{relative}\0".encode())
                digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


class Collector:
    """A local intake on 127.0.0.1 that accepts every batch and keeps its events."""

    def __init__(self) -> None:
        self.events: list[Event] = []
        self.batches = 0
        self.rejected: list[str] = []
        self._lock = threading.Lock()
        collector = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                if self.headers.get("content-encoding") == "gzip":
                    body = gzip.decompress(body)
                collector.receive(self.path, body)
                self.send_response(202)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *_: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1/events"

    def receive(self, path: str, body: bytes) -> None:
        try:
            batch = json.loads(body)
        except ValueError:
            batch = None
        with self._lock:
            if isinstance(batch, dict) and isinstance(batch.get("events"), list):
                self.batches += 1
                self.events.extend(event for event in batch["events"] if isinstance(event, dict))
            else:
                self.rejected.append(path)

    def reset(self) -> None:
        with self._lock:
            self.events, self.batches, self.rejected = [], 0, []

    def __enter__(self) -> Collector:
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.server.shutdown()
        self.server.server_close()


def classify(probe: Probe, events: list[Event]) -> dict[str, str]:
    return {
        name: "n/a" if name in probe.not_applicable else ("sent" if rule(events) else "missing")
        for name, (_, rule) in SIGNALS.items()
    }


def share(signals: dict[str, str]) -> float:
    applicable = [value for value in signals.values() if value != "n/a"]
    return round(100 * applicable.count("sent") / len(applicable), 1) if applicable else 100.0


def run_probe(probe: Probe, work: Path, collector: Collector, verbose: bool) -> list[Event]:
    run_dir = work / "probes" / probe.package
    shutil.rmtree(run_dir, ignore_errors=True)
    shutil.copytree(probe.directory, run_dir)
    values = {"work": str(work), "sdk": str(ROOT), "probe": str(run_dir)}
    command = [part.format(**values) for part in probe.run]
    env = {
        **os.environ,
        "LOGBREW_CAPTURE_ENDPOINT": collector.endpoint,
        "LOGBREW_CAPTURE_WORK": str(work),
        "LOGBREW_SDK_ROOT": str(ROOT),
    }
    collector.reset()
    result = subprocess.run(
        command, cwd=run_dir, env=env, capture_output=True, text=True, timeout=PROBE_TIMEOUT_SECONDS, check=False
    )
    threading.Event().wait(SETTLE_SECONDS)
    if verbose or result.returncode != 0:
        sys.stderr.write(result.stdout[-20000:] + result.stderr[-20000:])
    if result.returncode != 0:
        raise SystemExit(f"{probe.package}: probe exited with {result.returncode}")
    if collector.rejected:
        raise SystemExit(
            f"{probe.package}: the collector received bodies that are not event batches at {collector.rejected}"
        )
    if not collector.events:
        raise SystemExit(f"{probe.package}: the probe sent no events to the collector")
    (run_dir / "events.json").write_text(json.dumps(collector.events, indent=2), encoding="utf-8")
    return list(collector.events)


def measure(probe: Probe, probes: dict[str, Probe], work: Path, collector: Collector, verbose: bool) -> dict[str, Any]:
    events = run_probe(probe, work, collector, verbose)
    signals = classify(probe, events)
    kinds: dict[str, int] = {}
    for event in events:
        kinds[str(event.get("type"))] = kinds.get(str(event.get("type")), 0) + 1
    return {
        "share": share(signals),
        "signals": signals,
        "not_applicable": dict(sorted(probe.not_applicable.items())),
        "missing": [name for name, value in signals.items() if value == "missing"],
        "events": dict(sorted(kinds.items())),
        "method": probe.method,
        "probe": probe.directory.relative_to(ROOT).as_posix(),
        "inputs": input_hash(probe, probes),
    }


def setup_family(family: str, work: Path) -> None:
    script = FAMILIES / f"{family}.sh"
    result = subprocess.run(["bash", str(script), str(work)], cwd=ROOT, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        sys.stderr.write(result.stdout[-4000:] + result.stderr[-4000:])
        raise SystemExit(f"family setup {family} failed with {result.returncode}")


def read_matrix() -> dict[str, Any]:
    if not MATRIX.is_file():
        return {"signals": {}, "packages": {}}
    return dict(json.loads(MATRIX.read_text(encoding="utf-8")))


def write_matrix(packages: dict[str, Any]) -> None:
    matrix = {
        "about": "Generated by tools/capture-matrix/capture_matrix.py generate. Do not edit.",
        "signals": {name: description for name, (description, _) in SIGNALS.items()},
        "packages": dict(sorted(packages.items())),
    }
    temporary = MATRIX.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(matrix, indent=2) + "\n", encoding="utf-8")
    temporary.replace(MATRIX)


def generate(selected: list[str], keep: Path | None, write: bool, verbose: bool) -> int:
    probes = load_probes()
    unknown = [package for package in selected if package not in probes]
    if unknown:
        raise SystemExit(f"no probe for {unknown}")
    chosen = [probes[package] for package in (selected or list(probes))]
    work_root = keep or Path(tempfile.mkdtemp(prefix="logbrew-capture-matrix-"))
    results: dict[str, Any] = {}
    try:
        with Collector() as collector:
            for family in sorted({probe.family for probe in chosen}):
                work = work_root / family
                work.mkdir(parents=True, exist_ok=True)
                setup_family(family, work)
                for probe in (probe for probe in chosen if probe.family == family):
                    results[probe.package] = measure(probe, probes, work, collector, verbose)
                    row = results[probe.package]
                    missing = ", ".join(row["missing"]) or "none"
                    print(f"{probe.package}\t{row['share']}%\tmissing: {missing}\t{row['events']}")
    finally:
        if keep is None:
            shutil.rmtree(work_root, ignore_errors=True)
    if write:
        packages = read_matrix()["packages"] if selected else {}
        packages.update(results)
        write_matrix({package: row for package, row in packages.items() if package in probes})
    return 0


def check() -> int:
    probes = load_probes()
    matrix = read_matrix()
    recorded: dict[str, Any] = matrix["packages"]
    problems = []
    covered = set(probes) | {part for probe in probes.values() for part in probe.parts}
    problems += [
        f"{package}: no capture probe under tools/capture-matrix/probes/{package}"
        for package in package_directories()
        if package not in covered
    ]
    problems += [f"{package}: recorded but has no probe" for package in recorded if package not in probes]
    if matrix.get("signals") != {name: description for name, (description, _) in SIGNALS.items()}:
        problems.append("the signal list changed: regenerate every package")
    for package, probe in probes.items():
        row = recorded.get(package)
        if row is None:
            problems.append(f"{package}: not measured yet")
        elif row["inputs"] != input_hash(probe, probes):
            problems.append(f"{package}: stale, the package, its probe, or the tool changed since it was measured")
        elif row["not_applicable"] != dict(sorted(probe.not_applicable.items())):
            problems.append(f"{package}: not_applicable changed since it was measured")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        stale = sorted({problem.split(":", 1)[0] for problem in problems if problem.split(":", 1)[0] in probes})
        print(f"Run: python3 tools/capture-matrix/capture_matrix.py generate {' '.join(stale)}", file=sys.stderr)
        return 1
    print(f"capture matrix is current for {len(probes)} packages")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("generate", help="run probes and update quality/capture-matrix.json")
    run.add_argument("packages", nargs="*", help="package paths; all packages when none")
    run.add_argument("--keep", type=Path, help="reuse and keep this work directory")
    run.add_argument("--dry-run", action="store_true", help="print results without writing the matrix")
    run.add_argument("--verbose", action="store_true", help="print probe output")
    commands.add_parser("check", help="fail when a package has no probe or its record is stale")
    commands.add_parser("packages", help="print every package path")
    args = parser.parse_args()
    if args.command == "generate":
        return generate(args.packages, args.keep.resolve() if args.keep else None, not args.dry_run, args.verbose)
    if args.command == "packages":
        print("\n".join(sorted(load_probes())))
        return 0
    return check()


if __name__ == "__main__":
    sys.exit(main())
