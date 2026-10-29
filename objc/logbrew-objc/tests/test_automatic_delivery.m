#import "LogBrew.h"

static void LBWAssert(BOOL condition, NSString *message) {
  if (!condition) {
    fprintf(stderr, "%s\n", [message UTF8String]);
    exit(1);
  }
}

static LBWClient *LBWNewClient(void) {
  NSError *error = nil;
  LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  config.sdkName = @"logbrew-objc-automatic-tests";
  LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
  LBWAssert(client != nil, @"client init failed");
  return client;
}

static BOOL LBWWaitForSentBodies(LBWRecordingTransport *transport, NSUInteger count, NSTimeInterval timeout) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while ([[NSDate date] compare:deadline] == NSOrderedAscending) {
    if ([transport.sentBodies count] >= count) {
      return YES;
    }
    [NSThread sleepForTimeInterval:0.005];
  }
  return [transport.sentBodies count] >= count;
}

static BOOL LBWWaitForDeliveryState(LBWClient *client, LBWDeliveryState state, NSTimeInterval timeout) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while ([[NSDate date] compare:deadline] == NSOrderedAscending) {
    if (client.deliveryHealth.state == state) {
      return YES;
    }
    [NSThread sleepForTimeInterval:0.005];
  }
  return client.deliveryHealth.state == state;
}

static NSUInteger LBWEventCount(NSString *body) {
  NSError *error = nil;
  NSData *data = [body dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary<NSString *, id> *payload = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  LBWAssert(payload != nil && error == nil, @"delivery body was not JSON");
  NSArray *events = payload[@"events"];
  LBWAssert([events isKindOfClass:[NSArray class]], @"delivery body events missing");
  return [events count];
}

@interface LBWBlockingTransport : NSObject <LBWTransport>

@property(nonatomic) dispatch_semaphore_t requestStarted;
@property(nonatomic) dispatch_semaphore_t releaseRequest;

@end

@implementation LBWBlockingTransport

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _requestStarted = dispatch_semaphore_create(0);
    _releaseRequest = dispatch_semaphore_create(0);
  }
  return self;
}

- (LBWTransportResponse *)sendWithAPIKey:(NSString *)apiKey body:(NSString *)body error:(NSError **)error {
  (void)apiKey;
  (void)body;
  (void)error;
  dispatch_semaphore_signal(self.requestStarted);
  dispatch_semaphore_wait(self.releaseRequest, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  return [[LBWTransportResponse alloc] initWithStatusCode:202 attempts:1U];
}

@end


@interface LBWReentrantStopTransport : NSObject <LBWTransport>

@property(nonatomic, weak) LBWClient *client;
@property(nonatomic) dispatch_semaphore_t stopReturned;

@end


@implementation LBWReentrantStopTransport

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _stopReturned = dispatch_semaphore_create(0);
  }
  return self;
}

- (LBWTransportResponse *)sendWithAPIKey:(NSString *)apiKey body:(NSString *)body error:(NSError **)error {
  (void)apiKey;
  (void)body;
  (void)error;
  [self.client stopAutomaticDelivery];
  dispatch_semaphore_signal(self.stopReturned);
  return [[LBWTransportResponse alloc] initWithStatusCode:202 attempts:1U];
}

@end


static void LBWExerciseAutomaticDelivery(void) {
  NSError *error = nil;
  LBWClient *manualClient = LBWNewClient();
  LBWAssert(manualClient.deliveryHealth.state == LBWDeliveryStateManual, @"manual health state failed");

  LBWAutomaticDeliveryOptions *missingTransportOptions = [[LBWAutomaticDeliveryOptions alloc] init];
  id<LBWTransport> missingTransport = nil;
  LBWAssert(![manualClient startAutomaticDeliveryWithTransport:missingTransport
                                               options:missingTransportOptions
                                                 error:&error] &&
                error.code == LBWErrorKindConfig &&
                [error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"configuration_error"],
            @"missing transport did not fail configuration");
  LBWAutomaticDeliveryOptions *unboundedOptions = [[LBWAutomaticDeliveryOptions alloc] init];
  unboundedOptions.interval = 86401.0;
  LBWAssert(![manualClient startAutomaticDeliveryWithTransport:[[LBWRecordingTransport alloc] init]
                                                        options:unboundedOptions
                                                          error:&error],
            @"automatic delivery accepted unbounded interval");
  LBWAssert(manualClient.deliveryHealth.state == LBWDeliveryStateManual,
            @"invalid automatic options changed lifecycle state");

  LBWRecordingTransport *transport = [[LBWRecordingTransport alloc] initWithSteps:@[
    [LBWRecordingStep statusCodeStep:503],
    [LBWRecordingStep statusCodeStep:202],
    [LBWRecordingStep statusCodeStep:202]
  ]];
  LBWAutomaticDeliveryOptions *options = [[LBWAutomaticDeliveryOptions alloc] init];
  options.interval = 30.0;
  options.threshold = 1U;
  options.retryBaseDelay = 0.02;
  options.maxRetryDelay = 0.02;
  LBWClient *client = LBWNewClient();
  LBWAssert([client startAutomaticDeliveryWithTransport:transport options:options error:&error],
            @"automatic delivery start failed");
  options.threshold = 100U;
  LBWAssert([client logWithID:@"objc-auto-prefix"
                    timestamp:@"2026-07-18T12:00:00Z"
                   attributes:@{ @"message": @"automatic", @"level": @"info" }
                        error:&error],
            @"automatic prefix capture failed");
  LBWAssert(LBWWaitForSentBodies(transport, 2U, 2.0), @"automatic retry did not run");
  LBWAssert([transport.sentBodies[0] isEqualToString:transport.sentBodies[1]], @"automatic retry body changed");
  LBWAssert(client.deliveryHealth.lastOutcome == LBWDeliveryOutcomeAccepted, @"automatic health outcome failed");
  LBWAssert(client.deliveryHealth.acceptedEvents == 1U, @"automatic accepted count failed");
  LBWAssert(client.deliveryHealth.queuedEvents == 0U, @"automatic accepted prefix remained queued");

  LBWAssert([client logWithID:@"objc-auto-later"
                    timestamp:@"2026-07-18T12:00:01Z"
                   attributes:@{ @"message": @"later", @"level": @"info" }
                        error:&error],
            @"automatic later capture failed");
  LBWAssert(LBWWaitForSentBodies(transport, 3U, 2.0), @"automatic later delivery did not run");
  LBWAssert([transport.sentBodies[2] rangeOfString:@"objc-auto-later"].location != NSNotFound,
            @"automatic later event missing");
  LBWAssert(client.deliveryHealth.acceptedEvents == 2U, @"automatic later accepted count failed");
  NSData *healthJSON = [NSJSONSerialization dataWithJSONObject:[client.deliveryHealth dictionaryValue]
                                                       options:0
                                                         error:&error];
  NSString *healthText = [[NSString alloc] initWithData:healthJSON encoding:NSUTF8StringEncoding];
  LBWAssert([healthText rangeOfString:@"objc-auto-prefix"].location == NSNotFound, @"health leaked event id");
  LBWAssert([healthText rangeOfString:@"LOGBREW_API_KEY"].location == NSNotFound, @"health leaked API key");
  LBWAssert([client shutdownOwnedTransportWithError:&error] != nil, @"automatic shutdown failed");
  LBWAssert(client.deliveryHealth.state == LBWDeliveryStateClosed, @"automatic shutdown state failed");

  LBWBlockingTransport *blockingTransport = [[LBWBlockingTransport alloc] init];
  LBWClient *stoppedClient = LBWNewClient();
  LBWAutomaticDeliveryOptions *stoppedOptions = [[LBWAutomaticDeliveryOptions alloc] init];
  stoppedOptions.interval = 30.0;
  stoppedOptions.threshold = 1U;
  LBWAssert([stoppedClient startAutomaticDeliveryWithTransport:blockingTransport
                                                        options:stoppedOptions
                                                          error:&error],
            @"stale automatic start failed");
  LBWAssert([stoppedClient logWithID:@"objc-stop-in-flight"
                           timestamp:@"2026-07-18T12:00:02Z"
                          attributes:@{ @"message": @"stale", @"level": @"info" }
                               error:&error],
            @"stale automatic capture failed");
  LBWAssert(dispatch_semaphore_wait(blockingTransport.requestStarted,
                                    dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) == 0,
            @"stale automatic request did not start");
  dispatch_semaphore_t stopFinished = dispatch_semaphore_create(0);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
    [stoppedClient stopAutomaticDelivery];
    dispatch_semaphore_signal(stopFinished);
  });
  LBWAssert(LBWWaitForDeliveryState(stoppedClient, LBWDeliveryStateManual, 2.0), @"stop did not enter manual state");
  LBWAssert(dispatch_semaphore_wait(stopFinished, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC)) != 0,
            @"stop returned before in-flight delivery finished");
  dispatch_semaphore_signal(blockingTransport.releaseRequest);
  LBWAssert(dispatch_semaphore_wait(stopFinished, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) == 0,
            @"stop did not finish after in-flight delivery");
  LBWAssert(stoppedClient.deliveryHealth.state == LBWDeliveryStateManual, @"stale response changed stopped state");
  LBWAssert(stoppedClient.deliveryHealth.acceptedEvents == 0U, @"stale response was acknowledged");
  LBWAssert(stoppedClient.pendingEvents == 1U, @"stale response removed queued prefix");
  LBWRecordingTransport *manualTransport = [[LBWRecordingTransport alloc] init];
  LBWAssert([stoppedClient flushWithTransport:manualTransport error:&error] != nil, @"stopped prefix flush failed");

  LBWReentrantStopTransport *reentrantTransport = [[LBWReentrantStopTransport alloc] init];
  LBWClient *reentrantClient = LBWNewClient();
  reentrantTransport.client = reentrantClient;
  LBWAssert([reentrantClient startAutomaticDeliveryWithTransport:reentrantTransport
                                                          options:stoppedOptions
                                                            error:&error],
            @"reentrant automatic start failed");
  LBWAssert([reentrantClient logWithID:@"objc-reentrant-stop"
                             timestamp:@"2026-07-18T12:00:03Z"
                            attributes:@{ @"message": @"reentrant", @"level": @"info" }
                                 error:&error],
            @"reentrant automatic capture failed");
  LBWAssert(dispatch_semaphore_wait(reentrantTransport.stopReturned,
                                    dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) == 0,
            @"reentrant stop deadlocked");
  LBWAssert(LBWWaitForDeliveryState(reentrantClient, LBWDeliveryStateManual, 2.0),
            @"reentrant stop did not preserve manual state");
  LBWAssert(reentrantClient.pendingEvents == 1U, @"reentrant stop acknowledged stale response");

  LBWRecordingTransport *terminalTransport = [[LBWRecordingTransport alloc] initWithSteps:@[
    [LBWRecordingStep statusCodeStep:401]
  ]];
  LBWClient *terminalClient = LBWNewClient();
  LBWAutomaticDeliveryOptions *terminalOptions = [[LBWAutomaticDeliveryOptions alloc] init];
  terminalOptions.interval = 30.0;
  terminalOptions.threshold = 100U;
  LBWAssert([terminalClient startAutomaticDeliveryWithTransport:terminalTransport
                                                         options:terminalOptions
                                                           error:&error],
            @"terminal owned flush start failed");
  LBWAssert([terminalClient logWithID:@"objc-owned-flush-terminal"
                            timestamp:@"2026-07-18T12:00:04Z"
                           attributes:@{ @"message": @"terminal", @"level": @"info" }
                                error:&error],
            @"terminal owned flush capture failed");
  LBWAssert([terminalClient flushOwnedTransportWithError:&error] == nil,
            @"terminal owned flush unexpectedly succeeded");
  LBWAssert(terminalClient.deliveryHealth.state == LBWDeliveryStatePaused,
            @"terminal owned flush did not pause automatic delivery");
  LBWAssert(terminalClient.deliveryHealth.pauseReason == LBWDeliveryPauseReasonAuthentication,
            @"terminal owned flush pause reason failed");
  LBWAssert(terminalClient.deliveryHealth.deliveryAttempts == 1U,
            [NSString stringWithFormat:@"terminal owned flush attempt count failed: %lu",
                                       (unsigned long)terminalClient.deliveryHealth.deliveryAttempts]);
  LBWAssert(terminalClient.pendingEvents == 1U, @"terminal owned flush removed failed prefix");
  [terminalClient stopAutomaticDelivery];
  LBWAssert([terminalClient flushWithTransport:[[LBWRecordingTransport alloc] init] error:&error] != nil,
            @"terminal retained-prefix flush failed");

  LBWRecordingTransport *intervalTransport = [[LBWRecordingTransport alloc] init];
  LBWClient *intervalClient = LBWNewClient();
  LBWAutomaticDeliveryOptions *intervalOptions = [[LBWAutomaticDeliveryOptions alloc] init];
  intervalOptions.interval = 0.03;
  intervalOptions.threshold = 100U;
  LBWAssert([intervalClient startAutomaticDeliveryWithTransport:intervalTransport
                                                         options:intervalOptions
                                                           error:&error],
            @"interval automatic start failed");
  LBWAssert([intervalClient logWithID:@"objc-interval"
                            timestamp:@"2026-07-18T12:00:05Z"
                           attributes:@{ @"message": @"interval", @"level": @"info" }
                                error:&error],
            @"interval automatic capture failed");
  LBWAssert(LBWWaitForSentBodies(intervalTransport, 1U, 2.0), @"interval automatic delivery did not run");
  LBWAssert([intervalClient shutdownOwnedTransportWithError:&error] != nil, @"interval shutdown failed");

  LBWRecordingTransport *pausedTransport = [[LBWRecordingTransport alloc] initWithSteps:@[
    [LBWRecordingStep statusCodeStep:401],
    [LBWRecordingStep statusCodeStep:202]
  ]];
  LBWClient *pausedClient = LBWNewClient();
  LBWAutomaticDeliveryOptions *pausedOptions = [[LBWAutomaticDeliveryOptions alloc] init];
  pausedOptions.interval = 30.0;
  pausedOptions.threshold = 1U;
  LBWAssert([pausedClient startAutomaticDeliveryWithTransport:pausedTransport options:pausedOptions error:&error],
            @"paused automatic start failed");
  LBWAssert([pausedClient logWithID:@"objc-paused"
                          timestamp:@"2026-07-18T12:00:06Z"
                         attributes:@{ @"message": @"paused", @"level": @"info" }
                              error:&error],
            @"paused automatic capture failed");
  LBWAssert(LBWWaitForDeliveryState(pausedClient, LBWDeliveryStatePaused, 2.0),
            @"terminal automatic delivery did not pause");
  LBWAssert(pausedClient.deliveryHealth.pauseReason == LBWDeliveryPauseReasonAuthentication,
            @"terminal automatic pause reason failed");
  LBWAssert(pausedClient.pendingEvents == 1U, @"terminal automatic response removed prefix");
  LBWAssert([pausedClient recoverAutomaticDeliveryWithError:&error], @"automatic recovery failed");
  LBWAssert(LBWWaitForSentBodies(pausedTransport, 2U, 2.0), @"recovered automatic delivery did not run");
  LBWAssert(pausedClient.pendingEvents == 0U, @"recovered automatic prefix remained queued");
  LBWAssert([pausedClient shutdownOwnedTransportWithError:&error] != nil, @"recovered shutdown failed");

  LBWClient *boundedClient = LBWNewClient();
  for (NSUInteger index = 0U; index < 1000U; index += 1U) {
    NSString *eventID = [NSString stringWithFormat:@"objc-bound-%lu", (unsigned long)index];
    LBWAssert([boundedClient logWithID:eventID
                             timestamp:@"2026-07-18T12:00:07Z"
                            attributes:@{ @"message": @"bounded", @"level": @"info" }
                                 error:&error],
              @"bounded queue capture failed");
  }
  LBWAssert(![boundedClient logWithID:@"objc-bound-overflow"
                            timestamp:@"2026-07-18T12:00:07Z"
                           attributes:@{ @"message": @"bounded", @"level": @"info" }
                                error:&error],
            @"bounded queue accepted overflow");
  LBWAssert(boundedClient.deliveryHealth.queuedEvents == 1000U, @"bounded queue count failed");
  LBWAssert(boundedClient.deliveryHealth.droppedEvents == 1U, @"bounded queue drop count failed");
  LBWRecordingTransport *boundedTransport = [[LBWRecordingTransport alloc] init];
  LBWTransportResponse *boundedResponse = [boundedClient flushWithTransport:boundedTransport error:&error];
  LBWAssert(boundedResponse != nil && boundedResponse.attempts == 10U, @"bounded queue batch count failed");
  LBWAssert([boundedTransport.sentBodies count] == 10U, @"bounded queue request count failed");
  for (NSString *body in boundedTransport.sentBodies) {
    LBWAssert([body lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 256U * 1024U,
              @"bounded request byte limit failed");
    LBWAssert(LBWEventCount(body) <= 100U, @"bounded request event limit failed");
  }
}

@interface LBWRateLimitTransport : NSObject <LBWTransport>

@property(nonatomic, copy) NSArray<LBWTransportResponse *> *responses;
@property(nonatomic) NSMutableArray<NSString *> *bodies;

@end

@implementation LBWRateLimitTransport

- (LBWTransportResponse *)sendWithAPIKey:(NSString *)apiKey body:(NSString *)body error:(NSError **)error {
  (void)apiKey;
  (void)error;
  @synchronized(self) {
    if (self.bodies == nil) {
      self.bodies = [NSMutableArray array];
    }
    [self.bodies addObject:body];
    NSUInteger index = [self.bodies count] - 1U;
    return index < [self.responses count] ? self.responses[index]
                                          : [[LBWTransportResponse alloc] initWithStatusCode:202 attempts:1U];
  }
}

- (NSUInteger)requestCount {
  @synchronized(self) {
    return [self.bodies count];
  }
}

@end

static LBWTransportResponse *LBWRateLimited(NSNumber *_Nullable retryAfter, NSString *_Nullable code) {
  LBWTransportResponse *response = [[LBWTransportResponse alloc] initWithStatusCode:429 attempts:1U];
  response.retryAfter = retryAfter;
  response.errorCode = code;
  return response;
}

static LBWClient *LBWStartRateLimitClient(LBWRateLimitTransport *transport, NSString *eventID) {
  NSError *error = nil;
  LBWClient *client = LBWNewClient();
  LBWAutomaticDeliveryOptions *options = [[LBWAutomaticDeliveryOptions alloc] init];
  options.interval = 0.05;
  options.threshold = 1U;
  options.retryBaseDelay = 0.01;
  options.maxRetryDelay = 0.02;
  LBWAssert([client startAutomaticDeliveryWithTransport:transport options:options error:&error],
            @"rate-limit automatic start failed");
  LBWAssert([client logWithID:eventID
                    timestamp:@"2026-07-18T12:00:08Z"
                   attributes:@{ @"message": @"rate limited", @"level": @"info" }
                        error:&error],
            @"rate-limit capture failed");
  return client;
}

static BOOL LBWWaitForRequests(LBWRateLimitTransport *transport, NSUInteger count, NSTimeInterval timeout) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while ([transport requestCount] < count && [[NSDate date] compare:deadline] == NSOrderedAscending) {
    [NSThread sleepForTimeInterval:0.005];
  }
  return [transport requestCount] >= count;
}

static void LBWExerciseRateLimitedDelivery(void) {
  NSError *error = nil;

  // Retry-After seconds: timed wait, then automatic resend of the same batch.
  LBWRateLimitTransport *seconds = [[LBWRateLimitTransport alloc] init];
  seconds.responses = @[ LBWRateLimited(@1, nil) ];
  LBWClient *secondsClient = LBWStartRateLimitClient(seconds, @"objc-rate-seconds");
  LBWAssert(LBWWaitForDeliveryState(secondsClient, LBWDeliveryStateRetrying, 2.0), @"Retry-After did not wait");
  LBWDeliveryHealth *health = secondsClient.deliveryHealth;
  LBWAssert(health.pauseReason == LBWDeliveryPauseReasonNone, @"Retry-After paused delivery");
  LBWAssert(health.nextRetryDelay >= 0.5 && health.nextRetryDelay <= 1.1, @"Retry-After delay failed");
  LBWAssert(!LBWWaitForRequests(seconds, 2U, 0.5), @"Retry-After resent too early");
  LBWAssert(LBWWaitForRequests(seconds, 2U, 2.0), @"Retry-After did not resume");
  LBWAssert([seconds.bodies[0] isEqualToString:seconds.bodies[1]], @"Retry-After resent a different batch");
  LBWAssert(LBWWaitForDeliveryState(secondsClient, LBWDeliveryStateRunning, 2.0) && secondsClient.pendingEvents == 0U,
            @"Retry-After resume did not deliver");
  LBWAssert([secondsClient shutdownOwnedTransportWithError:&error] != nil, @"Retry-After shutdown failed");

  // code rate_limited without Retry-After: bounded backoff raised to 1 second; manual flush error kept.
  LBWRateLimitTransport *code = [[LBWRateLimitTransport alloc] init];
  code.responses = @[ LBWRateLimited(nil, @"rate_limited"), LBWRateLimited(nil, @"rate_limited") ];
  LBWClient *codeClient = LBWStartRateLimitClient(code, @"objc-rate-code");
  LBWAssert(LBWWaitForDeliveryState(codeClient, LBWDeliveryStateRetrying, 2.0), @"rate_limited did not wait");
  health = codeClient.deliveryHealth;
  LBWAssert(health.nextRetryDelay >= 0.5 && health.nextRetryDelay <= 1.1, @"rate_limited minimum wait failed");
  LBWAssert([codeClient flushOwnedTransportWithError:&error] == nil &&
                [error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"quota_exceeded"] &&
                [error.userInfo[LBWErrorRetryableKey] boolValue],
            @"rate_limited manual error failed");
  LBWAssert(codeClient.deliveryHealth.state == LBWDeliveryStateRetrying, @"rate_limited manual flush paused");
  LBWAssert([codeClient shutdownOwnedTransportWithError:&error] != nil, @"rate_limited shutdown failed");

  // usage_limit_exceeded pauses even with Retry-After.
  LBWRateLimitTransport *usage = [[LBWRateLimitTransport alloc] init];
  usage.responses = @[ LBWRateLimited(@1, @"usage_limit_exceeded") ];
  LBWClient *usageClient = LBWStartRateLimitClient(usage, @"objc-rate-usage");
  LBWAssert(LBWWaitForDeliveryState(usageClient, LBWDeliveryStatePaused, 2.0), @"usage_limit_exceeded did not pause");
  LBWAssert(usageClient.deliveryHealth.pauseReason == LBWDeliveryPauseReasonQuota, @"usage limit pause reason failed");
  LBWAssert(usageClient.deliveryHealth.nextRetryDelay == 0, @"usage limit scheduled a retry");
  LBWAssert(!LBWWaitForRequests(usage, 2U, 1.2), @"usage limit resumed without recovery");
  [usageClient stopAutomaticDelivery];

  // Bounds: waits above 1 hour are capped at 1 hour.
  LBWRateLimitTransport *capped = [[LBWRateLimitTransport alloc] init];
  capped.responses = @[ LBWRateLimited(@7200, nil) ];
  LBWClient *cappedClient = LBWStartRateLimitClient(capped, @"objc-rate-cap");
  LBWAssert(LBWWaitForDeliveryState(cappedClient, LBWDeliveryStateRetrying, 2.0), @"capped Retry-After did not wait");
  health = cappedClient.deliveryHealth;
  LBWAssert(health.nextRetryDelay > 3599.0 && health.nextRetryDelay <= 3600.0, @"Retry-After 1 hour cap failed");
  [cappedClient stopAutomaticDelivery];
}

int main(void) {
  @autoreleasepool {
    LBWExerciseAutomaticDelivery();
    LBWExerciseRateLimitedDelivery();
  }
  return 0;
}
