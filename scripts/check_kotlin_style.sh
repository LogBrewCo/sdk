#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
ktlint_version="1.8.0"
base_url="https://repo.maven.apache.org/maven2/com/pinterest/ktlint/ktlint-cli/$ktlint_version"
jar_path="$tmp_dir/ktlint-cli-$ktlint_version-all.jar"
sha256_path="$tmp_dir/ktlint-cli-$ktlint_version-all.jar.sha256"

remove_tmp_dir() {
	rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

curl -fsSL "$base_url/ktlint-cli-$ktlint_version-all.jar" -o "$jar_path"
curl -fsSL "$base_url/ktlint-cli-$ktlint_version-all.jar.sha256" -o "$sha256_path"

python3 - "$jar_path" "$sha256_path" <<'PY'
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

jar_path = Path(sys.argv[1])
sha256_path = Path(sys.argv[2])
expected = sha256_path.read_text(encoding="utf-8").strip().split()[0]
actual = hashlib.sha256(jar_path.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit(f"ktlint checksum mismatch: expected {expected}, got {actual}")
PY

java -jar "$jar_path" --version
java -jar "$jar_path" \
	"$repo_root/kotlin/logbrew-kotlin/src/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin/examples/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin/tests/**/*.kt"

printf '%s\n' "kotlin style checks passed"
