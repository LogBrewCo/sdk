#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_version="${1:-${LOGBREW_SWIFTPM_VERSION:-0.1.2}}"
package_url="${LOGBREW_SWIFTPM_URL:-https://github.com/LogBrewCo/sdk.git}"
package_identity="${LOGBREW_SWIFTPM_PACKAGE_IDENTITY:-sdk}"
expected_revision="${LOGBREW_SWIFTPM_EXPECTED_REVISION:-}"
expected_source_sha256="${LOGBREW_SWIFTPM_EXPECTED_SOURCE_SHA256:-}"
tmp_dir="$(mktemp -d)"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"

cleanup() {
  rm -rf "$tmp_dir"
}

on_error() {
  local status=$?
  if [[ "$receipt_mode" == "1" ]]; then
    echo "SwiftPM release receipt failed" >&2
    exit "$status"
  fi
  echo "real_user_swiftpm_public_smoke failed near line $LINENO" >&2
  for diagnostic in \
    "$tmp_dir/Package.swift" \
    "$tmp_dir/package.resolved" \
    "$tmp_dir/package.json" \
    "$tmp_dir/dependencies.json" \
    "$tmp_dir/run.stdout.json" \
    "$tmp_dir/run.stderr.json"; do
    if [[ -f "$diagnostic" ]]; then
      echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
      sed -n '1,160p' "$diagnostic" >&2
    fi
  done
  exit "$status"
}

trap cleanup EXIT
trap on_error ERR

run_receipt_smoke() {
  local bound="$tmp_dir/receipt-artifacts"
  local metadata="$tmp_dir/receipt-metadata.json"
  local extracted="$tmp_dir/receipt-source"
  python3 "$repo_root/scripts/release_artifact_receipt.py" bind \
    --family "swiftpm" --output-dir "$bound" --metadata "$metadata" \
    >"$tmp_dir/receipt-bind.out" 2>"$tmp_dir/receipt-bind.err"
  python3 "$repo_root/scripts/release_artifact_receipt.py" extract \
    --family "swiftpm" --metadata "$metadata" --index 0 --output-dir "$extracted" \
    >"$tmp_dir/receipt-extract.out" 2>"$tmp_dir/receipt-extract.err"
  local source_root
  source_root="$(find "$extracted" -name Package.swift -type f -print)"
  [[ -n "$source_root" && "$(printf '%s\n' "$source_root" | wc -l | tr -d ' ')" == "1" ]]
  source_root="${source_root%/Package.swift}"
  mv "$source_root" "$tmp_dir/sdk"

  local app="$tmp_dir/receipt-app"
  mkdir -p "$app/Sources/Receipt"
  cat > "$app/Package.swift" <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Receipt",
    platforms: [.macOS(.v13)],
    dependencies: [.package(path: "../sdk")],
    targets: [
        .executableTarget(
            name: "Receipt",
            dependencies: [
                .product(name: "LogBrew", package: "sdk"),
                .product(name: "LogBrewCrash", package: "sdk"),
            ]
        ),
    ]
)
SWIFT
  cat > "$app/Sources/Receipt/main.swift" <<'SWIFT'
import Foundation
import LogBrew
import LogBrewCrash

let storage = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("receipt-crash")
let configuration = try NativeCrashConfiguration(storageDirectory: storage)
let capture = NativeCrashCapture(configuration: configuration)
let crashStatus = try capture.status()
precondition(crashStatus.lifecycle == .idle)
let client = try LogBrewClient.create(apiKey: "key", sdkName: "receipt", sdkVersion: "0.1.0")
try client.log(
    "event",
    timestamp: "2026-01-01T00:00:00Z",
    attributes: LogAttributes(message: "ok", level: .info)
)
let response = try client.shutdown(transport: RecordingTransport.alwaysAccept())
precondition(response.statusCode == 202)
SWIFT
  swift run --package-path "$app" --scratch-path "$tmp_dir/receipt-build" Receipt \
    >"$tmp_dir/receipt-run.out" 2>"$tmp_dir/receipt-run.err"
  python3 "$repo_root/scripts/release_artifact_receipt.py" attest \
    --family "swiftpm" --metadata "$metadata"
}

if [[ "$receipt_mode" == "1" ]]; then
  [[ $# -eq 1 && -n "$package_version" ]] || exit 1
  run_receipt_smoke
  exit 0
fi

app_dir="$tmp_dir/swiftpm-public-app"
mkdir -p "$app_dir/Sources/SmokeApp" "$app_dir/Tests/SmokeAppTests"
cd "$app_dir"

cat > Package.swift <<EOF
// swift-tools-version: 6.0

import PackageDescription

let packageURL = "$package_url"
let packageVersion: Version = "$package_version"
let packageIdentity = "$package_identity"

let package = Package(
    name: "SmokeApp",
    platforms: [
        .macOS(.v13),
    ],
    dependencies: [
        .package(url: packageURL, exact: packageVersion),
    ],
    targets: [
        .executableTarget(
            name: "SmokeApp",
            dependencies: [
                .product(name: "LogBrew", package: packageIdentity),
                .product(name: "LogBrewCrash", package: packageIdentity),
            ]
        ),
        .testTarget(
            name: "SmokeAppTests",
            dependencies: [
                .product(name: "LogBrew", package: packageIdentity),
                .product(name: "LogBrewCrash", package: packageIdentity),
            ]
        ),
    ]
)
EOF

cat > Sources/SmokeApp/main.swift <<'EOF'
import Foundation
import LogBrew
import LogBrewCrash

let crashStorage = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("logbrew-swiftpm-crash-receipt", isDirectory: true)
let crashConfiguration = try NativeCrashConfiguration(storageDirectory: crashStorage)
let crashCapture = NativeCrashCapture(configuration: crashConfiguration)
precondition(try crashCapture.status().lifecycle == .idle)

let client = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "swiftpm-public-smoke",
    sdkVersion: "0.1.0",
    maxRetries: 1
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
let recordingResponse = try client.shutdown(transport: RecordingTransport.alwaysAccept())

let loggerClient = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "swiftpm-public-logger",
    sdkVersion: "0.1.0"
)
let logger = try LogBrewLogger(
    client: loggerClient,
    subsystem: "co.logbrew.app",
    category: "checkout",
    eventIDPrefix: "swiftpm_log",
    metadata: ["build": "debug"],
    timestampProvider: { "2026-06-02T10:00:06Z" }
)
logger.warning("checkout button tapped", metadata: ["screen": "Checkout"])
let loggerPreview = try loggerClient.previewJSON()
precondition(loggerPreview.contains(#""id" : "swiftpm_log_1""#))
precondition(loggerPreview.contains(#""level" : "warning""#))
precondition(loggerPreview.contains(#""swiftSubsystem" : "co.logbrew.app""#))
precondition(loggerPreview.contains(#""swiftCategory" : "checkout""#))

let httpClient = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "swiftpm-public-http",
    sdkVersion: "0.1.0",
    maxRetries: 1
)
try httpClient.log(
    "evt_swiftpm_http_transport",
    timestamp: "2026-06-02T10:00:07Z",
    attributes: LogAttributes(message: "swiftpm public HTTP transport smoke", level: .info, logger: "swiftpm-http")
)
var httpAttempts = 0
var capturedAuthorization = ""
var capturedContentType = ""
var capturedBody = ""
let localEndpoint = URL(string: "http://127.0.0.1:9/v1/events")!
let httpTransport = try HTTPTransport(
    endpoint: localEndpoint,
    headers: ["x-logbrew-source": "swiftpm-public-smoke"],
    requester: { request in
        httpAttempts += 1
        capturedAuthorization = request.value(forHTTPHeaderField: "authorization") ?? ""
        capturedContentType = request.value(forHTTPHeaderField: "content-type") ?? ""
        if let body = request.httpBody {
            capturedBody = String(data: body, encoding: .utf8) ?? ""
        }
        return httpAttempts == 1 ? 503 : 202
    }
)
let httpResponse = try httpClient.flush(transport: httpTransport)
precondition(capturedAuthorization == "Bearer LOGBREW_API_KEY")
precondition(capturedContentType == "application/json")
precondition(capturedBody.contains("evt_swiftpm_http_transport"))
precondition(httpResponse.statusCode == 202)
precondition(httpResponse.attempts == 2)
precondition(httpAttempts == 2)

print(preview)
let summaryFields = [
    #""ok":true"#,
    #""status":\#(recordingResponse.statusCode)"#,
    #""attempts":\#(recordingResponse.attempts)"#,
    #""events":6"#,
    #""loggerEvents":1"#,
    #""httpAttempts":\#(httpAttempts)"#,
]
let summary = "{\(summaryFields.joined(separator: ","))}\n"
FileHandle.standardError.write(Data(summary.utf8))
EOF

cat > Tests/SmokeAppTests/SmokeAppTests.swift <<'EOF'
import Foundation
import LogBrew
import LogBrewCrash
import XCTest

final class SmokeAppTests: XCTestCase {
    func testInstalledLogBrewProductFlushesLocally() throws {
        let client = try LogBrewClient.create(
            apiKey: "LOGBREW_API_KEY",
            sdkName: "swiftpm-public-test",
            sdkVersion: "0.1.0"
        )
        try client.log(
            "evt_swiftpm_test_log",
            timestamp: "2026-06-02T10:00:08Z",
            attributes: LogAttributes(message: "installed SwiftPM test", level: .info, logger: "swiftpm-test")
        )

        let response = try client.flush(transport: RecordingTransport.alwaysAccept())

        XCTAssertEqual(response.statusCode, 202)
        XCTAssertEqual(response.attempts, 1)
        XCTAssertEqual(client.pendingEvents(), 0)

        let crashStorage = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("logbrew-swiftpm-crash-test", isDirectory: true)
        let crashConfiguration = try NativeCrashConfiguration(storageDirectory: crashStorage)
        let crashCapture = NativeCrashCapture(configuration: crashConfiguration)
        XCTAssertEqual(try crashCapture.status().lifecycle, .idle)
    }
}
EOF

swift package --scratch-path "$tmp_dir/resolve" resolve >/dev/null
test -f Package.resolved
cp Package.resolved "$tmp_dir/package.resolved"
grep -q "\"identity\" : \"$package_identity\"" "$tmp_dir/package.resolved"
grep -q "\"version\" : \"$package_version\"" "$tmp_dir/package.resolved"

resolved_revision="$(python3 - "$tmp_dir/package.resolved" "$package_identity" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
matches = [pin for pin in payload.get("pins", []) if pin.get("identity") == sys.argv[2]]
if len(matches) != 1:
    raise SystemExit("SwiftPM resolution did not contain exactly one expected package")
revision = matches[0].get("state", {}).get("revision")
if not isinstance(revision, str) or len(revision) != 40:
    raise SystemExit("SwiftPM resolution did not contain a full source revision")
print(revision)
PY
)"
if [[ -n "$expected_revision" && "$resolved_revision" != "$expected_revision" ]]; then
  echo "SwiftPM source revision did not match the release ref" >&2
  exit 1
fi
package_checkout="$(find "$tmp_dir/resolve/checkouts" -mindepth 1 -maxdepth 1 -type d -name "$package_identity" -print -quit)"
if [[ -z "$package_checkout" ]]; then
  echo "SwiftPM package checkout was not available for source verification" >&2
  exit 1
fi
source_archive_sha256="$(git -C "$package_checkout" archive "$resolved_revision" | shasum -a 256 | awk '{print $1}')"
if [[ -n "$expected_source_sha256" && "$source_archive_sha256" != "$expected_source_sha256" ]]; then
  echo "SwiftPM source archive digest did not match the release ref" >&2
  exit 1
fi

swift package --scratch-path "$tmp_dir/describe" describe --type json > "$tmp_dir/package.json"
grep -q '"name" : "SmokeApp"' "$tmp_dir/package.json"
grep -q '"LogBrew"' "$tmp_dir/package.json"
grep -q '"LogBrewCrash"' "$tmp_dir/package.json"
grep -q '"product_dependencies" : \[' "$tmp_dir/package.json"

swift package --scratch-path "$tmp_dir/dependencies" show-dependencies --format json > "$tmp_dir/dependencies.json"
grep -q "\"identity\": \"$package_identity\"" "$tmp_dir/dependencies.json"
grep -q '"name": "logbrew-swift"' "$tmp_dir/dependencies.json"
grep -q "\"version\": \"$package_version\"" "$tmp_dir/dependencies.json"

swift run --scratch-path "$tmp_dir/run-build" SmokeApp > "$tmp_dir/run.stdout.json" 2> "$tmp_dir/run.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/run.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/run.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/run.stderr.json"
grep -q '"events":6' "$tmp_dir/run.stderr.json"
grep -q '"loggerEvents":1' "$tmp_dir/run.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/run.stderr.json"

swift build --scratch-path "$tmp_dir/build" >/dev/null
swift test --scratch-path "$tmp_dir/test" >/dev/null

printf '{"revision":"%s","sourceArchiveSha256":"%s","version":"%s"}\n' \
  "$resolved_revision" "$source_archive_sha256" "$package_version"
printf 'swiftpm public install smoke passed for %s %s\n' "$package_url" "$package_version"
