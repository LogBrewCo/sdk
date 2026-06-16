#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/objc/logbrew-objc"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

on_error() {
  local status=$?
  echo "real_user_objc_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
  for diagnostic in \
    "$tmp_dir/native-app.stdout.json" \
    "$tmp_dir/native-app.stderr.json" \
    "$tmp_dir/http-app.stdout.json" \
    "$tmp_dir/http-app.stderr.json" \
    "$tmp_dir/http-intake.stderr" \
    "$tmp_dir/readme-example.stdout.json" \
    "$tmp_dir/readme-example.stderr.json" \
    "$tmp_dir/real-user-smoke.stdout.json" \
    "$tmp_dir/real-user-smoke.stderr.json" \
    "$tmp_dir/trace-correlation.stdout.json" \
    "$tmp_dir/trace-correlation.stderr.json"; do
    if [[ -f "$diagnostic" ]]; then
      echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
      sed -n '1,80p' "$diagnostic" >&2
    fi
  done
  exit "$status"
}

trap remove_tmp_dir EXIT
trap on_error ERR

objc_command="${OBJC:-}"
if [[ -z "$objc_command" ]]; then
  if command -v clang >/dev/null 2>&1; then
    objc_command="clang"
  else
    printf '%s\n' "clang is required for Objective-C real-user smoke" >&2
    exit 1
  fi
fi

archive="$tmp_dir/logbrew-objc-0.1.0.tar.gz"
(cd "$package_dir" && tar -czf "$archive" README.md Makefile include src examples tests)

app_dir="$tmp_dir/native-objc-app"
sdk_dir="$app_dir/vendor/logbrew-objc"
mkdir -p "$sdk_dir"
tar -xzf "$archive" -C "$sdk_dir"
test -f "$sdk_dir/include/LogBrew.h"
test -f "$sdk_dir/src/LogBrew.m"
test -f "$sdk_dir/src/LogBrewTrace.m"
test -f "$sdk_dir/src/LogBrewNetworkValidation.h"
test -f "$sdk_dir/src/LogBrewNetworkValidation.m"
test -f "$sdk_dir/src/LogBrewURLSession.m"
test -f "$sdk_dir/src/LogBrewLifecycle.m"
test -f "$sdk_dir/src/LBWHTTPTransport.m"
grep -q 'LBWHTTPTransport' "$sdk_dir/include/LogBrew.h"
grep -q 'LBWTraceContext' "$sdk_dir/include/LogBrew.h"
grep -q 'metricWithID' "$sdk_dir/include/LogBrew.h"
grep -q 'captureProductActionWithID' "$sdk_dir/include/LogBrew.h"
grep -q 'captureNetworkMilestoneWithID' "$sdk_dir/include/LogBrew.h"
grep -q 'startURLSessionSpanForRequest' "$sdk_dir/include/LogBrew.h"
grep -q 'captureURLSessionSpanWithID' "$sdk_dir/include/LogBrew.h"
grep -q 'captureLifecycleSpanWithID' "$sdk_dir/include/LogBrew.h"

rm -rf "$sdk_dir"
if [[ -d "$sdk_dir" ]]; then
  echo "dependency removal failed" >&2
  exit 1
fi
mkdir -p "$sdk_dir"
tar -xzf "$archive" -C "$sdk_dir"
test -f "$sdk_dir/include/LogBrew.h"
test -f "$sdk_dir/src/LogBrew.m"
test -f "$sdk_dir/src/LogBrewTrace.m"
test -f "$sdk_dir/src/LogBrewNetworkValidation.h"
test -f "$sdk_dir/src/LogBrewNetworkValidation.m"
test -f "$sdk_dir/src/LogBrewURLSession.m"
test -f "$sdk_dir/src/LogBrewLifecycle.m"
test -f "$sdk_dir/src/LBWHTTPTransport.m"
grep -q 'LBWHTTPTransport' "$sdk_dir/include/LogBrew.h"
grep -q 'LBWTraceContext' "$sdk_dir/include/LogBrew.h"
grep -q 'metricWithID' "$sdk_dir/include/LogBrew.h"
grep -q 'captureProductActionWithID' "$sdk_dir/include/LogBrew.h"
grep -q 'captureNetworkMilestoneWithID' "$sdk_dir/include/LogBrew.h"
grep -q 'startURLSessionSpanForRequest' "$sdk_dir/include/LogBrew.h"
grep -q 'captureURLSessionSpanWithID' "$sdk_dir/include/LogBrew.h"
grep -q 'captureLifecycleSpanWithID' "$sdk_dir/include/LogBrew.h"

cat > "$app_dir/main.m" <<'EOF'
#import "LogBrew.h"

static void LBWDie(NSString *message) {
  fprintf(stderr, "%s\n", [message UTF8String]);
  exit(1);
}

static void LBWMust(BOOL condition, NSError *error) {
  if (!condition) {
    LBWDie([error localizedDescription]);
  }
}

static NSString *LBWStableCode(NSError *error) {
  NSString *code = error.userInfo[LBWErrorStableCodeKey];
  return code != nil ? code : @"";
}

static LBWClient *LBWNewClient(void) {
  NSError *error = nil;
  LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  config.sdkName = @"native-objc-app";
  LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
  if (client == nil) {
    LBWDie([NSString stringWithFormat:@"client init failed: %@", error]);
  }
  return client;
}

static void LBWQueueEvents(LBWClient *client) {
  NSError *error = nil;
  LBWMust([client releaseWithID:@"evt_release_001"
                      timestamp:@"2026-06-02T10:00:00Z"
                     attributes:@{
                       @"version": @"1.2.3",
                       @"commit": @"abc123def456",
                       @"notes": @"Public release marker"
                     }
                          error:&error], error);
  LBWMust([client environmentWithID:@"evt_environment_001"
                          timestamp:@"2026-06-02T10:00:01Z"
                         attributes:@{@"name": @"production", @"region": @"global"}
                              error:&error], error);
  LBWMust([client issueWithID:@"evt_issue_001"
                    timestamp:@"2026-06-02T10:00:02Z"
                   attributes:@{
                     @"title": @"Checkout timeout",
                     @"level": @"error",
                     @"message": @"Request timed out after retry budget"
                   }
                        error:&error], error);
  LBWMust([client logWithID:@"evt_log_001"
                  timestamp:@"2026-06-02T10:00:03Z"
                 attributes:@{
                   @"message": @"worker started",
                   @"level": @"info",
                   @"logger": @"job-runner"
                 }
                      error:&error], error);
  LBWMust([client spanWithID:@"evt_span_001"
                   timestamp:@"2026-06-02T10:00:04Z"
                  attributes:@{
                    @"name": @"GET /health",
                    @"traceId": @"trace_001",
                    @"spanId": @"span_001",
                    @"status": @"ok",
                    @"durationMs": @12.5
                  }
                       error:&error], error);
  LBWMust([client actionWithID:@"evt_action_001"
                     timestamp:@"2026-06-02T10:00:05Z"
                    attributes:@{@"name": @"deploy", @"status": @"success"}
                         error:&error], error);
}

static void LBWRequireCode(NSError *error, NSString *expectedCode, NSString *message) {
  if (![LBWStableCode(error) isEqualToString:expectedCode]) {
    LBWDie(message);
  }
}

static void LBWExerciseFailurePaths(void) {
  NSError *error = nil;
  LBWClient *emptyClient = LBWNewClient();
  LBWRecordingTransport *emptyTransport = [[LBWRecordingTransport alloc] init];
  LBWTransportResponse *emptyResponse = [emptyClient flushWithTransport:emptyTransport error:&error];
  if (emptyResponse.statusCode != 204 || emptyResponse.attempts != 0U) {
    LBWDie(@"empty flush failed");
  }

  BOOL ok = [emptyClient issueWithID:@"evt_bad"
                           timestamp:@"2026-06-02T10:00:02Z"
                          attributes:@{@"title": @"Checkout timeout", @"level": @"verbose"}
                               error:&error];
  if (ok) {
    LBWDie(@"validation failure did not fail");
  }
  LBWRequireCode(error, @"validation_error", @"validation failure used wrong code");

  LBWClient *unauthClient = LBWNewClient();
  LBWQueueEvents(unauthClient);
  LBWRecordingTransport *unauthTransport =
      [[LBWRecordingTransport alloc] initWithSteps:@[[LBWRecordingStep statusCodeStep:401]]];
  if ([unauthClient flushWithTransport:unauthTransport error:&error] != nil) {
    LBWDie(@"unauthenticated failure did not fail");
  }
  LBWRequireCode(error, @"unauthenticated", @"unauthenticated failure used wrong code");

  LBWClient *retryClient = LBWNewClient();
  LBWQueueEvents(retryClient);
  LBWRecordingTransport *retryTransport = [[LBWRecordingTransport alloc] initWithSteps:@[
    [LBWRecordingStep networkFailureWithMessage:@"first failure"],
    [LBWRecordingStep networkFailureWithMessage:@"second failure"],
    [LBWRecordingStep networkFailureWithMessage:@"third failure"]
  ]];
  if ([retryClient flushWithTransport:retryTransport error:&error] != nil) {
    LBWDie(@"retry-budget failure did not fail");
  }
  LBWRequireCode(error, @"network_failure", @"retry-budget failure used wrong code");

  LBWClient *statusClient = LBWNewClient();
  LBWQueueEvents(statusClient);
  LBWRecordingTransport *statusTransport =
      [[LBWRecordingTransport alloc] initWithSteps:@[[LBWRecordingStep statusCodeStep:422]]];
  if ([statusClient flushWithTransport:statusTransport error:&error] != nil) {
    LBWDie(@"non-retryable status did not fail");
  }
  LBWRequireCode(error, @"transport_error", @"non-retryable status used wrong code");

  LBWClient *shutdownClient = LBWNewClient();
  LBWQueueEvents(shutdownClient);
  LBWRecordingTransport *acceptTransport = [[LBWRecordingTransport alloc] init];
  LBWMust([shutdownClient shutdownWithTransport:acceptTransport error:&error] != nil, error);
  ok = [shutdownClient actionWithID:@"evt_after_shutdown"
                          timestamp:@"2026-06-02T10:00:05Z"
                         attributes:@{@"name": @"deploy", @"status": @"success"}
                              error:&error];
  if (ok) {
    LBWDie(@"post-shutdown action did not fail");
  }
  LBWRequireCode(error, @"shutdown_error", @"post-shutdown failure used wrong code");
}

static void LBWExerciseTimelineHelpers(void) {
  NSError *error = nil;
  LBWClient *timelineClient = LBWNewClient();
  NSDictionary<NSString *, id> *context = @{
    @"sessionId": @"session_123",
    @"screen": @"Checkout",
    @"traceId": @"trace_abc",
    @"funnel": @"checkout",
    @"step": @"payment"
  };
  LBWMust([timelineClient captureProductActionWithID:@"evt_product_action_001"
                                           timestamp:@"2026-06-02T10:00:07Z"
                                                name:@"checkout.pay_tapped"
                                              status:nil
                                             context:context
                                            metadata:@{@"component": @"pay-button"}
                                               error:&error], error);
  LBWMust([timelineClient captureNetworkMilestoneWithID:@"evt_network_milestone_001"
                                              timestamp:@"2026-06-02T10:00:08Z"
                                                 method:@"post"
                                          routeTemplate:@"https://mobile.example.test/api/checkout?itemId=123#pay"
                                             statusCode:@503
                                             durationMs:@184.5
                                                 status:nil
                                                context:context
                                               metadata:@{@"retryable": @YES}
                                                  error:&error], error);
  NSString *preview = [timelineClient previewJSONWithError:&error];
  LBWMust(preview != nil, error);
  if ([preview rangeOfString:@"\"source\":\"objc.action\""].location == NSNotFound ||
      [preview rangeOfString:@"\"source\":\"objc.network\""].location == NSNotFound ||
      [preview rangeOfString:@"\"method\":\"POST\""].location == NSNotFound ||
      [preview rangeOfString:@"\"status\":\"failure\""].location == NSNotFound ||
      [preview rangeOfString:@"itemId"].location != NSNotFound ||
      [preview rangeOfString:@"#pay"].location != NSNotFound) {
    LBWDie(@"timeline helper preview failed");
  }
}

static void LBWExerciseMetricHelper(void) {
  NSError *error = nil;
  LBWClient *metricClient = LBWNewClient();
  LBWMust([metricClient metricWithID:@"evt_metric_001"
                           timestamp:@"2026-06-02T10:00:06Z"
                          attributes:@{
                            @"name": @"checkout.latency",
                            @"kind": @"histogram",
                            @"value": @184.5,
                            @"unit": @"ms",
                            @"temporality": @"delta",
                            @"metadata": @{
                              @"routeTemplate": @"/api/checkout",
                              @"platform": @"ios"
                            }
                          }
                               error:&error], error);
  NSString *preview = [metricClient previewJSONWithError:&error];
  LBWMust(preview != nil, error);
  if ([preview rangeOfString:@"\"type\":\"metric\""].location == NSNotFound ||
      [preview rangeOfString:@"\"name\":\"checkout.latency\""].location == NSNotFound ||
      [preview rangeOfString:@"\"kind\":\"histogram\""].location == NSNotFound ||
      [preview rangeOfString:@"\"temporality\":\"delta\""].location == NSNotFound ||
      [preview rangeOfString:@"\"routeTemplate\":\"\\/api\\/checkout\""].location == NSNotFound) {
    LBWDie(@"metric helper preview failed");
  }

  BOOL ok = [metricClient metricWithID:@"evt_bad_counter"
                             timestamp:@"2026-06-02T10:00:06Z"
                            attributes:@{
                              @"name": @"jobs.processed",
                              @"kind": @"counter",
                              @"value": @-1,
                              @"unit": @"1",
                              @"temporality": @"delta"
                            }
                                 error:&error];
  if (ok) {
    LBWDie(@"metric validation failure did not fail");
  }
  LBWRequireCode(error, @"validation_error", @"metric validation failure used wrong code");
}

int main(void) {
  @autoreleasepool {
    NSError *error = nil;
    LBWClient *client = LBWNewClient();
    LBWQueueEvents(client);
    NSString *preview = [client previewJSONWithError:&error];
    LBWMust(preview != nil, error);
    printf("%s\n", [preview UTF8String]);

    LBWRecordingTransport *transport = [[LBWRecordingTransport alloc] initWithSteps:@[
      [LBWRecordingStep networkFailureWithMessage:@"temporary network failure"],
      [LBWRecordingStep statusCodeStep:503],
      [LBWRecordingStep statusCodeStep:202]
    ]];
    LBWTransportResponse *response = [client flushWithTransport:transport error:&error];
    LBWMust(response != nil, error);
    fprintf(stderr, "{\"ok\":true,\"status\":%ld,\"retryAttempts\":%lu,\"sentBodies\":%lu}\n",
            (long)response.statusCode,
            (unsigned long)response.attempts,
            (unsigned long)[transport.sentBodies count]);
    LBWExerciseFailurePaths();
    LBWExerciseMetricHelper();
    LBWExerciseTimelineHelpers();
  }
  return 0;
}
EOF

"$objc_command" -fobjc-arc -Wall -Wextra -Wpedantic -Werror \
  -I"$sdk_dir/include" \
  "$sdk_dir/src/LogBrew.m" \
  "$sdk_dir/src/LogBrewTrace.m" \
  "$sdk_dir/src/LogBrewNetworkValidation.m" \
  "$sdk_dir/src/LogBrewURLSession.m" \
  "$sdk_dir/src/LogBrewLifecycle.m" \
  "$app_dir/main.m" \
  -framework Foundation \
  -o "$app_dir/native_objc_app"
"$app_dir/native_objc_app" > "$tmp_dir/native-app.stdout.json" 2> "$tmp_dir/native-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/native-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/native-app.stdout.json" >/dev/null
grep -q '"retryAttempts":3' "$tmp_dir/native-app.stderr.json"

cat > "$app_dir/http_app.m" <<'EOF'
#import "LogBrew.h"

static void LBWDie(NSString *message) {
  fprintf(stderr, "%s\n", [message UTF8String]);
  exit(1);
}

int main(void) {
  @autoreleasepool {
    NSError *error = nil;
    NSString *endpoint = [[[NSProcessInfo processInfo] environment] objectForKey:@"LOGBREW_OBJC_HTTP_ENDPOINT"];
    LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
    config.sdkName = @"native-objc-http-app";
    config.maxRetries = 1U;
    LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
    if (client == nil) {
      LBWDie([error localizedDescription]);
    }
    if (![client logWithID:@"evt_objc_http_transport"
                 timestamp:@"2026-06-02T10:00:06Z"
                attributes:@{
                  @"message": @"objc http transport sent",
                  @"level": @"info",
                  @"logger": @"objc-http"
                }
                     error:&error]) {
      LBWDie([error localizedDescription]);
    }
    LBWHTTPTransport *transport = [[LBWHTTPTransport alloc] initWithEndpoint:endpoint
                                                                    headers:@{@"x-logbrew-source": @"objc-consumer"}
                                                                    timeout:5.0
                                                                      error:&error];
    if (transport == nil) {
      LBWDie([error localizedDescription]);
    }
    LBWTransportResponse *response = [client flushWithTransport:transport error:&error];
    if (response == nil) {
      LBWDie([error localizedDescription]);
    }
    if (response.statusCode != 202 || response.attempts != 2U || client.pendingEvents != 0U) {
      LBWDie([NSString stringWithFormat:@"unexpected HTTP response status=%ld attempts=%lu pending=%lu",
                                        (long)response.statusCode,
                                        (unsigned long)response.attempts,
                                        (unsigned long)client.pendingEvents]);
    }
    fprintf(stderr, "{\"ok\":true,\"httpAttempts\":%lu}\n", (unsigned long)response.attempts);
  }
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
cat > "$tmp_dir/objc_intake.py" <<'PY'
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
    print(f"objc intake timed out after {Handler.count} request(s)", file=sys.stderr)
    sys.exit(1)
PY
intake_ready="$tmp_dir/http-intake.ready"
intake_log="$tmp_dir/http-intake.jsonl"
python3 "$tmp_dir/objc_intake.py" "$http_port" "$intake_ready" "$intake_log" \
  > "$tmp_dir/http-intake.stdout" 2> "$tmp_dir/http-intake.stderr" &
intake_pid="$!"
for _attempt in {1..600}; do
  if [[ -f "$intake_ready" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -f "$intake_ready" ]]; then
  echo "objc intake server did not become ready" >&2
  exit 1
fi

"$objc_command" -fobjc-arc -Wall -Wextra -Wpedantic -Werror \
  -I"$sdk_dir/include" \
  "$sdk_dir/src/LogBrew.m" \
  "$sdk_dir/src/LogBrewTrace.m" \
  "$sdk_dir/src/LogBrewNetworkValidation.m" \
  "$sdk_dir/src/LogBrewURLSession.m" \
  "$sdk_dir/src/LogBrewLifecycle.m" \
  "$sdk_dir/src/LBWHTTPTransport.m" \
  "$app_dir/http_app.m" \
  -framework Foundation \
  -o "$app_dir/http_app"
LOGBREW_OBJC_HTTP_ENDPOINT="http://127.0.0.1:$http_port/v1/events" \
  "$app_dir/http_app" > "$tmp_dir/http-app.stdout.json" 2> "$tmp_dir/http-app.stderr.json"
wait "$intake_pid"
grep -q '"httpAttempts":2' "$tmp_dir/http-app.stderr.json"
python3 - "$intake_log" <<'PY'
import json
import sys
from pathlib import Path

requests = [json.loads(line) for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()]
if len(requests) != 2:
    raise SystemExit(f"expected 2 Objective-C HTTP delivery attempts, got {len(requests)}")
for request in requests:
    if request["authorization"] != "Bearer LOGBREW_API_KEY":
        raise SystemExit(f"unexpected authorization header: {request['authorization']}")
    if request["contentType"] != "application/json":
        raise SystemExit(f"unexpected content type: {request['contentType']}")
    if request["source"] != "objc-consumer":
        raise SystemExit(f"unexpected source header: {request['source']}")
    if request["path"] != "/v1/events":
        raise SystemExit(f"unexpected path: {request['path']}")
if "evt_objc_http_transport" not in requests[1]["body"]:
    raise SystemExit("missing Objective-C HTTP transport event in final request body")
PY

make -C "$sdk_dir/examples" OBJC="$objc_command" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"
grep -qx 'run-trace-correlation -> make run-trace-correlation' "$tmp_dir/examples-help.txt"
make -C "$sdk_dir/examples" OBJC="$objc_command" run-readme-example > "$tmp_dir/readme-example.stdout.json" 2> "$tmp_dir/readme-example.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme-example.stdout.json" >/dev/null
make -C "$sdk_dir/examples" OBJC="$objc_command" run-real-user-smoke > "$tmp_dir/real-user-smoke.stdout.json" 2> "$tmp_dir/real-user-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
make -C "$sdk_dir/examples" OBJC="$objc_command" run-trace-correlation > "$tmp_dir/trace-correlation.stdout.json" 2> "$tmp_dir/trace-correlation.stderr.json"
python3 "$repo_root/scripts/check_objc_trace_correlation_payload.py" \
  "$tmp_dir/trace-correlation.stdout.json" \
  "$tmp_dir/trace-correlation.stderr.json" >/dev/null

echo "objc real-user smoke passed with $($objc_command --version | head -n 1)"
