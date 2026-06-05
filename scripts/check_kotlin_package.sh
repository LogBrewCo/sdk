#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/kotlin/logbrew-kotlin"
tmp_dir="$(mktemp -d)"
lock_dir="${TMPDIR:-/tmp}/logbrewco-sdk-kotlin-checks.lock"
lock_pid_file="$lock_dir/pid"

acquire_lock() {
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock_pid_file"
    return 0
  fi

  local existing_pid=""
  if [[ -f "$lock_pid_file" ]]; then
    existing_pid="$(tr -d '[:space:]' < "$lock_pid_file")"
  fi

  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    return 1
  fi

  rm -rf "$lock_dir"
  mkdir "$lock_dir"
  printf '%s\n' "$$" > "$lock_pid_file"
}

clean_generated_artifacts() {
  find "$package_dir" -type d \( -name build -o -name .gradle \) -prune -exec rm -rf {} + 2>/dev/null || true
}

clean_after_run() {
  rm -rf "$tmp_dir"
  clean_generated_artifacts
  rmdir "$lock_dir" 2>/dev/null || true
}

trap clean_after_run EXIT

if ! acquire_lock; then
  echo "another Kotlin SDK verifier run is already in progress" >&2
  exit 1
fi

mkdir -p "$tmp_dir/classes" "$tmp_dir/test-classes" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-kotlin"

kotlinc "$package_dir"/src/main/kotlin/co/logbrew/sdk/*.kt \
  -jvm-target 11 \
  -Xjdk-release=11 \
  -Werror \
  -d "$tmp_dir/classes"

kotlinc "$package_dir"/src/main/kotlin/co/logbrew/sdk/*.kt "$package_dir/tests/LogBrewKotlinTest.kt" \
  -jvm-target 11 \
  -Xjdk-release=11 \
  -Werror \
  -include-runtime \
  -d "$tmp_dir/logbrew-kotlin-tests.jar"
java -jar "$tmp_dir/logbrew-kotlin-tests.jar"

cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-kotlin/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
mkdir -p "$tmp_dir/jar-stage/examples"
cp -R "$package_dir/examples/readme_example" "$tmp_dir/jar-stage/examples/readme_example"
cp -R "$package_dir/examples/real_user_smoke" "$tmp_dir/jar-stage/examples/real_user_smoke"
cp "$package_dir/examples/Makefile" "$tmp_dir/jar-stage/examples/Makefile"
jar --create --file "$tmp_dir/logbrew-kotlin-0.1.0.jar" -C "$tmp_dir/classes" . -C "$tmp_dir/jar-stage" .
jar --list --file "$tmp_dir/logbrew-kotlin-0.1.0.jar" > "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewClient.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewAndroid.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransportRequest.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransportRequester.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/AndroidLogPriority.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/RecordingTransport.class$' "$tmp_dir/jar-contents.txt"
grep -q '^META-INF/maven/co.logbrew/logbrew-kotlin/pom.xml$' "$tmp_dir/jar-contents.txt"
grep -q '^README.md$' "$tmp_dir/jar-contents.txt"
grep -q '^examples/readme_example/ReadmeExample.kt$' "$tmp_dir/jar-contents.txt"
grep -q '^examples/real_user_smoke/RealUserSmoke.kt$' "$tmp_dir/jar-contents.txt"
grep -q '^examples/Makefile$' "$tmp_dir/jar-contents.txt"

python3 - "$tmp_dir/logbrew-kotlin-0.1.0.jar" <<'PY'
import sys
import zipfile

jar_path = sys.argv[1]
with zipfile.ZipFile(jar_path) as archive:
    readme = archive.read("README.md").decode()
    pom = archive.read("META-INF/maven/co.logbrew/logbrew-kotlin/pom.xml").decode()
for needle in (
    "co.logbrew:logbrew-kotlin:0.1.0",
    "HttpTransport",
    "https://api.logbrew.com/v1/events",
    "LOGBREW_API_KEY",
    "LogBrewAndroid.captureActivityStarted",
    "LogBrewAndroid.captureAndroidLog",
    "LogBrewAndroid.captureThrowable",
    "AndroidLogPriority.WARN",
):
    if needle not in readme:
        raise SystemExit(f"missing README guidance: {needle}")
for needle in ("<groupId>co.logbrew</groupId>", "<artifactId>logbrew-kotlin</artifactId>", "<version>0.1.0</version>"):
    if needle not in pom:
        raise SystemExit(f"missing pom metadata: {needle}")
PY

run_example() {
  local name="$1"
  local main_class="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  shift 4
  local jar_path="$tmp_dir/$name.jar"
  kotlinc "$@" \
    -classpath "$tmp_dir/logbrew-kotlin-0.1.0.jar" \
    -jvm-target 11 \
    -Xjdk-release=11 \
    -Werror \
    -include-runtime \
    -d "$jar_path"
  java -cp "$jar_path:$tmp_dir/logbrew-kotlin-0.1.0.jar" "$main_class" > "$stdout_path" 2> "$stderr_path"
}

run_example \
  readme-example \
  ReadmeExampleKt \
  "$tmp_dir/readme-example.stdout.json" \
  "$tmp_dir/readme-example.stderr.json" \
  "$package_dir/examples/readme_example/ReadmeExample.kt"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme-example.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme-example.stderr.json"

run_example \
  real-user-smoke \
  RealUserSmokeKt \
  "$tmp_dir/real-user-smoke.stdout.json" \
  "$tmp_dir/real-user-smoke.stderr.json" \
  "$package_dir/examples/readme_example/ReadmeExample.kt" \
  "$package_dir/examples/real_user_smoke/RealUserSmoke.kt"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/real-user-smoke.stderr.json"
grep -q '"androidHelperEvents":3' "$tmp_dir/real-user-smoke.stderr.json"
grep -q '"httpAttempts":1' "$tmp_dir/real-user-smoke.stderr.json"

make -C "$package_dir/examples" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"

echo "kotlin package checks passed"
