#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/objc/logbrew-objc"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

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

rm -rf "$sdk_dir"
if [[ -d "$sdk_dir" ]]; then
  echo "dependency removal failed" >&2
  exit 1
fi
mkdir -p "$sdk_dir"
tar -xzf "$archive" -C "$sdk_dir"
test -f "$sdk_dir/include/LogBrew.h"
test -f "$sdk_dir/src/LogBrew.m"

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
                          attributes:@{@"title": @"Checkout timeout", @"level": @"fatal"}
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
  }
  return 0;
}
EOF

"$objc_command" -fobjc-arc -Wall -Wextra -Wpedantic -Werror \
  -I"$sdk_dir/include" \
  "$sdk_dir/src/LogBrew.m" \
  "$app_dir/main.m" \
  -framework Foundation \
  -o "$app_dir/native_objc_app"
"$app_dir/native_objc_app" > "$tmp_dir/native-app.stdout.json" 2> "$tmp_dir/native-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/native-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/native-app.stdout.json" >/dev/null
grep -q '"retryAttempts":3' "$tmp_dir/native-app.stderr.json"

make -C "$sdk_dir/examples" OBJC="$objc_command" > "$tmp_dir/examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/examples-help.txt"
make -C "$sdk_dir/examples" OBJC="$objc_command" run-readme-example > "$tmp_dir/readme-example.stdout.json" 2> "$tmp_dir/readme-example.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme-example.stdout.json" >/dev/null
make -C "$sdk_dir/examples" OBJC="$objc_command" run-real-user-smoke > "$tmp_dir/real-user-smoke.stdout.json" 2> "$tmp_dir/real-user-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/real-user-smoke.stdout.json" >/dev/null

echo "objc real-user smoke passed with $($objc_command --version | head -n 1)"
