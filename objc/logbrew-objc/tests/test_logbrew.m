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

static void LBWExerciseTimelineHelpers(void) {
  NSError *error = nil;
  LBWClient *client = LBWNewClient();
  NSDictionary<NSString *, id> *context = @{
    @"sessionId": @"session_123",
    @"screen": @"Checkout",
    @"traceId": @"trace_abc",
    @"funnel": @"checkout",
    @"step": @"payment"
  };
  LBWAssert([client captureProductActionWithID:@"evt_product_action_001"
                                     timestamp:@"2026-06-02T10:00:07Z"
                                          name:@"checkout.pay_tapped"
                                        status:nil
                                       context:context
                                      metadata:@{@"component": @"pay-button"}
                                         error:&error], @"product action helper failed");
  LBWAssert([client captureNetworkMilestoneWithID:@"evt_network_milestone_001"
                                        timestamp:@"2026-06-02T10:00:08Z"
                                           method:@"post"
                                    routeTemplate:@"https://mobile.example.test/api/checkout?itemId=123#pay"
                                       statusCode:@503
                                       durationMs:@184.5
                                           status:nil
                                          context:context
                                         metadata:@{@"retryable": @YES}
                                            error:&error], @"network milestone helper failed");

  NSString *preview = [client previewJSONWithError:&error];
  LBWAssert(preview != nil, @"timeline preview failed");
  NSDictionary<NSString *, id> *payload = LBWJSON(preview);
  NSArray<NSDictionary<NSString *, id> *> *events = payload[@"events"];
  NSDictionary<NSString *, id> *actionAttributes = events[0][@"attributes"];
  NSDictionary<NSString *, id> *actionMetadata = actionAttributes[@"metadata"];
  NSDictionary<NSString *, id> *networkAttributes = events[1][@"attributes"];
  NSDictionary<NSString *, id> *networkMetadata = networkAttributes[@"metadata"];

  LBWAssert([actionAttributes[@"name"] isEqualToString:@"checkout.pay_tapped"], @"action name failed");
  LBWAssert([actionAttributes[@"status"] isEqualToString:@"success"], @"action status failed");
  LBWAssert([actionMetadata[@"source"] isEqualToString:@"objc.action"], @"action source failed");
  LBWAssert([actionMetadata[@"sessionId"] isEqualToString:@"session_123"], @"action session failed");
  LBWAssert([actionMetadata[@"component"] isEqualToString:@"pay-button"], @"action metadata failed");
  LBWAssert([networkAttributes[@"name"] isEqualToString:@"POST /api/checkout"], @"network name failed");
  LBWAssert([networkAttributes[@"status"] isEqualToString:@"failure"], @"network status failed");
  LBWAssert([networkMetadata[@"source"] isEqualToString:@"objc.network"], @"network source failed");
  LBWAssert([networkMetadata[@"method"] isEqualToString:@"POST"], @"network method failed");
  LBWAssert([networkMetadata[@"routeTemplate"] isEqualToString:@"/api/checkout"], @"network route failed");
  LBWAssert([networkMetadata[@"statusCode"] integerValue] == 503, @"network status code failed");
  LBWAssert([networkMetadata[@"durationMs"] doubleValue] == 184.5, @"network duration failed");
  LBWAssert([preview rangeOfString:@"itemId"].location == NSNotFound, @"query text leaked");
  LBWAssert([preview rangeOfString:@"#pay"].location == NSNotFound, @"fragment text leaked");

  BOOL ok = [client captureNetworkMilestoneWithID:@"evt_bad_duration"
                                        timestamp:@"2026-06-02T10:00:08Z"
                                           method:@"GET"
                                    routeTemplate:@"/api/checkout"
                                       statusCode:nil
                                       durationMs:@-1
                                           status:nil
                                          context:nil
                                         metadata:nil
                                            error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"bad duration failed");
  ok = [client captureNetworkMilestoneWithID:@"evt_query_only"
                                   timestamp:@"2026-06-02T10:00:08Z"
                                      method:@"GET"
                               routeTemplate:@"?private=value"
                                  statusCode:nil
                                  durationMs:nil
                                      status:nil
                                     context:nil
                                    metadata:nil
                                       error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"query-only route failed");
  ok = [client captureNetworkMilestoneWithID:@"evt_fractional_status"
                                   timestamp:@"2026-06-02T10:00:08Z"
                                      method:@"GET"
                               routeTemplate:@"/api/checkout"
                                  statusCode:@202.5
                                  durationMs:nil
                                      status:nil
                                     context:nil
                                    metadata:nil
                                       error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"fractional status failed");
  ok = [client captureProductActionWithID:@"evt_nested_metadata"
                                timestamp:@"2026-06-02T10:00:07Z"
                                     name:@"checkout.pay_tapped"
                                   status:nil
                                  context:nil
                                 metadata:@{@"nested": @{@"bad": @"value"}}
                                    error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"nested metadata failed");
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
    LBWExerciseTimelineHelpers();
  }
  return 0;
}
