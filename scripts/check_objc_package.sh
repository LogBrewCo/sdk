#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/objc/logbrew-objc"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

objc_command="${OBJC:-}"
if [[ -z "$objc_command" ]]; then
  if command -v clang >/dev/null 2>&1; then
    objc_command="clang"
  else
    printf '%s\n' "clang is required for Objective-C package checks" >&2
    exit 1
  fi
fi

run_examples_make() {
    make --no-print-directory -C "$package_dir/examples" OBJC="$objc_command"
}

objcflags=(-fobjc-arc -Wall -Wextra -Wpedantic -Werror -I"$package_dir/include")
ldflags=(-framework Foundation)

mkdir -p "$tmp_dir/build"
"$objc_command" "${objcflags[@]}" "$package_dir/src/LogBrew.m" "$package_dir/tests/test_logbrew.m" \
  "${ldflags[@]}" -o "$tmp_dir/build/test_logbrew"
"$tmp_dir/build/test_logbrew"

"$objc_command" "${objcflags[@]}" "$package_dir/src/LogBrew.m" "$package_dir/examples/readme_example.m" \
  "${ldflags[@]}" -o "$tmp_dir/build/readme_example"
"$tmp_dir/build/readme_example" > "$tmp_dir/readme.stdout.json" 2> "$tmp_dir/readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme.stderr.json"

"$objc_command" "${objcflags[@]}" "$package_dir/src/LogBrew.m" "$package_dir/examples/real_user_smoke.m" \
  "${ldflags[@]}" -o "$tmp_dir/build/real_user_smoke"
"$tmp_dir/build/real_user_smoke" > "$tmp_dir/smoke.stdout.json" 2> "$tmp_dir/smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":3' "$tmp_dir/smoke.stderr.json"

run_examples_make > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"

archive="$tmp_dir/logbrew-objc-0.1.0.tar.gz"
(cd "$package_dir" && tar -czf "$archive" README.md Makefile include src examples tests)
tar -tzf "$archive" > "$tmp_dir/archive-contents.txt"
grep -qx 'README.md' "$tmp_dir/archive-contents.txt"
grep -qx 'Makefile' "$tmp_dir/archive-contents.txt"
grep -qx 'include/LogBrew.h' "$tmp_dir/archive-contents.txt"
grep -qx 'src/LogBrew.m' "$tmp_dir/archive-contents.txt"
grep -qx 'examples/readme_example.m' "$tmp_dir/archive-contents.txt"
grep -qx 'examples/real_user_smoke.m' "$tmp_dir/archive-contents.txt"
grep -qx 'examples/Makefile' "$tmp_dir/archive-contents.txt"
grep -qx 'tests/test_logbrew.m' "$tmp_dir/archive-contents.txt"

extracted_dir="$tmp_dir/extracted"
mkdir -p "$extracted_dir"
tar -xzf "$archive" -C "$extracted_dir"
make --no-print-directory -C "$extracted_dir" OBJC="$objc_command"

python3 - "$archive" <<'PY'
import sys
import tarfile
from pathlib import Path

archive_path = Path(sys.argv[1])
with tarfile.open(archive_path, "r:gz") as archive:
    readme = archive.extractfile("README.md").read().decode()
    header = archive.extractfile("include/LogBrew.h").read().decode()
for needle in ("LOGBREW_API_KEY", "make -C objc/logbrew-objc/examples run-real-user-smoke", "flushWithTransport"):
    if needle not in readme:
        raise SystemExit(f"missing README guidance: {needle}")
for needle in ("LogBrewObjectiveCVersion", "LBWClient", "LBWRecordingTransport", "LBWErrorStableCodeKey"):
    if needle not in header:
        raise SystemExit(f"missing public header symbol: {needle}")
PY

echo "objc package checks passed with $($objc_command --version | head -n 1)"
