#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/java/logbrew-java"
tmp_dir="$(mktemp -d)"

# shellcheck source=scripts/java_logback_deps.sh
source "$repo_root/scripts/java_logback_deps.sh"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

main_sources="$tmp_dir/main-sources.txt"
test_sources="$tmp_dir/test-sources.txt"
example_sources="$tmp_dir/example-sources.txt"

find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"
find "$package_dir/src/test/java" -name '*.java' | sort > "$test_sources"
find "$package_dir/examples" -name '*.java' | sort > "$example_sources"

mkdir -p "$tmp_dir/classes" "$tmp_dir/test-classes" "$tmp_dir/example-classes" "$tmp_dir/javadoc" "$tmp_dir/jar-stage"
java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"

javac -Xlint:all -Werror --release 11 -cp "$java_logback_classpath" -d "$tmp_dir/classes" @"$main_sources"
javac -Xlint:all -Werror --release 11 -cp "$tmp_dir/classes:$java_logback_classpath" -d "$tmp_dir/test-classes" @"$test_sources"
java -cp "$tmp_dir/classes:$tmp_dir/test-classes:$java_logback_classpath" co.logbrew.sdk.LogBrewClientTest
java -cp "$tmp_dir/classes:$tmp_dir/test-classes:$java_logback_classpath" co.logbrew.sdk.LogBrewTraceTest
java -cp "$tmp_dir/classes:$tmp_dir/test-classes:$java_logback_classpath" co.logbrew.sdk.SpanEventSummaryTest
java -cp "$tmp_dir/classes:$tmp_dir/test-classes:$java_logback_classpath" co.logbrew.sdk.LogBrewOperationTracingTest
java -cp "$tmp_dir/classes:$tmp_dir/test-classes:$java_logback_classpath" co.logbrew.sdk.SupportTicketDraftTest

python3 "$repo_root/scripts/check_maven_pom_metadata.py" \
  "$package_dir/pom.xml" \
  --group-id co.logbrew \
  --artifact-id logbrew-sdk \
  --version 0.1.0

javadoc -quiet -Xdoclint:all,-missing -Werror --release 11 -classpath "$java_logback_classpath" -d "$tmp_dir/javadoc" @"$main_sources"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/LogBrewClient.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/HttpTransport.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/MetricAttributes.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/ProductTimeline.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/Traceparent.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/LogBrewTraceContext.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/LogBrewTrace.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/SpanEventSummary.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/LogBrewHttpRequestTelemetry.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/LogBrewOperationTracing.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/SupportTicketDraft.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/LogBrewJulHandler.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/LogBrewLogbackAppender.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/RecordingTransport.html"
test -f "$tmp_dir/javadoc/co/logbrew/sdk/SdkException.html"

jar --create --file "$tmp_dir/logbrew-sdk-0.1.0-sources.jar" -C "$package_dir/src/main/java" .
jar --list --file "$tmp_dir/logbrew-sdk-0.1.0-sources.jar" > "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewClient.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/MetricAttributes.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/Traceparent.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTraceContext.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTrace.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/SpanEventSummary.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewHttpRequestTelemetry.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/SupportTicketDraft.java$' "$tmp_dir/sources-jar-contents.txt"
grep -q '^co/logbrew/sdk/package-info.java$' "$tmp_dir/sources-jar-contents.txt"

jar --create --file "$tmp_dir/logbrew-sdk-0.1.0-javadoc.jar" -C "$tmp_dir/javadoc" .
jar --list --file "$tmp_dir/logbrew-sdk-0.1.0-javadoc.jar" > "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^index.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewClient.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/MetricAttributes.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/Traceparent.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTraceContext.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTrace.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/SpanEventSummary.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewHttpRequestTelemetry.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing.html$' "$tmp_dir/javadoc-jar-contents.txt"
grep -q '^co/logbrew/sdk/SupportTicketDraft.html$' "$tmp_dir/javadoc-jar-contents.txt"

mkdir -p "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
jar --create --file "$tmp_dir/logbrew-sdk-0.1.0.jar" -C "$tmp_dir/jar-stage" .
jar --list --file "$tmp_dir/logbrew-sdk-0.1.0.jar" > "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewClient.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport\$Builder.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/MetricAttributes.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline\$ProductAction.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline\$NetworkMilestone.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/Traceparent.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/Traceparent\$Context.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/Traceparent\$SpanInput.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTraceContext.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTrace.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTrace\$Scope.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/SpanEventSummary.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewHttpRequestTelemetry.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing\$DatabaseOperation.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing\$CacheOperation.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing\$QueueOperation.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/SupportTicketDraft.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/SupportTicketDraft\$Input.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewJulHandler.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewLogbackAppender.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/RecordingTransport.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/SdkException.class$' "$tmp_dir/jar-contents.txt"
grep -q '^META-INF/maven/co.logbrew/logbrew-sdk/pom.xml$' "$tmp_dir/jar-contents.txt"
grep -q '^README.md$' "$tmp_dir/jar-contents.txt"
grep -q 'MetricAttributes' "$package_dir/README.md"
grep -q 'ProductTimeline' "$package_dir/README.md"
grep -q 'Traceparent' "$package_dir/README.md"
grep -q 'LogBrewTraceContext' "$package_dir/README.md"
grep -q 'LogBrewHttpRequestTelemetry' "$package_dir/README.md"
grep -q 'LogBrewOperationTracing' "$package_dir/README.md"
grep -q 'SupportTicketDraft' "$package_dir/README.md"
grep -q 'first useful LogBrew payload' "$package_dir/README.md"
grep -q 'without visual replay, HTTP client patching, request/response payload capture, or header capture' "$package_dir/README.md"
grep -q 'This SDK does not automatically collect JVM, runtime, or framework metrics yet.' "$package_dir/README.md"

javac -Xlint:all -Werror --release 11 -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$java_logback_classpath" -d "$tmp_dir/example-classes" @"$example_sources"
java -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$tmp_dir/example-classes:$java_logback_classpath" ReadmeExample > "$tmp_dir/readme-example.stdout.json" 2> "$tmp_dir/readme-example.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme-example.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme-example.stderr.json"
grep -q '"status":202' "$tmp_dir/readme-example.stderr.json"

java -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$tmp_dir/example-classes:$java_logback_classpath" RealUserSmoke > "$tmp_dir/real-user-smoke.stdout.json" 2> "$tmp_dir/real-user-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/real-user-smoke.stderr.json"
grep -q '"retryAttempts":2' "$tmp_dir/real-user-smoke.stderr.json"

java -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$tmp_dir/example-classes:$java_logback_classpath" FirstUsefulTelemetry > "$tmp_dir/first-useful.stdout.json" 2> "$tmp_dir/first-useful.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/first-useful.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_java_first_useful_payload.py" "$tmp_dir/first-useful.stdout.json" "$tmp_dir/first-useful.stderr.json" >/dev/null

java -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$tmp_dir/example-classes:$java_logback_classpath" HttpTraceCorrelation > "$tmp_dir/http-trace.stdout.json" 2> "$tmp_dir/http-trace.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/http-trace.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_java_http_trace_payload.py" "$tmp_dir/http-trace.stdout.json" "$tmp_dir/http-trace.stderr.json" >/dev/null

make -C "$package_dir/examples" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run-first-useful-telemetry -> make run-first-useful-telemetry' "$tmp_dir/examples-help.txt"
grep -qx 'run-http-trace-correlation -> make run-http-trace-correlation' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"

echo "java package checks passed"
