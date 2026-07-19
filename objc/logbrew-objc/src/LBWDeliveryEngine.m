#import "LBWDeliveryEnginePrivate.h"

#import <math.h>

static const NSUInteger LBWMaxQueuedEvents = 1000U;
static const NSUInteger LBWMaxQueuedBytes = 4U * 1024U * 1024U;
static const NSUInteger LBWMaxRequestEvents = 100U;
static const NSUInteger LBWMaxRequestBytes = 256U * 1024U;
static const NSTimeInterval LBWMaxScheduleDelay = 24.0 * 60.0 * 60.0;
static void *LBWDeliverySchedulerKey = &LBWDeliverySchedulerKey;

@interface LBWDeliveryHealth ()

@property(nonatomic) LBWDeliveryState state;
@property(nonatomic) NSUInteger queuedEvents;
@property(nonatomic) NSUInteger queuedBytes;
@property(nonatomic) BOOL inFlight;
@property(nonatomic) NSUInteger acceptedEvents;
@property(nonatomic) NSUInteger droppedEvents;
@property(nonatomic) NSUInteger deliveryAttempts;
@property(nonatomic) NSUInteger consecutiveFailures;
@property(nonatomic) LBWDeliveryOutcome lastOutcome;
@property(nonatomic) LBWDeliveryPauseReason pauseReason;

- (instancetype)initPrivate;

@end

@implementation LBWAutomaticDeliveryOptions

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _interval = 5.0;
    _threshold = 100U;
    _retryBaseDelay = 0.25;
    _maxRetryDelay = 30.0;
  }
  return self;
}

@end

static NSString *LBWDeliveryStateValue(LBWDeliveryState state) {
  switch (state) {
    case LBWDeliveryStateManual: return @"manual";
    case LBWDeliveryStateRunning: return @"running";
    case LBWDeliveryStateRetrying: return @"retrying";
    case LBWDeliveryStatePaused: return @"paused";
    case LBWDeliveryStateShuttingDown: return @"shutting_down";
    case LBWDeliveryStateClosed: return @"closed";
  }
}

static NSString *LBWDeliveryOutcomeValue(LBWDeliveryOutcome outcome) {
  switch (outcome) {
    case LBWDeliveryOutcomeNone: return @"none";
    case LBWDeliveryOutcomeAccepted: return @"accepted";
    case LBWDeliveryOutcomeRetryableFailure: return @"retryable_failure";
    case LBWDeliveryOutcomeTerminalFailure: return @"terminal_failure";
    case LBWDeliveryOutcomeDropped: return @"dropped";
  }
}

static NSString *LBWDeliveryPauseReasonValue(LBWDeliveryPauseReason reason) {
  switch (reason) {
    case LBWDeliveryPauseReasonNone: return @"none";
    case LBWDeliveryPauseReasonAuthentication: return @"authentication";
    case LBWDeliveryPauseReasonQuota: return @"quota";
    case LBWDeliveryPauseReasonValidation: return @"validation";
    case LBWDeliveryPauseReasonNonRetryable: return @"non_retryable";
    case LBWDeliveryPauseReasonRetryExhausted: return @"retry_exhausted";
    case LBWDeliveryPauseReasonStorage: return @"storage";
  }
}

@implementation LBWDeliveryHealth

- (instancetype)initPrivate {
  return [super init];
}

- (NSDictionary<NSString *, id> *)dictionaryValue {
  return @{
    @"state": LBWDeliveryStateValue(self.state),
    @"queuedEvents": @(self.queuedEvents),
    @"queuedBytes": @(self.queuedBytes),
    @"inFlight": @(self.inFlight),
    @"acceptedEvents": @(self.acceptedEvents),
    @"droppedEvents": @(self.droppedEvents),
    @"deliveryAttempts": @(self.deliveryAttempts),
    @"consecutiveFailures": @(self.consecutiveFailures),
    @"lastOutcome": LBWDeliveryOutcomeValue(self.lastOutcome),
    @"pauseReason": LBWDeliveryPauseReasonValue(self.pauseReason)
  };
}

@end

static NSError *LBWDeliveryError(LBWErrorKind kind, NSString *code, NSString *message, BOOL retryable) {
  return [NSError errorWithDomain:LBWErrorDomain
                             code:kind
                         userInfo:@{
                           LBWErrorStableCodeKey: code,
                           LBWErrorRetryableKey: @(retryable),
                           NSLocalizedDescriptionKey: message
                         }];
}

static void LBWDeliverySetError(NSError *_Nullable *_Nullable error, NSError *value) {
  if (error != NULL) {
    *error = value;
  }
}

static NSTimeInterval LBWDeliveryUptime(void) {
  return [NSProcessInfo processInfo].systemUptime;
}

@implementation LBWDeliveryEngine

- (instancetype)initWithAPIKey:(NSString *)apiKey
                       sdkName:(NSString *)sdkName
                    sdkVersion:(NSString *)sdkVersion
                    maxRetries:(NSUInteger)maxRetries {
  self = [super init];
  if (self != nil) {
    _apiKey = [apiKey copy];
    _sdk = @{ @"name": [sdkName copy], @"language": @"objc", @"version": [sdkVersion copy] };
    _maxRetries = maxRetries;
    _stateLock = [[NSLock alloc] init];
    _flushLock = [[NSLock alloc] init];
    _storageLock = [[NSLock alloc] init];
    _events = [NSMutableArray array];
    _eventBytes = [NSMutableArray array];
    _eventRecordNames = [NSMutableArray array];
    _frozenRecordNames = @[];
    _state = LBWDeliveryStateManual;
    _lastOutcome = LBWDeliveryOutcomeNone;
    _pauseReason = LBWDeliveryPauseReasonNone;
  }
  return self;
}

- (NSUInteger)pendingEvents {
  [self.stateLock lock];
  NSUInteger count = [self.events count];
  [self.stateLock unlock];
  return count;
}

- (NSString *)previewJSONWithError:(NSError **)error {
  [self.stateLock lock];
  NSArray<NSDictionary<NSString *, id> *> *events = [self.events copy];
  [self.stateLock unlock];
  NSData *data = [self encodeEvents:events error:error];
  return data == nil ? nil : [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

- (BOOL)enqueueEvent:(NSDictionary<NSString *, id> *)event error:(NSError **)error {
  NSData *eventData = [NSJSONSerialization dataWithJSONObject:event options:NSJSONWritingSortedKeys error:error];
  if (eventData == nil) {
    return NO;
  }
  NSData *singleBody = [self encodeEvents:@[ event ] error:error];
  if (singleBody == nil) {
    return NO;
  }

  BOOL shouldSchedule = NO;
  [self.storageLock lock];
  [self.stateLock lock];
  if (self.closed || self.state == LBWDeliveryStateShuttingDown || self.state == LBWDeliveryStateClosed) {
    LBWDeliverySetError(
        error, LBWDeliveryError(LBWErrorKindShutdown, @"shutdown_error", @"client is already shut down", NO));
    [self.stateLock unlock];
    [self.storageLock unlock];
    return NO;
  }
  if (self.state == LBWDeliveryStatePaused && self.pauseReason == LBWDeliveryPauseReasonStorage) {
    LBWDeliverySetError(error, [self storageErrorForStoreError:
        [NSError errorWithDomain:LBWDurableStoreErrorDomain code:LBWDurableStoreErrorCorrupt userInfo:nil]]);
    [self.stateLock unlock];
    [self.storageLock unlock];
    return NO;
  }
  if ([singleBody length] > LBWMaxRequestBytes) {
    self.droppedEvents += 1U;
    self.lastOutcome = LBWDeliveryOutcomeDropped;
    LBWDeliverySetError(error, LBWDeliveryError(
        LBWErrorKindValidation, @"event_too_large", @"event exceeds the delivery request byte limit", NO));
    [self.stateLock unlock];
    [self.storageLock unlock];
    return NO;
  }
  if ([self.events count] >= LBWMaxQueuedEvents || self.queuedBytes > LBWMaxQueuedBytes - [eventData length]) {
    self.droppedEvents += 1U;
    self.lastOutcome = LBWDeliveryOutcomeDropped;
    LBWDeliverySetError(
        error, LBWDeliveryError(LBWErrorKindValidation, @"queue_full", @"delivery queue capacity exceeded", NO));
    [self.stateLock unlock];
    [self.storageLock unlock];
    return NO;
  }
  LBWDurableDeliveryStore *store = self.durableStore;
  [self.stateLock unlock];
  NSString *recordName = nil;
  if (store != nil) {
    NSError *storeError = nil;
    recordName = [store appendEvent:event encodedBytes:eventData.length error:&storeError];
    if (recordName == nil) {
      [self recordStorageFailure];
      LBWDeliverySetError(error, [self storageErrorForStoreError:storeError]);
      [self.storageLock unlock];
      return NO;
    }
  }
  [self.stateLock lock];
  [self.events addObject:[event copy]];
  [self.eventBytes addObject:@([eventData length])];
  [self.eventRecordNames addObject:recordName != nil ? recordName : [NSNull null]];
  self.queuedBytes += [eventData length];
  shouldSchedule = [self scheduleCaptureLocked];
  [self.stateLock unlock];
  [self.storageLock unlock];
  if (shouldSchedule) {
    [self updateTimer];
  }
  return YES;
}

- (LBWDeliveryHealth *)health {
  [self.stateLock lock];
  LBWDeliveryHealth *health = [[LBWDeliveryHealth alloc] initPrivate];
  health.state = self.state;
  health.queuedEvents = [self.events count];
  health.queuedBytes = self.queuedBytes;
  health.inFlight = self.inFlight;
  health.acceptedEvents = self.acceptedEvents;
  health.droppedEvents = self.droppedEvents;
  health.deliveryAttempts = self.deliveryAttempts;
  health.consecutiveFailures = self.consecutiveFailures;
  health.lastOutcome = self.lastOutcome;
  health.pauseReason = self.pauseReason;
  [self.stateLock unlock];
  return health;
}

- (BOOL)startAutomaticDeliveryWithTransport:(id<LBWTransport>)transport
                                    options:(LBWAutomaticDeliveryOptions *)options
                                      error:(NSError **)error {
  if (transport == nil) {
    LBWDeliverySetError(error, LBWDeliveryError(
        LBWErrorKindConfig, @"configuration_error", @"automatic delivery transport is required", NO));
    return NO;
  }
  if (![self validateOptions:options error:error]) {
    return NO;
  }
  LBWAutomaticDeliveryOptions *ownedOptions = [[LBWAutomaticDeliveryOptions alloc] init];
  ownedOptions.interval = options.interval;
  ownedOptions.threshold = options.threshold;
  ownedOptions.retryBaseDelay = options.retryBaseDelay;
  ownedOptions.maxRetryDelay = options.maxRetryDelay;
  dispatch_queue_t scheduler = dispatch_queue_create("co.logbrew.objc.delivery", DISPATCH_QUEUE_SERIAL);
  dispatch_queue_set_specific(scheduler, LBWDeliverySchedulerKey, (__bridge void *)self, NULL);
  dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, scheduler);

  [self.storageLock lock];
  [self.stateLock lock];
  if (self.closed || self.state == LBWDeliveryStateClosed || self.state == LBWDeliveryStateShuttingDown) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    dispatch_resume(timer);
    dispatch_source_cancel(timer);
    LBWDeliverySetError(
        error, LBWDeliveryError(LBWErrorKindShutdown, @"shutdown_error", @"client is already shut down", NO));
    return NO;
  }
  if (self.state == LBWDeliveryStatePaused && self.pauseReason == LBWDeliveryPauseReasonStorage) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    dispatch_resume(timer);
    dispatch_source_cancel(timer);
    LBWDeliverySetError(error, [self storageErrorForStoreError:
        [NSError errorWithDomain:LBWDurableStoreErrorDomain code:LBWDurableStoreErrorCorrupt userInfo:nil]]);
    return NO;
  }
  if (self.automaticTransport != nil) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    dispatch_resume(timer);
    dispatch_source_cancel(timer);
    LBWDeliverySetError(error, LBWDeliveryError(
        LBWErrorKindConfig, @"configuration_error", @"automatic delivery is already running", NO));
    return NO;
  }
  self.generation += 1U;
  NSUInteger generation = self.generation;
  self.automaticTransport = transport;
  self.automaticOptions = ownedOptions;
  self.schedulerQueue = scheduler;
  self.schedulerTimer = timer;
  self.state = LBWDeliveryStateRunning;
  self.pauseReason = LBWDeliveryPauseReasonNone;
  self.retryAttempt = 0U;
  BOOL shouldSchedule = [self scheduleLiveQueueLocked];
  [self.stateLock unlock];
  [self.storageLock unlock];

  __weak LBWDeliveryEngine *weakSelf = self;
  dispatch_source_set_event_handler(timer, ^{
    [weakSelf timerFiredForGeneration:generation];
  });
  dispatch_resume(timer);
  if (shouldSchedule) {
    [self updateTimer];
  }
  return YES;
}

- (BOOL)recoverAutomaticDeliveryWithError:(NSError **)error {
  [self.stateLock lock];
  if (self.automaticTransport == nil || self.automaticOptions == nil) {
    [self.stateLock unlock];
    LBWDeliverySetError(error, LBWDeliveryError(
        LBWErrorKindConfig, @"configuration_error", @"automatic delivery is not running", NO));
    return NO;
  }
  if (self.state != LBWDeliveryStatePaused) {
    [self.stateLock unlock];
    return YES;
  }
  if (self.pauseReason == LBWDeliveryPauseReasonStorage) {
    [self.stateLock unlock];
    LBWDeliverySetError(error, [self storageErrorForStoreError:
        [NSError errorWithDomain:LBWDurableStoreErrorDomain code:LBWDurableStoreErrorCorrupt userInfo:nil]]);
    return NO;
  }
  self.state = LBWDeliveryStateRunning;
  self.pauseReason = LBWDeliveryPauseReasonNone;
  self.retryAttempt = 0U;
  self.consecutiveFailures = 0U;
  self.nextWakeUptime = 0;
  BOOL shouldSchedule = [self scheduleLiveQueueLocked];
  [self.stateLock unlock];
  if (shouldSchedule) {
    [self updateTimer];
  }
  return YES;
}

- (void)stopAutomaticDelivery {
  dispatch_source_t timer;
  [self.storageLock lock];
  [self.stateLock lock];
  self.generation += 1U;
  timer = self.schedulerTimer;
  self.schedulerTimer = nil;
  self.schedulerQueue = nil;
  self.automaticTransport = nil;
  self.automaticOptions = nil;
  self.nextWakeUptime = 0;
  self.retryAttempt = 0U;
  BOOL storagePaused = self.state == LBWDeliveryStatePaused && self.pauseReason == LBWDeliveryPauseReasonStorage;
  if (!storagePaused) {
    self.pauseReason = LBWDeliveryPauseReasonNone;
  }
  if (!self.closed && self.state != LBWDeliveryStateShuttingDown && !storagePaused) {
    self.state = LBWDeliveryStateManual;
  }
  [self.stateLock unlock];
  [self.storageLock unlock];
  if (timer != nil) {
    dispatch_source_cancel(timer);
  }
  if ((__bridge id)dispatch_get_specific(LBWDeliverySchedulerKey) != self) {
    [self.flushLock lock];
    [self.flushLock unlock];
  }
}

- (LBWTransportResponse *)flushWithTransport:(id<LBWTransport>)transport error:(NSError **)error {
  [self.stateLock lock];
  if (self.closed || self.state == LBWDeliveryStateClosed || self.state == LBWDeliveryStateShuttingDown) {
    [self.stateLock unlock];
    LBWDeliverySetError(
        error, LBWDeliveryError(LBWErrorKindShutdown, @"shutdown_error", @"client is already shut down", NO));
    return nil;
  }
  if (self.state == LBWDeliveryStatePaused && self.pauseReason == LBWDeliveryPauseReasonStorage) {
    [self.stateLock unlock];
    LBWDeliverySetError(error, [self storageErrorForStoreError:
        [NSError errorWithDomain:LBWDurableStoreErrorDomain code:LBWDurableStoreErrorCorrupt userInfo:nil]]);
    return nil;
  }
  self.nextWakeUptime = 0;
  [self.stateLock unlock];

  [self.flushLock lock];
  LBWTransportResponse *response = [self flushAllWithTransport:transport error:error];
  [self.flushLock unlock];
  [self rescheduleAfterManualFlush];
  return response;
}

- (LBWTransportResponse *)flushOwnedTransportWithError:(NSError **)error {
  [self.stateLock lock];
  id<LBWTransport> transport = self.automaticTransport;
  [self.stateLock unlock];
  if (transport == nil) {
    LBWDeliverySetError(error, LBWDeliveryError(
        LBWErrorKindConfig, @"configuration_error", @"automatic delivery is not running", NO));
    return nil;
  }
  return [self flushWithTransport:transport error:error];
}

- (LBWTransportResponse *)shutdownWithTransport:(id<LBWTransport>)transport error:(NSError **)error {
  dispatch_source_t timer;
  [self.storageLock lock];
  [self.stateLock lock];
  if (self.closed || self.state == LBWDeliveryStateClosed || self.state == LBWDeliveryStateShuttingDown) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    LBWDeliverySetError(
        error, LBWDeliveryError(LBWErrorKindShutdown, @"shutdown_error", @"client is already shut down", NO));
    return nil;
  }
  if (self.state == LBWDeliveryStatePaused && self.pauseReason == LBWDeliveryPauseReasonStorage) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    LBWDeliverySetError(error, [self storageErrorForStoreError:
        [NSError errorWithDomain:LBWDurableStoreErrorDomain code:LBWDurableStoreErrorCorrupt userInfo:nil]]);
    return nil;
  }
  self.closed = YES;
  self.state = LBWDeliveryStateShuttingDown;
  self.generation += 1U;
  self.nextWakeUptime = 0;
  timer = self.schedulerTimer;
  self.schedulerTimer = nil;
  self.schedulerQueue = nil;
  self.automaticTransport = nil;
  self.automaticOptions = nil;
  [self.stateLock unlock];
  [self.storageLock unlock];
  if (timer != nil) {
    dispatch_source_cancel(timer);
  }

  [self.flushLock lock];
  LBWTransportResponse *response = [self flushAllWithTransport:transport error:error];
  [self.stateLock lock];
  self.inFlight = NO;
  if (response == nil) {
    self.closed = NO;
    self.state = self.pauseReason == LBWDeliveryPauseReasonStorage ? LBWDeliveryStatePaused
                                                                  : LBWDeliveryStateManual;
  } else {
    self.state = LBWDeliveryStateClosed;
  }
  [self.stateLock unlock];
  [self.flushLock unlock];
  return response;
}

- (LBWTransportResponse *)shutdownOwnedTransportWithError:(NSError **)error {
  [self.stateLock lock];
  id<LBWTransport> transport = self.automaticTransport;
  [self.stateLock unlock];
  if (transport == nil) {
    LBWDeliverySetError(error, LBWDeliveryError(
        LBWErrorKindConfig, @"configuration_error", @"automatic delivery is not running", NO));
    return nil;
  }
  return [self shutdownWithTransport:transport error:error];
}

- (LBWTransportResponse *)flushAllWithTransport:(id<LBWTransport>)transport error:(NSError **)error {
  if (error != NULL) {
    *error = nil;
  }
  NSUInteger totalAttempts = 0U;
  NSInteger finalStatus = 204;
  while ([self freezePrefixWithError:error]) {
    BOOL accepted = NO;
    for (NSUInteger attempt = 1U; attempt <= self.maxRetries + 1U; attempt += 1U) {
      NSError *transportError = nil;
      LBWTransportResponse *response = [transport sendWithAPIKey:self.apiKey body:self.frozenBody error:&transportError];
      NSUInteger attempts = response == nil || response.attempts == 0U ? 1U : response.attempts;
      totalAttempts += attempts;
      [self recordDeliveryAttempts:attempts];
      if (response == nil) {
        BOOL retryable = [transportError.userInfo[LBWErrorRetryableKey] boolValue];
        if (retryable && attempt <= self.maxRetries) {
          continue;
        }
        LBWDeliveryPauseReason reason = retryable ? LBWDeliveryPauseReasonRetryExhausted
                                                  : LBWDeliveryPauseReasonNonRetryable;
        [self recordManualFailure:retryable ? LBWDeliveryOutcomeRetryableFailure : LBWDeliveryOutcomeTerminalFailure
                         reason:reason];
        LBWDeliverySetError(
            error,
            transportError != nil ? transportError :
                LBWDeliveryError(LBWErrorKindTransport, @"transport_error", @"transport failed", retryable));
        return nil;
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        finalStatus = response.statusCode;
        if (![self acknowledgeFrozenPrefixWithError:error]) {
          return nil;
        }
        accepted = YES;
        break;
      }
      BOOL retryable = response.statusCode == 408 || response.statusCode >= 500;
      if (retryable && attempt <= self.maxRetries) {
        continue;
      }
      LBWDeliveryPauseReason reason = retryable ? LBWDeliveryPauseReasonRetryExhausted : [self pauseReasonForStatus:response.statusCode];
      [self recordManualFailure:retryable ? LBWDeliveryOutcomeRetryableFailure : LBWDeliveryOutcomeTerminalFailure
                       reason:reason];
      LBWDeliverySetError(error, [self errorForPauseReason:reason]);
      return nil;
    }
    if (!accepted) {
      return nil;
    }
  }
  if (error != NULL && *error != nil) {
    return nil;
  }
  return [[LBWTransportResponse alloc] initWithStatusCode:finalStatus attempts:totalAttempts];
}

- (void)timerFiredForGeneration:(NSUInteger)generation {
  [self.stateLock lock];
  if (generation != self.generation) {
    [self.stateLock unlock];
    return;
  }
  BOOL due = self.nextWakeUptime > 0 && LBWDeliveryUptime() + 0.0005 >= self.nextWakeUptime;
  BOOL active = self.automaticTransport != nil &&
      (self.state == LBWDeliveryStateRunning || self.state == LBWDeliveryStateRetrying);
  if (due) {
    self.nextWakeUptime = 0;
  }
  [self.stateLock unlock];
  if (due && active) {
    [self runAutomaticDeliveryForGeneration:generation];
  }
}

- (void)runAutomaticDeliveryForGeneration:(NSUInteger)generation {
  [self.flushLock lock];
  [self.stateLock lock];
  id<LBWTransport> transport = self.automaticTransport;
  BOOL active = generation == self.generation && transport != nil &&
      (self.state == LBWDeliveryStateRunning || self.state == LBWDeliveryStateRetrying);
  [self.stateLock unlock];
  if (!active) {
    [self.flushLock unlock];
    return;
  }

  NSError *freezeError = nil;
  if (![self freezePrefixWithError:&freezeError]) {
    [self.flushLock unlock];
    return;
  }
  NSError *transportError = nil;
  LBWTransportResponse *response = [transport sendWithAPIKey:self.apiKey body:self.frozenBody error:&transportError];

  if (response != nil && response.statusCode >= 200 && response.statusCode < 300) {
    [self.storageLock lock];
    [self.stateLock lock];
    if (generation != self.generation && self.state != LBWDeliveryStateShuttingDown) {
      self.inFlight = NO;
      [self.stateLock unlock];
      [self.storageLock unlock];
      [self.flushLock unlock];
      return;
    }
    LBWDurableDeliveryStore *store = self.durableStore;
    NSString *body = self.frozenBody;
    NSArray<NSString *> *recordNames = self.frozenRecordNames;
    [self.stateLock unlock];

    NSError *storeError = nil;
    BOOL durableAccepted = store == nil ||
        (body != nil && [store acknowledgeBody:body eventRecordNames:recordNames error:&storeError]);
    [self.stateLock lock];
    self.inFlight = NO;
    self.deliveryAttempts += 1U;
    BOOL shouldSchedule = NO;
    if (durableAccepted) {
      NSUInteger acceptedCount = self.frozenCount;
      [self acknowledgeFrozenPrefixLocked];
      self.acceptedEvents += acceptedCount;
      self.consecutiveFailures = 0U;
      self.retryAttempt = 0U;
      self.lastOutcome = LBWDeliveryOutcomeAccepted;
      if (self.state != LBWDeliveryStateShuttingDown) {
        self.state = LBWDeliveryStateRunning;
        shouldSchedule = [self scheduleLiveQueueLocked];
      }
    } else {
      self.state = LBWDeliveryStatePaused;
      self.pauseReason = LBWDeliveryPauseReasonStorage;
      self.lastOutcome = LBWDeliveryOutcomeTerminalFailure;
      self.consecutiveFailures += 1U;
      self.nextWakeUptime = 0;
    }
    [self.stateLock unlock];
    [self.storageLock unlock];
    [self.flushLock unlock];
    if (shouldSchedule) {
      [self updateTimer];
    }
    return;
  }

  BOOL shouldSchedule = NO;
  [self.stateLock lock];
  if (generation != self.generation && self.state != LBWDeliveryStateShuttingDown) {
    self.inFlight = NO;
    [self.stateLock unlock];
    [self.flushLock unlock];
    return;
  }
  self.inFlight = NO;
  self.deliveryAttempts += 1U;
  BOOL retryable = response == nil ? [transportError.userInfo[LBWErrorRetryableKey] boolValue] :
      (response.statusCode == 408 || response.statusCode >= 500);
  self.consecutiveFailures += 1U;
  self.lastOutcome = retryable ? LBWDeliveryOutcomeRetryableFailure : LBWDeliveryOutcomeTerminalFailure;
  if (self.state != LBWDeliveryStateShuttingDown && retryable && self.retryAttempt < self.maxRetries) {
    self.retryAttempt += 1U;
    self.state = LBWDeliveryStateRetrying;
    shouldSchedule = [self scheduleRetryLocked];
  } else if (self.state != LBWDeliveryStateShuttingDown) {
    self.state = LBWDeliveryStatePaused;
    self.pauseReason = retryable ? LBWDeliveryPauseReasonRetryExhausted :
        (response == nil ? LBWDeliveryPauseReasonNonRetryable : [self pauseReasonForStatus:response.statusCode]);
  }
  [self.stateLock unlock];
  [self.flushLock unlock];
  if (shouldSchedule) {
    [self updateTimer];
  }
}

- (BOOL)freezePrefixWithError:(NSError **)error {
  [self.storageLock lock];
  [self.stateLock lock];
  if (self.frozenBody != nil) {
    self.inFlight = YES;
    [self.stateLock unlock];
    [self.storageLock unlock];
    return YES;
  }
  if ([self.events count] == 0U) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    return NO;
  }
  NSArray<NSDictionary<NSString *, id> *> *queueSnapshot = [self.events copy];
  NSArray<NSNumber *> *byteSnapshot = [self.eventBytes copy];
  NSArray<id> *recordNameSnapshot = [self.eventRecordNames copy];
  LBWDurableDeliveryStore *store = self.durableStore;
  [self.stateLock unlock];

  NSMutableArray<NSDictionary<NSString *, id> *> *selected = [NSMutableArray array];
  NSData *bodyData = nil;
  NSUInteger eventCount = [queueSnapshot count];
  NSUInteger limit = eventCount < LBWMaxRequestEvents ? eventCount : LBWMaxRequestEvents;
  for (NSUInteger index = 0U; index < limit; index += 1U) {
    [selected addObject:queueSnapshot[index]];
    NSData *candidate = [self encodeEvents:selected error:error];
    if (candidate == nil) {
      [self.storageLock unlock];
      return NO;
    }
    if ([candidate length] > LBWMaxRequestBytes) {
      [selected removeLastObject];
      break;
    }
    bodyData = candidate;
  }
  if ([selected count] == 0U || bodyData == nil) {
    [self.storageLock unlock];
    LBWDeliverySetError(error, LBWDeliveryError(
        LBWErrorKindValidation, @"event_too_large", @"event exceeds the delivery request byte limit", NO));
    return NO;
  }
  NSUInteger bytes = 0U;
  NSMutableArray<NSString *> *recordNames = [NSMutableArray array];
  for (NSUInteger index = 0U; index < [selected count]; index += 1U) {
    bytes += [byteSnapshot[index] unsignedIntegerValue];
    if (store != nil) {
      id name = recordNameSnapshot[index];
      if (![name isKindOfClass:[NSString class]]) {
        [self recordStorageFailure];
        [self.storageLock unlock];
        LBWDeliverySetError(error, [self storageErrorForStoreError:
            [NSError errorWithDomain:LBWDurableStoreErrorDomain
                                 code:LBWDurableStoreErrorCorrupt
                             userInfo:nil]]);
        return NO;
      }
      [recordNames addObject:name];
    }
  }
  NSString *body = [[NSString alloc] initWithData:bodyData encoding:NSUTF8StringEncoding];
  if (body == nil) {
    [self.storageLock unlock];
    LBWDeliverySetError(error, LBWDeliveryError(
        LBWErrorKindValidation, @"encoding_error", @"event batch was not valid UTF-8", NO));
    return NO;
  }
  if (store != nil) {
    NSError *storeError = nil;
    if (![store persistPrefixBody:body eventRecordNames:recordNames encodedBytes:bytes error:&storeError]) {
      [self recordStorageFailure];
      [self.storageLock unlock];
      LBWDeliverySetError(error, [self storageErrorForStoreError:storeError]);
      return NO;
    }
  }
  [self.stateLock lock];
  self.frozenBody = body;
  self.frozenCount = [selected count];
  self.frozenBytes = bytes;
  self.frozenRecordNames = recordNames;
  self.inFlight = YES;
  [self.stateLock unlock];
  [self.storageLock unlock];
  return YES;
}

- (BOOL)acknowledgeFrozenPrefixWithError:(NSError **)error {
  [self.storageLock lock];
  [self.stateLock lock];
  NSString *body = self.frozenBody;
  NSArray<NSString *> *recordNames = self.frozenRecordNames;
  LBWDurableDeliveryStore *store = self.durableStore;
  [self.stateLock unlock];
  if (store != nil) {
    NSError *storeError = nil;
    if (body == nil || ![store acknowledgeBody:body eventRecordNames:recordNames error:&storeError]) {
      [self recordStorageFailure];
      [self.storageLock unlock];
      LBWDeliverySetError(error, [self storageErrorForStoreError:storeError]);
      return NO;
    }
  }
  [self.stateLock lock];
  NSUInteger count = self.frozenCount;
  [self acknowledgeFrozenPrefixLocked];
  self.acceptedEvents += count;
  self.consecutiveFailures = 0U;
  self.lastOutcome = LBWDeliveryOutcomeAccepted;
  [self.stateLock unlock];
  [self.storageLock unlock];
  return YES;
}

- (void)acknowledgeFrozenPrefixLocked {
  if (self.frozenBody == nil || [self.events count] < self.frozenCount) {
    return;
  }
  [self.events removeObjectsInRange:NSMakeRange(0U, self.frozenCount)];
  [self.eventBytes removeObjectsInRange:NSMakeRange(0U, self.frozenCount)];
  [self.eventRecordNames removeObjectsInRange:NSMakeRange(0U, self.frozenCount)];
  self.queuedBytes -= self.frozenBytes;
  self.frozenBody = nil;
  self.frozenCount = 0U;
  self.frozenBytes = 0U;
  self.frozenRecordNames = @[];
  self.inFlight = NO;
  self.retryAttempt = 0U;
}

- (BOOL)scheduleCaptureLocked {
  if (self.automaticTransport == nil ||
      (self.state != LBWDeliveryStateRunning && self.state != LBWDeliveryStateRetrying) ||
      self.inFlight || self.frozenBody != nil) {
    return NO;
  }
  return [self scheduleLiveQueueLocked];
}

- (BOOL)scheduleLiveQueueLocked {
  if (self.automaticOptions == nil || [self.events count] == 0U ||
      (self.state != LBWDeliveryStateRunning && self.state != LBWDeliveryStateRetrying)) {
    self.nextWakeUptime = 0;
    return NO;
  }
  NSTimeInterval delay = [self.events count] >= self.automaticOptions.threshold ? 0 : self.automaticOptions.interval;
  return [self setWakeLocked:delay];
}

- (BOOL)scheduleRetryLocked {
  double multiplier = pow(2.0, (double)(self.retryAttempt > 0U ? self.retryAttempt - 1U : 0U));
  NSTimeInterval candidate = self.automaticOptions.retryBaseDelay * multiplier;
  NSTimeInterval ceiling = candidate < self.automaticOptions.maxRetryDelay ? candidate
                                                                           : self.automaticOptions.maxRetryDelay;
  double fraction = 0.5 + ((double)arc4random_uniform(10001U) / 20000.0);
  return [self setWakeLocked:ceiling * fraction];
}

- (BOOL)setWakeLocked:(NSTimeInterval)delay {
  NSTimeInterval deadline = LBWDeliveryUptime() + delay;
  if (self.nextWakeUptime > 0 && self.nextWakeUptime <= deadline) {
    return NO;
  }
  self.nextWakeUptime = deadline;
  return YES;
}

- (void)updateTimer {
  [self.stateLock lock];
  dispatch_source_t timer = self.schedulerTimer;
  NSTimeInterval untilWake = self.nextWakeUptime - LBWDeliveryUptime();
  NSTimeInterval remaining = untilWake > 0 ? untilWake : 0;
  [self.stateLock unlock];
  if (timer != nil) {
    double requestedNanoseconds = remaining * (double)NSEC_PER_SEC;
    double boundedNanoseconds = requestedNanoseconds < (double)INT64_MAX ? requestedNanoseconds : (double)INT64_MAX;
    uint64_t nanoseconds = (uint64_t)boundedNanoseconds;
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)nanoseconds), DISPATCH_TIME_FOREVER,
                              NSEC_PER_MSEC);
  }
}

- (void)rescheduleAfterManualFlush {
  [self.stateLock lock];
  BOOL shouldSchedule = NO;
  if (self.automaticTransport != nil && self.state != LBWDeliveryStatePaused && !self.closed) {
    self.state = LBWDeliveryStateRunning;
    self.retryAttempt = 0U;
    shouldSchedule = [self scheduleLiveQueueLocked];
  }
  [self.stateLock unlock];
  if (shouldSchedule) {
    [self updateTimer];
  }
}

- (void)recordManualFailure:(LBWDeliveryOutcome)outcome reason:(LBWDeliveryPauseReason)reason {
  [self.stateLock lock];
  self.inFlight = NO;
  self.consecutiveFailures += 1U;
  self.lastOutcome = outcome;
  if (self.automaticTransport != nil && self.state != LBWDeliveryStateShuttingDown &&
      self.state != LBWDeliveryStateClosed) {
    self.state = LBWDeliveryStatePaused;
    self.pauseReason = reason;
    self.nextWakeUptime = 0;
  }
  [self.stateLock unlock];
}

- (void)recordDeliveryAttempts:(NSUInteger)attempts {
  [self.stateLock lock];
  self.deliveryAttempts += attempts;
  [self.stateLock unlock];
}

- (LBWDeliveryPauseReason)pauseReasonForStatus:(NSInteger)statusCode {
  if (statusCode == 401 || statusCode == 403) return LBWDeliveryPauseReasonAuthentication;
  if (statusCode == 429) return LBWDeliveryPauseReasonQuota;
  if (statusCode == 400 || statusCode == 404 || statusCode == 409 || statusCode == 413 || statusCode == 422) {
    return LBWDeliveryPauseReasonValidation;
  }
  return LBWDeliveryPauseReasonNonRetryable;
}

- (NSError *)errorForPauseReason:(LBWDeliveryPauseReason)reason {
  switch (reason) {
    case LBWDeliveryPauseReasonAuthentication:
      return LBWDeliveryError(LBWErrorKindTransport, @"unauthenticated", @"transport rejected the API key", NO);
    case LBWDeliveryPauseReasonQuota:
      return LBWDeliveryError(LBWErrorKindTransport, @"quota_exceeded", @"transport rejected delivery quota", NO);
    case LBWDeliveryPauseReasonValidation:
      return LBWDeliveryError(LBWErrorKindTransport, @"transport_error", @"transport rejected the request", NO);
    case LBWDeliveryPauseReasonRetryExhausted:
      return LBWDeliveryError(LBWErrorKindTransport, @"transport_error", @"exhausted retries", YES);
    case LBWDeliveryPauseReasonStorage:
      return LBWDeliveryError(
          LBWErrorKindStorage, @"storage_corrupt", @"durable delivery data requires explicit recovery", NO);
    case LBWDeliveryPauseReasonNonRetryable:
    case LBWDeliveryPauseReasonNone:
      return LBWDeliveryError(LBWErrorKindTransport, @"transport_error", @"unexpected transport response", NO);
  }
}

- (BOOL)validateOptions:(LBWAutomaticDeliveryOptions *)options error:(NSError **)error {
  if (!isfinite(options.interval) || options.interval <= 0 || options.interval > LBWMaxScheduleDelay ||
      options.threshold == 0U ||
      options.threshold > LBWMaxQueuedEvents || !isfinite(options.retryBaseDelay) ||
      options.retryBaseDelay <= 0 || !isfinite(options.maxRetryDelay) ||
      options.maxRetryDelay < options.retryBaseDelay || options.maxRetryDelay > LBWMaxScheduleDelay) {
    LBWDeliverySetError(error, LBWDeliveryError(
        LBWErrorKindConfig, @"configuration_error", @"automatic delivery options are invalid", NO));
    return NO;
  }
  return YES;
}

- (NSData *)encodeEvents:(NSArray<NSDictionary<NSString *, id> *> *)events error:(NSError **)error {
  NSDictionary<NSString *, id> *payload = @{ @"sdk": self.sdk, @"events": events };
  return [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingSortedKeys error:error];
}

@end
