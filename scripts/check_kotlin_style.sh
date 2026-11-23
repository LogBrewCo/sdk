#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
ktlint_version="1.8.0"
ktlint_sha256="369ad2b789f95a011f807e1fcb690ccef80bd7cd014fd139e73ae82dcc0baeab"
base_url="https://repo.maven.apache.org/maven2/com/pinterest/ktlint/ktlint-cli/$ktlint_version"
cache_dir="${LOGBREW_TOOL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/logbrew-tools}"
jar_path="$cache_dir/ktlint-cli-$ktlint_version-all.jar"

remove_tmp_dir() {
	rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

cat >"$tmp_dir/jar_matches.py" <<'PY'
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

jar_path = Path(sys.argv[1])
if not jar_path.is_file() or hashlib.sha256(jar_path.read_bytes()).hexdigest() != sys.argv[2]:
    raise SystemExit(1)
PY

jar_matches() {
	python3 "$tmp_dir/jar_matches.py" "$1" "$ktlint_sha256"
}

# CI keeps the cache folder between runs, so Maven Central serves the jar once per version.
if ! jar_matches "$jar_path"; then
	# Maven Central answers 429 to busy CI runners; wait between retries instead of retrying at once.
	curl -fsSL --retry 8 --retry-delay 15 --retry-max-time 300 "$base_url/ktlint-cli-$ktlint_version-all.jar" -o "$tmp_dir/ktlint.jar"
	jar_matches "$tmp_dir/ktlint.jar" || {
		printf 'ktlint checksum mismatch: expected %s\n' "$ktlint_sha256" >&2
		exit 1
	}
	mkdir -p "$cache_dir"
	mv "$tmp_dir/ktlint.jar" "$jar_path"
fi

java -jar "$jar_path" --version
java -jar "$jar_path" \
	"$repo_root/kotlin/logbrew-kotlin/src/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin/examples/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin/tests/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin-okhttp/src/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin-okhttp/examples/**/*.kt" \
	"$repo_root/kotlin/logbrew-kotlin-okhttp/tests/**/*.kt"

printf '%s\n' "kotlin style checks passed"
