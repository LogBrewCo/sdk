#!/usr/bin/env bash
set -Eeuo pipefail

artifact_id="native:LogBrewCo/sdk"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"
version="${1:-0.1.0}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-native-release-public.XXXXXX")"

if [[ $# -gt 1 ]] || { [[ "$receipt_mode" != "0" ]] && [[ "$receipt_mode" != "1" ]]; }; then
  echo "usage: $0 [version]" >&2
  exit 2
fi

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

fail_stage() {
  if [[ "$receipt_mode" == "1" ]]; then
    echo "native release receipt failed at $1" >&2
  else
    echo "native GitHub release smoke failed at $1" >&2
  fi
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail_stage "toolchain"
  fi
}

run_bounded_command() {
  local stdout_path="$1"
  local stderr_path="$2"
  shift 2
  BUILD_STDOUT="$stdout_path" \
    BUILD_STDERR="$stderr_path" \
    BUILD_TMPDIR="$tmp_dir" \
    python3 - "$@" >"$tmp_dir/bounded-command.out" 2>"$tmp_dir/bounded-command.err" <<'PY'
import os
import resource
import signal
import subprocess
import sys
import time
from pathlib import Path

BUILD_TIMEOUT_SECONDS = 10
BUILD_FILE_LIMIT_BYTES = 32 * 1024 * 1024
stdout_path = Path(os.environ["BUILD_STDOUT"])
stderr_path = Path(os.environ["BUILD_STDERR"])
command = sys.argv[1:]
if not command:
    raise SystemExit(1)


def child_setup() -> None:
    os.setsid()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (BUILD_FILE_LIMIT_BYTES, BUILD_FILE_LIMIT_BYTES))


def terminate_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.02)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


environment = {
    "HOME": os.environ["BUILD_TMPDIR"],
    "LC_ALL": "C",
    "PATH": os.environ.get("PATH", ""),
    "TMPDIR": os.environ["BUILD_TMPDIR"],
}
with stdout_path.open("ab") as stdout_handle, stderr_path.open("ab") as stderr_handle:
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=stdout_handle,
            stderr=stderr_handle,
            close_fds=True,
            env=environment,
            preexec_fn=child_setup,
        )
    except OSError:
        raise SystemExit(1)
    deadline = time.monotonic() + BUILD_TIMEOUT_SECONDS
    try:
        return_code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        terminate_group(process)
        process.wait(timeout=2)
        raise SystemExit(1)
    while True:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        if time.monotonic() >= deadline:
            terminate_group(process)
            raise SystemExit(1)
        time.sleep(0.02)
if return_code != 0:
    raise SystemExit(1)
PY
}

require_command python3
require_command cc
require_command ar

if ! python3 - "$version" >"$tmp_dir/version.out" 2>"$tmp_dir/version.err" <<'PY'
import re
import sys

version = sys.argv[1]
if re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version) is None:
    raise SystemExit(1)
PY
then
  fail_stage "release identity"
fi

downloaded_archive="$tmp_dir/downloaded-source.tar.gz"
bound_archive="$tmp_dir/bound-source.tar.gz"
artifact_metadata="$tmp_dir/artifact-metadata.json"

if [[ "$receipt_mode" == "1" ]]; then
  if ! RECEIPT_ARTIFACT_ID="$artifact_id" \
    RECEIPT_BOUND_ARCHIVE="$bound_archive" \
    RECEIPT_METADATA_PATH="$artifact_metadata" \
    python3 >"$tmp_dir/artifact-bind.out" 2>"$tmp_dir/artifact-bind.err" <<'PY'
import hashlib
import json
import os
import stat

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
artifact_id = os.environ["RECEIPT_ARTIFACT_ID"]
destination = os.environ["RECEIPT_BOUND_ARCHIVE"]
metadata_path = os.environ["RECEIPT_METADATA_PATH"]

try:
    supplied = json.loads(os.environ.get("LOGBREW_RELEASE_ARTIFACT_FILES_JSON", ""))
except (json.JSONDecodeError, TypeError):
    raise SystemExit(1)
if (
    not isinstance(supplied, dict)
    or list(supplied) != [artifact_id]
    or not isinstance(supplied.get(artifact_id), str)
    or not os.path.isabs(supplied[artifact_id])
    or not hasattr(os, "O_NOFOLLOW")
):
    raise SystemExit(1)

source_path = supplied[artifact_id]
try:
    source_stat = os.lstat(source_path)
    if stat.S_ISLNK(source_stat.st_mode) or not stat.S_ISREG(source_stat.st_mode):
        raise SystemExit(1)
    source_fd = os.open(source_path, os.O_RDONLY | os.O_NOFOLLOW)
except OSError:
    raise SystemExit(1)

digest = hashlib.sha256()
try:
    opened_stat = os.fstat(source_fd)
    if (
        not stat.S_ISREG(opened_stat.st_mode)
        or opened_stat.st_dev != source_stat.st_dev
        or opened_stat.st_ino != source_stat.st_ino
        or opened_stat.st_size <= 0
        or opened_stat.st_size > MAX_ARCHIVE_BYTES
    ):
        raise SystemExit(1)
    destination_fd = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    try:
        copied = 0
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            copied += len(chunk)
            if copied > MAX_ARCHIVE_BYTES:
                raise SystemExit(1)
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                if written <= 0:
                    raise SystemExit(1)
                view = view[written:]
        if copied != opened_stat.st_size:
            raise SystemExit(1)
        os.fsync(destination_fd)
    finally:
        os.close(destination_fd)
finally:
    os.close(source_fd)

metadata_fd = os.open(
    metadata_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
    0o600,
)
try:
    payload = json.dumps(
        {"id": artifact_id, "digest": f"sha256:{digest.hexdigest()}"},
        separators=(",", ":"),
    ).encode("utf-8")
    view = memoryview(payload)
    while view:
        written = os.write(metadata_fd, view)
        if written <= 0:
            raise SystemExit(1)
        view = view[written:]
    os.fsync(metadata_fd)
finally:
    os.close(metadata_fd)
PY
  then
    fail_stage "artifact binding"
  fi
else
  require_command curl
  release_url="https://github.com/LogBrewCo/sdk/archive/refs/tags/v${version}.tar.gz"
  if ! curl \
    --fail \
    --location \
    --silent \
    --show-error \
    --max-time 30 \
    --max-filesize 67108864 \
    --retry 2 \
    --retry-all-errors \
    --output "$downloaded_archive" \
    "$release_url" \
    >"$tmp_dir/download.out" 2>"$tmp_dir/download.err"; then
    fail_stage "archive download"
  fi
  if ! SOURCE_ARCHIVE="$downloaded_archive" \
    BOUND_ARCHIVE="$bound_archive" \
    python3 >"$tmp_dir/human-bind.out" 2>"$tmp_dir/human-bind.err" <<'PY'
import os
import stat

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
source = os.environ["SOURCE_ARCHIVE"]
destination = os.environ["BOUND_ARCHIVE"]
try:
    source_stat = os.stat(source, follow_symlinks=False)
except OSError:
    raise SystemExit(1)
if (
    not stat.S_ISREG(source_stat.st_mode)
    or source_stat.st_size <= 0
    or source_stat.st_size > MAX_ARCHIVE_BYTES
):
    raise SystemExit(1)
with open(source, "rb") as source_handle, open(destination, "xb") as destination_handle:
    copied = 0
    while True:
        chunk = source_handle.read(1024 * 1024)
        if not chunk:
            break
        copied += len(chunk)
        if copied > MAX_ARCHIVE_BYTES:
            raise SystemExit(1)
        destination_handle.write(chunk)
    if copied != source_stat.st_size:
        raise SystemExit(1)
PY
  then
    fail_stage "archive download"
  fi
fi

extract_dir="$tmp_dir/extracted"
archive_root_path="$tmp_dir/archive-root.txt"
bounded_tar="$tmp_dir/bounded-source.tar"
mkdir -m 700 "$extract_dir" || fail_stage "archive validation"

if ! SOURCE_ARCHIVE="$bound_archive" \
  EXTRACT_DIR="$extract_dir" \
  ARCHIVE_ROOT_PATH="$archive_root_path" \
  BOUNDED_TAR_PATH="$bounded_tar" \
  python3 >"$tmp_dir/archive-validation.out" 2>"$tmp_dir/archive-validation.err" <<'PY'
import gzip
import os
import stat
import tarfile
from pathlib import Path

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 4096
MAX_DECOMPRESSED_TAR_BYTES = 144 * 1024 * 1024
MAX_EXTRACTED_BYTES = 128 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TAR_METADATA_BYTES = 1024 * 1024
MAX_ARCHIVE_PATH_BYTES = 4096
REQUIRED_FILES = {
    "LICENSE",
    "README.md",
    "c/logbrew-c/Makefile",
    "c/logbrew-c/README.md",
    "c/logbrew-c/include/logbrew.h",
    "c/logbrew-c/src/logbrew.c",
    "c/logbrew-c/src/logbrew_internal.h",
    "c/logbrew-c/src/logbrew_metric.c",
    "c/logbrew-c/src/logbrew_recording_transport.c",
    "c/logbrew-c/src/logbrew_timeline.c",
    "c/logbrew-c/src/logbrew_trace.c",
}

archive_path = Path(os.environ["SOURCE_ARCHIVE"])
extract_dir = Path(os.environ["EXTRACT_DIR"])
root_path_output = Path(os.environ["ARCHIVE_ROOT_PATH"])
bounded_tar_path = Path(os.environ["BOUNDED_TAR_PATH"])


def parse_tar_size(field: bytes) -> int:
    if len(field) != 12 or field[0] & 0x80:
        raise SystemExit(1)
    stripped = field.strip(b"\x00 ")
    if not stripped:
        return 0
    if any(byte < ord("0") or byte > ord("7") for byte in stripped):
        raise SystemExit(1)
    return int(stripped, 8)


def validate_pax_metadata(payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        separator = payload.find(b" ", offset, min(len(payload), offset + 32))
        if separator < 0:
            raise SystemExit(1)
        length_field = payload[offset:separator]
        if not length_field.isdigit():
            raise SystemExit(1)
        record_length = int(length_field, 10)
        record_end = offset + record_length
        if record_length <= separator - offset + 2 or record_end > len(payload):
            raise SystemExit(1)
        record = payload[separator + 1:record_end]
        if not record.endswith(b"\n") or b"=" not in record:
            raise SystemExit(1)
        key, value = record[:-1].split(b"=", 1)
        if (
            not key
            or key == b"size"
            or key.startswith(b"GNU.sparse")
            or (key in {b"path", b"linkpath"} and len(value) > MAX_ARCHIVE_PATH_BYTES)
        ):
            raise SystemExit(1)
        offset = record_end


def prevalidate_tar(path: Path) -> None:
    try:
        tar_size = path.stat().st_size
    except OSError:
        raise SystemExit(1)
    if tar_size < 1024 or tar_size > MAX_DECOMPRESSED_TAR_BYTES or tar_size % 512 != 0:
        raise SystemExit(1)

    zero_block = b"\x00" * 512
    raw_entries = 0
    with path.open("rb") as handle:
        while handle.tell() + 512 <= tar_size:
            header = handle.read(512)
            if len(header) != 512:
                raise SystemExit(1)
            if header == zero_block:
                if handle.read(512) != zero_block:
                    raise SystemExit(1)
                while chunk := handle.read(1024 * 1024):
                    if any(chunk):
                        raise SystemExit(1)
                return

            raw_entries += 1
            if raw_entries > MAX_ARCHIVE_ENTRIES:
                raise SystemExit(1)
            member_size = parse_tar_size(header[124:136])
            member_type = header[156:157] or b"\x00"
            padded_size = ((member_size + 511) // 512) * 512
            if padded_size > tar_size - handle.tell():
                raise SystemExit(1)

            if member_type in {b"x", b"g"}:
                if member_size > MAX_TAR_METADATA_BYTES:
                    raise SystemExit(1)
                payload = handle.read(member_size)
                if len(payload) != member_size:
                    raise SystemExit(1)
                validate_pax_metadata(payload)
                handle.seek(padded_size - member_size, os.SEEK_CUR)
            elif member_type in {b"L", b"K"}:
                if member_size > MAX_ARCHIVE_PATH_BYTES:
                    raise SystemExit(1)
                handle.seek(padded_size, os.SEEK_CUR)
            elif member_type in {b"\x00", b"0"}:
                if member_size > MAX_FILE_BYTES:
                    raise SystemExit(1)
                handle.seek(padded_size, os.SEEK_CUR)
            elif member_type == b"5":
                if member_size != 0:
                    raise SystemExit(1)
            else:
                raise SystemExit(1)
    raise SystemExit(1)

try:
    archive_stat = archive_path.stat()
    if (
        archive_path.is_symlink()
        or not archive_path.is_file()
        or archive_stat.st_size <= 0
        or archive_stat.st_size > MAX_ARCHIVE_BYTES
    ):
        raise SystemExit(1)
    with archive_path.open("rb") as archive_handle:
        if archive_handle.read(2) != b"\x1f\x8b":
            raise SystemExit(1)
except OSError:
    raise SystemExit(1)

try:
    with gzip.open(archive_path, mode="rb") as compressed_handle, bounded_tar_path.open("xb") as tar_handle:
        decompressed = 0
        while True:
            chunk = compressed_handle.read(1024 * 1024)
            if not chunk:
                break
            decompressed += len(chunk)
            if decompressed > MAX_DECOMPRESSED_TAR_BYTES:
                raise SystemExit(1)
            tar_handle.write(chunk)
    if decompressed < 1024:
        raise SystemExit(1)
    prevalidate_tar(bounded_tar_path)
    archive = tarfile.open(bounded_tar_path, mode="r:")
except (EOFError, OSError, tarfile.TarError):
    raise SystemExit(1)

with archive:
    members = []
    try:
        for member in archive:
            members.append(member)
            if len(members) > MAX_ARCHIVE_ENTRIES:
                raise SystemExit(1)
    except (OSError, tarfile.TarError):
        raise SystemExit(1)
    if not members:
        raise SystemExit(1)

    root_name = None
    seen = set()
    files = set()
    directories = set()
    normalized_members = []
    total_size = 0
    for member in members:
        raw_name = member.name.rstrip("/")
        parts = raw_name.split("/")
        try:
            raw_name_size = len(raw_name.encode("utf-8"))
        except UnicodeEncodeError:
            raise SystemExit(1)
        if (
            not raw_name
            or raw_name_size > MAX_ARCHIVE_PATH_BYTES
            or raw_name.startswith("/")
            or "\\" in raw_name
            or "\x00" in raw_name
            or any(ord(character) < 32 or ord(character) == 127 for character in raw_name)
            or any(part in {"", ".", ".."} for part in parts)
        ):
            raise SystemExit(1)
        if root_name is None:
            root_name = parts[0]
        if parts[0] != root_name:
            raise SystemExit(1)
        normalized = "/".join(parts)
        collision_key = normalized.casefold()
        if collision_key in seen:
            raise SystemExit(1)
        seen.add(collision_key)
        if member.isdir():
            directories.add(normalized)
        elif member.isfile():
            if member.size < 0 or member.size > MAX_FILE_BYTES:
                raise SystemExit(1)
            total_size += member.size
            if total_size > MAX_EXTRACTED_BYTES:
                raise SystemExit(1)
            files.add(normalized)
        else:
            raise SystemExit(1)
        normalized_members.append((member, normalized, parts))

    if root_name is None or root_name.casefold() in {".", ".."}:
        raise SystemExit(1)
    for file_name in files:
        file_parts = file_name.split("/")
        for index in range(1, len(file_parts)):
            if "/".join(file_parts[:index]) in files:
                raise SystemExit(1)

    relative_files = {
        "/".join(name.split("/")[1:])
        for name in files
        if "/" in name
    }
    if not REQUIRED_FILES.issubset(relative_files):
        raise SystemExit(1)

    for member, normalized, parts in normalized_members:
        destination = extract_dir.joinpath(*parts)
        if member.isdir():
            destination.mkdir(mode=0o700, parents=True, exist_ok=True)
            continue
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not hasattr(os, "O_NOFOLLOW"):
            raise SystemExit(1)
        try:
            destination_fd = os.open(
                destination,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
        except OSError:
            raise SystemExit(1)
        try:
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit(1)
            remaining = member.size
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise SystemExit(1)
                remaining -= len(chunk)
                view = memoryview(chunk)
                while view:
                    written = os.write(destination_fd, view)
                    if written <= 0:
                        raise SystemExit(1)
                    view = view[written:]
            if source.read(1):
                raise SystemExit(1)
        finally:
            os.close(destination_fd)

root_path = extract_dir / root_name
if root_path.is_symlink() or not root_path.is_dir():
    raise SystemExit(1)
root_path_output.write_text(f"{root_path}\n", encoding="utf-8")
PY
then
  fail_stage "archive validation"
fi

if ! IFS= read -r source_root <"$archive_root_path" || [[ -z "$source_root" ]]; then
  fail_stage "archive validation"
fi

if ! EXPECTED_VERSION="$version" \
  RELEASE_HEADER="$source_root/c/logbrew-c/include/logbrew.h" \
  python3 >"$tmp_dir/identity.out" 2>"$tmp_dir/identity.err" <<'PY'
import os
import re
from pathlib import Path

try:
    header = Path(os.environ["RELEASE_HEADER"]).read_text(encoding="utf-8")
except (OSError, UnicodeDecodeError):
    raise SystemExit(1)
versions = re.findall(
    r'^#define[ \t]+LOGBREW_C_VERSION[ \t]+"([^"\r\n]+)"[ \t]*$',
    header,
    flags=re.MULTILINE,
)
if versions != [os.environ["EXPECTED_VERSION"]]:
    raise SystemExit(1)
PY
then
  fail_stage "release identity"
fi

build_dir="$tmp_dir/build"
install_dir="$tmp_dir/install"
mkdir -p "$build_dir/objects" "$install_dir/include" "$install_dir/lib" \
  >"$tmp_dir/build-setup.out" 2>"$tmp_dir/build-setup.err" \
  || fail_stage "native build"

sdk_sources=(
  "src/logbrew.c"
  "src/logbrew_metric.c"
  "src/logbrew_recording_transport.c"
  "src/logbrew_timeline.c"
  "src/logbrew_trace.c"
)
objects=()
for index in "${!sdk_sources[@]}"; do
  object="$build_dir/objects/${index}.o"
  if ! run_bounded_command "$tmp_dir/build.out" "$tmp_dir/build.err" cc \
    -std=c99 \
    -Wall \
    -Wextra \
    -Wpedantic \
    -Werror \
    -I"$source_root/c/logbrew-c/include" \
    -c "$source_root/c/logbrew-c/${sdk_sources[$index]}" \
    -o "$object"; then
    fail_stage "native build"
  fi
  objects+=("$object")
done
if ! run_bounded_command "$tmp_dir/build.out" "$tmp_dir/build.err" \
  ar rcs "$install_dir/lib/liblogbrew.a" "${objects[@]}"; then
  fail_stage "native build"
fi
if ! cp "$source_root/c/logbrew-c/include/logbrew.h" "$install_dir/include/logbrew.h" \
  >"$tmp_dir/install.out" 2>"$tmp_dir/install.err"; then
  fail_stage "artifact install"
fi
chmod 600 "$install_dir/include/logbrew.h" "$install_dir/lib/liblogbrew.a" \
  >"$tmp_dir/install-mode.out" 2>"$tmp_dir/install-mode.err" \
  || fail_stage "artifact install"

consumer_source="$build_dir/native_release_consumer.c"
consumer_binary="$build_dir/native_release_consumer"
if ! cat >"$consumer_source" <<EOF
#include "logbrew.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void require_success(LogBrewStatus status) {
  if (status != LOGBREW_OK) {
    exit(1);
  }
}

int main(void) {
  LogBrewClient *client = NULL;
  LogBrewError error;
  LogBrewRecordingTransport transport;
  LogBrewTransportResponse response;
  const char *body;
  LogBrewConfig config = {
    "LOGBREW_API_KEY",
    "native-release-public-smoke",
    LOGBREW_C_VERSION,
    1U
  };

  if (strcmp(LOGBREW_C_VERSION, "$version") != 0) {
    return 1;
  }
  logbrew_error_clear(&error);
  require_success(logbrew_client_new(config, &client, &error));
  require_success(logbrew_client_log(
      client,
      "evt_native_release_public_smoke",
      "2026-07-01T00:00:00Z",
      (LogBrewLogAttributes){"native release smoke", "info", "native-release"},
      &error));
  logbrew_recording_transport_init(&transport, NULL, 0U);
  require_success(logbrew_client_flush(
      client,
      logbrew_recording_transport_as_transport(&transport),
      &response,
      &error));
  body = logbrew_recording_transport_last_body(&transport);
  if (response.status_code != 202
      || response.attempts != 1U
      || logbrew_recording_transport_sent_count(&transport) != 1U
      || logbrew_client_pending_events(client) != 0U
      || body == NULL
      || strstr(body, "evt_native_release_public_smoke") == NULL
      || strstr(body, "LOGBREW_API_KEY") != NULL) {
    return 1;
  }
  logbrew_recording_transport_free(&transport);
  logbrew_client_free(client);
  puts("native-release-consumer-passed");
  return 0;
}
EOF
then
  fail_stage "native build"
fi

if ! run_bounded_command "$tmp_dir/build.out" "$tmp_dir/build.err" cc \
  -std=c99 \
  -Wall \
  -Wextra \
  -Wpedantic \
  -Werror \
  -I"$install_dir/include" \
  "$consumer_source" \
  "$install_dir/lib/liblogbrew.a" \
  -o "$consumer_binary"; then
  fail_stage "native build"
fi

if ! CONSUMER_BINARY="$consumer_binary" \
  CONSUMER_STDOUT="$tmp_dir/consumer.out" \
  CONSUMER_STDERR="$tmp_dir/consumer.err" \
  python3 >"$tmp_dir/runtime-check.out" 2>"$tmp_dir/runtime-check.err" <<'PY'
import os
import resource
import signal
import subprocess
import time
from pathlib import Path

RUNTIME_TIMEOUT_SECONDS = 5
OUTPUT_LIMIT_BYTES = 64 * 1024
binary = os.environ["CONSUMER_BINARY"]
stdout_path = Path(os.environ["CONSUMER_STDOUT"])
stderr_path = Path(os.environ["CONSUMER_STDERR"])


def child_setup() -> None:
    os.setsid()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_LIMIT_BYTES, OUTPUT_LIMIT_BYTES))


def terminate_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.02)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


with stdout_path.open("xb") as stdout_handle, stderr_path.open("xb") as stderr_handle:
    try:
        process = subprocess.Popen(
            [binary],
            stdin=subprocess.DEVNULL,
            stdout=stdout_handle,
            stderr=stderr_handle,
            close_fds=True,
            env={"PATH": os.environ.get("PATH", "")},
            preexec_fn=child_setup,
        )
    except OSError:
        raise SystemExit(1)
    try:
        return_code = process.wait(timeout=RUNTIME_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        terminate_group(process)
        process.wait(timeout=2)
        raise SystemExit(1)
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        pass
    else:
        terminate_group(process)
        raise SystemExit(1)

if (
    return_code != 0
    or stdout_path.stat().st_size > OUTPUT_LIMIT_BYTES
    or stderr_path.stat().st_size > OUTPUT_LIMIT_BYTES
    or stdout_path.read_bytes() != b"native-release-consumer-passed\n"
    or stderr_path.read_bytes() != b""
):
    raise SystemExit(1)
PY
then
  fail_stage "installed execution"
fi

if [[ "$receipt_mode" == "1" ]]; then
  if ! python3 - "$artifact_metadata" \
    >"$tmp_dir/attestation.json" 2>"$tmp_dir/attestation.err" <<'PY'
import json
import re
import sys
from pathlib import Path

try:
    metadata = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)
if (
    not isinstance(metadata, dict)
    or list(metadata) != ["id", "digest"]
    or metadata.get("id") != "native:LogBrewCo/sdk"
    or not isinstance(metadata.get("digest"), str)
    or re.fullmatch(r"sha256:[0-9a-f]{64}", metadata["digest"]) is None
):
    raise SystemExit(1)
print(json.dumps(
    {"schema_version": 1, "status": "passed", "artifacts": [metadata]},
    separators=(",", ":"),
))
PY
  then
    fail_stage "attestation"
  fi
  cat "$tmp_dir/attestation.json"
  exit 0
fi

echo "native GitHub release install smoke passed"
