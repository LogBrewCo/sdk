#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/kotlin/logbrew-kotlin"
okhttp_package_dir="$repo_root/kotlin/logbrew-kotlin-okhttp"
tmp_dir="$(mktemp -d)"
lock_dir="${TMPDIR:-/tmp}/logbrewco-sdk-kotlin-checks.lock"
lock_pid_file="$lock_dir/pid"

# shellcheck source=scripts/kotlin_okhttp_deps.sh
source "$repo_root/scripts/kotlin_okhttp_deps.sh"

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
  find "$okhttp_package_dir" -type d \( -name build -o -name .gradle \) -prune -exec rm -rf {} + 2>/dev/null || true
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
mkdir -p "$tmp_dir/okhttp-jar-stage/META-INF/maven/co.logbrew/logbrew-kotlin-okhttp"

kotlinc "$package_dir"/src/main/kotlin/co/logbrew/sdk/*.kt \
  -jvm-target 11 \
  -Xjdk-release=11 \
  -Werror \
  -d "$tmp_dir/classes"

kotlinc "$package_dir"/src/main/kotlin/co/logbrew/sdk/*.kt "$package_dir"/tests/*.kt \
  -jvm-target 11 \
  -Xjdk-release=11 \
  -Werror \
  -include-runtime \
  -d "$tmp_dir/logbrew-kotlin-tests.jar"
java -jar "$tmp_dir/logbrew-kotlin-tests.jar"

okhttp_classpath="$tmp_dir/classes:$(fetch_kotlin_okhttp_deps "$tmp_dir/okhttp-deps")"
okhttp_sources=()
if [[ -d "$okhttp_package_dir/src/main/kotlin" ]]; then
  while IFS= read -r -d '' source_file; do
    okhttp_sources+=("$source_file")
  done < <(find "$okhttp_package_dir/src/main/kotlin" -name '*.kt' -print0 | sort -z)
fi
if [[ "${#okhttp_sources[@]}" -gt 0 ]]; then
  kotlinc "${okhttp_sources[@]}" \
    -classpath "$okhttp_classpath" \
    -jvm-target 11 \
    -Xjdk-release=11 \
    -Werror \
    -d "$tmp_dir/okhttp-classes"
  okhttp_classpath="$tmp_dir/okhttp-classes:$okhttp_classpath"
fi
kotlinc "$okhttp_package_dir"/tests/*.kt \
  -classpath "$okhttp_classpath" \
  -jvm-target 11 \
  -Xjdk-release=11 \
  -Werror \
  -include-runtime \
  -d "$tmp_dir/logbrew-kotlin-okhttp-tests.jar"
java -cp "$tmp_dir/logbrew-kotlin-okhttp-tests.jar:$okhttp_classpath" LogBrewOkHttpInterceptorTestsKt

python3 "$repo_root/scripts/check_maven_pom_metadata.py" \
  "$okhttp_package_dir/pom.xml" \
  --group-id co.logbrew \
  --artifact-id logbrew-kotlin-okhttp \
  --version 0.1.0

jar --create --file "$tmp_dir/logbrew-kotlin-okhttp-0.1.0-sources.jar" -C "$okhttp_package_dir/src/main/kotlin" .
jar --list --file "$tmp_dir/logbrew-kotlin-okhttp-0.1.0-sources.jar" > "$tmp_dir/okhttp-sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpCallbacks.kt$' "$tmp_dir/okhttp-sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpCallFactory.kt$' "$tmp_dir/okhttp-sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpInterceptor.kt$' "$tmp_dir/okhttp-sources-jar-contents.txt"

mkdir -p "$tmp_dir/okhttp-javadoc-stage"
cp "$okhttp_package_dir/README.md" "$tmp_dir/okhttp-javadoc-stage/README.md"
jar --create --file "$tmp_dir/logbrew-kotlin-okhttp-0.1.0-javadoc.jar" -C "$tmp_dir/okhttp-javadoc-stage" README.md
jar --list --file "$tmp_dir/logbrew-kotlin-okhttp-0.1.0-javadoc.jar" > "$tmp_dir/okhttp-javadoc-jar-contents.txt"
grep -q '^README.md$' "$tmp_dir/okhttp-javadoc-jar-contents.txt"

cp "$okhttp_package_dir/pom.xml" "$tmp_dir/okhttp-jar-stage/META-INF/maven/co.logbrew/logbrew-kotlin-okhttp/pom.xml"
cp "$okhttp_package_dir/README.md" "$tmp_dir/okhttp-jar-stage/README.md"
mkdir -p "$tmp_dir/okhttp-jar-stage/examples"
cp -R "$okhttp_package_dir/examples/okhttp_request" "$tmp_dir/okhttp-jar-stage/examples/okhttp_request"
jar --create --file "$tmp_dir/logbrew-kotlin-okhttp-0.1.0.jar" -C "$tmp_dir/okhttp-classes" . -C "$tmp_dir/okhttp-jar-stage" .
jar --list --file "$tmp_dir/logbrew-kotlin-okhttp-0.1.0.jar" > "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpCallbacks.class$' "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpCallbacks\$TracedCallback.class$' "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpCallFactory.class$' "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpCallFactory\$TracedCall.class$' "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpInterceptor.class$' "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpEventIdProvider.class$' "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpTimestampProvider.class$' "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^co/logbrew/sdk/okhttp/LogBrewOkHttpCaptureFailureHandler.class$' "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^META-INF/maven/co.logbrew/logbrew-kotlin-okhttp/pom.xml$' "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^README.md$' "$tmp_dir/okhttp-jar-contents.txt"
grep -q '^examples/okhttp_request/OkHttpRequestExample.kt$' "$tmp_dir/okhttp-jar-contents.txt"

python3 - "$tmp_dir/logbrew-kotlin-okhttp-0.1.0.jar" <<'PY'
import sys
import zipfile

jar_path = sys.argv[1]
with zipfile.ZipFile(jar_path) as archive:
    readme = archive.read("README.md").decode()
    pom = archive.read("META-INF/maven/co.logbrew/logbrew-kotlin-okhttp/pom.xml").decode()
for needle in (
    "co.logbrew:logbrew-kotlin-okhttp:0.1.0",
    "co.logbrew:logbrew-kotlin:0.1.0",
    "LogBrewOkHttpInterceptor",
    "LogBrewOkHttpCallbacks",
    "LogBrewOkHttpCallFactory",
    "LogBrewOkHttpCaptureFailureHandler",
    "enqueue",
    "dispatcher threads",
    "callback exceptions",
    "traceparent",
    "routeTemplate",
    "request or response bodies",
    "baggage",
    "tracestate",
):
    if needle not in readme:
        raise SystemExit(f"missing OkHttp README guidance: {needle}")
for needle in (
    "<artifactId>logbrew-kotlin-okhttp</artifactId>",
    "<artifactId>logbrew-kotlin</artifactId>",
    "<artifactId>okhttp</artifactId>",
    "<version>4.12.0</version>",
):
    if needle not in pom:
        raise SystemExit(f"missing OkHttp pom metadata: {needle}")
PY

python3 "$repo_root/scripts/check_maven_pom_metadata.py" \
  "$package_dir/pom.xml" \
  --group-id co.logbrew \
  --artifact-id logbrew-kotlin \
  --version 0.1.0

jar --create --file "$tmp_dir/logbrew-kotlin-0.1.0-sources.jar" -C "$package_dir/src/main/kotlin" .
jar --list --file "$tmp_dir/logbrew-kotlin-0.1.0-sources.jar" > "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewClient.kt$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewAndroid.kt$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewCoroutines.kt$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOpenTelemetry.kt$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing.kt$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTrace.kt$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/PublicTypes.kt$' "$tmp_dir/sources-jar-contents.txt"

mkdir -p "$tmp_dir/javadoc-stage"
cp "$package_dir/README.md" "$tmp_dir/javadoc-stage/README.md"
jar --create --file "$tmp_dir/logbrew-kotlin-0.1.0-javadoc.jar" -C "$tmp_dir/javadoc-stage" README.md
jar --list --file "$tmp_dir/logbrew-kotlin-0.1.0-javadoc.jar" > "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^README.md$' "$tmp_dir/javadoc-jar-contents.txt"

cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-kotlin/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
mkdir -p "$tmp_dir/jar-stage/examples"
cp -R "$package_dir/examples/readme_example" "$tmp_dir/jar-stage/examples/readme_example"
cp -R "$package_dir/examples/real_user_smoke" "$tmp_dir/jar-stage/examples/real_user_smoke"
cp -R "$package_dir/examples/trace_correlation" "$tmp_dir/jar-stage/examples/trace_correlation"
cp -R "$package_dir/examples/dependency_spans" "$tmp_dir/jar-stage/examples/dependency_spans"
cp "$package_dir/examples/Makefile" "$tmp_dir/jar-stage/examples/Makefile"
jar --create --file "$tmp_dir/logbrew-kotlin-0.1.0.jar" -C "$tmp_dir/classes" . -C "$tmp_dir/jar-stage" .
jar --list --file "$tmp_dir/logbrew-kotlin-0.1.0.jar" > "$tmp_dir/jar-contents.txt"
if grep -q '^co/logbrew/sdk/okhttp/' "$tmp_dir/jar-contents.txt"; then
  echo "core Kotlin jar must not contain optional OkHttp integration classes" >&2
  exit 1
fi
grep -q '^co/logbrew/sdk/LogBrewClient.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewAndroid.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTrace.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTraceContext.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTraceScope.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewCoroutines.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOpenTelemetry.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOpenTelemetrySpanContext.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/DatabaseOperation.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/CacheOperation.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/QueueOperation.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/SpanEventSummary.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/AndroidRequestSpan.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/AndroidLifecycleTracker.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewHeaderSetter.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransportRequest.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransportRequester.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/MetricAttributes.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/AndroidLogPriority.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/RecordingTransport.class$' "$tmp_dir/jar-contents.txt"
grep -q '^META-INF/maven/co.logbrew/logbrew-kotlin/pom.xml$' "$tmp_dir/jar-contents.txt"
grep -q '^README.md$' "$tmp_dir/jar-contents.txt"
grep -q '^examples/readme_example/ReadmeExample.kt$' "$tmp_dir/jar-contents.txt"
grep -q '^examples/real_user_smoke/RealUserSmoke.kt$' "$tmp_dir/jar-contents.txt"
grep -q '^examples/trace_correlation/TraceCorrelation.kt$' "$tmp_dir/jar-contents.txt"
grep -q '^examples/dependency_spans/DependencySpans.kt$' "$tmp_dir/jar-contents.txt"
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
    "MetricAttributes",
    "metric(...)",
    "LogBrewAndroid.captureActivityStarted",
    "LogBrewAndroid.captureAndroidLog",
    "LogBrewAndroid.captureThrowable",
    "AndroidLogPriority.WARN",
    "LogBrewTrace",
    "LogBrewOpenTelemetry",
    "LogBrewOpenTelemetrySpanContext",
    "LogBrewCoroutines",
    "LogBrewOperationTracing",
    "DatabaseOperation",
    "CacheOperation",
    "QueueOperation",
    "SpanEventSummary",
    "databaseOperation",
    "cacheOperation",
    "queueOperation",
    "type-only `exception` event",
    "dbStatementTemplate",
    "payload-like values",
    "traceContextElement",
    "currentTraceContextElement",
    "spanContextFromCurrentSpan",
    "spanContextFromSpan",
    "spanContextFromContext",
    "fromOpenTelemetrySpanContext",
    "traceparent",
    "LogBrewAndroid.startRequestSpan",
    "LogBrewAndroid.captureRequestSpan",
    "LogBrewAndroid.createLifecycleTracker",
    "AndroidLifecycleTracker",
    "captureTransition",
    "android.lifecycle",
    "applyHeadersTo",
    "withHttpURLConnectionSpan",
    "withTrace",
    "HttpURLConnection",
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
grep -q '"androidLifecycleSpans":1' "$tmp_dir/real-user-smoke.stderr.json"
grep -q '"metricEvents":1' "$tmp_dir/real-user-smoke.stderr.json"
grep -q '"httpAttempts":1' "$tmp_dir/real-user-smoke.stderr.json"

make -C "$package_dir/examples" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"
grep -qx 'run-trace-correlation -> make run-trace-correlation' "$tmp_dir/examples-help.txt"
grep -qx 'run-dependency-spans -> make run-dependency-spans' "$tmp_dir/examples-help.txt"

run_example \
  dependency-spans \
  DependencySpansKt \
  "$tmp_dir/dependency-spans.stdout.json" \
  "$tmp_dir/dependency-spans.stderr.json" \
  "$package_dir/examples/dependency_spans/DependencySpans.kt"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/dependency-spans.stdout.json" >/dev/null
grep -q '"dependencySpans":3' "$tmp_dir/dependency-spans.stderr.json"

run_example \
  trace-correlation \
  TraceCorrelationKt \
  "$tmp_dir/trace-correlation.stdout.json" \
  "$tmp_dir/trace-correlation.stderr.json" \
  "$package_dir/examples/trace_correlation/TraceCorrelation.kt"
python3 "$repo_root/scripts/check_kotlin_trace_correlation_payload.py" \
  "$tmp_dir/trace-correlation.stdout.json" \
  "$tmp_dir/trace-correlation.stderr.json"

echo "kotlin package checks passed"
