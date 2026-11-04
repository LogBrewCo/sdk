#import "LogBrew.h"

static NSString *const Traceparent = @"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

static void Check(BOOL ok, NSError *error, NSString *step) {
  if (!ok) {
    fprintf(stderr, "%s failed: %s\n", step.UTF8String, error.description.UTF8String);
    exit(1);
  }
}

static NSString *Now(void) {
  return [[[NSISO8601DateFormatter alloc] init] stringFromDate:[NSDate date]];
}

static void Fetch(LBWClient *client, NSURL *url, NSString *eventID) {
  NSError *error = nil;
  NSURLRequest *request = [NSURLRequest requestWithURL:url];
  LBWURLSessionSpan *span = [LBWTrace startURLSessionSpanForRequest:request error:&error];
  Check(span != nil, error, @"URLSession span");
  __block NSHTTPURLResponse *response = nil;
  __block NSError *requestError = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  NSDate *started = [NSDate date];
  [[NSURLSession.sharedSession dataTaskWithRequest:span.request
                                 completionHandler:^(NSData *data, NSURLResponse *urlResponse, NSError *taskError) {
                                   (void)data;
                                   response = (NSHTTPURLResponse *)urlResponse;
                                   requestError = taskError;
                                   dispatch_semaphore_signal(done);
                                 }] resume];
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  NSNumber *durationMs = @(-started.timeIntervalSinceNow * 1000.0);
  Check([client captureURLSessionSpanWithID:eventID
                                  timestamp:Now()
                                       span:span
                                 statusCode:response ? @(response.statusCode) : nil
                                 durationMs:durationMs
                                  errorType:requestError ? requestError.domain : nil
                                   metadata:nil
                                      error:&error],
        error, @"URLSession span capture");
  if (requestError == nil) {
    return;
  }
  LBWTraceScope *scope = [LBWTrace activateContext:span.traceContext];
  NSDictionary *issue = [LBWIssueDiagnostics attributesForError:requestError
                                                          title:@"Payment request failed"
                                                          level:@"error"
                                                      mechanism:@"objc.error"
                                                         handled:YES
                                                            file:[NSString stringWithUTF8String:__FILE__]
                                                            line:__LINE__
                                                          column:1U
                                                        function:[NSString stringWithUTF8String:__func__]
                                                        metadata:nil
                                                         context:nil
                                                           error:&error];
  Check(issue != nil, error, @"issue attributes");
  Check([client issueWithID:@"evt_issue_payment" timestamp:Now() attributes:issue error:&error], error, @"issue");
  Check([client logWithID:@"evt_log_payment"
                timestamp:Now()
               attributes:@{@"message": @"payment request failed", @"level": @"error", @"logger": @"checkout"}
                    error:&error],
        error, @"error log");
  [scope close];
}

int main(void) {
  @autoreleasepool {
    NSDictionary<NSString *, NSString *> *environment = NSProcessInfo.processInfo.environment;
    NSString *endpoint = environment[@"LOGBREW_CAPTURE_ENDPOINT"];
    NSString *backend = environment[@"CAPTURE_BACKEND"];
    if (endpoint == nil || backend == nil) {
      fprintf(stderr, "LOGBREW_CAPTURE_ENDPOINT and CAPTURE_BACKEND are required\n");
      return 1;
    }
    NSError *error = nil;
    LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
    config.sdkName = @"checkout-macos";
    config.sdkVersion = @"1.2.3";
    config.context = @{
      @"schemaVersion": @1,
      @"resource": @{
        @"service": @{@"name": @"checkout-macos", @"version": @"1.2.3"},
        @"deployment": @{@"environment": @"production", @"release": @"checkout@1.2.3"}
      }
    };
    LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
    Check(client != nil, error, @"client");
    LBWHTTPTransport *transport = [[LBWHTTPTransport alloc] initWithEndpoint:endpoint headers:nil timeout:10.0 error:&error];
    Check(transport != nil, error, @"transport");

    LBWTelemetryScope *telemetry = [LBWTelemetry activateContext:@{
      @"schemaVersion": @1,
      @"session": @{@"id": @"session_123"},
      @"subject": @{@"id": @"user_123", @"kind": @"user"}
    } error:&error];
    Check(telemetry != nil, error, @"telemetry scope");
    LBWTraceScope *trace = [LBWTrace activateContext:[LBWTraceContext continueOrCreateContextFromTraceparent:Traceparent]];

    Check([client addBreadcrumb:@{@"timestamp": Now(), @"category": @"checkout.submit", @"type": @"navigation", @"message": @"Checkout submitted"}
                          error:&error],
          error, @"breadcrumb");
    Check([client logWithID:@"evt_log_checkout"
                  timestamp:Now()
                 attributes:@{@"message": @"checkout started", @"level": @"info", @"logger": @"checkout"}
                      error:&error],
          error, @"log");
    Fetch(client, [NSURL URLWithString:[backend stringByAppendingString:@"/checkout"]], @"evt_span_checkout");
    Check([client metricWithID:@"evt_metric_checkout"
                     timestamp:Now()
                    attributes:@{@"name": @"checkout.duration", @"kind": @"histogram", @"value": @12.5, @"unit": @"ms", @"temporality": @"delta"}
                         error:&error],
          error, @"metric");
    Fetch(client, [NSURL URLWithString:@"http://127.0.0.1:9/payments"], @"evt_span_payment");

    [trace close];
    [telemetry close];
    Check([client shutdownWithTransport:transport error:&error] != nil, error, @"shutdown");
  }
  return 0;
}
