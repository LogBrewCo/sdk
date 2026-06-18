#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
export PYTHONDONTWRITEBYTECODE=1

cleanup() {
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

artifact_root="$tmp_dir/artifacts"
dsym_dir="$artifact_root/ios/Checkout.app.dSYM"
dwarf_dir="$dsym_dir/Contents/Resources/DWARF"
mapping_file="$artifact_root/android/mapping.txt"
native_symbols_dir="$artifact_root/android/symbols"
native_so="$native_symbols_dir/lib/arm64-v8a/libcheckout.so"
unity_archive="$artifact_root/unity/symbols.zip"

mkdir -p "$dwarf_dir" "$(dirname "$mapping_file")" "$(dirname "$native_so")"
printf '%s\n' '<plist version="1.0" />' > "$dsym_dir/Contents/Info.plist"
printf '%s\n' \
  'com.example.Checkout -> a:' \
  '    void placeOrder() -> a' \
  > "$mapping_file"
PYTHONPATH="$repo_root/tests" python3 - "$dwarf_dir/Checkout" "$native_so" "$unity_archive" <<'PY'
import sys
from pathlib import Path

from native_elf_fixture import write_android_elf_symbol
from native_macho_fixture import write_macho_dwarf
from native_unity_fixture import write_unity_symbols_zip

write_macho_dwarf(Path(sys.argv[1]))
write_android_elf_symbol(Path(sys.argv[2]))
write_unity_symbols_zip(Path(sys.argv[3]))
PY

manifest="$tmp_dir/native-upload-manifest-ready.json"
python3 "$repo_root/scripts/create_native_release_artifact_manifest.py" \
  --artifact-root "$artifact_root" \
  --release "2026.06.18" \
  --environment "production" \
  --service "checkout-mobile" \
  --artifact "ios_dsym=$dsym_dir" \
  --artifact "android_proguard_mapping=$mapping_file" \
  --artifact "android_native_symbols=$native_symbols_dir" \
  --artifact "unity_symbols=$unity_archive" \
  > "$manifest"

port_file="$tmp_dir/fake-intake-port"
state_file="$tmp_dir/fake-intake-state.json"
expected_token="fake-native-release-artifact-token"

python3 - "$port_file" "$state_file" "$expected_token" <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

port_file = Path(sys.argv[1])
state_file = Path(sys.argv[2])
expected_token = sys.argv[3]
state = {"events": []}


def write_state() -> None:
    state_file.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        auth = self.headers.get("Authorization", "")
        route = self.path.split("?", 1)[0]
        event = {
            "path": route,
            "authorized": auth == f"Bearer {expected_token}",
            "bodyLength": len(body),
            "containsManifest": b"native_debug_symbol_manifest" in body,
            "containsToken": expected_token.encode("utf-8") in body,
            "containsQueryPlaceholder": b"ignored=query" in body,
            "containsTempPath": str(state_file.parent).encode("utf-8") in body,
            "containsDsymPart": b'name="artifact_0_file_0"' in body and b'filename="Info.plist"' in body,
            "containsDwarfPart": b'name="artifact_0_file_1"' in body and b'filename="Checkout"' in body,
            "containsMappingPart": b'name="artifact_1_file_0"' in body and b'filename="mapping.txt"' in body,
            "containsNativePart": b'name="artifact_2_file_0"' in body and b'filename="libcheckout.so"' in body,
            "containsUnityZipPart": b'name="artifact_3_file_0"' in body and b'filename="symbols.zip"' in body,
        }
        state["events"].append(event)
        write_state()

        if route == "/retry-success":
            if not event["authorized"]:
                self.send_response(401)
            elif sum(1 for seen in state["events"] if seen["path"] == "/retry-success") == 1:
                self.send_response(503)
            else:
                self.send_response(202)
        elif route == "/auth-failure":
            self.send_response(403)
        elif route == "/validation-failure":
            self.send_response(400)
        else:
            self.send_response(404)
        self.end_headers()
        self.wfile.write(b"{}")


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port_file.write_text(str(server.server_address[1]), encoding="utf-8")
write_state()
server.serve_forever()
PY
server_pid=$!

for _ in $(seq 1 100); do
  if [[ -s "$port_file" ]]; then
    break
  fi
  sleep 0.05
done

if [[ ! -s "$port_file" ]]; then
  echo "fake native release-artifact intake did not start" >&2
  exit 1
fi

endpoint_base="http://127.0.0.1:$(cat "$port_file")"
export LOGBREW_RELEASE_ARTIFACT_TOKEN="$expected_token"

python3 "$repo_root/scripts/upload_native_release_artifacts.py" \
  --artifact-root "$artifact_root" \
  --manifest "$manifest" \
  --endpoint "$endpoint_base/retry-success?ignored=query#ignored" \
  --retry-delay 0 \
  --max-retries 2 \
  > "$tmp_dir/upload-success.json"

python3 "$repo_root/scripts/upload_native_release_artifacts.py" \
  --artifact-root "$artifact_root" \
  --manifest "$manifest" \
  --endpoint "$endpoint_base/retry-success" \
  --dry-run \
  > "$tmp_dir/upload-dry-run.json"

export LOGBREW_RELEASE_ARTIFACT_TOKEN_BAD="wrong-token"
if python3 "$repo_root/scripts/upload_native_release_artifacts.py" \
  --artifact-root "$artifact_root" \
  --manifest "$manifest" \
  --endpoint "$endpoint_base/auth-failure" \
  --token-env LOGBREW_RELEASE_ARTIFACT_TOKEN_BAD \
  --retry-delay 0 \
  --max-retries 2 \
  > "$tmp_dir/upload-auth-failure.json"; then
  echo "native upload verifier unexpectedly accepted auth failure" >&2
  exit 1
fi

if python3 "$repo_root/scripts/upload_native_release_artifacts.py" \
  --artifact-root "$artifact_root" \
  --manifest "$manifest" \
  --endpoint "$endpoint_base/validation-failure" \
  --retry-delay 0 \
  --max-retries 2 \
  > "$tmp_dir/upload-validation-failure.json"; then
  echo "native upload verifier unexpectedly accepted validation failure" >&2
  exit 1
fi

printf '%s\n' 'tampered mapping' >> "$mapping_file"
if python3 "$repo_root/scripts/upload_native_release_artifacts.py" \
  --artifact-root "$artifact_root" \
  --manifest "$manifest" \
  --endpoint "$endpoint_base/retry-success" \
  --retry-delay 0 \
  > "$tmp_dir/upload-local-validation-failure.json"; then
  echo "native upload verifier unexpectedly accepted a tampered artifact" >&2
  exit 1
fi

python3 - "$tmp_dir/upload-success.json" "$tmp_dir/upload-dry-run.json" "$tmp_dir/upload-auth-failure.json" "$tmp_dir/upload-validation-failure.json" "$tmp_dir/upload-local-validation-failure.json" "$state_file" "$tmp_dir" <<'PY'
import json
import sys
from pathlib import Path

success = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
dry_run = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
auth_failure = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
validation_failure = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
local_validation_failure = json.loads(Path(sys.argv[5]).read_text(encoding="utf-8"))
state = json.loads(Path(sys.argv[6]).read_text(encoding="utf-8"))
tmp_dir = sys.argv[7]

assert success["status"] == "uploaded"
assert success["retryCount"] == 1
assert success["artifactCount"] == 4
assert success["filePartCount"] == 5
assert success["artifactTypes"] == [
    "ios_dsym",
    "android_proguard_mapping",
    "android_native_symbols",
    "unity_symbols",
]
assert [attempt["httpStatus"] for attempt in success["attempts"]] == [503, 202]
assert success["endpoint"].endswith("/retry-success")
assert "ignored=query" not in json.dumps(success)
assert dry_run["status"] == "dry_run"
assert dry_run["attempts"] == []
assert auth_failure["status"] == "auth_failed"
assert len(auth_failure["attempts"]) == 1
assert validation_failure["status"] == "validation_failed"
assert len(validation_failure["attempts"]) == 1
assert local_validation_failure["status"] == "validation_failed"
assert "changed after manifest creation" in json.dumps(local_validation_failure)

events = state["events"]
assert [event["path"] for event in events].count("/retry-success") == 2
assert [event["path"] for event in events].count("/auth-failure") == 1
assert [event["path"] for event in events].count("/validation-failure") == 1
assert all(event["containsManifest"] for event in events)
assert all(event["containsDsymPart"] for event in events)
assert all(event["containsDwarfPart"] for event in events)
assert all(event["containsMappingPart"] for event in events)
assert all(event["containsNativePart"] for event in events)
assert all(event["containsUnityZipPart"] for event in events)
assert not any(event["containsToken"] for event in events)
assert not any(event["containsQueryPlaceholder"] for event in events)
assert not any(event["containsTempPath"] for event in events)
assert tmp_dir not in json.dumps(success)
PY

printf '%s\n' "real-user native release artifact upload smoke ok"
