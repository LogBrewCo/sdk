#!/usr/bin/env bash

fetch_kotlin_okhttp_deps() {
  local deps_dir="$1"
  local okhttp_version="${LOGBREW_OKHTTP_VERSION:-5.5.1}"
  local okio_version="${LOGBREW_OKIO_VERSION:-3.18.1}"

  mkdir -p "$deps_dir"
  fetch_kotlin_okhttp_maven_jar \
    "com/squareup/okhttp3" \
    "okhttp-jvm" \
    "$okhttp_version" \
    "4039527bd1f2e40b66e20b0e52c689cf56074b938ea02678141495f5160f1047" \
    "$deps_dir"
  fetch_kotlin_okhttp_maven_jar \
    "com/squareup/okio" \
    "okio-jvm" \
    "$okio_version" \
    "b97b640557a650d15411f2be29aef558c4e422a83653cb18ba494311dbed18be" \
    "$deps_dir"

  printf '%s:%s\n' \
    "$deps_dir/okhttp-jvm-$okhttp_version.jar" \
    "$deps_dir/okio-jvm-$okio_version.jar"
}

fetch_kotlin_okhttp_maven_jar() {
  local group_path="$1"
  local artifact="$2"
  local version="$3"
  local expected_sha256="$4"
  local deps_dir="$5"
  local jar_path="$deps_dir/$artifact-$version.jar"
  local url="https://repo.maven.apache.org/maven2/$group_path/$artifact/$version/$artifact-$version.jar"

  curl --fail --silent --show-error --location --retry 3 --output "$jar_path" "$url"
  verify_kotlin_okhttp_sha256 "$jar_path" "$expected_sha256"
}

verify_kotlin_okhttp_sha256() {
  local artifact="$1"
  local expected_sha256="$2"
  python3 - "$artifact" "$expected_sha256" <<'PY'
import hashlib
import sys
from pathlib import Path

artifact = Path(sys.argv[1])
expected = sys.argv[2]
actual = hashlib.sha256(artifact.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit(f"checksum mismatch for {artifact.name}: expected {expected}, got {actual}")
PY
}
