"""Shared helpers for release-artifact upload verifiers."""

from __future__ import annotations

import hashlib
import ipaddress
import json
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
            "release artifact upload proof endpoint must be loopback-only unless the verifier exposes explicit hosted upload opt-in"
        )


def require_upload_endpoint(endpoint: str, *, allow_hosted: bool = False) -> None:
    if is_loopback_endpoint(endpoint):
        return
    parsed = urlsplit(endpoint)
    if not allow_hosted:
        raise UploadValidationError(
            "release artifact hosted upload requires explicit --allow-hosted; use loopback endpoints for local proof"
        )
    if parsed.scheme != "https":
        raise UploadValidationError("hosted release artifact upload endpoints must use https")
    if not parsed.hostname:
        raise UploadValidationError("hosted release artifact upload endpoint must include a hostname")
    if parsed.username or parsed.password:
        raise UploadValidationError("hosted release artifact upload endpoints must not include embedded auth values")
    if parsed.query or parsed.fragment:
        raise UploadValidationError("hosted release artifact upload endpoints must not include query strings or fragments")


def read_manifest(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise UploadValidationError(f"manifest is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise UploadValidationError("manifest must be a JSON object")
    return payload


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
