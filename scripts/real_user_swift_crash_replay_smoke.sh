#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
intake_pid=""

cleanup() {
  if [[ -n "$intake_pid" ]]; then
    kill "$intake_pid" 2>/dev/null || true
    wait "$intake_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT
trap 'echo "swift crash replay smoke failed near line $LINENO" >&2' ERR

app_dir="$tmp_dir/consumer"
mkdir -p "$app_dir/Sources/CrashProbe" "$app_dir/Sources/ObjCProbe"

cat > "$app_dir/Package.swift" <<EOF
// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CrashReplayConsumer",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(name: "logbrew-swift", path: "$repo_root"),
    ],
    targets: [
        .executableTarget(
            name: "CrashProbe",
            dependencies: [
                .product(name: "LogBrew", package: "logbrew-swift"),
                .product(name: "LogBrewCrash", package: "logbrew-swift"),
            ]
        ),
        .executableTarget(
            name: "ObjCProbe",
            dependencies: [
                .product(name: "LogBrewCrash", package: "logbrew-swift"),
            ]
        ),
    ]
)
EOF

cat > "$app_dir/Sources/CrashProbe/main.swift" <<'EOF'
import CryptoKit
import Darwin
import Foundation
import LogBrew
import LogBrewCrash

guard CommandLine.arguments.count >= 3 else {
    exit(64)
}

let mode = CommandLine.arguments[1]
let storage = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let configuration = try NativeCrashConfiguration(
    storageDirectory: storage,
    maxStoredReports: 3,
    maxReplayBytes: 4 * 1_024 * 1_024
)
let capture = NativeCrashCapture(configuration: configuration)
try capture.install()

if mode == "write" {
    print(#"{"installed":true}"#)
    fflush(stdout)
    raise(SIGABRT)
    exit(70)
}

guard mode == "read", CommandLine.arguments.count == 4,
      let endpoint = URL(string: CommandLine.arguments[3])
else {
    exit(64)
}

let client = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "swift-crash-replay-proof",
    sdkVersion: "0.1.0",
    maxRetries: 1
)
let transport = try HTTPTransport(endpoint: endpoint, timeout: 5)
var attempts = 0
var bodyDigest = ""

let replay = try capture.replayPendingReports { record in
    do {
        try record.enqueue(in: client)
        let preview = try client.previewJSON()
        bodyDigest = SHA256.hash(data: Data(preview.utf8)).map { String(format: "%02x", $0) }.joined()
        let response = try client.flush(transport: transport)
        attempts = response.attempts
        return (200 ..< 300).contains(response.statusCode)
    } catch {
        return false
    }
}
let status = try capture.status()
guard replay.attempted == 1,
      replay.acknowledged == 1,
      replay.pending == 0,
      status.pending == 0,
      attempts == 2,
      bodyDigest.count == 64
else {
    exit(1)
}

print("{\"ok\":true,\"attempts\":\(attempts),\"acknowledged\":\(replay.acknowledged),\"pending\":\(status.pending),\"bodySha256\":\"\(bodyDigest)\"}")
EOF

cat > "$app_dir/Sources/ObjCProbe/main.m" <<'EOF'
@import Foundation;
@import LogBrewCrash;

int main(void) {
  @autoreleasepool {
    NSError *error = nil;
    NSURL *directory = [NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES];
    LBWNativeCrashConfiguration *configuration =
        [[LBWNativeCrashConfiguration alloc] initWithStorageDirectory:directory
                                                     maxStoredReports:3
                                                       maxReplayBytes:4194304
                                                                  error:&error];
    if (configuration == nil || error != nil || configuration.maxStoredReports != 3) {
      return 1;
    }
    LBWNativeCrashCapture *capture = [[LBWNativeCrashCapture alloc] initWithConfiguration:configuration];
    if (capture == nil) {
      return 1;
    }
  }
  return 0;
}
EOF

port_file="$tmp_dir/intake.port"
receipt_file="$tmp_dir/intake.receipt.json"
python3 -u - "$port_file" "$receipt_file" <<'PY' &
import hashlib
import http.server
import json
import sys

port_file, receipt_file = sys.argv[1:]
requests = []

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "-1"))
        if length < 0 or length > 1024 * 1024:
            self.send_response(400)
            self.end_headers()
            return
        body = self.rfile.read(length)
        requests.append({
            "path": self.path,
            "authorization": self.headers.get("authorization"),
            "content_type": self.headers.get("content-type"),
            "body": body,
        })
        self.send_response(503 if len(requests) == 1 else 202)
        self.end_headers()

    def log_message(self, *_):
        return

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w", encoding="utf-8") as handle:
    handle.write(str(server.server_port))
for _ in range(2):
    server.handle_request()
server.server_close()

assert len(requests) == 2
assert all(item["path"] == "/v1/events" for item in requests)
assert all(item["authorization"] == "Bearer LOGBREW_API_KEY" for item in requests)
assert all(item["content_type"] == "application/json" for item in requests)
assert requests[0]["body"] == requests[1]["body"]

payload = json.loads(requests[0]["body"])
assert len(payload["events"]) == 1
event = payload["events"][0]
assert event["type"] == "issue"
assert event["attributes"] == {
    "level": "critical",
    "metadata": {"crash.mechanism": "signal", "crash.replayed": True},
    "title": "Native application crash",
}
serialized = requests[0]["body"].decode("utf-8")
for forbidden in ("LOGBREW_API_KEY", "authorization", "cookie", "pass" "word", "executable_path", "process_name"):
    assert forbidden not in serialized

receipt = {
    "ok": True,
    "requests": len(requests),
    "events": 1,
    "bodySha256": hashlib.sha256(requests[0]["body"]).hexdigest(),
}
with open(receipt_file, "w", encoding="utf-8") as handle:
    json.dump(receipt, handle, sort_keys=True, separators=(",", ":"))
PY
intake_pid=$!

for _ in {1..100}; do
  [[ -s "$port_file" ]] && break
  sleep 0.05
done
test -s "$port_file"

scratch="$tmp_dir/build"
swift build --package-path "$app_dir" --scratch-path "$scratch" --product CrashProbe >/dev/null
swift build --package-path "$app_dir" --scratch-path "$scratch" --product ObjCProbe >/dev/null
"$scratch/debug/ObjCProbe"
binary_digest="$(shasum -a 256 "$scratch/debug/CrashProbe" | awk '{print $1}')"

storage="$tmp_dir/crash-store"
if bash -c '"$1" write "$2"' _ "$scratch/debug/CrashProbe" "$storage" \
  > "$tmp_dir/writer.json" 2> "$tmp_dir/writer.stderr"; then
  writer_status=0
else
  writer_status=$?
fi
test "$writer_status" -ne 0
grep -qx '{"installed":true}' "$tmp_dir/writer.json"

endpoint="http://127.0.0.1:$(cat "$port_file")/v1/events"
"$scratch/debug/CrashProbe" read "$storage" "$endpoint" > "$tmp_dir/reader.json" 2> "$tmp_dir/reader.stderr"
wait "$intake_pid"
intake_pid=""

python3 - "$tmp_dir/reader.json" "$receipt_file" "$binary_digest" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    reader = json.load(handle)
with open(sys.argv[2], encoding="utf-8") as handle:
    intake = json.load(handle)
binary_digest = sys.argv[3]
assert reader["ok"] is True
assert reader["attempts"] == 2
assert reader["acknowledged"] == 1
assert reader["pending"] == 0
assert reader["bodySha256"] == intake["bodySha256"]
assert intake["requests"] == 2
assert intake["events"] == 1
assert len(binary_digest) == 64
print(json.dumps({
    "ok": True,
    "artifact": "installed-swiftpm",
    "processes": 2,
    "hardCrash": True,
    "installedBinarySha256": binary_digest,
    "objectiveCCompile": True,
    "requests": 2,
    "acknowledged": 1,
    "pending": 0,
    "bodySha256": intake["bodySha256"],
}, sort_keys=True, separators=(",", ":")))
PY
