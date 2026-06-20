#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/c/logbrew-c"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

on_error() {
  local status=$?
  echo "real_user_c_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
  for diagnostic in \
    "$tmp_dir/examples-help.txt" \
    "$tmp_dir/native-app.stdout.json" \
    "$tmp_dir/native-app.stderr.json" \
    "$tmp_dir/readme-example.stdout.json" \
    "$tmp_dir/readme-example.stderr.json" \
    "$tmp_dir/real-user-smoke.stdout.json" \
    "$tmp_dir/real-user-smoke.stderr.json" \
    "$tmp_dir/http-app.stdout.json" \
    "$tmp_dir/http-app.stderr.json" \
    "$tmp_dir/http-intake.stdout" \
    "$tmp_dir/http-intake.stderr" \
    "$tmp_dir/http-intake.jsonl"; do
    if [[ -f "$diagnostic" ]]; then
      echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
      sed -n '1,80p' "$diagnostic" >&2
    fi
  done
  exit "$status"
}

trap remove_tmp_dir EXIT
trap on_error ERR

cc_command="${CC:-}"
if [[ -z "$cc_command" ]]; then
  if command -v clang >/dev/null 2>&1; then
    cc_command="clang"
  else
    cc_command="cc"
  fi
fi

run_examples_make() {
  make --no-print-directory -C "$sdk_dir/examples" CC="$cc_command" "$@"
}

archive="$tmp_dir/logbrew-c-0.1.0.tar.gz"
(cd "$package_dir" && tar -czf "$archive" README.md Makefile include src examples tests)

app_dir="$tmp_dir/native-app"
sdk_dir="$app_dir/vendor/logbrew-c"
mkdir -p "$sdk_dir"
tar -xzf "$archive" -C "$sdk_dir"
test -f "$sdk_dir/include/logbrew.h"
test -f "$sdk_dir/src/logbrew.c"
test -f "$sdk_dir/src/logbrew_http_transport.c"
test -f "$sdk_dir/src/logbrew_internal.h"
test -f "$sdk_dir/src/logbrew_metric.c"
test -f "$sdk_dir/src/logbrew_recording_transport.c"
test -f "$sdk_dir/src/logbrew_timeline.c"
test -f "$sdk_dir/src/logbrew_trace.c"
test -f "$sdk_dir/examples/trace_correlation.c"

rm -rf "$sdk_dir"
if [[ -d "$sdk_dir" ]]; then
  echo "dependency removal failed" >&2
  exit 1
fi
mkdir -p "$sdk_dir"
tar -xzf "$archive" -C "$sdk_dir"
test -f "$sdk_dir/include/logbrew.h"
test -f "$sdk_dir/src/logbrew.c"
test -f "$sdk_dir/src/logbrew_http_transport.c"
test -f "$sdk_dir/src/logbrew_internal.h"
test -f "$sdk_dir/src/logbrew_metric.c"
test -f "$sdk_dir/src/logbrew_recording_transport.c"
test -f "$sdk_dir/src/logbrew_timeline.c"
test -f "$sdk_dir/src/logbrew_trace.c"
test -f "$sdk_dir/examples/trace_correlation.c"
grep -q 'logbrew_client_product_action' "$sdk_dir/include/logbrew.h"
grep -q 'logbrew_client_network_milestone' "$sdk_dir/include/logbrew.h"
grep -q 'LogBrewMetricAttributes' "$sdk_dir/include/logbrew.h"
grep -q 'logbrew_client_metric' "$sdk_dir/include/logbrew.h"
grep -q 'LogBrewTraceContext' "$sdk_dir/include/logbrew.h"
grep -q 'LogBrewHttpClientSpan' "$sdk_dir/include/logbrew.h"
grep -q 'logbrew_trace_context_from_traceparent' "$sdk_dir/include/logbrew.h"
grep -q 'logbrew_trace_http_client_span_start' "$sdk_dir/include/logbrew.h"
grep -q 'logbrew_trace_http_client_span_attributes' "$sdk_dir/include/logbrew.h"
grep -q 'logbrew_trace_scope_enter' "$sdk_dir/include/logbrew.h"
grep -q 'logbrew_http_transport_init' "$sdk_dir/include/logbrew.h"

cat > "$app_dir/main.c" <<'EOF'
#include "logbrew.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void must(LogBrewStatus status, const LogBrewError *error) {
  if (status != LOGBREW_OK) {
    fprintf(stderr, "%s: %s\n", error->code, error->message);
    exit(1);
  }
}

static LogBrewClient *new_client(void) {
  LogBrewClient *client = NULL;
  LogBrewError error;
  LogBrewConfig config = {"LOGBREW_API_KEY", "native-app", LOGBREW_C_VERSION, 2U};
  logbrew_error_clear(&error);
  must(logbrew_client_new(config, &client, &error), &error);
  return client;
}

static void queue_events(LogBrewClient *client) {
  LogBrewError error;
  LogBrewSpanAttributes span = {"GET /health", "trace_001", "span_001", NULL, "ok", 12.5, true};
  logbrew_error_clear(&error);
  must(logbrew_client_release(client, "evt_release_001", "2026-06-02T10:00:00Z",
      (LogBrewReleaseAttributes){"1.2.3", "abc123def456", "Public release marker"}, &error), &error);
  must(logbrew_client_environment(client, "evt_environment_001", "2026-06-02T10:00:01Z",
      (LogBrewEnvironmentAttributes){"production", "global"}, &error), &error);
  must(logbrew_client_issue(client, "evt_issue_001", "2026-06-02T10:00:02Z",
      (LogBrewIssueAttributes){"Checkout timeout", "error", "Request timed out after retry budget"}, &error), &error);
  must(logbrew_client_log(client, "evt_log_001", "2026-06-02T10:00:03Z",
      (LogBrewLogAttributes){"worker started", "info", "job-runner"}, &error), &error);
  must(logbrew_client_span(client, "evt_span_001", "2026-06-02T10:00:04Z", span, &error), &error);
  must(logbrew_client_action(client, "evt_action_001", "2026-06-02T10:00:05Z",
      (LogBrewActionAttributes){"deploy", "success"}, &error), &error);
}

static void exercise_failure_paths(void) {
  LogBrewClient *client = new_client();
  LogBrewRecordingTransport transport;
  LogBrewTransportResponse response;
  LogBrewError error;
  LogBrewStatus status;

  logbrew_recording_transport_init(&transport, NULL, 0U);
  must(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error), &error);
  if (response.status_code != 204 || response.attempts != 0U) {
    fprintf(stderr, "empty flush failed\n");
    exit(1);
  }
  logbrew_recording_transport_free(&transport);

  status = logbrew_client_issue(client, "evt_bad", "2026-06-02T10:00:02Z",
      (LogBrewIssueAttributes){"Checkout timeout", "verbose", NULL}, &error);
  if (status != LOGBREW_VALIDATION_ERROR || strcmp(error.code, "validation_error") != 0) {
    fprintf(stderr, "validation failure failed\n");
    exit(1);
  }
  logbrew_client_free(client);

  client = new_client();
  queue_events(client);
  {
    LogBrewRecordingStep steps[] = {LOGBREW_RECORD_STATUS_CODE(401)};
    logbrew_recording_transport_init(&transport, steps, sizeof(steps) / sizeof(steps[0]));
    status = logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error);
    if (status != LOGBREW_TRANSPORT_ERROR || strcmp(error.code, "unauthenticated") != 0) {
      fprintf(stderr, "unauthenticated failure failed\n");
      exit(1);
    }
    logbrew_recording_transport_free(&transport);
  }
  logbrew_client_free(client);

  client = new_client();
  queue_events(client);
  {
    LogBrewRecordingStep steps[] = {
      LOGBREW_RECORD_NETWORK_FAILURE("first failure"),
      LOGBREW_RECORD_NETWORK_FAILURE("second failure"),
      LOGBREW_RECORD_NETWORK_FAILURE("third failure")
    };
    logbrew_recording_transport_init(&transport, steps, sizeof(steps) / sizeof(steps[0]));
    status = logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error);
    if (status != LOGBREW_TRANSPORT_ERROR || strcmp(error.code, "network_failure") != 0) {
      fprintf(stderr, "retry-budget failure failed\n");
      exit(1);
    }
    logbrew_recording_transport_free(&transport);
  }
  logbrew_client_free(client);

  client = new_client();
  queue_events(client);
  {
    LogBrewRecordingStep steps[] = {LOGBREW_RECORD_STATUS_CODE(422)};
    logbrew_recording_transport_init(&transport, steps, sizeof(steps) / sizeof(steps[0]));
    status = logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error);
    if (status != LOGBREW_TRANSPORT_ERROR || strcmp(error.code, "transport_error") != 0) {
      fprintf(stderr, "non-retryable status failure failed\n");
      exit(1);
    }
    logbrew_recording_transport_free(&transport);
  }
  logbrew_client_free(client);

  client = new_client();
  queue_events(client);
  logbrew_recording_transport_init(&transport, NULL, 0U);
  must(logbrew_client_shutdown(client, logbrew_recording_transport_as_transport(&transport), &response, &error), &error);
  status = logbrew_client_action(client, "evt_after_shutdown", "2026-06-02T10:00:05Z",
      (LogBrewActionAttributes){"deploy", "success"}, &error);
  if (status != LOGBREW_SHUTDOWN_ERROR || strcmp(error.code, "shutdown_error") != 0) {
    fprintf(stderr, "post-shutdown failure failed\n");
    exit(1);
  }
  logbrew_recording_transport_free(&transport);
  logbrew_client_free(client);
}

static void exercise_timeline_helpers(void) {
  LogBrewClient *client = new_client();
  LogBrewError error;
  char *preview = NULL;
  LogBrewMetadataEntry metadata[] = {
    LOGBREW_METADATA_NUMBER_VALUE("cartValue", 42.5),
    LOGBREW_METADATA_BOOL_VALUE("retry", false)
  };
  LogBrewProductTimelineContext context = {
    "session_123",
    "trace_001",
    "/checkout?sku=123#pay",
    "Checkout",
    "checkout",
    "submit"
  };
  logbrew_error_clear(&error);
  must(logbrew_client_product_action(client, "evt_product_action_001", "2026-06-02T10:00:06Z",
      (LogBrewProductActionAttributes){
        "checkout.submit",
        "success",
        context,
        {metadata, sizeof(metadata) / sizeof(metadata[0])}
      }, &error), &error);
  must(logbrew_client_network_milestone(client, "evt_network_milestone_001", "2026-06-02T10:00:07Z",
      (LogBrewNetworkMilestoneAttributes){
        "post",
        "https://api.example.com/api/checkout?sku=123#pay",
        503,
        true,
        184.5,
        true,
        context,
        {metadata, sizeof(metadata) / sizeof(metadata[0])}
      }, &error), &error);
  must(logbrew_client_preview_json(client, &preview, &error), &error);
  if (strstr(preview, "\"source\":\"c.action\"") == NULL ||
      strstr(preview, "\"source\":\"c.network\"") == NULL ||
      strstr(preview, "\"name\":\"POST /api/checkout\"") == NULL ||
      strstr(preview, "\"status\":\"failure\"") == NULL ||
      strstr(preview, "sku=") != NULL ||
      strstr(preview, "#pay") != NULL) {
    fprintf(stderr, "timeline helper preview failed\n");
    exit(1);
  }
  logbrew_free_string(preview);
  logbrew_client_free(client);
}

static void exercise_metric_helper(void) {
  LogBrewClient *client = new_client();
  LogBrewError error;
  char *preview = NULL;
  LogBrewStatus status;
  LogBrewMetadataEntry metadata[] = {
    LOGBREW_METADATA_STRING_VALUE("queue", "checkout"),
    LOGBREW_METADATA_BOOL_VALUE("sampled", true)
  };
  logbrew_error_clear(&error);
  must(logbrew_client_metric(client, "evt_metric_001", "2026-06-02T10:00:06Z",
      (LogBrewMetricAttributes){
        "queue.depth",
        "gauge",
        42.0,
        "{items}",
        "instant",
        {metadata, sizeof(metadata) / sizeof(metadata[0])}
      }, &error), &error);
  must(logbrew_client_preview_json(client, &preview, &error), &error);
  if (strstr(preview, "\"type\":\"metric\"") == NULL ||
      strstr(preview, "\"name\":\"queue.depth\"") == NULL ||
      strstr(preview, "\"kind\":\"gauge\"") == NULL ||
      strstr(preview, "\"value\":42") == NULL ||
      strstr(preview, "\"unit\":\"{items}\"") == NULL ||
      strstr(preview, "\"temporality\":\"instant\"") == NULL ||
      strstr(preview, "\"metadata\":{\"queue\":\"checkout\"") == NULL ||
      strstr(preview, "\"sampled\":true") == NULL) {
    fprintf(stderr, "metric helper preview failed\n");
    exit(1);
  }
  logbrew_free_string(preview);

  status = logbrew_client_metric(client, "evt_bad_counter", "2026-06-02T10:00:06Z",
      (LogBrewMetricAttributes){"jobs.processed", "counter", -1.0, "1", "delta", {NULL, 0U}}, &error);
  if (status != LOGBREW_VALIDATION_ERROR || strcmp(error.code, "validation_error") != 0) {
    fprintf(stderr, "metric validation failure failed\n");
    exit(1);
  }
  logbrew_client_free(client);
}

int main(void) {
  LogBrewClient *client = new_client();
  LogBrewRecordingStep steps[] = {
    LOGBREW_RECORD_NETWORK_FAILURE("temporary network failure"),
    LOGBREW_RECORD_STATUS_CODE(503),
    LOGBREW_RECORD_STATUS_CODE(202)
  };
  LogBrewRecordingTransport transport;
  LogBrewTransportResponse response;
  LogBrewError error;
  char *preview = NULL;

  queue_events(client);
  must(logbrew_client_preview_json(client, &preview, &error), &error);
  printf("%s\n", preview);
  logbrew_free_string(preview);

  logbrew_recording_transport_init(&transport, steps, sizeof(steps) / sizeof(steps[0]));
  must(logbrew_client_flush(client, logbrew_recording_transport_as_transport(&transport), &response, &error), &error);
  fprintf(stderr, "{\"ok\":true,\"status\":%d,\"retryAttempts\":%zu,\"sentBodies\":%zu}\n",
          response.status_code,
          response.attempts,
          logbrew_recording_transport_sent_count(&transport));
  logbrew_recording_transport_free(&transport);
  logbrew_client_free(client);

  exercise_timeline_helpers();
  exercise_metric_helper();
  exercise_failure_paths();
  return 0;
}
EOF

"$cc_command" -std=c99 -Wall -Wextra -Wpedantic -Werror \
  -I"$sdk_dir/include" \
  "$sdk_dir/src/logbrew.c" \
  "$sdk_dir/src/logbrew_metric.c" \
  "$sdk_dir/src/logbrew_recording_transport.c" \
  "$sdk_dir/src/logbrew_timeline.c" \
  "$sdk_dir/src/logbrew_trace.c" \
  "$app_dir/main.c" \
  -o "$app_dir/native_app"
  "$app_dir/native_app" > "$tmp_dir/native-app.stdout.json" 2> "$tmp_dir/native-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/native-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/native-app.stdout.json" >/dev/null
grep -q '"retryAttempts":3' "$tmp_dir/native-app.stderr.json"

if command -v curl-config >/dev/null 2>&1; then
  intake_pid=""
  cat > "$app_dir/http_app.c" <<'EOF'
#include "logbrew.h"

#include <stdio.h>
#include <stdlib.h>

static void must(LogBrewStatus status, const LogBrewError *error) {
  if (status != LOGBREW_OK) {
    fprintf(stderr, "%s: %s\n", error->code, error->message);
    exit(1);
  }
}

int main(void) {
  const char *endpoint = getenv("LOGBREW_C_HTTP_ENDPOINT");
  LogBrewClient *client = NULL;
  LogBrewError error;
  LogBrewTransportResponse response;
  LogBrewHttpHeader headers[] = {{"x-logbrew-source", "c-consumer"}};
  LogBrewHttpTransport transport;
  LogBrewConfig config = {"LOGBREW_API_KEY", "native-http-app", LOGBREW_C_VERSION, 1U};

  logbrew_error_clear(&error);
  must(logbrew_client_new(config, &client, &error), &error);
  must(logbrew_client_log(client, "evt_c_http_transport", "2026-06-02T10:00:06Z",
      (LogBrewLogAttributes){"c http transport sent", "info", "c-http"}, &error), &error);
  must(logbrew_http_transport_init(&transport, endpoint, headers, sizeof(headers) / sizeof(headers[0]), 5000L, &error), &error);
  must(logbrew_client_flush(client, logbrew_http_transport_as_transport(&transport), &response, &error), &error);
  if (response.status_code != 202 || response.attempts != 2U || logbrew_client_pending_events(client) != 0U) {
    fprintf(stderr, "unexpected HTTP response status=%d attempts=%zu pending=%zu\n",
            response.status_code,
            response.attempts,
            logbrew_client_pending_events(client));
    exit(1);
  }
  fprintf(stderr, "{\"ok\":true,\"httpAttempts\":%zu}\n", response.attempts);
  logbrew_http_transport_free(&transport);
  logbrew_client_free(client);
  return 0;
}
EOF

  http_port="$(python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
  cat > "$tmp_dir/c_intake.py" <<'PY'
import json
import sys
import time
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
                "path": self.path,
                "source": self.headers.get("x-logbrew-source"),
            }) + "\n")
        self.send_response(503 if Handler.count == 1 else 202)
        self.end_headers()
        self.wfile.write(b"accepted")

    def log_message(self, _format, *_args):
        return


server = HTTPServer(("127.0.0.1", port), Handler)
server.timeout = 1
ready_path.write_text("ready", encoding="utf-8")
deadline = time.monotonic() + 90
while Handler.count < 2 and time.monotonic() < deadline:
    server.handle_request()
if Handler.count < 2:
    print(f"c intake timed out after {Handler.count} request(s)", file=sys.stderr)
    sys.exit(1)
PY
  intake_ready="$tmp_dir/http-intake.ready"
  intake_log="$tmp_dir/http-intake.jsonl"
  python3 "$tmp_dir/c_intake.py" "$http_port" "$intake_ready" "$intake_log" \
    > "$tmp_dir/http-intake.stdout" 2> "$tmp_dir/http-intake.stderr" &
  intake_pid="$!"
  for _attempt in {1..600}; do
    if [[ -f "$intake_ready" ]]; then
      break
    fi
    sleep 0.1
  done
  if [[ ! -f "$intake_ready" ]]; then
    echo "c intake server did not become ready" >&2
    exit 1
  fi

  curl_cflags=()
  curl_libs=()
  curl_cflags_output="$(curl-config --cflags)"
  curl_libs_output="$(curl-config --libs)"
  if [[ -n "$curl_cflags_output" ]]; then
    read -r -a curl_cflags <<<"$curl_cflags_output"
  fi
  if [[ -n "$curl_libs_output" ]]; then
    read -r -a curl_libs <<<"$curl_libs_output"
  fi
  "$cc_command" -std=c99 -Wall -Wextra -Wpedantic -Werror \
    -I"$sdk_dir/include" ${curl_cflags[@]+"${curl_cflags[@]}"} \
    "$sdk_dir/src/logbrew.c" \
    "$sdk_dir/src/logbrew_metric.c" \
    "$sdk_dir/src/logbrew_recording_transport.c" \
    "$sdk_dir/src/logbrew_timeline.c" \
    "$sdk_dir/src/logbrew_trace.c" \
    "$sdk_dir/src/logbrew_http_transport.c" \
    "$app_dir/http_app.c" \
    ${curl_libs[@]+"${curl_libs[@]}"} \
    -o "$app_dir/http_app"
  LOGBREW_C_HTTP_ENDPOINT="http://127.0.0.1:$http_port/v1/events" \
    "$app_dir/http_app" > "$tmp_dir/http-app.stdout.json" 2> "$tmp_dir/http-app.stderr.json"
  wait "$intake_pid"
  grep -q '"httpAttempts":2' "$tmp_dir/http-app.stderr.json"
  python3 - "$intake_log" <<'PY'
import json
import sys
from pathlib import Path

requests = [json.loads(line) for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()]
if len(requests) != 2:
    raise SystemExit(f"expected 2 C HTTP delivery attempts, got {len(requests)}")
for request in requests:
    if request["authorization"] != "Bearer LOGBREW_API_KEY":
        raise SystemExit(f"unexpected authorization header: {request['authorization']}")
    if request["contentType"] != "application/json":
        raise SystemExit(f"unexpected content type: {request['contentType']}")
    if request["source"] != "c-consumer":
        raise SystemExit(f"unexpected source header: {request['source']}")
    if request["path"] != "/v1/events":
        raise SystemExit(f"unexpected path: {request['path']}")
if "evt_c_http_transport" not in requests[1]["body"]:
    raise SystemExit("missing C HTTP transport event in final request body")
PY
fi

run_examples_make > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"
grep -qx 'run-trace-correlation -> make run-trace-correlation' "$tmp_dir/examples-help.txt"
run_examples_make run-readme-example > "$tmp_dir/readme-example.stdout.json" 2> "$tmp_dir/readme-example.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme-example.stdout.json" >/dev/null
run_examples_make run-real-user-smoke > "$tmp_dir/real-user-smoke.stdout.json" 2> "$tmp_dir/real-user-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
run_examples_make run-trace-correlation > "$tmp_dir/trace-correlation.stdout.json" 2> "$tmp_dir/trace-correlation.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/trace-correlation.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_c_trace_correlation_payload.py" "$tmp_dir/trace-correlation.stdout.json" "$tmp_dir/trace-correlation.stderr.json" >/dev/null

echo "c real-user smoke passed with $($cc_command --version | head -n 1)"
