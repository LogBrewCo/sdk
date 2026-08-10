#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/cpp/logbrew-cpp"
tmp_dir="$(mktemp -d)"
intake_pid=""

remove_tmp_dir() {
  if [[ -n "$intake_pid" ]] && kill -0 "$intake_pid" 2>/dev/null; then
    kill "$intake_pid"
    wait "$intake_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

on_error() {
  local status=$?
  echo "real_user_cpp_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
  for diagnostic in "$tmp_dir"/*.stderr "$tmp_dir"/*.json; do
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

archive="$tmp_dir/logbrew-cpp-0.2.3.tar.gz"
(cd "$package_dir" && tar -czf "$archive" README.md CMakeLists.txt Makefile cmake include src examples tests)

app_dir="$tmp_dir/native-cpp-app"
sdk_dir="$app_dir/vendor/logbrew-cpp"
install_sdk() {
  mkdir -p "$sdk_dir"
  tar -xzf "$archive" -C "$sdk_dir"
}

install_sdk
rm -rf "$sdk_dir"
test ! -d "$sdk_dir"
install_sdk

for required_path in \
  CMakeLists.txt \
  cmake/LogBrewConfig.cmake.in \
  include/logbrew.hpp \
  src/logbrew.cpp \
  src/logbrew_http_transport.cpp \
  examples/http_transport.cpp \
  examples/real_user_smoke.cpp; do
  test -f "$sdk_dir/$required_path"
done
for public_symbol in \
  capture_product_action \
  capture_network_milestone \
  MetricAttributes \
  TelemetryContext \
  IssueDetails \
  SpanEvidence \
  TraceScope \
  HttpTransport; do
  grep -q "$public_symbol" "$sdk_dir/include/logbrew.hpp"
done

cat > "$app_dir/CMakeLists.txt" <<'EOF'
cmake_minimum_required(VERSION 3.16)
project(LogBrewConsumer LANGUAGES CXX)

include(FetchContent)
option(CONSUMER_WITH_HTTP "Build the HTTP delivery proof" OFF)
set(LOGBREW_BUILD_HTTP_TRANSPORT ${CONSUMER_WITH_HTTP} CACHE BOOL "" FORCE)
FetchContent_Declare(logbrew SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vendor/logbrew-cpp")
FetchContent_MakeAvailable(logbrew)

add_executable(native_cpp_app vendor/logbrew-cpp/examples/real_user_smoke.cpp)
target_link_libraries(native_cpp_app PRIVATE LogBrew::LogBrew)
if(CONSUMER_WITH_HTTP)
  add_executable(http_app vendor/logbrew-cpp/examples/http_transport.cpp)
  target_link_libraries(http_app PRIVATE LogBrew::HttpTransport)
endif()
EOF

cmake_args=(
  -S "$app_dir"
  -B "$app_dir/build"
  "-DCMAKE_CXX_COMPILER=$cxx_command"
  "-DCMAKE_CXX_FLAGS=-Wall -Wextra -Wpedantic -Werror"
)
if command -v curl-config >/dev/null 2>&1; then
  cmake_args+=("-DCONSUMER_WITH_HTTP=ON")
fi
cmake "${cmake_args[@]}"
cmake --build "$app_dir/build" --parallel

"$app_dir/build/native_cpp_app" > "$tmp_dir/native-app.stdout.json" 2> "$tmp_dir/native-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/native-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" \
  --allow-additive-context \
  "$repo_root/fixtures/valid-batch.json" \
  "$tmp_dir/native-app.stdout.json" >/dev/null
grep -q '"retryAttempts":3' "$tmp_dir/native-app.stderr.json"

if command -v curl-config >/dev/null 2>&1; then
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
        length = int(self.headers.get("content-length", "0"))
        Handler.count += 1
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "authorization": self.headers.get("authorization"),
                "body": self.rfile.read(length).decode("utf-8"),
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
server.server_close()
if Handler.count < 2:
    raise SystemExit(f"c++ intake timed out after {Handler.count} request(s)")
PY
  intake_ready="$tmp_dir/http-intake.ready"
  intake_log="$tmp_dir/http-intake.jsonl"
  python3 "$tmp_dir/cpp_intake.py" "$http_port" "$intake_ready" "$intake_log" \
    > "$tmp_dir/http-intake.stdout" 2> "$tmp_dir/http-intake.stderr" &
  intake_pid="$!"
  for _attempt in {1..600}; do
    [[ -f "$intake_ready" ]] && break
    sleep 0.1
  done
  test -f "$intake_ready"

  LOGBREW_CPP_HTTP_ENDPOINT="http://127.0.0.1:$http_port/v1/events" \
    "$app_dir/build/http_app" > "$tmp_dir/http-app.stdout.json" 2> "$tmp_dir/http-app.stderr.json"
  wait "$intake_pid"
  intake_pid=""
  grep -q '"httpAttempts":2' "$tmp_dir/http-app.stderr.json"
  python3 - "$intake_log" <<'PY'
import json
import sys
from pathlib import Path

requests = [json.loads(line) for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()]
if len(requests) != 2:
    raise SystemExit(f"expected 2 C++ HTTP delivery attempts, got {len(requests)}")
for request in requests:
    expected = {
        "authorization": "Bearer LOGBREW_API_KEY",
        "contentType": "application/json",
        "path": "/v1/events",
        "source": "cpp-consumer",
    }
    for key, value in expected.items():
        if request[key] != value:
            raise SystemExit(f"unexpected {key}: {request[key]}")
if "evt_cpp_http_transport" not in requests[-1]["body"]:
    raise SystemExit("missing C++ HTTP transport event in final request body")
PY
fi

echo "c++ CMake real-user smoke passed with $($cxx_command --version | head -n 1)"
