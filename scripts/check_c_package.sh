#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/c/logbrew-c"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

cc_command="${CC:-}"
if [[ -z "$cc_command" ]]; then
  if command -v clang >/dev/null 2>&1; then
    cc_command="clang"
  else
    cc_command="cc"
  fi
fi

cflags=(-std=c99 -Wall -Wextra -Wpedantic -Werror -I"$package_dir/include")

mkdir -p "$tmp_dir/build"
"$cc_command" "${cflags[@]}" "$package_dir/src/logbrew.c" "$package_dir/tests/test_logbrew.c" -o "$tmp_dir/build/test_logbrew"
"$tmp_dir/build/test_logbrew"

"$cc_command" "${cflags[@]}" "$package_dir/src/logbrew.c" "$package_dir/examples/readme_example.c" -o "$tmp_dir/build/readme_example"
"$tmp_dir/build/readme_example" > "$tmp_dir/readme.stdout.json" 2> "$tmp_dir/readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme.stderr.json"

"$cc_command" "${cflags[@]}" "$package_dir/src/logbrew.c" "$package_dir/examples/real_user_smoke.c" -o "$tmp_dir/build/real_user_smoke"
"$tmp_dir/build/real_user_smoke" > "$tmp_dir/smoke.stdout.json" 2> "$tmp_dir/smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":3' "$tmp_dir/smoke.stderr.json"

make -C "$package_dir/examples" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"

archive="$tmp_dir/logbrew-c-0.1.0.tar.gz"
(cd "$package_dir" && tar -czf "$archive" README.md Makefile include src examples tests)
tar -tzf "$archive" > "$tmp_dir/archive-contents.txt"
grep -qx 'README.md' "$tmp_dir/archive-contents.txt"
grep -qx 'Makefile' "$tmp_dir/archive-contents.txt"
grep -qx 'include/logbrew.h' "$tmp_dir/archive-contents.txt"
grep -qx 'src/logbrew.c' "$tmp_dir/archive-contents.txt"
grep -qx 'examples/readme_example.c' "$tmp_dir/archive-contents.txt"
grep -qx 'examples/real_user_smoke.c' "$tmp_dir/archive-contents.txt"
grep -qx 'examples/Makefile' "$tmp_dir/archive-contents.txt"
grep -qx 'tests/test_logbrew.c' "$tmp_dir/archive-contents.txt"

extracted_dir="$tmp_dir/extracted"
mkdir -p "$extracted_dir"
tar -xzf "$archive" -C "$extracted_dir"
make -C "$extracted_dir" CC="$cc_command"

python3 - "$archive" <<'PY'
import sys
import tarfile
from pathlib import Path

archive_path = Path(sys.argv[1])
with tarfile.open(archive_path, "r:gz") as archive:
    readme = archive.extractfile("README.md").read().decode()
    header = archive.extractfile("include/logbrew.h").read().decode()
for needle in ("LOGBREW_API_KEY", "make -C examples run-real-user-smoke", "logbrew_client_flush"):
    if needle not in readme:
        raise SystemExit(f"missing README guidance: {needle}")
for needle in ("LOGBREW_C_VERSION", "LogBrewClient", "LogBrewRecordingTransport"):
    if needle not in header:
        raise SystemExit(f"missing public header symbol: {needle}")
PY

echo "c package checks passed with $($cc_command --version | head -n 1)"
