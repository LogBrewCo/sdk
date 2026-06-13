#!/usr/bin/env python3
"""Create a dry-run manifest for JavaScript release artifact symbolication."""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


SOURCE_MAPPING_RE = re.compile(r"(?://#|/\*#)\s*sourceMappingURL=([^\s*]+)", re.IGNORECASE)
DEBUG_ID_RE = re.compile(r"(?://#|/\*#)\s*debugId=([A-Za-z0-9._:-]+)", re.IGNORECASE)
SOURCE_MAP_DEBUG_ID_KEYS = ("debug_id", "debugId", "debugID", "x_debug_id")
SCRIPT_VERSION = "0.1.0"


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


def byte_size(path: Path) -> int:
    return path.stat().st_size


def normalize_url_or_path(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme and parsed.netloc:
        normalized_path = posixpath.normpath(parsed.path or "/")
        if normalized_path == ".":
            normalized_path = "/"
        return urlunsplit((parsed.scheme, parsed.netloc, normalized_path.rstrip("/"), "", ""))
    path = value.split("?", 1)[0].split("#", 1)[0].strip()
    return path.rstrip("/")


def join_url_or_path(prefix: str, relative_path: str) -> str:
    normalized_prefix = normalize_url_or_path(prefix)
    normalized_relative = relative_path.strip("/").replace("\\", "/")
    parsed = urlsplit(normalized_prefix)
    if parsed.scheme and parsed.netloc:
        joined_path = posixpath.join(parsed.path.rstrip("/"), normalized_relative)
        if not joined_path.startswith("/"):
            joined_path = f"/{joined_path}"
        return urlunsplit((parsed.scheme, parsed.netloc, joined_path, "", ""))
    if normalized_prefix == "":
        return normalized_relative
    return f"{normalized_prefix.rstrip('/')}/{normalized_relative}"


def file_reference(value: str) -> str:
    return value.split("?", 1)[0].split("#", 1)[0]


def relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def safe_resolve(candidate: Path, root: Path) -> Path | None:
    try:
        resolved = candidate.resolve()
        resolved.relative_to(root.resolve())
        return resolved
    except ValueError:
        return None


def find_source_mapping_url(source: str) -> str | None:
    matches = SOURCE_MAPPING_RE.findall(source)
    return matches[-1].strip() if matches else None


def find_debug_id(source: str) -> str | None:
    matches = DEBUG_ID_RE.findall(source)
    return matches[-1].strip() if matches else None


def resolve_source_map_path(
    js_path: Path,
    build_dir: Path,
    source_mapping_url: str | None,
) -> tuple[Path | None, list[str], list[str]]:
    warnings: list[str] = []
    errors: list[str] = []
    if source_mapping_url is None:
        fallback = js_path.with_name(f"{js_path.name}.map")
        warnings.append("sourceMappingURL comment missing; checked sibling .map fallback")
        return (fallback if fallback.exists() else None), warnings, errors

    reference = file_reference(source_mapping_url)
    if reference.startswith("data:"):
        errors.append("inline source maps are not accepted for release artifact manifests")
        return None, warnings, errors

    parsed = urlsplit(reference)
    if parsed.scheme and parsed.netloc:
        errors.append("external sourceMappingURL cannot be validated from the local build directory")
        return None, warnings, errors

    candidate = (build_dir / reference.lstrip("/")) if reference.startswith("/") else (js_path.parent / reference)
    resolved = safe_resolve(candidate, build_dir)
    if resolved is None:
        errors.append("sourceMappingURL resolves outside the build directory")
    return resolved, warnings, errors


def read_source_map(path: Path) -> tuple[dict[str, Any] | None, list[str]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return None, [f"source map is not valid JSON: {exc}"]
    if not isinstance(payload, dict):
        return None, ["source map must be a JSON object"]
    return payload, []


def source_map_debug_id(payload: dict[str, Any]) -> str | None:
    for key in SOURCE_MAP_DEBUG_ID_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def validate_source_map_payload(payload: dict[str, Any], allow_sources_content: bool) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if payload.get("version") is None:
        errors.append("source map version is required")
    if not isinstance(payload.get("sources"), list) or not payload["sources"]:
        errors.append("source map sources must be a non-empty array")
    if not isinstance(payload.get("mappings"), str) or payload["mappings"] == "":
        errors.append("source map mappings must be a non-empty string")
    if "sourcesContent" in payload:
        if allow_sources_content:
            warnings.append("source map contains sourcesContent; ensure app policy permits source upload")
        else:
            errors.append("source map contains sourcesContent; rerun with --allow-sources-content only if policy permits it")
    return errors, warnings


def artifact_status(errors: list[str]) -> str:
    return "blocked" if errors else "ready"


def build_artifact_entry(
    js_path: Path,
    build_dir: Path,
    minified_path_prefix: str,
    allow_sources_content: bool,
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    rel_js = relative(js_path, build_dir)
    js_size = byte_size(js_path)
    if js_size == 0:
        errors.append("minified source file is empty")

    source = js_path.read_text(encoding="utf-8", errors="replace")
    js_debug_id = find_debug_id(source)
    source_mapping_url = find_source_mapping_url(source)
    source_map_path, map_resolution_warnings, map_resolution_errors = resolve_source_map_path(
        js_path,
        build_dir,
        source_mapping_url,
    )
    warnings.extend(map_resolution_warnings)
    errors.extend(map_resolution_errors)

    source_map_entry: dict[str, Any] | None = None
    map_debug_id: str | None = None
    if source_map_path is None:
        errors.append("source map file is missing")
    elif not source_map_path.exists():
        missing_path = relative(source_map_path, build_dir) if safe_resolve(source_map_path, build_dir) else source_map_path
        errors.append(f"source map file is missing: {missing_path}")
    elif byte_size(source_map_path) == 0:
        errors.append(f"source map file is empty: {relative(source_map_path, build_dir)}")
    else:
        payload, source_map_errors = read_source_map(source_map_path)
        errors.extend(source_map_errors)
        if payload is not None:
            payload_errors, payload_warnings = validate_source_map_payload(payload, allow_sources_content)
            errors.extend(payload_errors)
            warnings.extend(payload_warnings)
            map_debug_id = source_map_debug_id(payload)
            source_map_entry = {
                "path": relative(source_map_path, build_dir),
                "artifactSha256": sha256_file(source_map_path),
                "byteSize": byte_size(source_map_path),
                "sourceCount": len(payload.get("sources", [])) if isinstance(payload.get("sources"), list) else 0,
                "hasSourcesContent": "sourcesContent" in payload,
                **({"debugId": map_debug_id} if map_debug_id else {}),
            }

    if js_debug_id and map_debug_id and js_debug_id != map_debug_id:
        errors.append("minified source debugId does not match source map debugId")
    if not js_debug_id and not map_debug_id:
        warnings.append("no debugId found; backend matching must rely on release/environment/service and minified path")

    debug_id = js_debug_id or map_debug_id
    return {
        "artifactType": "javascript_source_map",
        **({"debugId": debug_id} if debug_id else {}),
        "minifiedSource": {
            "path": rel_js,
            "minifiedUrl": join_url_or_path(minified_path_prefix, rel_js),
            "artifactSha256": sha256_file(js_path),
            "byteSize": js_size,
            **({"debugId": js_debug_id} if js_debug_id else {}),
            **({"sourceMappingUrl": source_mapping_url} if source_mapping_url else {}),
        },
        "sourceMap": source_map_entry,
        "validation": {
            "status": artifact_status(errors),
            "errors": errors,
            "warnings": warnings,
        },
    }


def create_manifest(
    *,
    build_dir: Path,
    release: str,
    environment: str,
    service: str,
    minified_path_prefix: str,
    allow_sources_content: bool = False,
    repository_url: str | None = None,
    commit_sha: str | None = None,
) -> dict[str, Any]:
    release = require_non_empty("release", release)
    environment = require_non_empty("environment", environment)
    service = require_non_empty("service", service)
    minified_path_prefix = normalize_url_or_path(require_non_empty("minified path prefix", minified_path_prefix))
    build_dir = build_dir.resolve()
    if not build_dir.is_dir():
        raise ValueError(f"build directory does not exist: {build_dir}")

    js_files = sorted(path for path in build_dir.rglob("*.js") if not path.name.endswith(".map"))
    artifacts = [
        build_artifact_entry(path, build_dir, minified_path_prefix, allow_sources_content)
        for path in js_files
    ]
    errors = [] if artifacts else ["no JavaScript files found in build directory"]
    warnings: list[str] = []
    for artifact in artifacts:
        rel_path = artifact["minifiedSource"]["path"]
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
        "artifactType": "javascript_source_map_manifest",
        "minifiedPathPrefix": minified_path_prefix,
        "uploader": {
            "name": "logbrew-js-release-artifact-manifest",
            "version": SCRIPT_VERSION,
        },
        **({"git": git} if git else {}),
        "artifacts": artifacts,
        "validation": {
            "status": artifact_status(errors),
            "errors": errors,
            "warnings": warnings,
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a LogBrew dry-run manifest for JavaScript source-map artifacts.")
    parser.add_argument("--build-dir", required=True, type=Path, help="Directory containing built JavaScript assets.")
    parser.add_argument("--release", required=True, help="Application release version or id.")
    parser.add_argument("--environment", required=True, help="Deployment environment, such as production.")
    parser.add_argument("--service", required=True, help="Service or frontend app name.")
    parser.add_argument("--minified-path-prefix", required=True, help="Public URL or path prefix for minified JS assets.")
    parser.add_argument("--repository-url", help="Optional app-owned source repository URL.")
    parser.add_argument("--commit-sha", help="Optional app-owned commit SHA for source links.")
    parser.add_argument(
        "--allow-sources-content",
        action="store_true",
        help="Permit source maps that embed sourcesContent. Defaults to blocking them as sensitive.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        manifest = create_manifest(
            build_dir=args.build_dir,
            release=args.release,
            environment=args.environment,
            service=args.service,
            minified_path_prefix=args.minified_path_prefix,
            allow_sources_content=args.allow_sources_content,
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
