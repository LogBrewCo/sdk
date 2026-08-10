#import "LogBrew.h"

static void LBWFail(NSString *message) {
  fprintf(stderr, "%s\n", [message UTF8String]);
  exit(1);
}

static void LBWAssert(BOOL condition, NSString *message) {
  if (!condition) {
    LBWFail(message);
  }
}

static NSDictionary<NSString *, id> *LBWPayload(LBWClient *client) {
  NSError *error = nil;
  NSString *json = [client previewJSONWithError:&error];
  if (json == nil) {
    LBWFail([NSString stringWithFormat:@"preview failed: %@", error]);
  }
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (![value isKindOfClass:[NSDictionary class]]) {
    LBWFail([NSString stringWithFormat:@"payload parse failed: %@", error]);
  }
  return value;
}

static NSDictionary<NSString *, id> *LBWEventWithID(NSDictionary<NSString *, id> *payload, NSString *eventID) {
  for (NSDictionary<NSString *, id> *event in payload[@"events"]) {
    if ([event[@"id"] isEqualToString:eventID]) {
      return event;
    }
  }
  LBWFail([NSString stringWithFormat:@"missing event: %@", eventID]);
  return @{};
}

static NSDictionary<NSString *, id> *LBWBaseContext(void) {
  return @{
    @"schemaVersion": @1,
    @"resource": @{
      @"service": @{@"name": @"checkout-api", @"version": @"2.4.0"},
      @"runtime": @{@"name": @"objective-c"}
    },
    @"tags": @{@"plan": @"team"}
  };
}

static NSDictionary<NSString *, id> *LBWAmbientContext(void) {
  return @{
    @"schemaVersion": @1,
    @"resource": @{
      @"deployment": @{@"environment": @"production", @"release": @"checkout@2.4.0"}
    },
    @"session": @{@"id": @"session_01", @"previousId": @"session_00"},
    @"tags": @{@"journey": @"checkout"}
  };
}

static NSDictionary<NSString *, id> *LBWEventContext(void) {
  return @{
    @"schemaVersion": @1,
    @"subject": @{@"id": @"subject_01", @"kind": @"user"},
    @"tags": @{@"step": @"confirm"}
  };
}

static LBWClient *LBWContextualClient(void) {
  NSError *error = nil;
  LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  config.includeAutomaticContext = NO;
  config.context = LBWBaseContext();
  LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
  if (client == nil) {
    LBWFail([NSString stringWithFormat:@"client init failed: %@", error]);
  }
  return client;
}

static void LBWCaptureContextualSignals(LBWClient *client) {
  NSError *error = nil;
  LBWTraceContext *trace = [LBWTraceContext contextWithTraceID:@"4bf92f3577b34da6a3ce929d0e0e4736"
                                                       spanID:@"00f067aa0ba902b7"
                                                 parentSpanID:@"1111111111111111"
                                                   traceFlags:@"01"
                                                        error:&error];
  LBWAssert(trace != nil, @"trace setup failed");
  LBWTelemetryScope *telemetryScope = [LBWTelemetry activateContext:LBWAmbientContext() error:&error];
  LBWAssert(telemetryScope != nil, @"telemetry scope setup failed");
  LBWTraceScope *traceScope = [LBWTrace activateContext:trace];
  NSDictionary<NSString *, id> *context = LBWEventContext();

  LBWAssert([client releaseWithID:@"release"
                        timestamp:@"2026-08-06T10:00:00Z"
                       attributes:@{@"version": @"2.4.0", @"context": context}
                            error:&error], @"release failed");
  LBWAssert([client environmentWithID:@"environment"
                            timestamp:@"2026-08-06T10:00:01Z"
                           attributes:@{@"name": @"production", @"context": context}
                                error:&error], @"environment failed");
  LBWAssert([client issueWithID:@"issue"
                      timestamp:@"2026-08-06T10:00:02Z"
                     attributes:@{@"title": @"Checkout failed", @"level": @"error", @"context": context}
                          error:&error], @"issue failed");
  LBWAssert([client logWithID:@"log"
                    timestamp:@"2026-08-06T10:00:03Z"
                   attributes:@{@"message": @"Checkout started", @"level": @"info", @"context": context}
                        error:&error], @"log failed");
  LBWAssert([client spanWithID:@"span"
                     timestamp:@"2026-08-06T10:00:04Z"
                    attributes:@{
                      @"name": @"checkout.submit",
                      @"traceId": trace.traceID,
                      @"spanId": trace.spanID,
                      @"parentSpanId": trace.parentSpanID,
                      @"status": @"error",
                      @"events": @[
                        @{
                          @"name": @"payment.retry",
                          @"timestamp": @"2026-08-06T10:00:04.200Z",
                          @"metadata": @{@"attempt": @2}
                        }
                      ],
                      @"links": @[
                        @{
                          @"traceId": @"22222222222222222222222222222222",
                          @"spanId": @"3333333333333333",
                          @"sampled": @YES,
                          @"metadata": @{@"relationship": @"follows_from"}
                        }
                      ],
                      @"context": context
                    }
                         error:&error], @"span failed");
  LBWAssert([client actionWithID:@"action"
                       timestamp:@"2026-08-06T10:00:05Z"
                      attributes:@{@"name": @"checkout.submit", @"status": @"failure", @"context": context}
                           error:&error], @"action failed");
  LBWAssert([client metricWithID:@"metric"
                       timestamp:@"2026-08-06T10:00:06Z"
                      attributes:@{
                        @"name": @"checkout.duration",
                        @"kind": @"histogram",
                        @"value": @420,
                        @"unit": @"ms",
                        @"temporality": @"delta",
                        @"context": context
                      }
                           error:&error], @"metric failed");

  [traceScope close];
  [telemetryScope close];
  LBWAssert([LBWTelemetry currentContext] == nil, @"telemetry scope remained active after close");
}

static void LBWAssertMergedContext(NSDictionary<NSString *, id> *event) {
  NSDictionary<NSString *, id> *attributes = event[@"attributes"];
  NSDictionary<NSString *, id> *context = attributes[@"context"];
  NSDictionary<NSString *, id> *resource = context[@"resource"];
  NSDictionary<NSString *, id> *service = resource[@"service"];
  NSDictionary<NSString *, id> *deployment = resource[@"deployment"];
  NSDictionary<NSString *, id> *trace = context[@"trace"];
  NSDictionary<NSString *, id> *session = context[@"session"];
  NSDictionary<NSString *, id> *subject = context[@"subject"];
  NSDictionary<NSString *, id> *tags = context[@"tags"];

  LBWAssert([context[@"schemaVersion"] isEqual:@1], @"schema version missing");
  LBWAssert([service[@"name"] isEqualToString:@"checkout-api"], @"service missing");
  LBWAssert([service[@"version"] isEqualToString:@"2.4.0"], @"service version missing");
  LBWAssert([deployment[@"environment"] isEqualToString:@"production"], @"environment missing");
  LBWAssert([deployment[@"release"] isEqualToString:@"checkout@2.4.0"], @"release missing");
  LBWAssert([trace[@"traceId"] isEqualToString:@"4bf92f3577b34da6a3ce929d0e0e4736"], @"trace missing");
  LBWAssert([trace[@"spanId"] isEqualToString:@"00f067aa0ba902b7"], @"span missing");
  LBWAssert([trace[@"parentSpanId"] isEqualToString:@"1111111111111111"], @"parent span missing");
  LBWAssert([trace[@"sampled"] boolValue], @"sampled state missing");
  LBWAssert([session[@"id"] isEqualToString:@"session_01"], @"session missing");
  LBWAssert([subject[@"id"] isEqualToString:@"subject_01"], @"subject missing");
  LBWAssert([subject[@"kind"] isEqualToString:@"user"], @"subject kind missing");
  LBWAssert([tags isEqual:@{@"plan": @"team", @"journey": @"checkout", @"step": @"confirm"}], @"tags did not merge");
}

static void LBWTestSharedContext(void) {
  LBWClient *client = LBWContextualClient();
  LBWCaptureContextualSignals(client);
  NSDictionary<NSString *, id> *payload = LBWPayload(client);
  NSArray<NSDictionary<NSString *, id> *> *events = payload[@"events"];
  LBWAssert([events count] == 7U, @"expected all seven signals");
  for (NSDictionary<NSString *, id> *event in events) {
    LBWAssertMergedContext(event);
  }
  NSDictionary<NSString *, id> *span = LBWEventWithID(payload, @"span")[@"attributes"];
  LBWAssert([span[@"events"] count] == 1U, @"span events missing");
  LBWAssert([span[@"links"] count] == 1U, @"span links missing");
}

static void LBWTestAutomaticContext(void) {
  NSError *error = nil;
  LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
  LBWAssert(client != nil, @"automatic client failed");
  LBWAssert([client logWithID:@"automatic"
                    timestamp:@"2026-08-06T10:00:00Z"
                   attributes:@{@"message": @"app started", @"level": @"info"}
                        error:&error], @"automatic log failed");
  NSDictionary<NSString *, id> *event = LBWEventWithID(LBWPayload(client), @"automatic");
  NSDictionary<NSString *, id> *context = event[@"attributes"][@"context"];
  NSDictionary<NSString *, id> *resource = context[@"resource"];
  LBWAssert([resource[@"runtime"][@"name"] isEqualToString:@"objective-c"], @"runtime context missing");
  LBWAssert([resource[@"operatingSystem"][@"name"] length] > 0U, @"operating system missing");
  LBWAssert([resource[@"operatingSystem"][@"version"] length] > 0U, @"operating-system version missing");
  LBWAssert([resource[@"device"][@"architecture"] length] > 0U, @"architecture missing");
  LBWAssert(context[@"session"] == nil, @"automatic context collected a session");
  LBWAssert(context[@"subject"] == nil, @"automatic context collected a subject");
  LBWAssert(context[@"tags"] == nil, @"automatic context collected tags");

  LBWConfig *optOutConfig = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  optOutConfig.includeAutomaticContext = NO;
  LBWClient *optOutClient = [[LBWClient alloc] initWithConfig:optOutConfig error:&error];
  LBWAssert([optOutClient logWithID:@"opt-out"
                          timestamp:@"2026-08-06T10:00:01Z"
                         attributes:@{@"message": @"app started", @"level": @"info"}
                              error:&error], @"opt-out log failed");
  NSDictionary<NSString *, id> *optOut = LBWEventWithID(LBWPayload(optOutClient), @"opt-out");
  LBWAssert(optOut[@"attributes"][@"context"] == nil, @"automatic context opt-out failed");
}

static void LBWTestIssueEvidence(void) {
  NSError *error = nil;
  LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  config.includeAutomaticContext = NO;
  LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
  for (NSUInteger index = 0U; index < 66U; index++) {
    NSDictionary<NSString *, id> *breadcrumb = @{
      @"timestamp": index == 65U ? @" 2026-08-06T10:00:00Z " : @"2026-08-06T10:00:00Z",
      @"category": [NSString stringWithFormat:@"step_%lu", (unsigned long)index],
      @"type": @"navigation",
      @"level": @"info",
      @"message": @"Checkout step",
      @"data": @{@"index": @(index)}
    };
    LBWAssert([client addBreadcrumb:breadcrumb error:&error], @"breadcrumb failed");
  }
  NSError *underlying = [NSError errorWithDomain:@"GatewayError"
                                             code:503
                                         userInfo:@{NSLocalizedDescriptionKey: @"gateway-message-canary"}];
  NSError *aggregateMember = [NSError errorWithDomain:@"InventoryError"
                                                  code:409
                                              userInfo:@{
                                                NSLocalizedDescriptionKey: @"inventory-message-canary"
                                              }];
  NSMutableDictionary<NSString *, id> *capturedUserInfo = [@{
    NSLocalizedDescriptionKey: @"card-number-must-never-escape",
    NSUnderlyingErrorKey: underlying
  } mutableCopy];
  if (@available(macOS 11.3, iOS 14.5, tvOS 14.5, watchOS 7.4, *)) {
    capturedUserInfo[NSMultipleUnderlyingErrorsKey] = @[aggregateMember];
  }
  NSError *captured = [NSError errorWithDomain:@"CheckoutError" code:42 userInfo:capturedUserInfo];
  NSDictionary<NSString *, id> *attributes = [LBWIssueDiagnostics attributesForError:captured
                                                                                title:@"Payment authorization failed"
                                                                                level:@"error"
                                                                            mechanism:@"objc.error"
                                                                               handled:YES
                                                                                  file:@"/opt/app/Shop/Checkout.m?query=value"
                                                                                  line:42U
                                                                                column:17U
                                                                              function:@"submitPayment:"
                                                                              metadata:nil
                                                                               context:nil
                                                                                 error:&error];
  LBWAssert(attributes != nil, @"issue attributes failed");
  LBWAssert([client issueWithID:@"handled"
                      timestamp:@"2026-08-06T10:00:01Z"
                     attributes:attributes
                          error:&error], @"handled issue failed");
  NSString *json = [client previewJSONWithError:&error];
  NSDictionary<NSString *, id> *issue = LBWEventWithID(LBWPayload(client), @"handled")[@"attributes"];
  NSDictionary<NSString *, id> *exception = issue[@"exception"];
  NSDictionary<NSString *, id> *mechanism = exception[@"mechanism"];
  NSArray<NSDictionary<NSString *, id> *> *frames = issue[@"stackFrames"];
  NSDictionary<NSString *, id> *exceptionChain = issue[@"exceptionChain"];
  NSArray<NSDictionary<NSString *, id> *> *chainEntries = exceptionChain[@"entries"];
  NSArray<NSDictionary<NSString *, id> *> *breadcrumbs = issue[@"breadcrumbs"];
  LBWAssert([exception[@"type"] isEqualToString:@"CheckoutError"], @"exception type missing");
  LBWAssert([mechanism[@"type"] isEqualToString:@"objc.error"], @"mechanism missing");
  LBWAssert([mechanism[@"handled"] boolValue], @"handled state missing");
  LBWAssert([frames count] == 1U, @"frame missing");
  LBWAssert([frames[0][@"filename"] isEqualToString:@"Checkout.m"], @"filename was not sanitized");
  LBWAssert([frames[0][@"function"] isEqualToString:@"submitPayment:"], @"function missing");
  LBWAssert([chainEntries count] == 3U, @"NSError exception chain missing");
  LBWAssert([chainEntries[0][@"relationship"] isEqualToString:@"reported"], @"reported relationship missing");
  LBWAssert([chainEntries[0][@"messageState"] isEqualToString:@"redacted"], @"root message state missing");
  LBWAssert([chainEntries[0][@"stackFrames"] isEqualToArray:frames], @"reported stack did not match");
  LBWAssert([chainEntries[1][@"relationship"] isEqualToString:@"cause"], @"cause relationship missing");
  LBWAssert([chainEntries[1][@"type"] isEqualToString:@"GatewayError"], @"cause type missing");
  LBWAssert(
      [chainEntries[1][@"stackFramesState"] isEqualToString:@"not_captured"],
      @"cause stack state missing");
  LBWAssert(
      [chainEntries[2][@"relationship"] isEqualToString:@"aggregate_member"],
      @"aggregate relationship missing");
  LBWAssert(![exceptionChain[@"truncated"] boolValue], @"complete exception chain marked truncated");
  LBWAssert([breadcrumbs count] == 64U, @"breadcrumb bound failed");
  LBWAssert([breadcrumbs[0][@"category"] isEqualToString:@"step_2"], @"breadcrumb order failed");
  LBWAssert([[breadcrumbs lastObject][@"timestamp"] isEqualToString:@"2026-08-06T10:00:00Z"], @"breadcrumb timestamp was not normalized");
  LBWAssert([issue[@"breadcrumbsTruncated"] boolValue], @"breadcrumb truncation missing");
  LBWAssert([json rangeOfString:@"card-number-must-never-escape"].location == NSNotFound, @"NSError description leaked");
  LBWAssert([json rangeOfString:@"gateway-message-canary"].location == NSNotFound, @"cause description leaked");
  LBWAssert([json rangeOfString:@"inventory-message-canary"].location == NSNotFound, @"aggregate description leaked");
  LBWAssert([json rangeOfString:@"/opt/app"].location == NSNotFound, @"absolute source path leaked");

  [client clearBreadcrumbs];
  LBWAssert([client issueWithID:@"after-clear"
                      timestamp:@"2026-08-06T10:00:02Z"
                     attributes:@{@"title": @"Fresh issue", @"level": @"error"}
                          error:&error], @"issue after clear failed");
  NSDictionary<NSString *, id> *cleared = LBWEventWithID(LBWPayload(client), @"after-clear")[@"attributes"];
  LBWAssert(cleared[@"breadcrumbs"] == nil, @"breadcrumbs were not cleared");
}

static void LBWTestSpanTraceCanonicality(void) {
  NSError *error = nil;
  LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  config.includeAutomaticContext = NO;
  LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
  LBWTraceContext *activeTrace = [LBWTraceContext contextWithTraceID:@"11111111111111111111111111111111"
                                                              spanID:@"2222222222222222"
                                                        parentSpanID:nil
                                                          traceFlags:@"00"
                                                               error:&error];
  LBWTraceScope *scope = [LBWTrace activateContext:activeTrace];
  LBWAssert([client spanWithID:@"legacy-span"
                     timestamp:@"2026-08-06T10:00:00Z"
                    attributes:@{
                      @"name": @"legacy.operation",
                      @"traceId": @"trace_legacy",
                      @"spanId": @"span_legacy",
                      @"status": @"ok",
                      @"context": @{@"schemaVersion": @1, @"tags": @{@"source": @"legacy"}}
                    }
                         error:&error], @"legacy span failed");
  [scope close];
  NSDictionary<NSString *, id> *legacy = LBWEventWithID(LBWPayload(client), @"legacy-span")[@"attributes"];
  LBWAssert(legacy[@"context"][@"trace"] == nil, @"legacy IDs created a typed trace");
  LBWAssert([legacy[@"context"][@"tags"][@"source"] isEqualToString:@"legacy"], @"legacy context was lost");

  LBWAssert([client spanWithID:@"canonical-span"
                     timestamp:@"2026-08-06T10:00:01Z"
                    attributes:@{
                      @"name": @"checkout.submit",
                      @"traceId": @"4bf92f3577b34da6a3ce929d0e0e4736",
                      @"spanId": @"00f067aa0ba902b7",
                      @"status": @"ok",
                      @"context": @{
                        @"schemaVersion": @1,
                        @"trace": @{
                          @"traceId": @"33333333333333333333333333333333",
                          @"spanId": @"4444444444444444",
                          @"sampled": @NO
                        }
                      }
                    }
                         error:&error], @"canonical span failed");
  NSDictionary<NSString *, id> *canonical = LBWEventWithID(LBWPayload(client), @"canonical-span")[@"attributes"];
  NSDictionary<NSString *, id> *trace = canonical[@"context"][@"trace"];
  LBWAssert([trace[@"traceId"] isEqualToString:@"4bf92f3577b34da6a3ce929d0e0e4736"], @"span traceId was not canonical");
  LBWAssert([trace[@"spanId"] isEqualToString:@"00f067aa0ba902b7"], @"span spanId was not canonical");
  LBWAssert(trace[@"sampled"] == nil, @"contradictory sampled state survived");

  LBWTraceContext *sampledTrace = [LBWTraceContext contextWithTraceID:@"55555555555555555555555555555555"
                                                               spanID:@"6666666666666666"
                                                         parentSpanID:nil
                                                           traceFlags:@"01"
                                                                error:&error];
  scope = [LBWTrace activateContext:sampledTrace];
  LBWAssert([client logWithID:@"sampled-override"
                    timestamp:@"2026-08-06T10:00:02Z"
                   attributes:@{
                     @"message": @"explicit sampling override",
                     @"level": @"info",
                     @"context": @{
                       @"schemaVersion": @1,
                       @"trace": @{
                         @"traceId": sampledTrace.traceID,
                         @"spanId": sampledTrace.spanID,
                         @"sampled": @NO
                       }
                     }
                   }
                        error:&error], @"sampled override log failed");
  [scope close];
  NSDictionary<NSString *, id> *sampledOverride =
      LBWEventWithID(LBWPayload(client), @"sampled-override")[@"attributes"];
  LBWAssert(![sampledOverride[@"context"][@"trace"][@"sampled"] boolValue], @"typed sampled override was lost");
  LBWAssert(![sampledOverride[@"metadata"][@"traceSampled"] boolValue], @"metadata contradicted sampled override");
  LBWAssert(sampledOverride[@"metadata"][@"traceFlags"] == nil, @"stale active trace flags survived override");
}

static void LBWTestInvalidEvidenceFailsClosed(void) {
  NSError *error = nil;
  LBWConfig *badConfig = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  badConfig.includeAutomaticContext = NO;
  badConfig.context = @{@"schemaVersion": @2, @"tags": @{@"plan": @"team"}};
  LBWAssert([[LBWClient alloc] initWithConfig:badConfig error:&error] == nil, @"invalid client context was accepted");

  LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  config.includeAutomaticContext = NO;
  LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
  BOOL ok = [client logWithID:@"bad-context"
                    timestamp:@"2026-08-06T10:00:00Z"
                   attributes:@{
                     @"message": @"invalid",
                     @"level": @"info",
                     @"context": @{@"schemaVersion": @2, @"tags": @{@"plan": @"team"}}
                   }
                        error:&error];
  LBWAssert(!ok, @"invalid context was accepted");
  LBWAssert(client.pendingEvents == 0U, @"invalid context entered the queue");

  NSMutableArray<NSDictionary<NSString *, id> *> *events = [NSMutableArray array];
  for (NSUInteger index = 0U; index < 9U; index++) {
    [events addObject:@{@"name": [NSString stringWithFormat:@"event_%lu", (unsigned long)index]}];
  }
  error = nil;
  ok = [client spanWithID:@"too-many-events"
                timestamp:@"2026-08-06T10:00:01Z"
               attributes:@{
                 @"name": @"checkout",
                 @"traceId": @"4bf92f3577b34da6a3ce929d0e0e4736",
                 @"spanId": @"00f067aa0ba902b7",
                 @"status": @"ok",
                 @"events": events
               }
                    error:&error];
  LBWAssert(!ok, @"oversized span evidence was accepted");
  LBWAssert(client.pendingEvents == 0U, @"invalid span evidence entered the queue");

  error = nil;
  ok = [client addBreadcrumb:@{@"timestamp": @"not-a-time", @"category": @"unsafe category"} error:&error];
  LBWAssert(!ok, @"invalid breadcrumb was accepted");
  LBWAssert(client.pendingEvents == 0U, @"invalid breadcrumb changed the queue");

  error = nil;
  ok = [client spanWithID:@"zero-link"
                timestamp:@"2026-08-06T10:00:02Z"
               attributes:@{
                 @"name": @"checkout",
                 @"traceId": @"4bf92f3577b34da6a3ce929d0e0e4736",
                 @"spanId": @"00f067aa0ba902b7",
                 @"status": @"ok",
                 @"links": @[@{@"traceId": @"00000000000000000000000000000000", @"spanId": @"2222222222222222"}]
               }
                    error:&error];
  LBWAssert(!ok, @"zero span-link trace was accepted");
  LBWAssert(client.pendingEvents == 0U, @"invalid span link entered the queue");

  NSDictionary<NSString *, id> *manualFrame = @{
    @"filename": @"Checkout.m", @"line": @42, @"column": @17, @"inApp": @YES
  };
  error = nil;
  ok = [client issueWithID:@"mismatched-chain"
                 timestamp:@"2026-08-06T10:00:03Z"
                attributes:@{
                  @"title": @"Mismatch",
                  @"level": @"error",
                  @"exception": @{
                    @"type": @"CheckoutError",
                    @"mechanism": @{@"type": @"objc.error", @"handled": @YES}
                  },
                  @"stackFrames": @[manualFrame],
                  @"exceptionChain": @{
                    @"entries": @[
                      @{
                        @"id": @0,
                        @"relationship": @"reported",
                        @"type": @"DifferentError",
                        @"messageState": @"not_captured",
                        @"mechanism": @{@"type": @"objc.error", @"handled": @YES},
                        @"stackFrames": @[manualFrame],
                        @"stackFramesState": @"captured"
                      }
                    ],
                    @"truncated": @NO
                  }
                }
                     error:&error];
  LBWAssert(!ok, @"mismatched exception-chain root was accepted");
  LBWAssert(client.pendingEvents == 0U, @"invalid exception chain entered the queue");
}

int main(void) {
  @autoreleasepool {
    LBWTestSharedContext();
    LBWTestAutomaticContext();
    LBWTestIssueEvidence();
    LBWTestSpanTraceCanonicality();
    LBWTestInvalidEvidenceFailsClosed();
    printf("objc rich telemetry tests passed\n");
  }
  return 0;
}
