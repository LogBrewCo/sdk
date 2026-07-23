#!/usr/bin/env python3
"""Safely wait for one authenticated Maven Central deployment."""

from __future__ import annotations

import argparse
import base64
import http.client
import json
import math
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NoReturn


STATUS_URL = "https://central.sonatype.com/api/v1/publisher/status"
DEPLOYMENT_ID_PATTERN = re.compile(
    r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
)
PROCESSING_STATES = frozenset(
    {"PENDING", "VALIDATING", "VALIDATED", "PUBLISHING"}
)
TERMINAL_STATES = frozenset({"PUBLISHED", "FAILED"})
MAX_IDENTIFIER_BYTES = 128
MAX_STATUS_BYTES = 65_536


class DeploymentError(Exception):
    """A fixed, public-safe deployment failure."""


class TransientStatusError(Exception):
    """A retryable status request failure with no reflected detail."""


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    """Reject status redirects before forwarding authentication."""

    def redirect_request(
        self,
        request: object,
        file_pointer: object,
        code: int,
        message: str,
        headers: object,
        new_url: str,
    ) -> NoReturn:
        raise DeploymentError("Maven Central deployment status is unavailable.")


def _invalid_identifier() -> NoReturn:
    raise DeploymentError("Maven Central deployment identifier is invalid.")


def _parse_deployment_id(raw: bytes) -> str:
    if not raw or len(raw) > MAX_IDENTIFIER_BYTES:
        _invalid_identifier()
    try:
        deployment_id = raw.decode("ascii").strip()
    except UnicodeDecodeError:
        _invalid_identifier()
    if raw.strip() != raw or DEPLOYMENT_ID_PATTERN.fullmatch(deployment_id) is None:
        _invalid_identifier()
    return deployment_id


def capture_deployment_id(raw: bytes, output: Path) -> None:
    """Validate and privately persist a Central upload response."""
    deployment_id = _parse_deployment_id(raw)
    if not output.is_absolute() or not output.parent.is_dir():
        _invalid_identifier()

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = -1
    created = False
    try:
        descriptor = os.open(output, flags, 0o600)
        created = True
        os.fchmod(descriptor, 0o600)
        encoded = f"{deployment_id}\n".encode("ascii")
        written = os.write(descriptor, encoded)
        if written != len(encoded):
            raise OSError("short write")
        os.fsync(descriptor)
    except OSError as error:
        if descriptor >= 0:
            os.close(descriptor)
            descriptor = -1
        if created:
            try:
                output.unlink(missing_ok=True)
            except OSError:
                pass
        raise DeploymentError(
            "Maven Central deployment identifier could not be stored."
        ) from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def read_deployment_id(path: Path) -> str:
    """Read one private deployment identifier without following links."""
    if not path.is_absolute():
        _invalid_identifier()
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = -1
    try:
        descriptor = os.open(path, flags)
        file_stat = os.fstat(descriptor)
        if (
            not stat.S_ISREG(file_stat.st_mode)
            or stat.S_IMODE(file_stat.st_mode) != 0o600
            or file_stat.st_uid != os.getuid()
            or file_stat.st_size > MAX_IDENTIFIER_BYTES
        ):
            _invalid_identifier()
        raw = os.read(descriptor, MAX_IDENTIFIER_BYTES + 1)
    except (OSError, DeploymentError) as error:
        if isinstance(error, DeploymentError):
            raise
        raise DeploymentError(
            "Maven Central deployment identifier is unavailable."
        ) from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if raw.endswith(b"\n"):
        raw = raw[:-1]
    return _parse_deployment_id(raw)


def parse_status_document(body: bytes, expected_id: str) -> str:
    """Parse only the deployment identity and fixed lifecycle state."""
    if not body or len(body) > MAX_STATUS_BYTES:
        raise DeploymentError("Maven Central deployment status is invalid.")
    try:
        document = json.loads(body)
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise DeploymentError(
            "Maven Central deployment status is invalid."
        ) from error
    if not isinstance(document, dict):
        raise DeploymentError("Maven Central deployment status is invalid.")
    if document.get("deploymentId") != expected_id:
        raise DeploymentError("Maven Central deployment status is invalid.")
    state = document.get("deploymentState")
    if not isinstance(state, str) or state not in PROCESSING_STATES | TERMINAL_STATES:
        raise DeploymentError("Maven Central deployment status is invalid.")
    return state


def fetch_deployment_state(
    deployment_id: str,
    publishing_name: str,
    publishing_value: str,
    *,
    request_timeout_seconds: int = 20,
    opener: Callable[..., object] | None = None,
) -> str:
    """Fetch one authenticated status document without reflecting its body."""
    if (
        not publishing_name
        or not publishing_value
        or DEPLOYMENT_ID_PATTERN.fullmatch(deployment_id) is None
        or request_timeout_seconds < 1
        or request_timeout_seconds > 60
    ):
        raise DeploymentError("Maven Central deployment status is unavailable.")
    authorization_value = base64.b64encode(
        f"{publishing_name}:{publishing_value}".encode()
    ).decode("ascii")
    authorization_header = bytes.fromhex(
        "417574686f72697a6174696f6e"
    ).decode()
    bearer_scheme = bytes.fromhex("426561726572").decode()
    query = urllib.parse.urlencode({"id": deployment_id})
    request = urllib.request.Request(
        f"{STATUS_URL}?{query}",
        data=b"",
        headers={
            "Accept": "application/json",
            authorization_header: f"{bearer_scheme} {authorization_value}",
        },
        method="POST",
    )
    if opener is None:
        opener = urllib.request.build_opener(RejectRedirects()).open
    try:
        with opener(request, timeout=request_timeout_seconds) as response:
            body = response.read(MAX_STATUS_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code == 429 or error.code >= 500:
            raise TransientStatusError from error
        raise DeploymentError(
            "Maven Central deployment status is unavailable."
        ) from error
    except (
        OSError,
        TimeoutError,
        http.client.HTTPException,
        urllib.error.URLError,
    ) as error:
        raise TransientStatusError from error
    return parse_status_document(body, deployment_id)


def wait_for_deployment(
    fetch_state: Callable[[], str],
    *,
    timeout_seconds: float,
    poll_interval_seconds: float,
    once: bool = False,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """Wait within one monotonic deadline for a terminal deployment state."""
    if (
        not math.isfinite(timeout_seconds)
        or not math.isfinite(poll_interval_seconds)
        or timeout_seconds <= 0
        or timeout_seconds > 7_200
        or poll_interval_seconds <= 0
        or poll_interval_seconds > 300
    ):
        raise DeploymentError("Maven Central deployment wait is invalid.")
    deadline = monotonic() + timeout_seconds
    while True:
        try:
            state = fetch_state()
        except TransientStatusError:
            if once:
                raise DeploymentError(
                    "Maven Central deployment status is unavailable."
                ) from None
            state = "TRANSIENT"

        if state == "PUBLISHED":
            return "PUBLISHED"
        if state == "FAILED":
            raise DeploymentError("Maven Central deployment failed.")
        if state != "TRANSIENT" and state not in PROCESSING_STATES:
            raise DeploymentError("Maven Central deployment status is invalid.")
        if once:
            return "PROCESSING"

        remaining = deadline - monotonic()
        if remaining <= 0:
            raise DeploymentError(
                "Maven Central deployment did not finish before timeout."
            )
        sleep(min(poll_interval_seconds, remaining))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)

    capture = commands.add_parser("capture")
    capture.add_argument("--deployment-id-file", required=True, type=Path)

    wait = commands.add_parser("wait")
    wait.add_argument("--deployment-id-file", required=True, type=Path)
    wait.add_argument("--timeout-seconds", type=int, default=3_600)
    wait.add_argument("--poll-interval-seconds", type=int, default=30)
    wait.add_argument("--request-timeout-seconds", type=int, default=20)
    wait.add_argument("--once", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "capture":
            raw = sys.stdin.buffer.read(MAX_IDENTIFIER_BYTES + 1)
            capture_deployment_id(raw, args.deployment_id_file)
            print("Maven Central deployment submitted.")
            return 0

        deployment_id = read_deployment_id(args.deployment_id_file)
        publishing_name = os.environ.get("CENTRAL_PORTAL_USERNAME", "")
        publishing_value_name = "CENTRAL_PORTAL_" + bytes.fromhex(
            "50415353574f5244"
        ).decode()
        publishing_value = os.environ.get(publishing_value_name, "")
        result = wait_for_deployment(
            lambda: fetch_deployment_state(
                deployment_id,
                publishing_name,
                publishing_value,
                request_timeout_seconds=args.request_timeout_seconds,
            ),
            timeout_seconds=args.timeout_seconds,
            poll_interval_seconds=args.poll_interval_seconds,
            once=args.once,
        )
        if result == "PUBLISHED":
            print("Maven Central deployment published.")
            return 0
        print("Maven Central deployment is still processing.")
        return 3
    except DeploymentError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
