#!/usr/bin/env bash

fetch_java_logback_deps() {
  local deps_dir="$1"
  local slf4j_version="${LOGBREW_SLF4J_VERSION:-2.0.18}"
  local logback_version="${LOGBREW_LOGBACK_VERSION:-1.5.34}"

  mkdir -p "$deps_dir"
  fetch_maven_jar "org/slf4j/slf4j-api/$slf4j_version/slf4j-api-$slf4j_version" "$deps_dir"
  fetch_maven_jar "ch/qos/logback/logback-core/$logback_version/logback-core-$logback_version" "$deps_dir"
  fetch_maven_jar "ch/qos/logback/logback-classic/$logback_version/logback-classic-$logback_version" "$deps_dir"

  printf '%s:%s:%s\n' \
    "$deps_dir/slf4j-api-$slf4j_version.jar" \
    "$deps_dir/logback-core-$logback_version.jar" \
    "$deps_dir/logback-classic-$logback_version.jar"
}

fetch_java_opentelemetry_deps() {
  local deps_dir="$1"
  local opentelemetry_version="${LOGBREW_OPENTELEMETRY_VERSION:-1.63.0}"

  mkdir -p "$deps_dir"
  fetch_maven_jar \
    "io/opentelemetry/opentelemetry-api/$opentelemetry_version/opentelemetry-api-$opentelemetry_version" \
    "$deps_dir"
  fetch_maven_jar \
    "io/opentelemetry/opentelemetry-context/$opentelemetry_version/opentelemetry-context-$opentelemetry_version" \
    "$deps_dir"
  fetch_maven_jar \
    "io/opentelemetry/opentelemetry-common/$opentelemetry_version/opentelemetry-common-$opentelemetry_version" \
    "$deps_dir"

  printf '%s:%s:%s\n' \
    "$deps_dir/opentelemetry-api-$opentelemetry_version.jar" \
    "$deps_dir/opentelemetry-context-$opentelemetry_version.jar" \
    "$deps_dir/opentelemetry-common-$opentelemetry_version.jar"
}

fetch_java_servlet_deps() {
  local deps_dir="$1"
  local servlet_version="${LOGBREW_SERVLET_VERSION:-6.1.0}"

  mkdir -p "$deps_dir"
  fetch_maven_jar \
    "jakarta/servlet/jakarta.servlet-api/$servlet_version/jakarta.servlet-api-$servlet_version" \
    "$deps_dir"

  printf '%s\n' "$deps_dir/jakarta.servlet-api-$servlet_version.jar"
}

fetch_maven_jar() {
  local artifact_path="$1"
  local deps_dir="$2"
  local base_url="https://repo.maven.apache.org/maven2/$artifact_path"
  local artifact_name
  artifact_name="$(basename "$artifact_path")"
  local jar_path="$deps_dir/$artifact_name.jar"
  local checksum_path="$jar_path.sha256"

  curl --fail --silent --show-error --location --retry 3 --output "$jar_path" "$base_url.jar"
  if curl --fail --silent --location --retry 3 --output "$checksum_path" "$base_url.jar.sha256"; then
    verify_java_logback_sha256 "$jar_path" "$checksum_path"
  else
    checksum_path="$jar_path.sha1"
    curl --fail --silent --show-error --location --retry 3 --output "$checksum_path" "$base_url.jar.sha1"
    verify_java_logback_sha1 "$jar_path" "$checksum_path"
  fi
}

verify_java_logback_sha256() {
  local artifact="$1"
  local checksum_file="$2"
  python3 - "$artifact" "$checksum_file" <<'PY'
import hashlib
import sys
from pathlib import Path

artifact = Path(sys.argv[1])
checksum_file = Path(sys.argv[2])
expected = checksum_file.read_text(encoding="utf-8").strip().split()[0]
actual = hashlib.sha256(artifact.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit(f"checksum mismatch for {artifact.name}: expected {expected}, got {actual}")
PY
}

verify_java_logback_sha1() {
  local artifact="$1"
  local checksum_file="$2"
  python3 - "$artifact" "$checksum_file" <<'PY'
import hashlib
import sys
from pathlib import Path

artifact = Path(sys.argv[1])
checksum_file = Path(sys.argv[2])
expected = checksum_file.read_text(encoding="utf-8").strip().split()[0]
actual = hashlib.sha1(artifact.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit(f"checksum mismatch for {artifact.name}: expected {expected}, got {actual}")
PY
}
