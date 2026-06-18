#!/usr/bin/env bash

fetch_kotlin_okhttp_deps() {
  local deps_dir="$1"
  local okhttp_version="${LOGBREW_OKHTTP_VERSION:-4.12.0}"
  local okio_version="${LOGBREW_OKIO_VERSION:-3.6.0}"

  mkdir -p "$deps_dir"
  fetch_kotlin_okhttp_maven_jar \
    "com/squareup/okhttp3" \
    "okhttp" \
    "$okhttp_version" \
    "b1050081b14bb7a3a7e55a4d3ef01b5dcfabc453b4573a4fc019767191d5f4e0" \
    "$deps_dir"
  fetch_kotlin_okhttp_maven_jar \
    "com/squareup/okio" \
    "okio-jvm" \
    "$okio_version" \
    "67543f0736fc422ae927ed0e504b98bc5e269fda0d3500579337cb713da28412" \
    "$deps_dir"

  printf '%s:%s\n' \
    "$deps_dir/okhttp-$okhttp_version.jar" \
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
