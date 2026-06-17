#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/swift/logbrew-swift"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

swift build --package-path "$package_dir" --scratch-path "$tmp_dir/build" >/dev/null
swift test --package-path "$package_dir" --scratch-path "$tmp_dir/test" >/dev/null

archive_path="$tmp_dir/logbrew-swift-source.zip"
swift package --package-path "$package_dir" --scratch-path "$tmp_dir/archive" archive-source --output "$archive_path" >/dev/null
test -f "$archive_path"
unzip -Z1 "$archive_path" > "$tmp_dir/archive-contents.txt"
grep -q '/Package.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/README.md$' "$tmp_dir/archive-contents.txt"
grep -q '/.swiftformat$' "$tmp_dir/archive-contents.txt"
grep -q '/.swiftlint.yml$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/EventEncoding.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/LifecycleTrace.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/LogBrewClient.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/LogBrewLogger.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/LogBrewTrace.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/Metadata.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/ProductTimeline.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/PublicTypes.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/Transport.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/URLSessionTrace.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/LogBrew/Validation.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/ReadmeExample/main.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/RealUserSmoke/main.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Sources/TraceCorrelationExample/main.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Tests/LogBrewTests/LogBrewTests.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Tests/LogBrewTests/LifecycleTraceTests.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/Tests/LogBrewTests/TraceContextTests.swift$' "$tmp_dir/archive-contents.txt"
grep -q '/examples/Makefile$' "$tmp_dir/archive-contents.txt"
unzip -p "$archive_path" '*/README.md' > "$tmp_dir/archive-readme.md"
grep -q 'HTTPTransport' "$tmp_dir/archive-readme.md"
grep -q 'LogBrewLogger' "$tmp_dir/archive-readme.md"
grep -q 'client.metric' "$tmp_dir/archive-readme.md"
grep -q 'MetricAttributes' "$tmp_dir/archive-readme.md"
grep -q 'LogBrewTrace' "$tmp_dir/archive-readme.md"
grep -q 'captureLifecycleSpan' "$tmp_dir/archive-readme.md"
grep -q 'startURLSessionSpan' "$tmp_dir/archive-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/archive-readme.md"

echo "swift package checks passed"
