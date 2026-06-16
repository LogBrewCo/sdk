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

static NSDictionary<NSString *, id> *LBWEventWithID(NSDictionary<NSString *, id> *payload, NSString *eventID) {
  for (NSDictionary<NSString *, id> *event in payload[@"events"]) {
    if ([event[@"id"] isEqualToString:eventID]) {
      return event;
    }
  }
  LBWTestFail([NSString stringWithFormat:@"missing event %@", eventID]);
  return @{};
}

static void LBWExerciseFailurePaths(void) {
  NSError *error = nil;
  LBWClient *emptyClient = LBWNewClient();
  LBWRecordingTransport *emptyTransport = [[LBWRecordingTransport alloc] init];
  LBWTransportResponse *emptyResponse = [emptyClient flushWithTransport:emptyTransport error:&error];
  LBWAssert(emptyResponse.statusCode == 204 && emptyResponse.attempts == 0U, @"empty flush failed");

  BOOL ok = [emptyClient issueWithID:@"evt_bad"
                           timestamp:@"2026-06-02T10:00:02Z"
                          attributes:@{@"title": @"Checkout timeout", @"level": @"verbose"}
                               error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"validation code failed");

  LBWClient *aliasClient = LBWNewClient();
  LBWAssert([aliasClient issueWithID:@"evt_issue_alias"
                           timestamp:@"2026-06-02T10:00:02Z"
                          attributes:@{@"title": @"Checkout timeout", @"level": @"fatal"}
                               error:&error],
            @"fatal issue alias failed");
  LBWAssert([aliasClient logWithID:@"evt_log_debug"
                         timestamp:@"2026-06-02T10:00:03Z"
                        attributes:@{@"message": @"verbose runtime detail", @"level": @"debug"}
                             error:&error],
            @"debug log alias failed");
  NSString *aliasPreview = [aliasClient previewJSONWithError:&error];
  LBWAssert([aliasPreview containsString:@"\"level\":\"critical\""], @"fatal alias did not normalize");
  LBWAssert([aliasPreview containsString:@"\"level\":\"info\""], @"debug alias did not normalize");

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

static void LBWExerciseMetricHelper(void) {
  NSError *error = nil;
  LBWClient *client = LBWNewClient();
  LBWAssert([client metricWithID:@"evt_metric_001"
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
                           error:&error], @"metric helper failed");
  NSString *preview = [client previewJSONWithError:&error];
  LBWAssert(preview != nil, @"metric preview failed");
  NSDictionary<NSString *, id> *payload = LBWJSON(preview);
  NSArray<NSDictionary<NSString *, id> *> *events = payload[@"events"];
  NSDictionary<NSString *, id> *metricAttributes = events[0][@"attributes"];
  NSDictionary<NSString *, id> *metadata = metricAttributes[@"metadata"];
  LBWAssert([events[0][@"type"] isEqualToString:@"metric"], @"metric type failed");
  LBWAssert([metricAttributes[@"name"] isEqualToString:@"checkout.latency"], @"metric name failed");
  LBWAssert([metricAttributes[@"kind"] isEqualToString:@"histogram"], @"metric kind failed");
  LBWAssert([metricAttributes[@"value"] doubleValue] == 184.5, @"metric value failed");
  LBWAssert([metricAttributes[@"unit"] isEqualToString:@"ms"], @"metric unit failed");
  LBWAssert([metricAttributes[@"temporality"] isEqualToString:@"delta"], @"metric temporality failed");
  LBWAssert([metadata[@"routeTemplate"] isEqualToString:@"/api/checkout"], @"metric metadata failed");

  BOOL ok = [client metricWithID:@"evt_bad_counter"
                       timestamp:@"2026-06-02T10:00:06Z"
                      attributes:@{
                        @"name": @"jobs.processed",
                        @"kind": @"counter",
                        @"value": @-1,
                        @"unit": @"1",
                        @"temporality": @"delta"
                      }
                           error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"negative counter failed");
  ok = [client metricWithID:@"evt_bad_gauge"
                 timestamp:@"2026-06-02T10:00:06Z"
                attributes:@{
                  @"name": @"queue.depth",
                  @"kind": @"gauge",
                  @"value": @3,
                  @"unit": @"1",
                  @"temporality": @"delta"
                }
                     error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"bad gauge temporality failed");
  ok = [client metricWithID:@"evt_nested_metric_metadata"
                 timestamp:@"2026-06-02T10:00:06Z"
                attributes:@{
                  @"name": @"queue.depth",
                  @"kind": @"gauge",
                  @"value": @3,
                  @"unit": @"1",
                  @"temporality": @"instant",
                  @"metadata": @{@"nested": @{@"bad": @"value"}}
                }
                     error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"nested metric metadata failed");
}

static void LBWExerciseTraceHelpers(void) {
  NSError *error = nil;
  NSString *incoming = @"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  LBWTraceContext *parsed = [LBWTraceContext contextFromTraceparent:incoming error:&error];
  LBWAssert(parsed != nil, @"traceparent parse failed");
  LBWAssert([parsed.traceID isEqualToString:@"4bf92f3577b34da6a3ce929d0e0e4736"], @"parsed trace id failed");
  LBWAssert([parsed.spanID isEqualToString:@"00f067aa0ba902b7"], @"parsed parent span failed");
  LBWAssert(parsed.sampled, @"parsed sampled flag failed");

  LBWTraceContext *context = [LBWTraceContext continueOrCreateContextFromTraceparent:incoming];
  LBWAssert([context.traceID isEqualToString:parsed.traceID], @"continued trace id failed");
  LBWAssert([context.parentSpanID isEqualToString:parsed.spanID], @"continued parent span failed");
  LBWAssert(![context.spanID isEqualToString:parsed.spanID], @"continued span reused parent");
  NSDictionary<NSString *, NSString *> *headers = [context outgoingHeaders];
  LBWAssert([headers[@"traceparent"] hasPrefix:@"00-4bf92f3577b34da6a3ce929d0e0e4736-"], @"outgoing trace failed");
  NSDictionary<NSString *, id> *unscopedSpanAttributes = [context spanAttributesWithName:@"manual child work"
                                                                                  status:@"ok"
                                                                              durationMs:nil
                                                                                metadata:@{@"routeTemplate": @"/manual"}
                                                                                   error:&error];
  LBWAssert([unscopedSpanAttributes[@"metadata"][@"traceId"] isEqualToString:context.traceID],
            @"unscoped span metadata failed");

  LBWTraceContext *fallback = [LBWTraceContext continueOrCreateContextFromTraceparent:@"malformed"];
  LBWAssert([fallback.traceID length] == 32U && fallback.parentSpanID == nil, @"malformed fallback failed");
  LBWAssert([LBWTraceContext contextFromTraceparent:@"00-00000000000000000000000000000000-00f067aa0ba902b7-01"
                                             error:&error] == nil &&
                [LBWStableCode(error) isEqualToString:@"validation_error"],
            @"strict all-zero trace id failed");

  LBWClient *client = LBWNewClient();
  LBWTraceScope *scope = [LBWTrace activateContext:context];
  LBWAssert([LBWTrace currentContext] == context, @"active context failed");
  LBWAssert([client issueWithID:@"evt_trace_issue_001"
                      timestamp:@"2026-06-02T10:00:02Z"
                     attributes:@{
                       @"title": @"Checkout timeout",
                       @"level": @"error",
                       @"metadata": @{@"traceId": @"caller_supplied_trace", @"component": @"checkout"}
                     }
                          error:&error], @"trace issue failed");
  LBWAssert([client logWithID:@"evt_trace_log_001"
                    timestamp:@"2026-06-02T10:00:03Z"
                   attributes:@{
                     @"message": @"checkout retry scheduled",
                     @"level": @"warning",
                     @"logger": @"checkout"
                   }
                        error:&error], @"trace log failed");
  LBWAssert([client captureProductActionWithID:@"evt_trace_action_001"
                                     timestamp:@"2026-06-02T10:00:04Z"
                                          name:@"checkout.pay_tapped"
                                        status:nil
                                       context:@{@"sessionId": @"session_123"}
                                      metadata:@{@"component": @"pay-button"}
                                         error:&error], @"trace action failed");
  LBWAssert([client metricWithID:@"evt_trace_metric_001"
                       timestamp:@"2026-06-02T10:00:06Z"
                      attributes:@{
                        @"name": @"http.server.duration",
                        @"kind": @"histogram",
                        @"value": @184.5,
                        @"unit": @"ms",
                        @"temporality": @"delta"
                      }
                           error:&error], @"trace metric failed");
  NSDictionary<NSString *, id> *spanAttributes = [context spanAttributesWithName:@"POST /api/checkout"
                                                                          status:@"error"
                                                                      durationMs:@184.5
                                                                        metadata:nil
                                                                           error:&error];
  LBWAssert(spanAttributes != nil, @"trace span attributes failed");
  LBWAssert([client spanWithID:@"evt_trace_span_001"
                     timestamp:@"2026-06-02T10:00:07Z"
                    attributes:spanAttributes
                         error:&error], @"trace span failed");
  NSMutableURLRequest *request =
      [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"https://api.example.com/api/checkout?cart=123#pay"]];
  request.HTTPMethod = @"post";
  [request setValue:@"app-owned-header-value" forHTTPHeaderField:@"x-app-context"];
  LBWURLSessionSpan *urlSessionSpan = [LBWTrace startURLSessionSpanForRequest:request error:&error];
  LBWAssert(urlSessionSpan != nil, @"URLSession span start failed");
  LBWAssert([urlSessionSpan.method isEqualToString:@"POST"], @"URLSession method normalization failed");
  LBWAssert([urlSessionSpan.routeTemplate isEqualToString:@"/api/checkout"], @"URLSession route failed");
  LBWAssert([urlSessionSpan.traceContext.traceID isEqualToString:context.traceID], @"URLSession trace id failed");
  LBWAssert([urlSessionSpan.traceContext.parentSpanID isEqualToString:context.spanID],
            @"URLSession parent span failed");
  LBWAssert([urlSessionSpan.request valueForHTTPHeaderField:@"traceparent"] != nil,
            @"URLSession traceparent missing");
  LBWAssert([[urlSessionSpan.request valueForHTTPHeaderField:@"x-app-context"] isEqualToString:@"app-owned-header-value"],
            @"URLSession app header not preserved on copied request");
  LBWAssert([client captureURLSessionSpanWithID:@"evt_trace_urlsession_001"
                                      timestamp:@"2026-06-02T10:00:08Z"
                                           span:urlSessionSpan
                                     statusCode:@503
                                     durationMs:@184.5
                                      errorType:nil
                                       metadata:@{@"component": @"pay-api"}
                                          error:&error], @"URLSession span capture failed");
  LBWAssert([client captureLifecycleSpanWithID:@"evt_trace_lifecycle_001"
                                     timestamp:@"2026-06-02T10:00:09Z"
                                 previousState:@" active "
                                  currentState:@"background"
                                    durationMs:@1532.25
                                       context:@{@"screen": @"Checkout", @"traceId": @"spoofed_trace"}
                                      metadata:@{@"component": @"app-delegate"}
                                         error:&error], @"lifecycle span capture failed");

  NSString *preview = [client previewJSONWithError:&error];
  LBWAssert(preview != nil, @"trace preview failed");
  NSDictionary<NSString *, id> *payload = LBWJSON(preview);
  NSDictionary<NSString *, id> *issue = LBWEventWithID(payload, @"evt_trace_issue_001");
  NSDictionary<NSString *, id> *issueMetadata = issue[@"attributes"][@"metadata"];
  LBWAssert([issueMetadata[@"traceId"] isEqualToString:context.traceID], @"trace metadata id failed");
  LBWAssert([issueMetadata[@"spanId"] isEqualToString:context.spanID], @"trace metadata span failed");
  LBWAssert([issueMetadata[@"parentSpanId"] isEqualToString:parsed.spanID], @"trace metadata parent failed");
  LBWAssert([issueMetadata[@"component"] isEqualToString:@"checkout"], @"trace metadata app field failed");
  LBWAssert(![issueMetadata[@"traceId"] isEqualToString:@"caller_supplied_trace"], @"active trace did not win");
  NSDictionary<NSString *, id> *log = LBWEventWithID(payload, @"evt_trace_log_001");
  LBWAssert([log[@"attributes"][@"metadata"][@"spanId"] isEqualToString:context.spanID], @"log trace failed");
  NSDictionary<NSString *, id> *span = LBWEventWithID(payload, @"evt_trace_span_001");
  LBWAssert([span[@"attributes"][@"traceId"] isEqualToString:context.traceID], @"span trace id failed");
  LBWAssert([span[@"attributes"][@"spanId"] isEqualToString:context.spanID], @"span id failed");
  NSDictionary<NSString *, id> *urlSpan = LBWEventWithID(payload, @"evt_trace_urlsession_001")[@"attributes"];
  LBWAssert([urlSpan[@"traceId"] isEqualToString:context.traceID], @"URLSession event trace id failed");
  LBWAssert([urlSpan[@"parentSpanId"] isEqualToString:context.spanID], @"URLSession event parent failed");
  LBWAssert(![urlSpan[@"spanId"] isEqualToString:context.spanID], @"URLSession child span reused parent");
  LBWAssert([urlSpan[@"status"] isEqualToString:@"error"], @"URLSession span status failed");
  NSDictionary<NSString *, id> *urlMetadata = urlSpan[@"metadata"];
  LBWAssert([urlMetadata[@"source"] isEqualToString:@"objc.urlsession"], @"URLSession source failed");
  LBWAssert([urlMetadata[@"routeTemplate"] isEqualToString:@"/api/checkout"], @"URLSession metadata route failed");
  LBWAssert([urlMetadata[@"method"] isEqualToString:@"POST"], @"URLSession metadata method failed");
  LBWAssert([urlMetadata[@"statusCode"] isEqual:@503], @"URLSession statusCode failed");
  LBWAssert([urlMetadata[@"component"] isEqualToString:@"pay-api"], @"URLSession app metadata failed");
  NSDictionary<NSString *, id> *lifecycleSpan = LBWEventWithID(payload, @"evt_trace_lifecycle_001")[@"attributes"];
  LBWAssert([lifecycleSpan[@"traceId"] isEqualToString:context.traceID], @"lifecycle trace id failed");
  LBWAssert([lifecycleSpan[@"parentSpanId"] isEqualToString:context.spanID], @"lifecycle parent failed");
  LBWAssert(![lifecycleSpan[@"spanId"] isEqualToString:context.spanID], @"lifecycle child span reused parent");
  LBWAssert([lifecycleSpan[@"name"] isEqualToString:@"objc.lifecycle:active->background"], @"lifecycle name failed");
  LBWAssert([lifecycleSpan[@"status"] isEqualToString:@"ok"], @"lifecycle status failed");
  LBWAssert([lifecycleSpan[@"durationMs"] doubleValue] == 1532.25, @"lifecycle duration failed");
  NSDictionary<NSString *, id> *lifecycleMetadata = lifecycleSpan[@"metadata"];
  LBWAssert([lifecycleMetadata[@"source"] isEqualToString:@"objc.lifecycle"], @"lifecycle source failed");
  LBWAssert([lifecycleMetadata[@"previousState"] isEqualToString:@"active"], @"lifecycle previous state failed");
  LBWAssert([lifecycleMetadata[@"currentState"] isEqualToString:@"background"], @"lifecycle current state failed");
  LBWAssert([lifecycleMetadata[@"durationSource"] isEqualToString:@"previous_state"], @"lifecycle duration source failed");
  LBWAssert([lifecycleMetadata[@"screen"] isEqualToString:@"Checkout"], @"lifecycle context failed");
  LBWAssert([lifecycleMetadata[@"component"] isEqualToString:@"app-delegate"], @"lifecycle app metadata failed");
  LBWAssert([lifecycleMetadata[@"traceId"] isEqualToString:context.traceID], @"lifecycle trace metadata failed");
  LBWAssert(![lifecycleMetadata[@"traceId"] isEqualToString:@"spoofed_trace"], @"lifecycle spoofed trace won");
  LBWAssert([preview rangeOfString:@"cart=123"].location == NSNotFound, @"URLSession leaked query");
  LBWAssert([preview rangeOfString:@"#pay"].location == NSNotFound, @"URLSession leaked fragment");
  LBWAssert([preview rangeOfString:@"app-owned-header-value"].location == NSNotFound,
            @"URLSession leaked app header");
  LBWAssert([preview rangeOfString:@"traceparent"].location == NSNotFound, @"URLSession leaked traceparent");

  BOOL ok = [client captureLifecycleSpanWithID:@"evt_bad_lifecycle"
                                     timestamp:@"2026-06-02T10:00:09Z"
                                 previousState:@""
                                  currentState:@"background"
                                    durationMs:nil
                                       context:nil
                                      metadata:nil
                                         error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"bad lifecycle state failed");
  ok = [client captureLifecycleSpanWithID:@"evt_bad_lifecycle_duration"
                                timestamp:@"2026-06-02T10:00:09Z"
                            previousState:@"active"
                             currentState:@"background"
                               durationMs:@-1
                                  context:nil
                                 metadata:nil
                                    error:&error];
  LBWAssert(!ok && [LBWStableCode(error) isEqualToString:@"validation_error"], @"bad lifecycle duration failed");
  [scope close];
  LBWAssert([LBWTrace currentContext] == nil, @"trace scope close failed");
}

static void LBWExerciseHTTPTransportValidation(void) {
  NSError *error = nil;
  LBWHTTPTransport *transport = [[LBWHTTPTransport alloc] initWithEndpoint:@"ftp://example.com/v1/events"
                                                                   headers:nil
                                                                   timeout:1.0
                                                                     error:&error];
  LBWAssert(transport == nil && [LBWStableCode(error) isEqualToString:@"configuration_error"], @"bad endpoint failed");
  transport = [[LBWHTTPTransport alloc] initWithEndpoint:@"https://example.com/v1/events"
                                                 headers:nil
                                                 timeout:0.0
                                                   error:&error];
  LBWAssert(transport == nil && [LBWStableCode(error) isEqualToString:@"configuration_error"], @"bad timeout failed");
  transport = [[LBWHTTPTransport alloc] initWithEndpoint:@"https://example.com/v1/events"
                                                 headers:@{@"authorization": @"bad"}
                                                 timeout:1.0
                                                   error:&error];
  LBWAssert(transport == nil && [LBWStableCode(error) isEqualToString:@"configuration_error"], @"reserved header failed");
  transport = [[LBWHTTPTransport alloc] initWithEndpoint:@"https://example.com/v1/events"
                                                 headers:@{@"x-logbrew-source": @"objc-test"}
                                                 timeout:1.0
                                                   error:&error];
  LBWAssert(transport != nil, @"valid HTTP transport failed");
  LBWAssert([LBWHTTPTransportDefaultEndpoint isEqualToString:@"https://api.logbrew.com/v1/events"],
            @"default endpoint failed");
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
    LBWExerciseMetricHelper();
    LBWExerciseTimelineHelpers();
    LBWExerciseTraceHelpers();
    LBWExerciseHTTPTransportValidation();
  }
  return 0;
}
