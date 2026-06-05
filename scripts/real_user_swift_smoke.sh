#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/swift/logbrew-swift"
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
trap 'echo "swift real-user smoke failed near line $LINENO" >&2' ERR

echo "swift real-user smoke: package build/test" >&2
swift build --package-path "$package_dir" --scratch-path "$tmp_dir/package-build" >/dev/null
swift test --package-path "$package_dir" --scratch-path "$tmp_dir/package-test" >/dev/null

echo "swift real-user smoke: archive source" >&2
archive_path="$tmp_dir/logbrew-swift-source.zip"
swift package --package-path "$package_dir" --scratch-path "$tmp_dir/package-archive" archive-source --output "$archive_path" >/dev/null
test -f "$archive_path"
unzip -Z1 "$archive_path" > "$tmp_dir/archive-contents.txt"
grep -q '/Package.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/README.md$' "$tmp_dir/archive-contents.txt"
grep -q '/.swiftformat$' "$tmp_dir/archive-contents.txt"
grep -q '/.swiftlint.yml$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/EventEncoding.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/LogBrewClient.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/LogBrewLogger.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/Metadata.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/PublicTypes.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/Transport.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/Validation.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/ReadmeExample/main.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/RealUserSmoke/main.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Tests/LogBrewTests/LogBrewTests.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/examples/Makefile$' "$tmp_dir/archive-contents.txt"

echo "swift real-user smoke: packaged README example" >&2
swift run --package-path "$package_dir" --scratch-path "$tmp_dir/readme-run-build" ReadmeExample > "$tmp_dir/readme.stdout.json" 2> "$tmp_dir/readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme.stderr.json"
grep -q '"events":6' "$tmp_dir/readme.stderr.json"

echo "swift real-user smoke: packaged real-user example" >&2
swift run --package-path "$package_dir" --scratch-path "$tmp_dir/smoke-run-build" RealUserSmoke > "$tmp_dir/smoke.stdout.json" 2> "$tmp_dir/smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/smoke.stderr.json"
grep -q '"httpAttempts":1' "$tmp_dir/smoke.stderr.json"
grep -q '"events":6' "$tmp_dir/smoke.stderr.json"

echo "swift real-user smoke: example Makefile commands" >&2
(cd "$package_dir/examples" && make) > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' <(sed -n '1p' "$tmp_dir/examples-help.txt")
grep -qx 'run (real-user-smoke) -> make run' <(sed -n '2p' "$tmp_dir/examples-help.txt")
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' <(sed -n '3p' "$tmp_dir/examples-help.txt")
test "$(wc -l < "$tmp_dir/examples-help.txt" | tr -d ' ')" = "3"

(cd "$package_dir/examples" && make -n SWIFT_SCRATCH="$tmp_dir/make-readme-build" run-readme-example) > "$tmp_dir/make-readme-plan.txt"
grep -q 'swift run --package-path .. --scratch-path' "$tmp_dir/make-readme-plan.txt"
grep -q 'ReadmeExample' "$tmp_dir/make-readme-plan.txt"

(cd "$package_dir/examples" && make -n SWIFT_SCRATCH="$tmp_dir/make-smoke-build" run-real-user-smoke) > "$tmp_dir/make-smoke-plan.txt"
grep -q 'swift run --package-path .. --scratch-path' "$tmp_dir/make-smoke-plan.txt"
grep -q 'RealUserSmoke' "$tmp_dir/make-smoke-plan.txt"

(cd "$package_dir/examples" && make -n SWIFT_SCRATCH="$tmp_dir/make-alias-build" run) > "$tmp_dir/make-alias-plan.txt"
grep -q 'swift run --package-path .. --scratch-path' "$tmp_dir/make-alias-plan.txt"
grep -q 'RealUserSmoke' "$tmp_dir/make-alias-plan.txt"

echo "swift real-user smoke: installed consumer app" >&2
consumer_dir="$tmp_dir/smoke-app"
mkdir -p "$consumer_dir/Sources/SmokeApp"
cat > "$consumer_dir/Package.swift" <<EOF
// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "SmokeApp",
    platforms: [
        .macOS(.v13),
    ],
    dependencies: [
        .package(path: "$package_dir"),
    ],
    targets: [
        .executableTarget(
            name: "SmokeApp",
            dependencies: [
                .product(name: "LogBrew", package: "logbrew-swift"),
            ]
        ),
    ]
)
EOF
cat > "$consumer_dir/Sources/SmokeApp/main.swift" <<'EOF'
import Foundation
import LogBrew

let client = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "swift-consumer",
    sdkVersion: "0.1.0"
)
try client.release(
    "evt_release_001",
    timestamp: "2026-06-02T10:00:00Z",
    attributes: ReleaseAttributes(version: "1.2.3", commit: "abc123def456", notes: "Public release marker")
)
try client.environment(
    "evt_environment_001",
    timestamp: "2026-06-02T10:00:01Z",
    attributes: EnvironmentAttributes(name: "production", region: "global")
)
try client.issue(
    "evt_issue_001",
    timestamp: "2026-06-02T10:00:02Z",
    attributes: IssueAttributes(title: "Checkout timeout", level: .error, message: "Request timed out after retry budget")
)
try client.log(
    "evt_log_001",
    timestamp: "2026-06-02T10:00:03Z",
    attributes: LogAttributes(message: "worker started", level: .info, logger: "job-runner")
)
try client.span(
    "evt_span_001",
    timestamp: "2026-06-02T10:00:04Z",
    attributes: SpanAttributes(name: "GET /health", traceId: "trace_001", spanId: "span_001", status: .ok, durationMs: 12.5)
)
try client.action(
    "evt_action_001",
    timestamp: "2026-06-02T10:00:05Z",
    attributes: ActionAttributes(name: "deploy", status: .success)
)

let preview = try client.previewJSON()
let response = try client.shutdown(transport: RecordingTransport.alwaysAccept())

let loggerClient = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "swift-consumer",
    sdkVersion: "0.1.0"
)
let logger = try LogBrewLogger(
    client: loggerClient,
    subsystem: "co.logbrew.app",
    category: "checkout",
    eventIDPrefix: "ios_log",
    metadata: ["build": "debug"],
    timestampProvider: { "2026-06-02T10:00:06Z" }
)
logger.warning("checkout button tapped", metadata: ["screen": "Checkout"])
let loggerPreview = try loggerClient.previewJSON()
precondition(loggerPreview.contains(#""id" : "ios_log_1""#))
precondition(loggerPreview.contains(#""level" : "warning""#))
precondition(loggerPreview.contains(#""logger" : "checkout""#))
precondition(loggerPreview.contains(#""swiftLogLevel" : "warning""#))
precondition(loggerPreview.contains(#""swiftSubsystem" : "co.logbrew.app""#))
precondition(loggerPreview.contains(#""swiftCategory" : "checkout""#))
precondition(loggerPreview.contains(#""screen" : "Checkout""#))

let httpEndpointValue = ProcessInfo.processInfo.environment["LOGBREW_SWIFT_HTTP_ENDPOINT"] ?? ""
let httpEndpoint = URL(string: httpEndpointValue)!
let httpClient = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "swift-consumer-http",
    sdkVersion: "0.1.0",
    maxRetries: 1
)
try httpClient.log(
    "evt_swift_http_transport",
    timestamp: "2026-06-02T10:00:06Z",
    attributes: LogAttributes(message: "swift http transport sent", level: .info, logger: "swift-http")
)
let httpTransport = try HTTPTransport(
    endpoint: httpEndpoint,
    headers: ["x-logbrew-source": "swift-consumer"],
    timeout: 5
)
let httpResponse = try httpClient.flush(transport: httpTransport)
precondition(httpResponse.statusCode == 202)
precondition(httpResponse.attempts == 2)

print(preview)
let summary = """
{"ok":true,"status":\(response.statusCode),"attempts":\(response.attempts),"events":6,"loggerEvents":1,"httpAttempts":\(httpResponse.attempts)}

"""
FileHandle.standardError.write(Data(summary.utf8))
EOF

intake_port="$(python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
cat > "$tmp_dir/swift_intake.py" <<'PY'
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

port = int(sys.argv[1])
ready_path = Path(sys.argv[2])
log_path = Path(sys.argv[3])


class Handler(BaseHTTPRequestHandler):
    count = 0

    def do_POST(self):
        content_length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(content_length).decode("utf-8")
        Handler.count += 1
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "authorization": self.headers.get("authorization"),
                "body": body,
                "contentType": self.headers.get("content-type"),
                "source": self.headers.get("x-logbrew-source"),
                "path": self.path,
            }) + "\n")
        self.send_response(503 if Handler.count == 1 else 202)
        self.end_headers()
        self.wfile.write(b"accepted")

    def log_message(self, _format, *_args):
        return


server = HTTPServer(("127.0.0.1", port), Handler)
ready_path.write_text("ready", encoding="utf-8")
while Handler.count < 2:
    server.handle_request()
PY
intake_ready="$tmp_dir/intake.ready"
intake_log="$tmp_dir/intake.jsonl"
python3 "$tmp_dir/swift_intake.py" "$intake_port" "$intake_ready" "$intake_log" &
intake_pid="$!"
for _attempt in {1..200}; do
  if [[ -f "$intake_ready" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -f "$intake_ready" ]]; then
  if ! kill -0 "$intake_pid" 2>/dev/null; then
    echo "swift intake server exited before becoming ready" >&2
  fi
  exit 1
fi

swift package --package-path "$consumer_dir" --scratch-path "$tmp_dir/consumer-describe" describe --type json > "$tmp_dir/consumer-package.json"
grep -q '"name" : "SmokeApp"' "$tmp_dir/consumer-package.json"
grep -q '"identity" : "logbrew-swift"' "$tmp_dir/consumer-package.json"
grep -q '"product_dependencies" : \[' "$tmp_dir/consumer-package.json"
grep -q '"LogBrew"' "$tmp_dir/consumer-package.json"
swift package --package-path "$consumer_dir" --scratch-path "$tmp_dir/consumer-dependencies" show-dependencies --format json > "$tmp_dir/consumer-dependencies.json"
grep -q '"identity": "logbrew-swift"' "$tmp_dir/consumer-dependencies.json"
grep -q '"name": "logbrew-swift"' "$tmp_dir/consumer-dependencies.json"

if ! LOGBREW_SWIFT_HTTP_ENDPOINT="http://127.0.0.1:$intake_port/v1/events" \
  swift run --package-path "$consumer_dir" --scratch-path "$tmp_dir/consumer-run-build" SmokeApp > "$tmp_dir/consumer.stdout.json" 2> "$tmp_dir/consumer.stderr.json"; then
  echo "swift real-user smoke: installed consumer app failed" >&2
  sed -n '1,160p' "$tmp_dir/consumer.stderr.json" >&2 || true
  sed -n '1,80p' "$tmp_dir/consumer.stdout.json" >&2 || true
  sed -n '1,20p' "$intake_log" >&2 || true
  exit 1
fi
if ! wait "$intake_pid"; then
  echo "swift real-user smoke: intake server exited nonzero" >&2
  sed -n '1,20p' "$intake_log" >&2 || true
  exit 1
fi
intake_pid=""
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/consumer.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/consumer.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/consumer.stderr.json"
grep -q '"attempts":1' "$tmp_dir/consumer.stderr.json"
grep -q '"events":6' "$tmp_dir/consumer.stderr.json"
grep -q '"loggerEvents":1' "$tmp_dir/consumer.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/consumer.stderr.json"
python3 - "$intake_log" <<'PY'
import json
import sys
from pathlib import Path

requests = [
    json.loads(line)
    for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
]
if len(requests) != 2:
    raise SystemExit(f"expected 2 HTTP delivery attempts, got {len(requests)}")
for request in requests:
    if request["authorization"] != "Bearer LOGBREW_API_KEY":
        raise SystemExit(f"unexpected authorization header: {request['authorization']}")
    if request["contentType"] != "application/json":
        raise SystemExit(f"unexpected content type: {request['contentType']}")
    if request["source"] != "swift-consumer":
        raise SystemExit(f"unexpected source header: {request['source']}")
    if request["path"] != "/v1/events":
        raise SystemExit(f"unexpected intake path: {request['path']}")
if "evt_swift_http_transport" not in requests[1]["body"]:
    raise SystemExit("missing HTTP transport event in final request body")
PY

echo "swift real-user smoke passed"
