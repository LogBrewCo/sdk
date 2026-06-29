#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/java/logbrew-java"
tmp_dir="$(mktemp -d)"
spotbugs_version="${SPOTBUGS_VERSION:-4.9.8}"
spotbugs_base_url="https://repo.maven.apache.org/maven2/com/github/spotbugs/spotbugs/$spotbugs_version"

# shellcheck source=scripts/java_logback_deps.sh
source "$repo_root/scripts/java_logback_deps.sh"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

download() {
  local url="$1"
  local output="$2"
  curl --fail --silent --show-error --location --retry 3 --output "$output" "$url"
}

verify_sha256() {
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

main_sources="$tmp_dir/main-sources.txt"
classes_dir="$tmp_dir/classes"
java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"
java_opentelemetry_classpath="$(fetch_java_opentelemetry_deps "$tmp_dir/java-opentelemetry-deps")"
java_servlet_classpath="$(fetch_java_servlet_deps "$tmp_dir/java-servlet-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath"
spotbugs_tgz="$tmp_dir/spotbugs-$spotbugs_version.tgz"
spotbugs_sha256="$tmp_dir/spotbugs-$spotbugs_version.tgz.sha256"
spotbugs_report="$tmp_dir/spotbugs.xml"

find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"
mkdir -p "$classes_dir"

download "$spotbugs_base_url/spotbugs-$spotbugs_version.tgz" "$spotbugs_tgz"
download "$spotbugs_base_url/spotbugs-$spotbugs_version.tgz.sha256" "$spotbugs_sha256"
verify_sha256 "$spotbugs_tgz" "$spotbugs_sha256"
tar -xzf "$spotbugs_tgz" -C "$tmp_dir"

spotbugs_bin="$tmp_dir/spotbugs-$spotbugs_version/bin/spotbugs"
spotbugs_report_version="$("$spotbugs_bin" -version)"
if [[ "$spotbugs_report_version" != "$spotbugs_version" ]]; then
  echo "unexpected SpotBugs version: $spotbugs_report_version" >&2
  exit 1
fi

javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" -d "$classes_dir" @"$main_sources"
"$spotbugs_bin" \
  -textui \
  -effort:max \
  -low \
  -auxclasspath "$java_optional_classpath" \
  -xml:withMessages \
  -output "$spotbugs_report" \
  "$classes_dir"

python3 - "$spotbugs_report" <<'PY'
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

report = Path(sys.argv[1])
root = ET.parse(report).getroot()
bugs = root.findall("BugInstance")
errors = root.find("Errors")
missing_classes = 0
analysis_errors = 0
if errors is not None:
    missing_classes = int(errors.attrib.get("missingClasses", "0"))
    analysis_errors = int(errors.attrib.get("errors", "0"))

if analysis_errors or missing_classes or bugs:
    for bug in bugs:
        bug_type = bug.attrib.get("type", "unknown")
        priority = bug.attrib.get("priority", "unknown")
        class_node = bug.find("Class")
        class_name = class_node.attrib.get("classname", "unknown") if class_node is not None else "unknown"
        print(f"{bug_type} priority={priority} class={class_name}", file=sys.stderr)
    if analysis_errors:
        print(f"SpotBugs analysis errors: {analysis_errors}", file=sys.stderr)
    if missing_classes:
        print(f"SpotBugs missing classes: {missing_classes}", file=sys.stderr)
    raise SystemExit("java SpotBugs static analysis failed")
PY

echo "java SpotBugs static analysis ok ($spotbugs_report_version)"
