#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/swift/logbrew-swift"
[[ ! -e "$repo_root/Package.resolved" && ! -e "$package_dir/Package.resolved" ]] || {
	echo "Swift checks require a clean package-resolution boundary" >&2
	exit 1
}
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"; rm -f "$repo_root/Package.resolved" "$package_dir/Package.resolved"' EXIT

swift test --package-path "$package_dir" --scratch-path "$tmp_dir/test" >"$tmp_dir/test.log" 2>&1 &
test_pid=$!
swift build \
	--package-path "$repo_root" \
	--scratch-path "$tmp_dir/root-release" \
	--configuration release \
	--target LogBrewCrash \
	>"$tmp_dir/root-release.log" 2>&1 &
release_pid=$!
test_status=0
wait "$test_pid" || test_status=$?
release_status=0
wait "$release_pid" || release_status=$?
((test_status == 0)) || {
	cat "$tmp_dir/test.log"
	exit "$test_status"
}
((release_status == 0)) || {
	cat "$tmp_dir/root-release.log"
	exit "$release_status"
}

rm -f "$repo_root/Package.resolved" "$package_dir/Package.resolved"
archive_path="$tmp_dir/logbrew-swift-source.zip"
swift package --package-path "$package_dir" --scratch-path "$tmp_dir/archive" archive-source --output "$archive_path" >/dev/null
test -f "$archive_path"
git -C "$repo_root" ls-files swift/logbrew-swift |
	sed 's#^swift/logbrew-swift/##' | sort >"$tmp_dir/expected-archive-files.txt"
unzip -Z1 "$archive_path" |
	sed -E 's#^[^/]+/##' | sed '/^$/d' | grep -v '/$' | sort >"$tmp_dir/archive-files.txt"
diff -u "$tmp_dir/expected-archive-files.txt" "$tmp_dir/archive-files.txt"
unzip -p "$archive_path" '*/README.md' | grep -q 'IssueDiagnosticEvidence'

echo "swift package checks passed"
