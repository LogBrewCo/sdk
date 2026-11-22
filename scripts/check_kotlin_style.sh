#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
ktlint_version="1.8.0"
ktlint_sha256="369ad2b789f95a011f807e1fcb690ccef80bd7cd014fd139e73ae82dcc0baeab"
base_url="https://repo.maven.apache.org/maven2/com/pinterest/ktlint/ktlint-cli/$ktlint_version"
jar_path="$tmp_dir/ktlint-cli-$ktlint_version-all.jar"

remove_tmp_dir() {
	rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

# Maven Central answers 429 to busy CI runners; wait between retries instead of retrying at once.
curl -fsSL --retry 8 --retry-delay 15 --retry-max-time 300 "$base_url/ktlint-cli-$ktlint_version-all.jar" -o "$jar_path"

python3 - "$jar_path" "$ktlint_sha256" <<'PY'
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

jar_path = Path(sys.argv[1])
expected = sys.argv[2]
actual = hashlib.sha256(jar_path.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit(f"ktlint checksum mismatch: expected {expected}, got {actual}")
PY

java -jar "$jar_path" --version
java -jar "$jar_path" \
	"$repo_root/kotlin/logbrew-kotlin/src/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin/examples/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin/tests/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin-okhttp/src/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin-okhttp/examples/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin-okhttp/tests/**/*.kt"

printf '%s\n' "kotlin style checks passed"
