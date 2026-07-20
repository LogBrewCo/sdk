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

package_archive="$tmp_dir/logbrew-swift-source.zip"
package_extract="$tmp_dir/package"
mkdir -p "$package_extract"
swift package \
  --package-path "$repo_root/swift/logbrew-swift" \
  --scratch-path "$tmp_dir/archive-build" \
  archive-source \
  --output "$package_archive" >/dev/null
unzip -q "$package_archive" -d "$package_extract"
package_path="$(dirname "$(find "$package_extract" -mindepth 2 -maxdepth 2 -name Package.swift -print -quit)")"
test -f "$package_path/Package.swift"
package_digest="$(shasum -a 256 "$package_archive" | awk '{print $1}')"

app_dir="$tmp_dir/consumer"
mkdir -p "$app_dir/Sources/CrashProbe" "$app_dir/Sources/ObjCProbe"

cat > "$app_dir/Package.swift" <<EOF
// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CrashReplayConsumer",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(name: "logbrew-swift", path: "$package_path"),
        .package(url: "https://github.com/kstenerud/KSCrash.git", exact: "2.5.1"),
    ],
    targets: [
        .executableTarget(
            name: "CrashProbe",
            dependencies: [
                .product(name: "LogBrew", package: "logbrew-swift"),
                .product(name: "LogBrewCrash", package: "logbrew-swift"),
                .product(name: "Recording", package: "KSCrash"),
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
import KSCrashRecording

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
    let syntheticReport: [String: Any] = [
        "report": [
            "id": "8F12B746-0C79-4CC6-A077-98ED62F094B2",
            "timestamp": "2026-07-20T00:00:00Z",
        ],
        "crash": [
            "error": ["type": "signal", "reason": "raw-envelope-marker"],
            "threads": [[
                "crashed": true,
                "backtrace": ["contents": [
                    ["instruction_addr": 0x1010, "symbol_name": "raw-envelope-marker"],
                    ["instruction_addr": 0x202F, "symbol_name": "raw-envelope-marker"],
                ]],
                "registers": ["basic": ["pc": 0x1010]],
            ]],
        ],
        "binary_images": [
            [
                "image_addr": 0x1000,
                "image_size": 0x100,
                "uuid": "11111111-2222-3333-4444-555555555555",
                "cpu_type": 0x0100_000C,
                "cpu_subtype": 0,
                "name": "/Applications/EnvelopeFixture.app/EnvelopeFixture",
            ],
            [
                "image_addr": 0x2000,
                "image_size": 0x100,
                "uuid": "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
                "cpu_type": 0x0100_000C,
                "cpu_subtype": 2,
                "name": "/Applications/EnvelopeFixture.app/EnvelopeFixture",
            ],
        ],
        "system": ["process_name": "raw-envelope-marker"],
        "user": ["opaque_value": "raw-envelope-marker"],
    ]
    let reportData = try JSONSerialization.data(withJSONObject: syntheticReport, options: [.prettyPrinted, .sortedKeys])
    let reportID = reportData.withUnsafeBytes { bytes -> Int64 in
        guard let baseAddress = bytes.baseAddress else {
            return -1
        }
        return kscrash_addUserReport(
            baseAddress.assumingMemoryBound(to: CChar.self),
            Int32(bytes.count)
        )
    }
    guard reportID > 0 else {
        exit(1)
    }
    print(#"{"installed":true,"synthetic":true}"#)
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
var bodyDigests: [String] = []

let replay = try capture.replayPendingReports { record in
    do {
        try record.enqueue(in: client)
        let preview = try client.previewJSON()
        bodyDigests.append(SHA256.hash(data: Data(preview.utf8)).map { String(format: "%02x", $0) }.joined())
        let response = try client.flush(transport: transport)
        attempts = response.attempts
        return (200 ..< 300).contains(response.statusCode)
    } catch {
        return false
    }
}
let status = try capture.status()
guard replay.attempted == 2,
      replay.acknowledged == 2,
      replay.pending == 0,
      status.pending == 0,
      attempts == 2,
      bodyDigests.count == 2,
      bodyDigests.allSatisfy({ $0.count == 64 })
else {
    exit(1)
}

let digestJSON = bodyDigests.map { "\"\($0)\"" }.joined(separator: ",")
print("{\"ok\":true,\"attempts\":\(attempts),\"acknowledged\":\(replay.acknowledged),\"pending\":\(status.pending),\"bodySha256\":[\(digestJSON)]}")
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
        self.send_response(503 if len(requests) in (1, 3) else 202)
        self.end_headers()

    def log_message(self, *_):
        return

server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w", encoding="utf-8") as handle:
    handle.write(str(server.server_port))
for _ in range(4):
    server.handle_request()
server.server_close()

assert len(requests) == 4
assert all(item["path"] == "/v1/events" for item in requests)
assert all(item["authorization"] == "Bearer LOGBREW_API_KEY" for item in requests)
assert all(item["content_type"] == "application/json" for item in requests)
assert requests[0]["body"] == requests[1]["body"]
assert requests[2]["body"] == requests[3]["body"]

payloads = [json.loads(requests[index]["body"]) for index in (0, 2)]
events = []
for payload in payloads:
    assert len(payload["events"]) == 1
    event = payload["events"][0]
    assert event["type"] == "issue"
    events.append(event)

expected_frames = [
    {
        "imageUuid": "11111111-2222-3333-4444-555555555555",
        "architecture": "arm64",
        "instructionOffset": "0000000000000010",
    },
    {
        "imageUuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "architecture": "arm64e",
        "instructionOffset": "000000000000002f",
    },
]
synthetic = [event for event in events if event["attributes"].get("nativeStackFrames") == expected_frames]
assert len(synthetic) == 1
assert synthetic[0]["attributes"] == {
    "level": "critical",
    "metadata": {"crash.mechanism": "signal", "crash.replayed": True},
    "nativeStackFrames": expected_frames,
    "title": "Native application crash",
}

actual = [event for event in events if event is not synthetic[0]]
assert len(actual) == 1
actual_attributes = actual[0]["attributes"]
assert actual_attributes["level"] == "critical"
assert actual_attributes["metadata"] == {"crash.mechanism": "signal", "crash.replayed": True}
assert actual_attributes["title"] == "Native application crash"
assert set(actual_attributes).issubset({"level", "metadata", "nativeStackFrames", "title"})
for frame in actual_attributes.get("nativeStackFrames", []):
    assert set(frame) == {"architecture", "imageUuid", "instructionOffset"}
    assert frame["architecture"] in {"arm64", "arm64e", "x86_64"}
    assert len(frame["imageUuid"]) == 36 and frame["imageUuid"] == frame["imageUuid"].lower()
    assert len(frame["instructionOffset"]) == 16
    assert all(character in "0123456789abcdef" for character in frame["instructionOffset"])

serialized = b"".join(item["body"] for item in requests).decode("utf-8")
for forbidden in (
    "LOGBREW_API_KEY", "authorization", "cookie", "pass" "word", "executable_path",
    "process_name", "instruction_addr", "image_addr", "image_size", "symbol_name",
    "registers", "EnvelopeFixture", "raw-envelope-marker",
):
    assert forbidden not in serialized

receipt = {
    "ok": True,
    "requests": len(requests),
    "events": len(events),
    "syntheticFrames": len(expected_frames),
    "bodySha256": [hashlib.sha256(requests[index]["body"]).hexdigest() for index in (0, 2)],
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
grep -qx '{"installed":true,"synthetic":true}' "$tmp_dir/writer.json"

endpoint="http://127.0.0.1:$(cat "$port_file")/v1/events"
"$scratch/debug/CrashProbe" read "$storage" "$endpoint" > "$tmp_dir/reader.json" 2> "$tmp_dir/reader.stderr"
wait "$intake_pid"
intake_pid=""

python3 - "$tmp_dir/reader.json" "$receipt_file" "$binary_digest" "$package_digest" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    reader = json.load(handle)
with open(sys.argv[2], encoding="utf-8") as handle:
    intake = json.load(handle)
binary_digest = sys.argv[3]
package_digest = sys.argv[4]
assert reader["ok"] is True
assert reader["attempts"] == 2
assert reader["acknowledged"] == 2
assert reader["pending"] == 0
assert reader["bodySha256"] == intake["bodySha256"]
assert intake["requests"] == 4
assert intake["events"] == 2
assert intake["syntheticFrames"] == 2
assert len(binary_digest) == 64
assert len(package_digest) == 64
print(json.dumps({
    "ok": True,
    "artifact": "installed-swiftpm",
    "processes": 2,
    "hardCrash": True,
    "syntheticEnvelope": True,
    "packageSha256": package_digest,
    "installedBinarySha256": binary_digest,
    "objectiveCCompile": True,
    "requests": 4,
    "events": 2,
    "syntheticFrames": 2,
    "acknowledged": 2,
    "pending": 0,
    "bodySha256": intake["bodySha256"],
}, sort_keys=True, separators=(",", ":")))
PY
