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

  LBWClient *statusClient = LBWNewClient();
  LBWQueueEvents(statusClient);
  LBWRecordingTransport *statusTransport =
      [[LBWRecordingTransport alloc] initWithSteps:@[[LBWRecordingStep statusCodeStep:422]]];
  if ([statusClient flushWithTransport:statusTransport error:&error] != nil) {
    LBWDie(@"non-retryable status did not fail");
  }
  LBWRequireCode(error, @"transport_error", @"non-retryable status used wrong code");

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
      [preview rangeOfString:@"\"name\":\"POST \\/api\\/checkout\""].location == NSNotFound ||
      [preview rangeOfString:@"\"status\":\"failure\""].location == NSNotFound ||
      [preview rangeOfString:@"itemId"].location != NSNotFound ||
      [preview rangeOfString:@"#pay"].location != NSNotFound) {
    LBWDie(@"timeline helper preview failed");
  }
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
    LBWExerciseTimelineHelpers();
  }
  return 0;
}
