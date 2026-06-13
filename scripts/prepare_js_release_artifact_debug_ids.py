#!/usr/bin/env python3
"""Prepare JavaScript build artifacts with matching source-map debug IDs."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

from create_js_release_artifact_manifest import (
    DEBUG_ID_RE,
    SCRIPT_VERSION,
    SOURCE_MAP_DEBUG_ID_KEYS,
    byte_size,
    find_debug_id,
    find_source_mapping_url,
    read_source_map,
    relative,
    require_non_empty,
    resolve_source_map_path,
    safe_resolve,
    source_map_debug_id,
)


DEBUG_ID_NAMESPACE = uuid.UUID("16f4a837-7e0b-4d7c-97d9-8a7af1fd2768")
SOURCE_MAPPING_COMMENT_RE = re.compile(r"(?://#|/\*#)\s*sourceMappingURL=[^\r\n]*")


def canonical_source_without_debug_id(source: str) -> str:
    return DEBUG_ID_RE.sub("", source)


def canonical_source_map_without_debug_id(payload: dict[str, Any]) -> str:
    canonical = deepcopy(payload)
    for key in SOURCE_MAP_DEBUG_ID_KEYS:
        canonical.pop(key, None)
    return json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def generate_debug_id(relative_js_path: str, js_source: str, source_map_payload: dict[str, Any]) -> str:
    digest = hashlib.sha256()
    digest.update(relative_js_path.encode("utf-8"))
    digest.update(b"\0")
    digest.update(canonical_source_without_debug_id(js_source).encode("utf-8"))
    digest.update(b"\0")
    digest.update(canonical_source_map_without_debug_id(source_map_payload).encode("utf-8"))
    return str(uuid.uuid5(DEBUG_ID_NAMESPACE, digest.hexdigest()))


def source_with_debug_id(source: str, debug_id: str) -> str:
    if find_debug_id(source):
        return source

    debug_line = f"//# debugId={debug_id}\n"
    matches = list(SOURCE_MAPPING_COMMENT_RE.finditer(source))
    if matches:
        last = matches[-1]
        prefix = source[: last.start()]
        separator = "" if prefix.endswith(("\n", "\r")) else "\n"
        return f"{prefix}{separator}{debug_line}{source[last.start():]}"
    separator = "" if source.endswith("\n") else "\n"
    return f"{source}{separator}{debug_line}"


def source_map_with_debug_id(payload: dict[str, Any], debug_id: str) -> dict[str, Any]:
    if source_map_debug_id(payload):
        return payload
    updated = dict(payload)
    updated["debug_id"] = debug_id
    return updated


def build_artifact_plan(js_path: Path, build_dir: Path) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    changes: list[str] = []
    rel_js = relative(js_path, build_dir)

    if byte_size(js_path) == 0:
        errors.append("minified source file is empty")

    js_source = js_path.read_text(encoding="utf-8", errors="replace")
    js_debug_id = find_debug_id(js_source)
    source_mapping_url = find_source_mapping_url(js_source)
    source_map_path, map_warnings, map_errors = resolve_source_map_path(js_path, build_dir, source_mapping_url)
    warnings.extend(map_warnings)
    errors.extend(map_errors)

    source_map_payload: dict[str, Any] | None = None
    map_debug_id: str | None = None
    source_map_rel: str | None = None
    if source_map_path is None:
        errors.append("source map file is missing")
    elif not source_map_path.exists():
        missing_path = relative(source_map_path, build_dir) if safe_resolve(source_map_path, build_dir) else source_map_path
        errors.append(f"source map file is missing: {missing_path}")
    elif byte_size(source_map_path) == 0:
        errors.append(f"source map file is empty: {relative(source_map_path, build_dir)}")
    else:
        source_map_rel = relative(source_map_path, build_dir)
        source_map_payload, source_map_errors = read_source_map(source_map_path)
        errors.extend(source_map_errors)
        if source_map_payload is not None:
            map_debug_id = source_map_debug_id(source_map_payload)

    if js_debug_id and map_debug_id and js_debug_id != map_debug_id:
        errors.append("minified source debugId does not match source map debugId")

    debug_id = js_debug_id or map_debug_id
    if not errors and source_map_payload is not None:
        if debug_id is None:
            debug_id = generate_debug_id(rel_js, js_source, source_map_payload)
            changes.extend(["minifiedSource.debugId", "sourceMap.debug_id"])
        else:
            if js_debug_id is None:
                changes.append("minifiedSource.debugId")
            if map_debug_id is None:
                changes.append("sourceMap.debug_id")

    return {
        "path": rel_js,
        **({"sourceMapPath": source_map_rel} if source_map_rel else {}),
        **({"debugId": debug_id} if debug_id else {}),
        "changes": changes,
        "validation": {
            "status": "blocked" if errors else "ready",
            "errors": errors,
            "warnings": warnings,
        },
    }


def apply_artifact_plan(artifact: dict[str, Any], build_dir: Path) -> None:
    debug_id = artifact["debugId"]
    js_path = build_dir / artifact["path"]
    js_source = js_path.read_text(encoding="utf-8", errors="replace")
    updated_source = source_with_debug_id(js_source, debug_id)
    if updated_source != js_source:
        js_path.write_text(updated_source, encoding="utf-8")

    source_map_path = build_dir / artifact["sourceMapPath"]
    payload, errors = read_source_map(source_map_path)
    if errors or payload is None:
        raise ValueError(f"{artifact['path']}: source map became unreadable before write")
    updated_payload = source_map_with_debug_id(payload, debug_id)
    if updated_payload != payload:
        source_map_path.write_text(
            f"{json.dumps(updated_payload, indent=2, sort_keys=True)}\n",
            encoding="utf-8",
        )


def create_debug_id_plan(*, build_dir: Path, write: bool = False) -> dict[str, Any]:
    build_dir = build_dir.resolve()
    if not build_dir.is_dir():
        raise ValueError(f"build directory does not exist: {build_dir}")

    js_files = sorted(path for path in build_dir.rglob("*.js") if not path.name.endswith(".map"))
    artifacts = [build_artifact_plan(path, build_dir) for path in js_files]
    errors = [] if artifacts else ["no JavaScript files found in build directory"]
    warnings: list[str] = []
    for artifact in artifacts:
        rel_path = artifact["path"]
        errors.extend(f"{rel_path}: {message}" for message in artifact["validation"]["errors"])
        warnings.extend(f"{rel_path}: {message}" for message in artifact["validation"]["warnings"])

    status = "blocked" if errors else "ready"
    if write and status == "ready":
        for artifact in artifacts:
            apply_artifact_plan(artifact, build_dir)

    return {
        "manifestVersion": 1,
        "tool": {
            "name": "logbrew-js-release-artifact-debug-id-prep",
            "version": SCRIPT_VERSION,
        },
        "writeApplied": bool(write and status == "ready"),
        "artifacts": artifacts,
        "validation": {
            "status": status,
            "errors": errors,
            "warnings": warnings,
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Dry-run or inject matching debug IDs into JavaScript minified files and source maps.",
    )
    parser.add_argument("--build-dir", required=True, type=Path, help="Directory containing built JavaScript assets.")
    parser.add_argument(
        "--write",
        action="store_true",
        help="Mutate build artifacts after validation. Defaults to dry-run JSON output only.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        require_non_empty("build directory", str(args.build_dir))
        plan = create_debug_id_plan(build_dir=args.build_dir, write=args.write)
    except ValueError as exc:
        print(f"debug-id preparation failed: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(plan, indent=2, sort_keys=True))
    return 1 if plan["validation"]["status"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
