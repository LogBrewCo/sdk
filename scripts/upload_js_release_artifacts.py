#!/usr/bin/env python3
"""Upload JavaScript release artifacts to a loopback fake intake.

This is a transport verifier for SDK release-artifact readiness. It is
intentionally loopback-only until the backend-owned upload contract exists.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


SCRIPT_VERSION = "0.1.0"
DEFAULT_TOKEN_ENV = "LOGBREW_RELEASE_ARTIFACT_TOKEN"
AUTH_FAILURE_STATUSES = {401, 403}
NON_RETRYABLE_STATUSES = {400, 401, 403, 413}
RETRYABLE_STATUSES = {408, 429}


class UploadValidationError(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def byte_size(path: Path) -> int:
    return path.stat().st_size


def safe_resolve(candidate: Path, root: Path) -> Path | None:
    try:
        resolved = candidate.resolve()
        resolved.relative_to(root.resolve())
        return resolved
    except ValueError:
        return None


def endpoint_without_query(endpoint: str) -> str:
    parsed = urlsplit(endpoint)
    port = f":{parsed.port}" if parsed.port is not None else ""
    netloc = f"{parsed.hostname or ''}{port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path or "/", "", ""))


def is_loopback_endpoint(endpoint: str) -> bool:
    parsed = urlsplit(endpoint)
    if parsed.scheme not in {"http", "https"}:
        return False
    hostname = parsed.hostname
    if not hostname:
        return False
    normalized = hostname.lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def require_loopback_endpoint(endpoint: str) -> None:
    if not is_loopback_endpoint(endpoint):
        raise UploadValidationError(
            "release artifact upload proof endpoint must be loopback-only until the backend upload contract exists"
        )


def read_manifest(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise UploadValidationError(f"manifest is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise UploadValidationError("manifest must be a JSON object")
    return payload


def require_ready_js_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("artifactType") != "javascript_source_map_manifest":
        raise UploadValidationError("only javascript_source_map_manifest uploads are supported by this verifier")
    validation = manifest.get("validation")
    if not isinstance(validation, dict) or validation.get("status") != "ready":
        raise UploadValidationError("manifest validation status must be ready before upload")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise UploadValidationError("manifest must contain at least one JavaScript release artifact")


def require_artifact_file(
    artifact: dict[str, Any],
    build_dir: Path,
    section: str,
    required_fields: tuple[str, ...],
) -> Path:
    payload = artifact.get(section)
    if not isinstance(payload, dict):
        raise UploadValidationError(f"artifact is missing {section}")
    for field in required_fields:
        if payload.get(field) in (None, ""):
            raise UploadValidationError(f"{section} is missing {field}")
    path = safe_resolve(build_dir / str(payload["path"]), build_dir)
    if path is None:
        raise UploadValidationError(f"{section} path resolves outside the build directory")
    if not path.is_file():
        raise UploadValidationError(f"{section} file is missing: {payload['path']}")
    expected_size = int(payload["byteSize"])
    if byte_size(path) != expected_size:
        raise UploadValidationError(f"{section} byte size changed after manifest creation: {payload['path']}")
    expected_sha = str(payload["artifactSha256"])
    if sha256_file(path) != expected_sha:
        raise UploadValidationError(f"{section} sha256 changed after manifest creation: {payload['path']}")
    return path


def collect_artifact_files(manifest: dict[str, Any], build_dir: Path) -> list[tuple[str, Path]]:
    require_ready_js_manifest(manifest)
    files: list[tuple[str, Path]] = []
    for index, artifact in enumerate(manifest["artifacts"]):
        if not isinstance(artifact, dict):
            raise UploadValidationError("artifact entries must be JSON objects")
        minified = require_artifact_file(
            artifact,
            build_dir,
            "minifiedSource",
            ("path", "artifactSha256", "byteSize"),
        )
        source_map = require_artifact_file(
            artifact,
            build_dir,
            "sourceMap",
            ("path", "artifactSha256", "byteSize"),
        )
        files.append((f"minified_source_{index}", minified))
        files.append((f"source_map_{index}", source_map))
    return files


def quote_multipart_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def encode_multipart(
    manifest: dict[str, Any],
    files: list[tuple[str, Path]],
) -> tuple[bytes, str]:
    boundary = f"logbrew-{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    def append_field(name: str, filename: str, content_type: str, data: bytes) -> None:
        chunks.append(f"--{boundary}\r\n".encode("ascii"))
        chunks.append(
            (
                f'Content-Disposition: form-data; name="{quote_multipart_value(name)}"; '
                f'filename="{quote_multipart_value(filename)}"\r\n'
            ).encode("utf-8")
        )
        chunks.append(f"Content-Type: {content_type}\r\n\r\n".encode("ascii"))
        chunks.append(data)
        chunks.append(b"\r\n")

    manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    append_field("manifest", "manifest.json", "application/json", manifest_bytes)
    for name, path in files:
        append_field(name, path.name, "application/octet-stream", path.read_bytes())
    chunks.append(f"--{boundary}--\r\n".encode("ascii"))
    return b"".join(chunks), boundary


def classify_http_status(status: int) -> str:
    if 200 <= status < 300:
        return "uploaded"
    if status in AUTH_FAILURE_STATUSES:
        return "auth_failed"
    if status in NON_RETRYABLE_STATUSES:
        return "validation_failed"
    if status in RETRYABLE_STATUSES or status >= 500:
        return "retryable_error"
    return "upload_failed"


def post_multipart(endpoint: str, token: str, body: bytes, boundary: str, timeout_seconds: float) -> int:
    request = Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": f"logbrew-release-artifact-verifier/{SCRIPT_VERSION}",
        },
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            response.read(1024)
            return int(response.status)
    except HTTPError as exc:
        exc.read(1024)
        return int(exc.code)


def upload_with_retries(
    *,
    endpoint: str,
    token: str,
    body: bytes,
    boundary: str,
    max_retries: int,
    retry_delay_seconds: float,
    timeout_seconds: float,
) -> dict[str, Any]:
    attempts: list[dict[str, Any]] = []
    for attempt in range(1, max_retries + 2):
        try:
            http_status = post_multipart(endpoint, token, body, boundary, timeout_seconds)
            result = classify_http_status(http_status)
            attempts.append({"attempt": attempt, "httpStatus": http_status, "result": result})
        except URLError:
            result = "retryable_error"
            attempts.append({"attempt": attempt, "result": result})

        if result == "uploaded":
            break
        if result != "retryable_error" or attempt > max_retries:
            break
        if retry_delay_seconds > 0:
            time.sleep(retry_delay_seconds)

    final_result = attempts[-1]["result"]
    return {
        "status": final_result,
        "attempts": attempts,
        "retryCount": max(0, len(attempts) - 1),
    }


def build_report(
    *,
    endpoint: str,
    manifest: dict[str, Any],
    files: list[tuple[str, Path]],
    dry_run: bool,
) -> dict[str, Any]:
    return {
        "uploader": {"name": "logbrew-js-release-artifact-upload-verifier", "version": SCRIPT_VERSION},
        "endpoint": endpoint_without_query(endpoint),
        "dryRun": dry_run,
        "release": manifest.get("release"),
        "environment": manifest.get("environment"),
        "service": manifest.get("service"),
        "artifactType": manifest.get("artifactType"),
        "artifactCount": len(manifest.get("artifacts", [])),
        "filePartCount": len(files),
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
            "Upload a ready JavaScript release-artifact manifest and its local files to a loopback fake intake. "
            "This verifier does not claim backend release-artifact support."
        )
    )
    parser.add_argument("--build-dir", required=True, type=Path, help="Directory used to create the manifest.")
    parser.add_argument("--manifest", required=True, type=Path, help="Ready JavaScript release-artifact manifest JSON.")
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
        build_dir = args.build_dir.resolve()
        if not build_dir.is_dir():
            raise UploadValidationError(f"build directory does not exist: {build_dir}")
        manifest = read_manifest(args.manifest)
        files = collect_artifact_files(manifest, build_dir)
        report = build_report(endpoint=args.endpoint, manifest=manifest, files=files, dry_run=args.dry_run)
    except UploadValidationError as exc:
        print(
            json.dumps(
                {
                    "status": "validation_failed",
                    "validation": {"errors": [str(exc)]},
                    "uploader": {"name": "logbrew-js-release-artifact-upload-verifier", "version": SCRIPT_VERSION},
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
