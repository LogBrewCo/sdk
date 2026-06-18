#!/usr/bin/env python3
"""Verify a minified JavaScript frame resolves through a prepared source map."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from create_js_release_artifact_manifest import file_reference, safe_resolve  # noqa: E402
from release_artifact_upload_common import read_manifest  # noqa: E402


SCRIPT_VERSION = "0.1.0"
BASE64_VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
BASE64_VLQ_VALUES = {char: index for index, char in enumerate(BASE64_VLQ_CHARS)}


class SymbolicationValidationError(ValueError):
    pass


def decode_vlq_values(segment: str) -> list[int]:
    values: list[int] = []
    value = 0
    shift = 0
    for char in segment:
        if char not in BASE64_VLQ_VALUES:
            raise SymbolicationValidationError("source map mappings contain an invalid base64 VLQ character")
        digit = BASE64_VLQ_VALUES[char]
        continuation = digit & 32
        digit_value = digit & 31
        value += digit_value << shift
        if continuation:
            shift += 5
            continue

        sign = -1 if value & 1 else 1
        values.append(sign * (value >> 1))
        value = 0
        shift = 0

    if shift:
        raise SymbolicationValidationError("source map mappings contain an unterminated base64 VLQ value")
    return values


def decoded_mapping_segments(mappings: str) -> list[list[tuple[int, int | None, int | None, int | None, int | None]]]:
    lines: list[list[tuple[int, int | None, int | None, int | None, int | None]]] = []
    previous_source = 0
    previous_original_line = 0
    previous_original_column = 0
    previous_name = 0

    for raw_line in mappings.split(";"):
        generated_column = 0
        line_segments: list[tuple[int, int | None, int | None, int | None, int | None]] = []
        if raw_line:
            for raw_segment in raw_line.split(","):
                if not raw_segment:
                    continue
                values = decode_vlq_values(raw_segment)
                if len(values) not in {1, 4, 5}:
                    raise SymbolicationValidationError("source map segment must contain 1, 4, or 5 VLQ fields")
                generated_column += values[0]
                if len(values) == 1:
                    line_segments.append((generated_column, None, None, None, None))
                    continue
                previous_source += values[1]
                previous_original_line += values[2]
                previous_original_column += values[3]
                name_index: int | None = None
                if len(values) == 5:
                    previous_name += values[4]
                    name_index = previous_name
                line_segments.append(
                    (
                        generated_column,
                        previous_source,
                        previous_original_line,
                        previous_original_column,
                        name_index,
                    )
                )
        lines.append(line_segments)
    return lines


def parse_stack_frame(stack_line: str) -> dict[str, Any]:
    line = stack_line.strip()
    if line.startswith("at "):
        line = line[3:].strip()

    function_name: str | None = None
    location = line
    if line.endswith(")") and " (" in line:
        function_name, location = line.rsplit(" (", 1)
        location = location[:-1]

    try:
        filename, lineno, colno = location.rsplit(":", 2)
    except ValueError as exc:
        raise SymbolicationValidationError("stack frame must end with :line:column") from exc

    try:
        generated_line = int(lineno, 10)
        generated_column = int(colno, 10)
    except ValueError as exc:
        raise SymbolicationValidationError("stack frame line and column must be integers") from exc
    if generated_line < 1 or generated_column < 1:
        raise SymbolicationValidationError("stack frame line and column must be one-based positive integers")

    return {
        "function": function_name,
        "filename": filename,
        "line": generated_line,
        "column": generated_column,
    }


def normalize_reference(value: str) -> str:
    normalized = file_reference(value.strip())
    if normalized.startswith("file://"):
        normalized = normalized[7:]
    return normalized


def artifact_matches_frame(artifact: dict[str, Any], frame_filename: str, build_dir: Path) -> bool:
    minified = artifact.get("minifiedSource")
    if not isinstance(minified, dict):
        return False
    artifact_path = str(minified.get("path", ""))
    artifact_url = str(minified.get("minifiedUrl", ""))
    normalized_frame = normalize_reference(frame_filename)

    if normalized_frame == normalize_reference(artifact_url):
        return True
    if normalized_frame.strip("/") == artifact_path.strip("/"):
        return True

    local_frame = Path(normalized_frame)
    if local_frame.is_absolute():
        resolved = safe_resolve(local_frame, build_dir)
        if resolved is not None:
            return resolved.relative_to(build_dir).as_posix() == artifact_path

    return False


def require_ready_manifest(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    if manifest.get("artifactType") != "javascript_source_map_manifest":
        raise SymbolicationValidationError("only javascript_source_map_manifest symbolication proof is supported")
    validation = manifest.get("validation")
    if not isinstance(validation, dict) or validation.get("status") != "ready":
        raise SymbolicationValidationError("manifest validation status must be ready")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise SymbolicationValidationError("manifest must contain at least one JavaScript source-map artifact")
    ready_artifacts: list[dict[str, Any]] = []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise SymbolicationValidationError("artifact entries must be JSON objects")
        artifact_validation = artifact.get("validation")
        if not isinstance(artifact_validation, dict) or artifact_validation.get("status") != "ready":
            raise SymbolicationValidationError("all artifact validation statuses must be ready")
        ready_artifacts.append(artifact)
    return ready_artifacts


def find_matching_artifact(manifest: dict[str, Any], frame: dict[str, Any], build_dir: Path) -> dict[str, Any]:
    for artifact in require_ready_manifest(manifest):
        if artifact_matches_frame(artifact, str(frame["filename"]), build_dir):
            return artifact
    raise SymbolicationValidationError("no manifest artifact matches the minified stack frame filename")


def load_source_map(artifact: dict[str, Any], build_dir: Path) -> dict[str, Any]:
    source_map = artifact.get("sourceMap")
    if not isinstance(source_map, dict) or not source_map.get("path"):
        raise SymbolicationValidationError("matched artifact is missing source map metadata")
    source_map_path = safe_resolve(build_dir / str(source_map["path"]), build_dir)
    if source_map_path is None:
        raise SymbolicationValidationError("source map path resolves outside the build directory")
    payload = read_manifest(source_map_path)
    if "sourcesContent" in payload:
        raise SymbolicationValidationError("source map still contains sourcesContent; strip it before symbolication proof")
    artifact_debug_id = artifact.get("debugId")
    map_debug_id = payload.get("debug_id") or payload.get("debugId") or payload.get("debugID") or payload.get("x_debug_id")
    if artifact_debug_id and map_debug_id and artifact_debug_id != map_debug_id:
        raise SymbolicationValidationError("matched artifact debug ID does not match source map debug ID")
    if not isinstance(payload.get("sources"), list) or not payload["sources"]:
        raise SymbolicationValidationError("source map sources must be a non-empty array")
    if not isinstance(payload.get("mappings"), str) or not payload["mappings"]:
        raise SymbolicationValidationError("source map mappings must be a non-empty string")
    return payload


def original_position_for(payload: dict[str, Any], generated_line: int, generated_column: int) -> dict[str, Any]:
    generated_line_index = generated_line - 1
    generated_column_index = generated_column - 1
    lines = decoded_mapping_segments(str(payload["mappings"]))
    if generated_line_index >= len(lines):
        raise SymbolicationValidationError("generated line is outside source map mappings")

    best_segment: tuple[int, int | None, int | None, int | None, int | None] | None = None
    for segment in lines[generated_line_index]:
        if segment[0] <= generated_column_index:
            best_segment = segment
        else:
            break
    if best_segment is None or best_segment[1] is None or best_segment[2] is None or best_segment[3] is None:
        raise SymbolicationValidationError("no original source mapping found for generated frame")

    sources = payload["sources"]
    source_index = best_segment[1]
    if not isinstance(source_index, int) or source_index < 0 or source_index >= len(sources):
        raise SymbolicationValidationError("source map segment references an invalid source index")
    source = safe_original_source_for_report(sources[source_index])
    if not source:
        raise SymbolicationValidationError("source map segment references an invalid source value")

    name: str | None = None
    names = payload.get("names")
    name_index = best_segment[4]
    if isinstance(names, list) and isinstance(name_index, int) and 0 <= name_index < len(names):
        candidate = names[name_index]
        if isinstance(candidate, str) and candidate:
            name = candidate

    return {
        "source": source,
        "line": best_segment[2] + 1,
        "column": best_segment[3] + 1,
        **({"name": name} if name else {}),
    }


def safe_original_source_for_report(source: Any) -> str:
    if not isinstance(source, str):
        raise SymbolicationValidationError("source map segment references an invalid source value")
    value = file_reference(source.strip())
    if not value:
        raise SymbolicationValidationError("source map segment references an invalid source value")
    parsed = urlsplit(value)
    if parsed.scheme.lower() == "file":
        raise SymbolicationValidationError("source map source path must be stripped before symbolication proof")
    if Path(value).is_absolute() or re.match(r"^[A-Za-z]:[\\/]", value):
        raise SymbolicationValidationError("source map source path must be stripped before symbolication proof")
    return value


def verify_symbolication(build_dir: Path, manifest: dict[str, Any], stack_frame: str) -> dict[str, Any]:
    build_dir = build_dir.resolve()
    if not build_dir.is_dir():
        raise SymbolicationValidationError(f"build directory does not exist: {build_dir}")
    frame = parse_stack_frame(stack_frame)
    artifact = find_matching_artifact(manifest, frame, build_dir)
    source_map = load_source_map(artifact, build_dir)
    original = original_position_for(source_map, int(frame["line"]), int(frame["column"]))
    minified = artifact["minifiedSource"]
    source_map_entry = artifact["sourceMap"]
    return {
        "status": "resolved",
        "verifier": {"name": "logbrew-js-release-artifact-symbolication-verifier", "version": SCRIPT_VERSION},
        "release": manifest.get("release"),
        "environment": manifest.get("environment"),
        "service": manifest.get("service"),
        "debugId": artifact.get("debugId"),
        "generated": {
            "path": minified.get("path"),
            "minifiedUrl": minified.get("minifiedUrl"),
            "line": frame["line"],
            "column": frame["column"],
            **({"function": frame["function"]} if frame.get("function") else {}),
        },
        "sourceMap": {
            "path": source_map_entry.get("path"),
            "hasSourcesContent": False,
        },
        "original": original,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Resolve one minified JavaScript stack frame through a ready LogBrew source-map manifest.",
    )
    parser.add_argument("--build-dir", required=True, type=Path, help="Directory containing prepared build artifacts.")
    parser.add_argument("--manifest", required=True, type=Path, help="Ready JavaScript release-artifact manifest JSON.")
    parser.add_argument("--stack-frame", required=True, help="One generated stack frame ending in :line:column.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        manifest = read_manifest(args.manifest)
        report = verify_symbolication(args.build_dir, manifest, args.stack_frame)
    except (OSError, ValueError) as exc:
        print(
            json.dumps(
                {
                    "status": "validation_failed",
                    "validation": {"errors": [str(exc)]},
                    "verifier": {
                        "name": "logbrew-js-release-artifact-symbolication-verifier",
                        "version": SCRIPT_VERSION,
                    },
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 1

    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
