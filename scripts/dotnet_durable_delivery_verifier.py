#!/usr/bin/env python3

from __future__ import annotations

import os
import socketserver
import stat
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable
from enum import Enum
from http.server import BaseHTTPRequestHandler
from pathlib import Path, PureWindowsPath


class AdmissionOutcome(Enum):
    RUNTIME_VALIDATION_TIMEOUT = "admission runtime validation timeout"
    DURABLE_CLIENT_CREATION_TIMEOUT = "admission durable client creation timeout"
    FIRST_ADMISSION_TIMEOUT = "admission first persistence timeout"
    SECOND_ADMISSION_TIMEOUT = "admission second persistence timeout"
    RETRY_OBSERVATION_TIMEOUT = "admission retry observation timeout"
    PENDING_VERIFICATION_TIMEOUT = "admission pending verification timeout"
    REQUEST_TIMEOUT = "admission request timeout"
    SPONTANEOUS_EXIT_AFTER_NONE = "admission spontaneous exit after none"
    SPONTANEOUS_EXIT_AFTER_RUNTIME_VALIDATED = "admission spontaneous exit after runtime-validated"
    SPONTANEOUS_EXIT_AFTER_DURABLE_CLIENT_CREATED = "admission spontaneous exit after durable-client-created"
    SPONTANEOUS_EXIT_AFTER_FIRST_ADMISSION_PERSISTED = "admission spontaneous exit after first-admission-persisted"
    SPONTANEOUS_EXIT_AFTER_SECOND_ADMISSION_PERSISTED = "admission spontaneous exit after second-admission-persisted"
    SPONTANEOUS_EXIT_AFTER_RETRY_OBSERVED = "admission spontaneous exit after retry-observed"
    SPONTANEOUS_EXIT_AFTER_PENDING_VERIFIED = "admission spontaneous exit after pending-verified"
    KILL_REQUEST_FAILED = "admission kill request failed"
    ZERO_EXIT = "admission zero exit"
    EXPECTED_NONZERO_EXIT = "admission expected nonzero exit"
    REAP_FAILED = "admission reap failed"
    WITNESS_INVALID_INVENTORY = "admission witness invalid: inventory"
    WITNESS_INVALID_COMMITTED = "admission witness invalid: committed"
    WITNESS_INVALID_PUBLICATION = "admission witness invalid: publication"
    WITNESS_INVALID_SUPERVISOR = "admission witness invalid: supervisor"
    DURABLE_CLIENT_VALIDATION_FAILURE = "admission durable client creation failed: validation"
    DURABLE_CLIENT_CONFIGURATION_FAILURE = "admission durable client creation failed: configuration"
    DURABLE_CLIENT_STORAGE_FAILURE = "admission durable client creation failed: storage"
    DURABLE_CLIENT_STATE_FAILURE = "admission durable client creation failed: state"
    DURABLE_CLIENT_UNKNOWN_SDK_FAILURE = "admission durable client creation failed: sdk-unknown"
    DURABLE_CLIENT_NON_SDK_FAILURE = "admission durable client creation failed: non-sdk"
    SPONTANEOUS_EXIT_AFTER_LINUX_PREFLIGHT = "admission spontaneous exit after linux-storage-preflight-passed"
    LINUX_PREFLIGHT_NATIVE_BIND_FAILURE = "admission linux storage preflight failed: native-bind"
    LINUX_PREFLIGHT_PARENT_OPEN_MISSING = "admission linux storage preflight failed: parent-open-missing"
    LINUX_PREFLIGHT_PARENT_OPEN_DENIED = "admission linux storage preflight failed: parent-open-denied"
    LINUX_PREFLIGHT_PARENT_OPEN_INVALID = "admission linux storage preflight failed: parent-open-invalid"
    LINUX_PREFLIGHT_PARENT_OPEN_OTHER = "admission linux storage preflight failed: parent-open-other"
    LINUX_PREFLIGHT_PARENT_STATX_FAILURE = "admission linux storage preflight failed: parent-statx"
    LINUX_PREFLIGHT_CHILD_OPEN_FAILURE = "admission linux storage preflight failed: child-mkdir-open"
    LINUX_PREFLIGHT_CHILD_STATX_FAILURE = "admission linux storage preflight failed: child-statx"
    LINUX_PREFLIGHT_OWNER_OPEN_FAILURE = "admission linux storage preflight failed: owner-create-open"
    LINUX_PREFLIGHT_OWNER_STATX_FAILURE = "admission linux storage preflight failed: owner-statx-mode"
    LINUX_PREFLIGHT_OWNER_LOCK_FAILURE = "admission linux storage preflight failed: owner-lock"
    LINUX_PREFLIGHT_ROOT_REMOVE_FAILURE = "admission linux storage preflight failed: root-remove"


APP_WITNESS_STAGES = (
    ("runtime-validated", AdmissionOutcome.RUNTIME_VALIDATION_TIMEOUT),
    ("durable-client-created", AdmissionOutcome.DURABLE_CLIENT_CREATION_TIMEOUT),
    ("first-admission-persisted", AdmissionOutcome.FIRST_ADMISSION_TIMEOUT),
    ("second-admission-persisted", AdmissionOutcome.SECOND_ADMISSION_TIMEOUT),
    ("retry-observed", AdmissionOutcome.RETRY_OBSERVATION_TIMEOUT),
    ("pending-verified", AdmissionOutcome.PENDING_VERIFICATION_TIMEOUT),
)
RECOVERY_WITNESS_STAGES = (
    "recovery-runtime-validated",
    "recovery-client-created",
    "recovery-accepted",
    "recovery-pending-empty",
    "recovery-health-ready",
    "recovery-shutdown-complete",
)
RECOVERY_FAILURE_STAGES = frozenset(
    {
        "recovery-failed-storage",
        "recovery-failed-terminal",
        "recovery-failed-retry-exhausted",
        "recovery-failed-retry-scheduled",
        "recovery-failed-in-flight",
        "recovery-failed-scheduled",
        "recovery-failed-idle",
    }
)
SUPERVISOR_WITNESS_STAGES = ("external-kill-requested", "post-kill-reaped")
CREATION_FAILURE_STAGES = {
    "durable-client-failed-validation": AdmissionOutcome.DURABLE_CLIENT_VALIDATION_FAILURE,
    "durable-client-failed-configuration": AdmissionOutcome.DURABLE_CLIENT_CONFIGURATION_FAILURE,
    "durable-client-failed-storage": AdmissionOutcome.DURABLE_CLIENT_STORAGE_FAILURE,
    "durable-client-failed-state": AdmissionOutcome.DURABLE_CLIENT_STATE_FAILURE,
    "durable-client-failed-sdk-unknown": AdmissionOutcome.DURABLE_CLIENT_UNKNOWN_SDK_FAILURE,
    "durable-client-failed-non-sdk": AdmissionOutcome.DURABLE_CLIENT_NON_SDK_FAILURE,
}
LINUX_PREFLIGHT_PASSED_STAGE = "linux-storage-preflight-passed"
LINUX_PREFLIGHT_FAILURE_STAGES = {
    "linux-storage-preflight-failed-native-bind": AdmissionOutcome.LINUX_PREFLIGHT_NATIVE_BIND_FAILURE,
    "linux-storage-preflight-failed-parent-open-missing": AdmissionOutcome.LINUX_PREFLIGHT_PARENT_OPEN_MISSING,
    "linux-storage-preflight-failed-parent-open-denied": AdmissionOutcome.LINUX_PREFLIGHT_PARENT_OPEN_DENIED,
    "linux-storage-preflight-failed-parent-open-invalid": AdmissionOutcome.LINUX_PREFLIGHT_PARENT_OPEN_INVALID,
    "linux-storage-preflight-failed-parent-open-other": AdmissionOutcome.LINUX_PREFLIGHT_PARENT_OPEN_OTHER,
    "linux-storage-preflight-failed-parent-statx": AdmissionOutcome.LINUX_PREFLIGHT_PARENT_STATX_FAILURE,
    "linux-storage-preflight-failed-child-mkdir-open": AdmissionOutcome.LINUX_PREFLIGHT_CHILD_OPEN_FAILURE,
    "linux-storage-preflight-failed-child-statx": AdmissionOutcome.LINUX_PREFLIGHT_CHILD_STATX_FAILURE,
    "linux-storage-preflight-failed-owner-create-open": AdmissionOutcome.LINUX_PREFLIGHT_OWNER_OPEN_FAILURE,
    "linux-storage-preflight-failed-owner-statx-mode": AdmissionOutcome.LINUX_PREFLIGHT_OWNER_STATX_FAILURE,
    "linux-storage-preflight-failed-owner-lock": AdmissionOutcome.LINUX_PREFLIGHT_OWNER_LOCK_FAILURE,
    "linux-storage-preflight-failed-root-remove": AdmissionOutcome.LINUX_PREFLIGHT_ROOT_REMOVE_FAILURE,
}
WITNESS_TEMPORARY_NAME = ".stage.tmp"
WITNESS_VALUE = b"observed"
SPONTANEOUS_EXIT_OUTCOMES = {
    None: AdmissionOutcome.SPONTANEOUS_EXIT_AFTER_NONE,
    "runtime-validated": AdmissionOutcome.SPONTANEOUS_EXIT_AFTER_RUNTIME_VALIDATED,
    "durable-client-created": (AdmissionOutcome.SPONTANEOUS_EXIT_AFTER_DURABLE_CLIENT_CREATED),
    "first-admission-persisted": (AdmissionOutcome.SPONTANEOUS_EXIT_AFTER_FIRST_ADMISSION_PERSISTED),
    "second-admission-persisted": (AdmissionOutcome.SPONTANEOUS_EXIT_AFTER_SECOND_ADMISSION_PERSISTED),
    "retry-observed": AdmissionOutcome.SPONTANEOUS_EXIT_AFTER_RETRY_OBSERVED,
    "pending-verified": AdmissionOutcome.SPONTANEOUS_EXIT_AFTER_PENDING_VERIFIED,
    LINUX_PREFLIGHT_PASSED_STAGE: AdmissionOutcome.SPONTANEOUS_EXIT_AFTER_LINUX_PREFLIGHT,
}
WITNESS_INVALID_OUTCOMES = frozenset(
    {
        AdmissionOutcome.WITNESS_INVALID_INVENTORY,
        AdmissionOutcome.WITNESS_INVALID_COMMITTED,
        AdmissionOutcome.WITNESS_INVALID_PUBLICATION,
        AdmissionOutcome.WITNESS_INVALID_SUPERVISOR,
    }
)
TERMINAL_ADMISSION_OUTCOMES = (
    WITNESS_INVALID_OUTCOMES
    | frozenset(CREATION_FAILURE_STAGES.values())
    | frozenset(LINUX_PREFLIGHT_FAILURE_STAGES.values())
)


class IntakeServer(socketserver.TCPServer):
    allow_reuse_address = True


def create_intake_server(root: Path, expected_auth: str) -> IntakeServer:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self) -> None:
            index = self.server.request_index + 1
            if self.path != "/v1/events":
                self.send_error(404)
                return
            if self.headers.get("authorization") != expected_auth:
                self.send_error(401)
                return
            if self.headers.get("content-type") != "application/json; charset=utf-8":
                self.send_error(415)
                return
            try:
                length = int(self.headers.get("content-length", "-1"))
            except ValueError:
                self.send_error(400)
                return
            if length <= 0 or length > 256 * 1024 or index > 2:
                self.send_error(413)
                return

            body = self.rfile.read(length)
            temporary = root / f"request-{index}.tmp"
            final = root / f"request-{index}.bin"
            with temporary.open("xb") as stream:
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(final)
            self.server.request_index = index
            self.send_response(503 if index == 1 else 202)
            self.send_header("content-length", "0")
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            return

    server = IntakeServer(("127.0.0.1", 0), Handler)
    server.request_index = 0
    return server


def serve_intake(root: Path, expected_auth: str) -> bool:
    server = create_intake_server(root, expected_auth)
    try:
        port_temporary = root / "port.tmp"
        port_temporary.write_text(str(server.server_address[1]), encoding="ascii")
        port_temporary.replace(root / "port")
        for _ in range(2):
            server.timeout = 30
            server.handle_request()
        return server.request_index == 2
    finally:
        server.server_close()


def local_package_source(path_text: str, *, platform_name: str | None = None) -> str:
    current_platform = platform_name or ("windows" if os.name == "nt" else "posix")
    if current_platform == "windows":
        path = PureWindowsPath(path_text)
        if not path.is_absolute():
            raise ValueError("local package source must be absolute")
        return path.as_uri()
    if current_platform != "posix":
        raise ValueError("unsupported package source platform")

    path = Path(path_text).resolve()
    if not path.is_absolute():
        raise ValueError("local package source must be absolute")
    return path.as_uri()


def write_nuget_config(
    packages_directory: str,
    output_path: Path,
    *,
    platform_name: str | None = None,
) -> None:
    configuration = ET.Element("configuration")
    sources = ET.SubElement(configuration, "packageSources")
    ET.SubElement(sources, "clear")
    ET.SubElement(
        sources,
        "add",
        key="local-logbrew",
        value=local_package_source(packages_directory, platform_name=platform_name),
    )
    ET.SubElement(
        sources,
        "add",
        key="nuget.org",
        value="https://api.nuget.org/v3/index.json",
    )
    mapping = ET.SubElement(configuration, "packageSourceMapping")
    local_mapping = ET.SubElement(mapping, "packageSource", key="local-logbrew")
    ET.SubElement(local_mapping, "package", pattern="LogBrew")
    public_mapping = ET.SubElement(mapping, "packageSource", key="nuget.org")
    for pattern in ("Microsoft.*", "System.*", "NETStandard.Library"):
        ET.SubElement(public_mapping, "package", pattern=pattern)
    ET.ElementTree(configuration).write(
        output_path,
        encoding="utf-8",
        xml_declaration=True,
    )


def _is_nonempty_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def inspect_admission_readiness(
    witness_directory: Path,
    request_path: Path,
) -> AdmissionOutcome | None:
    return inspect_admission_witness(witness_directory, request_path)[0]


def _read_committed_witness(path: Path) -> bytes | None:
    try:
        path_details = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(path_details.st_mode) or path_details.st_size > len(WITNESS_VALUE):
            return None
        with path.open("rb") as stream:
            details = os.fstat(stream.fileno())
            if not stat.S_ISREG(details.st_mode) or details.st_size > len(WITNESS_VALUE):
                return None
            value = stream.read(len(WITNESS_VALUE) + 1)
            return value if len(value) == details.st_size else None
    except OSError:
        return None


def _is_valid_committed_witness(path: Path) -> bool:
    return _read_committed_witness(path) == WITNESS_VALUE


def _temporary_witness_validity(path: Path) -> bool | None:
    try:
        path_details = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(path_details.st_mode):
            return False
        with path.open("rb") as stream:
            details = os.fstat(stream.fileno())
            if not stat.S_ISREG(details.st_mode):
                return False
            value = stream.read(len(WITNESS_VALUE) + 1)
            return len(value) <= len(WITNESS_VALUE) and WITNESS_VALUE.startswith(value)
    except FileNotFoundError:
        return None
    except OSError:
        return False


def _is_valid_temporary_witness(path: Path) -> bool:
    return _temporary_witness_validity(path) is True


def inspect_recovery_witness(witness_directory: Path) -> str:
    try:
        if not witness_directory.is_dir():
            return "invalid"
        entries = {path.name: path for path in witness_directory.iterdir()}
    except OSError:
        return "invalid"

    allowed_entries = set(RECOVERY_WITNESS_STAGES) | RECOVERY_FAILURE_STAGES
    if not entries.keys() <= allowed_entries:
        return "invalid"

    failure_entries = entries.keys() & RECOVERY_FAILURE_STAGES
    if failure_entries:
        if len(failure_entries) != 1:
            return "invalid"
        expected_success = set(RECOVERY_WITNESS_STAGES[:2])
        if entries.keys() - failure_entries != expected_success:
            return "invalid"
        failure_stage = next(iter(failure_entries))
        if not all(_is_valid_committed_witness(entries[stage]) for stage in expected_success):
            return "invalid"
        if not _is_valid_committed_witness(entries[failure_stage]):
            return "invalid"
        return failure_stage

    last_stage = "none"
    found_gap = False
    for stage in RECOVERY_WITNESS_STAGES:
        path = entries.get(stage)
        if path is None:
            found_gap = True
            continue
        if found_gap or not _is_valid_committed_witness(path):
            return "invalid"
        last_stage = stage
    return last_stage


def _is_regular_single_link(path: Path) -> bool:
    try:
        details = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
            return False
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            return (
                stat.S_ISREG(opened.st_mode)
                and opened.st_nlink == 1
                and os.path.samestat(details, opened)
            )
    except OSError:
        return False


def _durable_record_kind(path: Path) -> int | None:
    try:
        with path.open("rb") as stream:
            header = stream.read(10)
    except OSError:
        return None
    if len(header) != 10 or header[:8] != b"LBDOTN01" or header[8] != 1:
        return None
    return header[9]


def inspect_recovery_storage(parent_directory: Path) -> str:
    child = parent_directory / ".logbrew-delivery-v1"
    state_name = "delivery-state.lbd"
    event_names = (
        "event-00000000000000000001.lbd",
        "event-00000000000000000002.lbd",
    )
    try:
        if not child.is_dir():
            return "invalid"
        entries = {path.name: path for path in child.iterdir()}
    except OSError:
        return "invalid"
    temporary_names = tuple(name for name in entries if name.startswith(".tmp-"))
    if len(temporary_names) > 1:
        return "invalid"
    temporary_name = temporary_names[0] if temporary_names else None
    if temporary_name is not None and (
        len(temporary_name) != 37
        or any(character not in "0123456789abcdef" for character in temporary_name[5:])
    ):
        return "invalid"
    allowed_names = {".owner", state_name, *event_names}
    if temporary_name is not None:
        allowed_names.add(temporary_name)
    if not entries.keys() <= allowed_names or ".owner" not in entries:
        return "invalid"
    if not all(_is_regular_single_link(path) for path in entries.values()):
        return "invalid"

    present_events = sum(event_name in entries for event_name in event_names)
    event_count_label = ("no-events", "one-event", "two-events")[present_events]
    state = entries.get(state_name)
    if state is None:
        return "recovery-storage-no-state" if present_events == 0 else "invalid"
    state_kind = _durable_record_kind(state)
    if temporary_name is not None:
        if (
            present_events == 2
            and state_kind == 2
            and _durable_record_kind(entries[temporary_name]) == 3
        ):
            return "recovery-storage-acknowledgement-replacement-pending"
        return "invalid"
    kind = {2: "prefix", 3: "acknowledged"}.get(state_kind)
    return f"recovery-storage-{kind}-{event_count_label}" if kind else "invalid"


def inspect_admission_witness(
    witness_directory: Path,
    request_path: Path,
    *,
    _minimum_committed_stages: int = 0,
    _publication_retry_allowed: bool = True,
) -> tuple[AdmissionOutcome | None, str | None, bool]:
    try:
        if not witness_directory.is_dir():
            return AdmissionOutcome.RUNTIME_VALIDATION_TIMEOUT, None, False
        entries = {path.name: path for path in witness_directory.iterdir()}
    except OSError:
        return AdmissionOutcome.WITNESS_INVALID_INVENTORY, None, False

    allowed_names = {
        *(stage for stage, _ in APP_WITNESS_STAGES),
        *CREATION_FAILURE_STAGES,
        LINUX_PREFLIGHT_PASSED_STAGE,
        *LINUX_PREFLIGHT_FAILURE_STAGES,
        *SUPERVISOR_WITNESS_STAGES,
        WITNESS_TEMPORARY_NAME,
    }
    if not entries.keys() <= allowed_names:
        return AdmissionOutcome.WITNESS_INVALID_INVENTORY, None, False
    if any(stage in entries for stage in SUPERVISOR_WITNESS_STAGES):
        return AdmissionOutcome.WITNESS_INVALID_INVENTORY, None, False
    creation_failures = [stage for stage in CREATION_FAILURE_STAGES if stage in entries]
    if len(creation_failures) > 1:
        return AdmissionOutcome.WITNESS_INVALID_INVENTORY, None, False
    preflight_failures = [stage for stage in LINUX_PREFLIGHT_FAILURE_STAGES if stage in entries]
    preflight_passed = entries.get(LINUX_PREFLIGHT_PASSED_STAGE)
    if (
        len(preflight_failures) > 1
        or (preflight_failures and preflight_passed is not None)
        or (preflight_failures and creation_failures)
    ):
        return AdmissionOutcome.WITNESS_INVALID_INVENTORY, None, False

    first_missing: AdmissionOutcome | None = None
    last_stage: str | None = None
    committed_stages = 0
    for stage, missing_outcome in APP_WITNESS_STAGES:
        path = entries.get(stage)
        if path is None:
            if first_missing is None:
                first_missing = missing_outcome
            continue
        if first_missing is not None or not _is_valid_committed_witness(path):
            return AdmissionOutcome.WITNESS_INVALID_COMMITTED, None, False
        last_stage = stage
        committed_stages += 1

    if committed_stages < _minimum_committed_stages:
        return AdmissionOutcome.WITNESS_INVALID_PUBLICATION, None, False

    temporary = entries.get(WITNESS_TEMPORARY_NAME)
    if preflight_failures:
        if temporary is not None:
            return AdmissionOutcome.WITNESS_INVALID_PUBLICATION, None, False
        failure_stage = preflight_failures[0]
        if (
            committed_stages != 1
            or first_missing != AdmissionOutcome.DURABLE_CLIENT_CREATION_TIMEOUT
            or not _is_valid_committed_witness(entries[failure_stage])
        ):
            return AdmissionOutcome.WITNESS_INVALID_COMMITTED, None, False
        return LINUX_PREFLIGHT_FAILURE_STAGES[failure_stage], last_stage, False

    if preflight_passed is not None:
        if committed_stages < 1 or not _is_valid_committed_witness(preflight_passed):
            return AdmissionOutcome.WITNESS_INVALID_COMMITTED, None, False
        if committed_stages == 1:
            last_stage = LINUX_PREFLIGHT_PASSED_STAGE

    if creation_failures:
        if temporary is not None:
            return AdmissionOutcome.WITNESS_INVALID_PUBLICATION, None, False
        failure_stage = creation_failures[0]
        if (
            committed_stages != 1
            or first_missing != AdmissionOutcome.DURABLE_CLIENT_CREATION_TIMEOUT
            or not _is_valid_committed_witness(entries[failure_stage])
        ):
            return AdmissionOutcome.WITNESS_INVALID_COMMITTED, None, False
        return CREATION_FAILURE_STAGES[failure_stage], last_stage, False

    if temporary is not None:
        temporary_validity = _temporary_witness_validity(temporary)
        if temporary_validity is None:
            if not _publication_retry_allowed:
                return AdmissionOutcome.WITNESS_INVALID_PUBLICATION, None, False
            return inspect_admission_witness(
                witness_directory,
                request_path,
                _minimum_committed_stages=committed_stages + 1,
                _publication_retry_allowed=False,
            )
        if not temporary_validity:
            return AdmissionOutcome.WITNESS_INVALID_PUBLICATION, None, False

    if first_missing is not None:
        return first_missing, last_stage, temporary is not None
    if temporary is not None:
        return AdmissionOutcome.WITNESS_INVALID_PUBLICATION, None, False
    outcome = None if _is_nonempty_file(request_path) else AdmissionOutcome.REQUEST_TIMEOUT
    return outcome, last_stage, False


def record_witness_stage(witness_directory: Path, stage: str) -> None:
    if stage not in SUPERVISOR_WITNESS_STAGES or not witness_directory.is_dir():
        raise ValueError("invalid admission witness stage")
    temporary = witness_directory / WITNESS_TEMPORARY_NAME
    final = witness_directory / stage
    if final.exists():
        raise ValueError("duplicate admission witness stage")
    with temporary.open("xb") as stream:
        stream.write(WITNESS_VALUE)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(final)


def run_until_ready_and_kill(
    command: list[str],
    marker_path: Path,
    request_path: Path,
    stdout_path: Path,
    stderr_path: Path,
    *,
    timeout_seconds: float,
    reap_timeout_seconds: float = 5,
    kill_request: Callable[[subprocess.Popen[bytes]], None] | None = None,
) -> AdmissionOutcome:
    if not command or timeout_seconds <= 0 or timeout_seconds > 300:
        raise ValueError("invalid bounded process request")
    if reap_timeout_seconds <= 0 or reap_timeout_seconds > 30:
        raise ValueError("invalid bounded reap request")

    deadline = time.monotonic() + timeout_seconds
    process: subprocess.Popen[bytes] | None = None
    last_outcome = AdmissionOutcome.RUNTIME_VALIDATION_TIMEOUT
    with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
            )
            while time.monotonic() < deadline:
                readiness, last_stage, temporary_pending = inspect_admission_witness(
                    marker_path,
                    request_path,
                )
                if readiness in TERMINAL_ADMISSION_OUTCOMES:
                    return readiness
                if readiness is None:
                    if process.poll() is not None:
                        return (
                            AdmissionOutcome.WITNESS_INVALID_PUBLICATION
                            if temporary_pending
                            else SPONTANEOUS_EXIT_OUTCOMES[last_stage]
                        )
                    try:
                        (kill_request or subprocess.Popen.kill)(process)
                    except OSError:
                        return AdmissionOutcome.KILL_REQUEST_FAILED
                    try:
                        record_witness_stage(marker_path, "external-kill-requested")
                    except (OSError, ValueError):
                        return AdmissionOutcome.WITNESS_INVALID_SUPERVISOR
                    try:
                        return_code = process.wait(timeout=reap_timeout_seconds)
                    except subprocess.TimeoutExpired:
                        return AdmissionOutcome.REAP_FAILED
                    try:
                        record_witness_stage(marker_path, "post-kill-reaped")
                    except (OSError, ValueError):
                        return AdmissionOutcome.WITNESS_INVALID_SUPERVISOR
                    return AdmissionOutcome.EXPECTED_NONZERO_EXIT if return_code != 0 else AdmissionOutcome.ZERO_EXIT
                if process.poll() is not None:
                    return (
                        AdmissionOutcome.WITNESS_INVALID_PUBLICATION
                        if temporary_pending
                        else SPONTANEOUS_EXIT_OUTCOMES[last_stage]
                    )
                last_outcome = readiness
                time.sleep(0.05)
            return last_outcome
        finally:
            if process is not None and process.poll() is None:
                try:
                    process.kill()
                    process.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass


def main(arguments: list[str]) -> int:
    try:
        if len(arguments) == 3 and arguments[0] == "write-nuget-config":
            write_nuget_config(arguments[1], Path(arguments[2]))
            return 0
        if len(arguments) == 3 and arguments[0] == "serve-intake":
            return 0 if serve_intake(Path(arguments[1]), arguments[2]) else 1
        if len(arguments) == 2 and arguments[0] == "recovery-stage":
            print(inspect_recovery_witness(Path(arguments[1])))
            return 0
        if len(arguments) == 2 and arguments[0] == "recovery-storage-stage":
            print(inspect_recovery_storage(Path(arguments[1])))
            return 0
        if len(arguments) >= 8 and arguments[0] == "kill-after-ready":
            separator = arguments.index("--", 6)
            if separator != 6:
                return 1
            outcome = run_until_ready_and_kill(
                arguments[7:],
                Path(arguments[1]),
                Path(arguments[2]),
                Path(arguments[3]),
                Path(arguments[4]),
                timeout_seconds=int(arguments[5]),
            )
            if outcome == AdmissionOutcome.EXPECTED_NONZERO_EXIT:
                return 0
            print(outcome.value, file=sys.stderr)
            return 1
    except Exception:
        print("admission supervisor failed", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
