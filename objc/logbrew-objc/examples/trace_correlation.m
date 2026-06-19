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

int main(void) {
  @autoreleasepool {
    NSError *error = nil;
    LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
    config.sdkName = @"objc-trace-correlation";
    LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
    if (client == nil) {
      LBWDie([NSString stringWithFormat:@"client init failed: %@", error]);
    }

    LBWOpenTelemetrySpanContext *openTelemetryParent =
        [LBWTrace openTelemetrySpanContextWithTraceID:@"4bf92f3577b34da6a3ce929d0e0e4736"
                                               spanID:@"00f067aa0ba902b7"
                                           traceFlags:@"01"
                                                error:&error];
    LBWMust(openTelemetryParent != nil, error);
    LBWTraceContext *trace = [LBWTrace contextFromOpenTelemetrySpanContext:openTelemetryParent];
    LBWTraceScope *scope = [LBWTrace activateContext:trace];

    LBWMust([client issueWithID:@"evt_trace_issue_001"
                      timestamp:@"2026-06-02T10:00:02Z"
                     attributes:@{
                       @"title": @"Checkout timeout",
                       @"level": @"error",
                       @"message": @"Request timed out after retry budget",
                       @"metadata": @{@"component": @"checkout", @"traceId": @"caller_supplied_trace"}
                     }
                          error:&error], error);
    LBWMust([client logWithID:@"evt_trace_log_001"
                    timestamp:@"2026-06-02T10:00:03Z"
                   attributes:@{
                     @"message": @"checkout retry scheduled",
                     @"level": @"warning",
                     @"logger": @"checkout",
                     @"metadata": @{@"retryable": @YES}
                   }
                        error:&error], error);
    LBWMust([client captureProductActionWithID:@"evt_trace_action_001"
                                     timestamp:@"2026-06-02T10:00:04Z"
                                          name:@"checkout.pay_tapped"
                                        status:nil
                                       context:@{@"sessionId": @"session_123", @"screen": @"Checkout"}
                                      metadata:@{@"component": @"pay-button"}
                                         error:&error], error);
    LBWMust([client captureNetworkMilestoneWithID:@"evt_trace_network_001"
                                        timestamp:@"2026-06-02T10:00:05Z"
                                           method:@"POST"
                                    routeTemplate:@"https://mobile.example.test/api/checkout?card=redacted#pay"
                                       statusCode:@503
                                       durationMs:@184.5
                                           status:nil
                                          context:@{@"sessionId": @"session_123", @"screen": @"Checkout"}
                                         metadata:@{@"retryable": @YES}
                                            error:&error], error);
    LBWMust([client metricWithID:@"evt_trace_metric_001"
                       timestamp:@"2026-06-02T10:00:06Z"
                      attributes:@{
                        @"name": @"http.server.duration",
                        @"kind": @"histogram",
                        @"value": @184.5,
                        @"unit": @"ms",
                        @"temporality": @"delta",
                        @"metadata": @{@"routeTemplate": @"/api/checkout", @"method": @"POST"}
                      }
                           error:&error], error);

    NSDictionary<NSString *, id> *spanAttributes =
        [trace spanAttributesWithName:@"POST /api/checkout"
                                status:@"error"
                            durationMs:@184.5
                              metadata:@{@"routeTemplate": @"/api/checkout"}
                                 error:&error];
    LBWMust(spanAttributes != nil, error);
    LBWMust([client spanWithID:@"evt_trace_span_001"
                     timestamp:@"2026-06-02T10:00:07Z"
                    attributes:spanAttributes
                         error:&error], error);
    NSMutableURLRequest *request =
        [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"https://api.example.com/api/checkout?cart=123#pay"]];
    request.HTTPMethod = @"post";
    [request setValue:@"app-owned-header-value" forHTTPHeaderField:@"x-app-context"];
    LBWURLSessionSpan *urlSessionSpan = [LBWTrace startURLSessionSpanForRequest:request error:&error];
    LBWMust(urlSessionSpan != nil, error);
    LBWURLSessionTimings *urlSessionTimings =
        [LBWURLSessionTimings timingsWithFetchMs:@188.5
                                      redirectMs:@3.25
                                    nameLookupMs:@2.5
                                       connectMs:@10
                                           tlsMs:@6.5
                                          sendMs:@4
                                          waitMs:@120.25
                                       receiveMs:@25
                                requestBodyBytes:@512
                               responseBodyBytes:@4096
                                           error:&error];
    LBWMust(urlSessionTimings != nil, error);
    LBWMust([client captureURLSessionSpanWithID:@"evt_trace_urlsession_001"
                                      timestamp:@"2026-06-02T10:00:08Z"
                                           span:urlSessionSpan
                                     statusCode:@503
                                     durationMs:@184.5
                                      errorType:nil
                                       metadata:@{@"component": @"pay-api", @"requestWaitMs": @999}
                                        timings:urlSessionTimings
                                          error:&error], error);
    LBWMust([client captureLifecycleSpanWithID:@"evt_trace_lifecycle_001"
                                     timestamp:@"2026-06-02T10:00:09Z"
                                 previousState:@"active"
                                  currentState:@"background"
                                    durationMs:@1532.25
                                       context:@{@"screen": @"Checkout", @"traceId": @"spoofed_trace"}
                                      metadata:@{@"component": @"app-delegate"}
                                         error:&error], error);

    NSDictionary<NSString *, NSString *> *headers = [LBWTrace outgoingHeaders];
    fprintf(stderr, "{\"traceparent\":\"%s\"}\n", [headers[@"traceparent"] UTF8String]);
    [scope close];

    NSString *preview = [client previewJSONWithError:&error];
    LBWMust(preview != nil, error);
    printf("%s\n", [preview UTF8String]);
  }
  return 0;
}
