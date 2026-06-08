#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/cpp/logbrew-cpp"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

on_error() {
  local status=$?
  echo "real_user_cpp_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
  for diagnostic in \
    "$tmp_dir/examples-help.txt" \
    "$tmp_dir/native-app.stdout.json" \
    "$tmp_dir/native-app.stderr.json" \
    "$tmp_dir/http-app.stdout.json" \
    "$tmp_dir/http-app.stderr.json" \
    "$tmp_dir/http-intake.stderr" \
    "$tmp_dir/readme-example.stdout.json" \
    "$tmp_dir/readme-example.stderr.json" \
    "$tmp_dir/real-user-smoke.stdout.json" \
    "$tmp_dir/real-user-smoke.stderr.json"; do
    if [[ -f "$diagnostic" ]]; then
      echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
      sed -n '1,80p' "$diagnostic" >&2
    fi
  done
  exit "$status"
}

trap remove_tmp_dir EXIT
trap on_error ERR

cxx_command="${CXX:-}"
if [[ -z "$cxx_command" ]]; then
  if command -v clang++ >/dev/null 2>&1; then
    cxx_command="clang++"
  else
    cxx_command="c++"
  fi
fi

run_examples_make() {
  make --no-print-directory -C "$sdk_dir/examples" CXX="$cxx_command" "$@"
}

archive="$tmp_dir/logbrew-cpp-0.1.0.tar.gz"
(cd "$package_dir" && tar -czf "$archive" README.md Makefile include src examples tests)

app_dir="$tmp_dir/native-cpp-app"
sdk_dir="$app_dir/vendor/logbrew-cpp"
mkdir -p "$sdk_dir"
tar -xzf "$archive" -C "$sdk_dir"
test -f "$sdk_dir/include/logbrew.hpp"
test -f "$sdk_dir/src/logbrew.cpp"
test -f "$sdk_dir/src/logbrew_http_transport.cpp"

rm -rf "$sdk_dir"
if [[ -d "$sdk_dir" ]]; then
  echo "dependency removal failed" >&2
  exit 1
fi
mkdir -p "$sdk_dir"
tar -xzf "$archive" -C "$sdk_dir"
test -f "$sdk_dir/include/logbrew.hpp"
test -f "$sdk_dir/src/logbrew.cpp"
test -f "$sdk_dir/src/logbrew_http_transport.cpp"
grep -q 'capture_product_action' "$sdk_dir/include/logbrew.hpp"
grep -q 'capture_network_milestone' "$sdk_dir/include/logbrew.hpp"
grep -q 'HttpTransport' "$sdk_dir/include/logbrew.hpp"

cat > "$app_dir/main.cpp" <<'EOF'
#include "logbrew.hpp"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

logbrew::LogBrewClient new_client() {
  return logbrew::LogBrewClient(logbrew::Config{"LOGBREW_API_KEY", "native-cpp-app", logbrew::version, 2});
}

void queue_events(logbrew::LogBrewClient &client) {
  client.release("evt_release_001", "2026-06-02T10:00:00Z", logbrew::ReleaseAttributes{"1.2.3", "abc123def456", "Public release marker"});
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", logbrew::EnvironmentAttributes{"production", "global"});
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", logbrew::IssueAttributes{"Checkout timeout", "error", "Request timed out after retry budget"});
  client.log("evt_log_001", "2026-06-02T10:00:03Z", logbrew::LogAttributes{"worker started", "info", "job-runner"});
  client.span("evt_span_001", "2026-06-02T10:00:04Z", logbrew::SpanAttributes{"GET /health", "trace_001", "span_001", std::nullopt, "ok", 12.5});
  client.action("evt_action_001", "2026-06-02T10:00:05Z", logbrew::ActionAttributes{"deploy", "success"});
}

void require_condition(bool condition, const char *message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

void exercise_timeline_helpers() {
  auto timeline_client = new_client();
  logbrew::ProductTimelineContext context;
  context.session_id = "session_123";
  context.screen = "Checkout";
  context.trace_id = "trace_001";
  context.funnel = "checkout";
  context.step = "submit";

  logbrew::ProductActionAttributes action;
  action.name = "checkout submit";
  action.context = context;
  action.metadata = {{"component", "pay-button"}, {"attempt", 2}};
  timeline_client.capture_product_action("evt_product_action_001", "2026-06-02T10:00:06Z", action);

  logbrew::NetworkMilestoneAttributes network;
  network.method = "POST";
  network.route_template = "https://api.example.com/checkout/confirm?view=ignored#fragment";
  network.status_code = 503;
  network.duration_ms = 42.75;
  network.context = context;
  timeline_client.capture_network_milestone("evt_network_001", "2026-06-02T10:00:07Z", network);

  const std::string preview = timeline_client.preview_json();
  require_condition(preview.find("\"source\":\"cpp.product_action\"") != std::string::npos, "product action source missing");
  require_condition(preview.find("\"source\":\"cpp.network\"") != std::string::npos, "network source missing");
  require_condition(preview.find("\"routeTemplate\":\"/checkout/confirm\"") != std::string::npos, "route template missing");
  require_condition(preview.find("view=ignored") == std::string::npos, "network query leaked");
  require_condition(preview.find("#fragment") == std::string::npos, "network hash leaked");
}

void exercise_failure_paths() {
  auto empty_client = new_client();
  logbrew::RecordingTransport empty_transport;
  const logbrew::TransportResponse empty_response = empty_client.flush(empty_transport);
  require_condition(empty_response.status_code == 204 && empty_response.attempts == 0U, "empty flush failed");

  try {
    empty_client.issue("evt_bad", "2026-06-02T10:00:02Z", logbrew::IssueAttributes{"Checkout timeout", "fatal", std::nullopt});
    require_condition(false, "validation failure did not throw");
  } catch (const logbrew::SdkException &error) {
    require_condition(error.code() == "validation_error", "validation failure used wrong code");
  }

  auto unauth_client = new_client();
  queue_events(unauth_client);
  logbrew::RecordingTransport unauth_transport({logbrew::RecordingTransport::Step::status_code_step(401)});
  try {
    static_cast<void>(unauth_client.flush(unauth_transport));
    require_condition(false, "unauthenticated failure did not throw");
  } catch (const logbrew::SdkException &error) {
    require_condition(error.code() == "unauthenticated", "unauthenticated failure used wrong code");
  }

  auto retry_client = new_client();
  queue_events(retry_client);
  logbrew::RecordingTransport retry_transport({
      logbrew::RecordingTransport::Step::network_failure("first failure"),
      logbrew::RecordingTransport::Step::network_failure("second failure"),
      logbrew::RecordingTransport::Step::network_failure("third failure"),
  });
  try {
    static_cast<void>(retry_client.flush(retry_transport));
    require_condition(false, "retry-budget failure did not throw");
  } catch (const logbrew::SdkException &error) {
    require_condition(error.code() == "network_failure", "retry-budget failure used wrong code");
  }

  auto status_client = new_client();
  queue_events(status_client);
  logbrew::RecordingTransport status_transport({logbrew::RecordingTransport::Step::status_code_step(422)});
  try {
    static_cast<void>(status_client.flush(status_transport));
    require_condition(false, "non-retryable status failure did not throw");
  } catch (const logbrew::SdkException &error) {
    require_condition(error.code() == "transport_error", "non-retryable status failure used wrong code");
  }

  auto shutdown_client = new_client();
  queue_events(shutdown_client);
  logbrew::RecordingTransport accept_transport;
  static_cast<void>(shutdown_client.shutdown(accept_transport));
  try {
    shutdown_client.action("evt_after_shutdown", "2026-06-02T10:00:05Z", logbrew::ActionAttributes{"deploy", "success"});
    require_condition(false, "post-shutdown failure did not throw");
  } catch (const logbrew::SdkException &error) {
    require_condition(error.code() == "shutdown_error", "post-shutdown failure used wrong code");
  }
}

} // namespace

int main() {
  try {
    auto client = new_client();
    queue_events(client);
    std::cout << client.preview_json() << '\n';
    logbrew::RecordingTransport transport({
        logbrew::RecordingTransport::Step::network_failure("temporary network failure"),
        logbrew::RecordingTransport::Step::status_code_step(503),
        logbrew::RecordingTransport::Step::status_code_step(202),
    });
    const logbrew::TransportResponse response = client.flush(transport);
    std::cerr << "{\"ok\":true,\"status\":" << response.status_code << ",\"retryAttempts\":" << response.attempts
              << ",\"sentBodies\":" << transport.sent_bodies().size() << "}\n";
    exercise_timeline_helpers();
    exercise_failure_paths();
    return 0;
  } catch (const logbrew::SdkException &error) {
    std::cerr << error.code() << ": " << error.what() << '\n';
    return 1;
  }
}
EOF

"$cxx_command" -std=c++17 -Wall -Wextra -Wpedantic -Werror \
  -I"$sdk_dir/include" \
  "$sdk_dir/src/logbrew.cpp" \
  "$app_dir/main.cpp" \
  -o "$app_dir/native_cpp_app"
"$app_dir/native_cpp_app" > "$tmp_dir/native-app.stdout.json" 2> "$tmp_dir/native-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/native-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/native-app.stdout.json" >/dev/null
grep -q '"retryAttempts":3' "$tmp_dir/native-app.stderr.json"

if command -v curl-config >/dev/null 2>&1; then
  intake_pid=""
  cat > "$app_dir/http_app.cpp" <<'EOF'
#include "logbrew.hpp"

#include <cstdlib>
#include <iostream>

int main() {
  try {
    const char *endpoint = std::getenv("LOGBREW_CPP_HTTP_ENDPOINT");
    logbrew::LogBrewClient client(logbrew::Config{"LOGBREW_API_KEY", "native-cpp-http-app", logbrew::version, 1});
    client.log(
        "evt_cpp_http_transport",
        "2026-06-02T10:00:06Z",
        logbrew::LogAttributes{"c++ http transport sent", "info", "cpp-http"});
    logbrew::HttpTransport transport(
        endpoint == nullptr ? "" : endpoint,
        {{"x-logbrew-source", "cpp-consumer"}},
        5000L);
    const logbrew::TransportResponse response = client.flush(transport);
    if (response.status_code != 202 || response.attempts != 2U || client.pending_events() != 0U) {
      std::cerr << "unexpected HTTP response status=" << response.status_code << " attempts=" << response.attempts
                << " pending=" << client.pending_events() << '\n';
      return 1;
    }
    std::cerr << "{\"ok\":true,\"httpAttempts\":" << response.attempts << "}\n";
    return 0;
  } catch (const logbrew::SdkException &error) {
    std::cerr << error.code() << ": " << error.what() << '\n';
    return 1;
  }
}
EOF

  http_port="$(python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
  cat > "$tmp_dir/cpp_intake.py" <<'PY'
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
    print(f"c++ intake timed out after {Handler.count} request(s)", file=sys.stderr)
    sys.exit(1)
PY
  intake_ready="$tmp_dir/http-intake.ready"
  intake_log="$tmp_dir/http-intake.jsonl"
  python3 "$tmp_dir/cpp_intake.py" "$http_port" "$intake_ready" "$intake_log" \
    > "$tmp_dir/http-intake.stdout" 2> "$tmp_dir/http-intake.stderr" &
  intake_pid="$!"
  for _attempt in {1..600}; do
    if [[ -f "$intake_ready" ]]; then
      break
    fi
    sleep 0.1
  done
  if [[ ! -f "$intake_ready" ]]; then
    echo "c++ intake server did not become ready" >&2
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
  "$cxx_command" -std=c++17 -Wall -Wextra -Wpedantic -Werror \
    -I"$sdk_dir/include" ${curl_cflags[@]+"${curl_cflags[@]}"} \
    "$sdk_dir/src/logbrew.cpp" \
    "$sdk_dir/src/logbrew_http_transport.cpp" \
    "$app_dir/http_app.cpp" \
    ${curl_libs[@]+"${curl_libs[@]}"} \
    -o "$app_dir/http_app"
  LOGBREW_CPP_HTTP_ENDPOINT="http://127.0.0.1:$http_port/v1/events" \
    "$app_dir/http_app" > "$tmp_dir/http-app.stdout.json" 2> "$tmp_dir/http-app.stderr.json"
  wait "$intake_pid"
  grep -q '"httpAttempts":2' "$tmp_dir/http-app.stderr.json"
  python3 - "$intake_log" <<'PY'
import json
import sys
from pathlib import Path

requests = [json.loads(line) for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()]
if len(requests) != 2:
    raise SystemExit(f"expected 2 C++ HTTP delivery attempts, got {len(requests)}")
for request in requests:
    if request["authorization"] != "Bearer LOGBREW_API_KEY":
        raise SystemExit(f"unexpected authorization header: {request['authorization']}")
    if request["contentType"] != "application/json":
        raise SystemExit(f"unexpected content type: {request['contentType']}")
    if request["source"] != "cpp-consumer":
        raise SystemExit(f"unexpected source header: {request['source']}")
    if request["path"] != "/v1/events":
        raise SystemExit(f"unexpected path: {request['path']}")
if "evt_cpp_http_transport" not in requests[1]["body"]:
    raise SystemExit("missing C++ HTTP transport event in final request body")
PY
fi

run_examples_make > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"
run_examples_make run-readme-example > "$tmp_dir/readme-example.stdout.json" 2> "$tmp_dir/readme-example.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme-example.stdout.json" >/dev/null
run_examples_make run-real-user-smoke > "$tmp_dir/real-user-smoke.stdout.json" 2> "$tmp_dir/real-user-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null

echo "c++ real-user smoke passed with $($cxx_command --version | head -n 1)"
