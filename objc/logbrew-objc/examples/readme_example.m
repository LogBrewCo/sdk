#import "LogBrew.h"

static void LBWMust(BOOL condition, NSError *error) {
  if (!condition) {
    fprintf(stderr, "%s\n", [[error localizedDescription] UTF8String]);
    exit(1);
  }
}

int main(void) {
  @autoreleasepool {
    NSError *error = nil;
    LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
    LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
    LBWMust(client != nil, error);

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

    NSString *preview = [client previewJSONWithError:&error];
    LBWMust(preview != nil, error);
    printf("%s\n", [preview UTF8String]);

    LBWRecordingTransport *transport = [[LBWRecordingTransport alloc] init];
    LBWTransportResponse *response = [client flushWithTransport:transport error:&error];
    LBWMust(response != nil, error);
    fprintf(stderr, "{\"ok\":true,\"status\":%ld,\"attempts\":%lu,\"events\":%lu}\n",
            (long)response.statusCode,
            (unsigned long)response.attempts,
            (unsigned long)[transport.sentBodies count]);
  }
  return 0;
}
