#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/kotlin/logbrew-kotlin"
tmp_dir="$(mktemp -d)"
lock_dir="${TMPDIR:-/tmp}/logbrewco-sdk-kotlin-checks.lock"
lock_pid_file="$lock_dir/pid"
intake_pid=""

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
  if [[ -n "$intake_pid" ]]; then
    kill "$intake_pid" 2>/dev/null || true
    wait "$intake_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
  clean_generated_artifacts
  rmdir "$lock_dir" 2>/dev/null || true
}

trap clean_after_run EXIT

if ! acquire_lock; then
  echo "another Kotlin SDK verifier run is already in progress" >&2
  exit 1
fi

mkdir -p "$tmp_dir/classes" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-kotlin"
kotlinc "$package_dir"/src/main/kotlin/co/logbrew/sdk/*.kt \
  -jvm-target 11 \
  -Xjdk-release=11 \
  -Werror \
  -d "$tmp_dir/classes"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-kotlin/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
mkdir -p "$tmp_dir/jar-stage/examples"
cp -R "$package_dir/examples/readme_example" "$tmp_dir/jar-stage/examples/readme_example"
cp -R "$package_dir/examples/real_user_smoke" "$tmp_dir/jar-stage/examples/real_user_smoke"
cp -R "$package_dir/examples/trace_correlation" "$tmp_dir/jar-stage/examples/trace_correlation"
cp "$package_dir/examples/Makefile" "$tmp_dir/jar-stage/examples/Makefile"
jar --create --file "$tmp_dir/logbrew-kotlin-0.1.0.jar" -C "$tmp_dir/classes" . -C "$tmp_dir/jar-stage" .
jar --list --file "$tmp_dir/logbrew-kotlin-0.1.0.jar" > "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTrace.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTraceContext.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransportRequest.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransportRequester.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/MetricAttributes.class$' "$tmp_dir/jar-contents.txt"

maven_dir="$tmp_dir/maven/co/logbrew/logbrew-kotlin/0.1.0"
mkdir -p "$maven_dir"
cp "$tmp_dir/logbrew-kotlin-0.1.0.jar" "$maven_dir/logbrew-kotlin-0.1.0.jar"
cp "$package_dir/pom.xml" "$maven_dir/logbrew-kotlin-0.1.0.pom"

gradle_app="$tmp_dir/gradle-app"
mkdir -p "$gradle_app/src/main/java/app"
cat > "$gradle_app/settings.gradle" <<'EOF'
rootProject.name = "kotlin-lifecycle-app"
EOF
cat > "$gradle_app/build.gradle" <<EOF
plugins {
    id 'java'
}

repositories {
    maven {
        url = uri('$tmp_dir/maven')
    }
}

dependencies {
    implementation 'co.logbrew:logbrew-kotlin:0.1.0'
}
EOF
cat > "$gradle_app/src/main/java/app/LifecycleApp.java" <<'JAVA'
package app;

import co.logbrew.sdk.LogBrewClient;

public final class LifecycleApp {
    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.Companion.create("LOGBREW_API_KEY", "gradle-app", "0.1.0", 2);
        if (client.pendingEvents() != 0) {
            throw new IllegalStateException("expected empty queue");
        }
    }
}
JAVA
(cd "$gradle_app" && gradle --no-daemon -q dependencies --configuration runtimeClasspath > "$tmp_dir/gradle-deps.txt")
grep -q 'co.logbrew:logbrew-kotlin:0.1.0' "$tmp_dir/gradle-deps.txt"
(cd "$gradle_app" && gradle --no-daemon -q compileJava)
python3 - "$gradle_app/build.gradle" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace("    implementation 'co.logbrew:logbrew-kotlin:0.1.0'\n", "")
path.write_text(text)
if "co.logbrew:logbrew-kotlin" in path.read_text():
    raise SystemExit("dependency removal failed")
path.write_text(text.replace("dependencies {\n", "dependencies {\n    implementation 'co.logbrew:logbrew-kotlin:0.1.0'\n"))
if "co.logbrew:logbrew-kotlin:0.1.0" not in path.read_text():
    raise SystemExit("dependency re-add failed")
PY
(cd "$gradle_app" && gradle --no-daemon -q dependencies --configuration runtimeClasspath > "$tmp_dir/gradle-deps-readded.txt")
grep -q 'co.logbrew:logbrew-kotlin:0.1.0' "$tmp_dir/gradle-deps-readded.txt"

extract_dir="$tmp_dir/extracted-jar"
mkdir -p "$extract_dir"
(cd "$extract_dir" && jar --extract --file "$tmp_dir/logbrew-kotlin-0.1.0.jar")
test -f "$extract_dir/README.md"
test -f "$extract_dir/examples/readme_example/ReadmeExample.kt"
test -f "$extract_dir/examples/real_user_smoke/RealUserSmoke.kt"
test -f "$extract_dir/examples/trace_correlation/TraceCorrelation.kt"
test -f "$extract_dir/examples/Makefile"
grep -q 'HttpTransport' "$extract_dir/README.md"
grep -q 'captureProductAction' "$extract_dir/README.md"
grep -q 'captureNetworkMilestone' "$extract_dir/README.md"
grep -q 'LogBrewTrace' "$extract_dir/README.md"

run_app() {
  local name="$1"
  local main_class="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  shift 4
  local app_jar="$tmp_dir/$name.jar"
  kotlinc "$@" \
    -classpath "$maven_dir/logbrew-kotlin-0.1.0.jar" \
    -jvm-target 11 \
    -Xjdk-release=11 \
    -Werror \
    -include-runtime \
    -d "$app_jar"
  java -cp "$app_jar:$maven_dir/logbrew-kotlin-0.1.0.jar" "$main_class" > "$stdout_path" 2> "$stderr_path"
}

run_app \
  installed-readme \
  ReadmeExampleKt \
  "$tmp_dir/installed-readme.stdout.json" \
  "$tmp_dir/installed-readme.stderr.json" \
  "$extract_dir/examples/readme_example/ReadmeExample.kt"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/installed-readme.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/installed-readme.stderr.json"

run_app \
  installed-smoke \
  RealUserSmokeKt \
  "$tmp_dir/installed-smoke.stdout.json" \
  "$tmp_dir/installed-smoke.stderr.json" \
  "$extract_dir/examples/readme_example/ReadmeExample.kt" \
  "$extract_dir/examples/real_user_smoke/RealUserSmoke.kt"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/installed-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/installed-smoke.stderr.json"
grep -q '"androidHelperEvents":3' "$tmp_dir/installed-smoke.stderr.json"
grep -q '"androidTimelineEvents":2' "$tmp_dir/installed-smoke.stderr.json"
grep -q '"androidNetworkAction":"POST /api/checkout"' "$tmp_dir/installed-smoke.stderr.json"

run_app \
  installed-trace-correlation \
  TraceCorrelationKt \
  "$tmp_dir/installed-trace-correlation.stdout.json" \
  "$tmp_dir/installed-trace-correlation.stderr.json" \
  "$extract_dir/examples/trace_correlation/TraceCorrelation.kt"
python3 "$repo_root/scripts/check_kotlin_trace_correlation_payload.py" \
  "$tmp_dir/installed-trace-correlation.stdout.json" \
  "$tmp_dir/installed-trace-correlation.stderr.json"

smoke_app="$tmp_dir/smoke-app"
mkdir -p "$smoke_app"
cat > "$smoke_app/SmokeApp.kt" <<'KT'
import co.logbrew.sdk.ActionAttributes
import co.logbrew.sdk.AndroidContext
import co.logbrew.sdk.AndroidLogPriority
import co.logbrew.sdk.EnvironmentAttributes
import co.logbrew.sdk.HttpTransport
import co.logbrew.sdk.IssueAttributes
import co.logbrew.sdk.LogAttributes
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.MetricAttributes
import co.logbrew.sdk.RecordingTransport
import co.logbrew.sdk.ReleaseAttributes
import co.logbrew.sdk.SdkException
import co.logbrew.sdk.SpanAttributes
import co.logbrew.sdk.TransportException

fun newClient(maxRetries: Int = 2): LogBrewClient =
    LogBrewClient.create("LOGBREW_API_KEY", "kotlin-smoke-app", "0.1.0", maxRetries)

fun enqueueAll(client: LogBrewClient) {
    client.release("evt_release_001", "2026-06-02T10:00:00Z", ReleaseAttributes.create("1.2.3").withCommit("abc123def456").withNotes("Public release marker"))
    client.environment("evt_environment_001", "2026-06-02T10:00:01Z", EnvironmentAttributes.create("production").withRegion("global"))
    client.issue("evt_issue_001", "2026-06-02T10:00:02Z", IssueAttributes.create("Checkout timeout", "error").withMessage("Request timed out after retry budget"))
    client.log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes.create("worker started", "info").withLogger("job-runner"))
    client.span("evt_span_001", "2026-06-02T10:00:04Z", SpanAttributes.create("GET /health", "trace_001", "span_001", "ok").withDurationMs(12.5))
    client.action("evt_action_001", "2026-06-02T10:00:05Z", ActionAttributes.create("deploy", "success"))
}

fun expect(code: String, block: () -> Unit) {
    try {
        block()
    } catch (error: SdkException) {
        check(error.code == code)
        return
    }
    error("expected $code")
}

fun main() {
    val happy = newClient()
    enqueueAll(happy)
    println(happy.previewJson())
    val response = happy.flush(RecordingTransport.alwaysAccept())
    check(response.statusCode == 202)
    check(response.attempts == 1)
    check(happy.pendingEvents() == 0)

    val empty = happy.flush(RecordingTransport.alwaysAccept())
    check(empty.statusCode == 204)
    check(empty.attempts == 0)

    expect("validation_error") {
        happy.log("evt_bad", "2026-06-02T10:00:03", LogAttributes.create("worker started", "info"))
    }

    val unauthenticated = newClient()
    enqueueAll(unauthenticated)
    expect("unauthenticated") {
        unauthenticated.flush(RecordingTransport(listOf(401)))
    }
    check(unauthenticated.pendingEvents() == 6)

    val retry = newClient()
    enqueueAll(retry)
    val retryResponse = retry.flush(RecordingTransport(listOf(TransportException.network("temporary outage"), 202)))
    check(retryResponse.attempts == 2)

    val exhausted = newClient(maxRetries = 1)
    enqueueAll(exhausted)
    expect("network_failure") {
        exhausted.flush(RecordingTransport(listOf(TransportException.network("temporary outage"), TransportException.network("still down"))))
    }
    check(exhausted.pendingEvents() == 6)

    val nonRetryable = newClient()
    enqueueAll(nonRetryable)
    expect("transport_error") {
        nonRetryable.flush(RecordingTransport(listOf(400)))
    }
    check(nonRetryable.pendingEvents() == 6)

    val metric = newClient()
    metric.metric(
        "evt_metric_001",
        "2026-06-02T10:00:06Z",
        MetricAttributes.create("queue.depth", "gauge", 42.0, "{items}", "instant").withMetadata(mapOf("queue" to "checkout")),
    )
    val metricPreview = metric.previewJson()
    check("\"type\": \"metric\"" in metricPreview)
    check("\"name\": \"queue.depth\"" in metricPreview)
    check("\"queue\": \"checkout\"" in metricPreview)
    expect("validation_error") {
        metric.metric(
            "evt_metric_bad_temporality",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("queue.depth", "gauge", 2.0, "{items}", "delta"),
        )
    }

    val helper = newClient()
    val context = AndroidContext.create()
        .withActivityName("MainActivity")
        .withScreenName("Checkout")
        .withDeviceModel("Pixel")
        .withOsVersion("Android 15")
        .withSessionId("session_001")
    LogBrewAndroid.captureActivityStarted(helper, "evt_activity_started_001", "2026-06-02T10:00:06Z", "MainActivity", context)
    LogBrewAndroid.captureAndroidLog(
        helper,
        "evt_android_log_001",
        "2026-06-02T10:00:07Z",
        AndroidLogPriority.INFO,
        "Checkout",
        "button clicked",
        IllegalStateException("tap handler warning"),
        context,
    )
    LogBrewAndroid.captureThrowable(
        helper,
        "evt_android_exception_001",
        "2026-06-02T10:00:08Z",
        IllegalStateException("checkout failed"),
        context,
    )
    val helperPreview = helper.previewJson()
    check("\"activityName\": \"MainActivity\"" in helperPreview)
    check("\"androidPriority\": \"INFO\"" in helperPreview)
    check("\"androidPriorityNumber\": 4" in helperPreview)
    check("\"throwableName\": \"IllegalStateException\"" in helperPreview)
    check("\"throwableStackTrace\"" !in helperPreview)

    val timeline = newClient()
    LogBrewAndroid.captureProductAction(
        timeline,
        "evt_android_action_001",
        "2026-06-02T10:00:09Z",
        "checkout.submit",
        context = context,
        metadata = mapOf("funnel" to "checkout", "step" to "submit", "traceId" to "trace_android_001"),
    )
    LogBrewAndroid.captureNetworkMilestone(
        timeline,
        "evt_android_network_001",
        "2026-06-02T10:00:10Z",
        "post",
        "https://mobile.example.test/api/checkout?itemId=123#pay",
        statusCode = 503,
        durationMs = 42.5,
        context = context,
        metadata = mapOf("funnel" to "checkout", "traceId" to "trace_android_001"),
    )
    val timelinePreview = timeline.previewJson()
    check("\"source\": \"android.action\"" in timelinePreview)
    check("\"source\": \"android.network\"" in timelinePreview)
    check("\"name\": \"POST /api/checkout\"" in timelinePreview)
    check("\"status\": \"failure\"" in timelinePreview)
    check("\"routeTemplate\": \"/api/checkout\"" in timelinePreview)
    check("\"durationMs\": 42.5" in timelinePreview)
    check("?itemId" !in timelinePreview)
    check("#pay" !in timelinePreview)
    expect("validation_error") {
        LogBrewAndroid.captureProductAction(
            newClient(),
            "evt_android_action_bad_metadata",
            "2026-06-02T10:00:11Z",
            "checkout.submit",
            metadata = mapOf("nested" to mapOf("unsafe" to true)),
        )
    }
    expect("validation_error") {
        LogBrewAndroid.captureNetworkMilestone(
            newClient(),
            "evt_android_network_bad_duration",
            "2026-06-02T10:00:12Z",
            "GET",
            "/api/cart",
            durationMs = -1.0,
        )
    }
    expect("validation_error") {
        LogBrewAndroid.captureNetworkMilestone(
            newClient(),
            "evt_android_network_bad_status",
            "2026-06-02T10:00:12Z",
            "GET",
            "/api/cart",
            statusCode = 99,
        )
    }

    val httpEndpoint = System.getenv("LOGBREW_KOTLIN_HTTP_ENDPOINT") ?: error("missing HTTP endpoint")
    val http = newClient(maxRetries = 1)
    http.log(
        "evt_kotlin_http_transport",
        "2026-06-02T10:00:09Z",
        LogAttributes.create("kotlin http transport sent", "info").withLogger("kotlin-http"),
    )
    val httpResponse = http.flush(
        HttpTransport(
            endpoint = httpEndpoint,
            headers = mapOf("x-logbrew-source" to "kotlin-smoke-app"),
            connectTimeoutMillis = 5_000,
            readTimeoutMillis = 5_000,
        ),
    )
    check(httpResponse.statusCode == 202)
    check(httpResponse.attempts == 2)
    check(http.pendingEvents() == 0)

    val closed = newClient()
    enqueueAll(closed)
    closed.shutdown(RecordingTransport.alwaysAccept())
    expect("shutdown_error") {
        closed.action("evt_action_002", "2026-06-02T10:00:06Z", ActionAttributes.create("deploy", "success"))
    }

    System.err.println("""{"ok":true,"status":202,"attempts":1,"events":6,"metricEvents":1,"androidHelperEvents":3,"androidTimelineEvents":2,"androidNetworkAction":"POST /api/checkout","httpAttempts":${httpResponse.attempts}}""")
}
KT

intake_port="$(python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
cat > "$tmp_dir/kotlin_intake.py" <<'PY'
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

port = int(sys.argv[1])
ready_path = Path(sys.argv[2])
log_path = Path(sys.argv[3])


class Handler(BaseHTTPRequestHandler):
    count = 0

    def do_POST(self):
        content_length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(content_length).decode("utf-8")
        Handler.count += 1
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "authorization": self.headers.get("authorization"),
                "body": body,
                "contentType": self.headers.get("content-type"),
                "source": self.headers.get("x-logbrew-source"),
                "path": self.path,
            }) + "\n")
        self.send_response(503 if Handler.count == 1 else 202)
        self.end_headers()
        self.wfile.write(b"accepted")

    def log_message(self, _format, *_args):
        return


server = HTTPServer(("127.0.0.1", port), Handler)
ready_path.write_text("ready", encoding="utf-8")
while Handler.count < 2:
    server.handle_request()
PY
intake_ready="$tmp_dir/intake.ready"
intake_log="$tmp_dir/intake.jsonl"
python3 "$tmp_dir/kotlin_intake.py" "$intake_port" "$intake_ready" "$intake_log" &
intake_pid="$!"
for _attempt in {1..50}; do
  if [[ -f "$intake_ready" ]]; then
    break
  fi
  sleep 0.1
done
test -f "$intake_ready"

LOGBREW_KOTLIN_HTTP_ENDPOINT="http://127.0.0.1:$intake_port/v1/events" \
run_app \
  smoke-app \
  SmokeAppKt \
  "$tmp_dir/smoke-app.stdout.json" \
  "$tmp_dir/smoke-app.stderr.json" \
  "$smoke_app/SmokeApp.kt"
wait "$intake_pid"
intake_pid=""
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke-app.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/smoke-app.stderr.json"
grep -q '"metricEvents":1' "$tmp_dir/smoke-app.stderr.json"
grep -q '"androidHelperEvents":3' "$tmp_dir/smoke-app.stderr.json"
grep -q '"androidTimelineEvents":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"androidNetworkAction":"POST /api/checkout"' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/smoke-app.stderr.json"
python3 - "$intake_log" <<'PY'
import json
import sys
from pathlib import Path

requests = [
    json.loads(line)
    for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
]
if len(requests) != 2:
    raise SystemExit(f"expected 2 HTTP delivery attempts, got {len(requests)}")
for request in requests:
    if request["authorization"] != "Bearer LOGBREW_API_KEY":
        raise SystemExit(f"unexpected authorization header: {request['authorization']}")
    if request["contentType"] != "application/json":
        raise SystemExit(f"unexpected content type: {request['contentType']}")
    if request["source"] != "kotlin-smoke-app":
        raise SystemExit(f"unexpected source header: {request['source']}")
    if request["path"] != "/v1/events":
        raise SystemExit(f"unexpected intake path: {request['path']}")
if "evt_kotlin_http_transport" not in requests[1]["body"]:
    raise SystemExit("missing HTTP transport event in final request body")
PY

echo "kotlin real-user smoke passed"
