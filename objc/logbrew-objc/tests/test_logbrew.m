#import "LogBrew.h"

static void LBWTestFail(NSString *message) {
  fprintf(stderr, "%s\n", [message UTF8String]);
  exit(1);
}

static void LBWAssert(BOOL condition, NSString *message) {
  if (!condition) {
    LBWTestFail(message);
  }
}

static NSString *LBWStableCode(NSError *error) {
  NSString *code = error.userInfo[LBWErrorStableCodeKey];
  return code != nil ? code : @"";
}

static LBWClient *LBWNewClient(void) {
  NSError *error = nil;
  LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  config.sdkName = @"logbrew-objc";
  LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
  if (client == nil) {
    LBWTestFail([NSString stringWithFormat:@"client init failed: %@", error]);
  }
  return client;
}

static void LBWQueueEvents(LBWClient *client) {
  NSError *error = nil;
  LBWAssert([client releaseWithID:@"evt_release_001"
                        timestamp:@"2026-06-02T10:00:00Z"
                       attributes:@{
                         @"version": @"1.2.3",
                         @"commit": @"abc123def456",
                         @"notes": @"Public release marker"
                       }
                            error:&error], @"release failed");
  LBWAssert([client environmentWithID:@"evt_environment_001"
                            timestamp:@"2026-06-02T10:00:01Z"
                           attributes:@{@"name": @"production", @"region": @"global"}
                                error:&error], @"environment failed");
  LBWAssert([client issueWithID:@"evt_issue_001"
                      timestamp:@"2026-06-02T10:00:02Z"
                     attributes:@{
                       @"title": @"Checkout timeout",
                       @"level": @"error",
                       @"message": @"Request timed out after retry budget"
                     }
                          error:&error], @"issue failed");
  LBWAssert([client logWithID:@"evt_log_001"
                    timestamp:@"2026-06-02T10:00:03Z"
                   attributes:@{
                     @"message": @"worker started",
                     @"level": @"info",
                     @"logger": @"job-runner"
                   }
                        error:&error], @"log failed");
  LBWAssert([client spanWithID:@"evt_span_001"
                     timestamp:@"2026-06-02T10:00:04Z"
                    attributes:@{
                      @"name": @"GET /health",
                      @"traceId": @"trace_001",
                      @"spanId": @"span_001",
                      @"status": @"ok",
                      @"durationMs": @12.5
                    }
                         error:&error], @"span failed");
  LBWAssert([client actionWithID:@"evt_action_001"
                       timestamp:@"2026-06-02T10:00:05Z"
                      attributes:@{@"name": @"deploy", @"status": @"success"}
                           error:&error], @"action failed");
}

static NSDictionary<NSString *, id> *LBWJSON(NSString *body) {
  NSData *data = [body dataUsingEncoding:NSUTF8StringEncoding];
  NSError *error = nil;
  NSDictionary<NSString *, id> *payload = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (payload == nil) {
    LBWTestFail([NSString stringWithFormat:@"json parse failed: %@", error]);
  }
  return payload;
}

static void LBWExerciseFailurePaths(void) {
  NSError *error = nil;
  LBWClient *emptyClient = LBWNewClient();
  LBWRecordingTransport *emptyTransport = [[LBWRecordingTransport alloc] init];
  LBWTransportResponse *emptyResponse = [emptyClient flushWithTransport:emptyTransport error:&error];
  LBWAssert(emptyResponse.statusCode == 204 && emptyResponse.attempts == 0U, @"empty flush failed");

  BOOL ok = [emptyClient issueWithID:@"evt_bad"
                           timestamp:@"2026-06-02T10:00:02Z"
                          attributes:@{@"title": @"Checkout timeout", @"level": @"fatal"}
                               error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"validation code failed");

  LBWClient *unauthClient = LBWNewClient();
  LBWQueueEvents(unauthClient);
  LBWRecordingTransport *unauthTransport =
      [[LBWRecordingTransport alloc] initWithSteps:@[[LBWRecordingStep statusCodeStep:401]]];
  LBWAssert([unauthClient flushWithTransport:unauthTransport error:&error] == nil &&
                [LBWStableCode(error) isEqualToString:@"unauthenticated"],
            @"unauthenticated code failed");

  LBWClient *statusClient = LBWNewClient();
  LBWQueueEvents(statusClient);
  LBWRecordingTransport *statusTransport =
      [[LBWRecordingTransport alloc] initWithSteps:@[[LBWRecordingStep statusCodeStep:422]]];
  LBWAssert([statusClient flushWithTransport:statusTransport error:&error] == nil &&
                [LBWStableCode(error) isEqualToString:@"transport_error"],
            @"non-retryable code failed");

  LBWClient *retryClient = LBWNewClient();
  LBWQueueEvents(retryClient);
  LBWRecordingTransport *retryTransport = [[LBWRecordingTransport alloc] initWithSteps:@[
    [LBWRecordingStep networkFailureWithMessage:@"first failure"],
    [LBWRecordingStep networkFailureWithMessage:@"second failure"],
    [LBWRecordingStep networkFailureWithMessage:@"third failure"]
  ]];
  LBWAssert([retryClient flushWithTransport:retryTransport error:&error] == nil &&
                [LBWStableCode(error) isEqualToString:@"network_failure"],
            @"retry-budget code failed");

  LBWClient *shutdownClient = LBWNewClient();
  LBWQueueEvents(shutdownClient);
  LBWRecordingTransport *acceptTransport = [[LBWRecordingTransport alloc] init];
  LBWAssert([shutdownClient shutdownWithTransport:acceptTransport error:&error] != nil, @"shutdown failed");
  ok = [shutdownClient actionWithID:@"evt_after_shutdown"
                          timestamp:@"2026-06-02T10:00:05Z"
                         attributes:@{@"name": @"deploy", @"status": @"success"}
                              error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"shutdown_error"], @"post-shutdown code failed");
}

int main(void) {
  @autoreleasepool {
    NSError *error = nil;
    LBWClient *client = LBWNewClient();
    LBWQueueEvents(client);
    LBWAssert(client.pendingEvents == 6U, @"pending count failed");
    NSString *preview = [client previewJSONWithError:&error];
    LBWAssert(preview != nil, @"preview failed");
    NSDictionary<NSString *, id> *payload = LBWJSON(preview);
    LBWAssert([payload[@"events"] count] == 6U, @"event count failed");
    LBWRecordingTransport *transport = [[LBWRecordingTransport alloc] initWithSteps:@[
      [LBWRecordingStep networkFailureWithMessage:@"temporary network failure"],
      [LBWRecordingStep statusCodeStep:503],
      [LBWRecordingStep statusCodeStep:202]
    ]];
    LBWTransportResponse *response = [client flushWithTransport:transport error:&error];
    LBWAssert(response.statusCode == 202 && response.attempts == 3U, @"retry success failed");
    LBWAssert([transport.sentBodies count] == 3U && transport.lastBody != nil, @"recording transport failed");
    LBWAssert(client.pendingEvents == 0U, @"flush did not clear events");
    LBWExerciseFailurePaths();
  }
  return 0;
}
