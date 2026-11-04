#!/usr/bin/env bash
# Build the Swift probe as a SwiftPM app in $1 with a path dependency on swift/logbrew-swift.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
app="$work/app"
mkdir -p "$app/Sources/CaptureProbe"
cmp -s "$sdk/tools/capture-matrix/probes/swift/logbrew-swift/main.swift" "$app/Sources/CaptureProbe/main.swift" ||
  cp "$sdk/tools/capture-matrix/probes/swift/logbrew-swift/main.swift" "$app/Sources/CaptureProbe/main.swift"
cat >"$app/Package.swift.next" <<MANIFEST
// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "capture-probe",
    platforms: [.macOS(.v13)],
    dependencies: [.package(path: "$sdk/swift/logbrew-swift")],
    targets: [
        .executableTarget(
            name: "CaptureProbe",
            dependencies: [
                .product(name: "LogBrew", package: "logbrew-swift"),
                .product(name: "LogBrewCrash", package: "logbrew-swift"),
            ],
        ),
    ],
)
MANIFEST
if cmp -s "$app/Package.swift.next" "$app/Package.swift"; then
  rm "$app/Package.swift.next"
else
  mv "$app/Package.swift.next" "$app/Package.swift"
fi
swift build --package-path "$app" --product CaptureProbe
