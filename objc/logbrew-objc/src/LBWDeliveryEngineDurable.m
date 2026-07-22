#import "LBWDeliveryEnginePrivate.h"

static NSError *LBWDurableEngineError(LBWErrorKind kind, NSString *code, NSString *message) {
  return [NSError errorWithDomain:LBWErrorDomain
                             code:kind
                         userInfo:@{
                           LBWErrorStableCodeKey: code,
                           LBWErrorRetryableKey: @NO,
                           NSLocalizedDescriptionKey: message
                         }];
}

static void LBWDurableEngineSetError(NSError *_Nullable *_Nullable error, NSError *value) {
  if (error != NULL) {
    *error = value;
  }
}

@implementation LBWDeliveryEngine (Durable)

- (BOOL)enableDurableDeliveryWithOptions:(LBWDurableDeliveryOptions *)options error:(NSError **)error {
  if (options == nil) {
    LBWDurableEngineSetError(error, LBWDurableEngineError(
        LBWErrorKindConfig, @"configuration_error", @"durable delivery options are required"));
    return NO;
  }
  [self.storageLock lock];
  [self.stateLock lock];
  if (self.closed || self.state == LBWDeliveryStateClosed || self.state == LBWDeliveryStateShuttingDown) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    LBWDurableEngineSetError(
        error, LBWDurableEngineError(LBWErrorKindShutdown, @"shutdown_error", @"client is already shut down"));
    return NO;
  }
  if (self.durableStore != nil) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    LBWDurableEngineSetError(error, LBWDurableEngineError(
        LBWErrorKindConfig, @"configuration_error", @"durable delivery is already enabled"));
    return NO;
  }
  if (self.automaticTransport != nil || self.inFlight) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    LBWDurableEngineSetError(error, LBWDurableEngineError(
        LBWErrorKindConfig, @"configuration_error", @"stop active delivery before enabling durability"));
    return NO;
  }
  NSArray<NSDictionary<NSString *, id> *> *memoryEvents = [self.events copy];
  NSArray<NSNumber *> *memoryBytes = [self.eventBytes copy];
  [self.stateLock unlock];

  NSError *storeError = nil;
  LBWDurableDeliveryStore *store = [[LBWDurableDeliveryStore alloc] initWithParentURL:options.directoryURL
                                                                                  sdk:self.sdk
                                                                                error:&storeError];
  LBWDurableRecovery *recovery = store == nil ? nil : [store recovery];
  NSArray<NSDictionary<NSString *, id> *> *ownedEvents = nil;
  NSArray<NSNumber *> *ownedBytes = nil;
  NSArray<NSString *> *ownedNames = nil;
  NSString *ownedFrozenBody = nil;
  NSArray<NSString *> *ownedFrozenNames = @[];
  NSUInteger ownedFrozenBytes = 0U;
  if (store != nil && recovery.events.count == 0U) {
    ownedNames = [store appendExistingEvents:memoryEvents eventBytes:memoryBytes error:&storeError];
    if (ownedNames != nil) {
      ownedEvents = memoryEvents;
      ownedBytes = memoryBytes;
    }
  } else if (store != nil && memoryEvents.count != 0U) {
    storeError = [NSError errorWithDomain:LBWDurableStoreErrorDomain
                                     code:LBWDurableStoreErrorOwned
                                 userInfo:nil];
  } else if (store != nil) {
    ownedEvents = recovery.events;
    ownedBytes = recovery.eventBytes;
    ownedNames = recovery.eventRecordNames;
    ownedFrozenBody = recovery.frozenBody;
    ownedFrozenNames = recovery.frozenRecordNames;
    ownedFrozenBytes = recovery.frozenBytes;
    if (ownedFrozenBody != nil) {
      NSData *encoded = [self encodeEvents:[ownedEvents subarrayWithRange:NSMakeRange(0U, ownedFrozenNames.count)]
                                     error:&storeError];
      NSString *encodedBody = encoded == nil ? nil : [[NSString alloc] initWithData:encoded
                                                                           encoding:NSUTF8StringEncoding];
      if (encodedBody == nil || ![encodedBody isEqualToString:ownedFrozenBody]) {
        storeError = [NSError errorWithDomain:LBWDurableStoreErrorDomain
                                         code:LBWDurableStoreErrorCorrupt
                                     userInfo:nil];
      }
    }
  }
  if (store == nil || ownedEvents == nil || ownedBytes == nil || ownedNames == nil || storeError != nil) {
    [self.stateLock lock];
    self.durableParent = options.directoryURL;
    if ([storeError.domain isEqualToString:LBWDurableStoreErrorDomain] &&
        storeError.code == LBWDurableStoreErrorCorrupt) {
      self.state = LBWDeliveryStatePaused;
      self.pauseReason = LBWDeliveryPauseReasonStorage;
      self.lastOutcome = LBWDeliveryOutcomeTerminalFailure;
      self.consecutiveFailures += 1U;
    }
    [self.stateLock unlock];
    [self.storageLock unlock];
    LBWDurableEngineSetError(error, [self storageErrorForStoreError:storeError]);
    return NO;
  }

  [self.stateLock lock];
  self.events = [ownedEvents mutableCopy];
  self.eventBytes = [ownedBytes mutableCopy];
  self.eventRecordNames = [ownedNames mutableCopy];
  self.queuedBytes = 0U;
  for (NSNumber *value in ownedBytes) {
    self.queuedBytes += value.unsignedIntegerValue;
  }
  self.frozenBody = ownedFrozenBody;
  self.frozenCount = ownedFrozenNames.count;
  self.frozenBytes = ownedFrozenBytes;
  self.frozenRecordNames = ownedFrozenNames;
  self.durableStore = store;
  self.durableParent = options.directoryURL;
  if (self.state == LBWDeliveryStatePaused && self.pauseReason == LBWDeliveryPauseReasonStorage) {
    self.state = LBWDeliveryStateManual;
    self.pauseReason = LBWDeliveryPauseReasonNone;
  }
  [self.stateLock unlock];
  [self.storageLock unlock];
  return YES;
}

- (BOOL)purgeDurableDeliveryWithError:(NSError **)error {
  [self.storageLock lock];
  [self.stateLock lock];
  if (self.automaticTransport != nil || self.inFlight || self.state == LBWDeliveryStateShuttingDown ||
      self.state == LBWDeliveryStateClosed) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    LBWDurableEngineSetError(error, LBWDurableEngineError(
        LBWErrorKindConfig, @"configuration_error", @"stop active delivery before purging durable data"));
    return NO;
  }
  NSURL *parent = self.durableParent;
  if (parent == nil) {
    [self.stateLock unlock];
    [self.storageLock unlock];
    return YES;
  }
  self.durableStore = nil;
  [self.stateLock unlock];

  NSError *storeError = nil;
  if (![LBWDurableDeliveryStore purgeParentURL:parent error:&storeError]) {
    [self recordStorageFailure];
    [self.storageLock unlock];
    LBWDurableEngineSetError(error, [self storageErrorForStoreError:storeError]);
    return NO;
  }
  [self.stateLock lock];
  [self.events removeAllObjects];
  [self.eventBytes removeAllObjects];
  [self.eventRecordNames removeAllObjects];
  self.queuedBytes = 0U;
  self.frozenBody = nil;
  self.frozenCount = 0U;
  self.frozenBytes = 0U;
  self.frozenRecordNames = @[];
  self.durableParent = nil;
  self.state = LBWDeliveryStateManual;
  self.pauseReason = LBWDeliveryPauseReasonNone;
  self.inFlight = NO;
  [self.stateLock unlock];
  [self.storageLock unlock];
  return YES;
}

- (void)recordStorageFailure {
  [self.stateLock lock];
  self.inFlight = NO;
  self.state = LBWDeliveryStatePaused;
  self.pauseReason = LBWDeliveryPauseReasonStorage;
  self.lastOutcome = LBWDeliveryOutcomeTerminalFailure;
  self.consecutiveFailures += 1U;
  self.nextWakeUptime = 0;
  [self.stateLock unlock];
}

- (NSError *)storageErrorForStoreError:(NSError *)storeError {
  if ([storeError.domain isEqualToString:LBWDurableStoreErrorDomain]) {
    if (storeError.code == LBWDurableStoreErrorCorrupt) {
      return LBWDurableEngineError(
          LBWErrorKindStorage, @"storage_corrupt", @"durable delivery data requires explicit recovery");
    }
    if (storeError.code == LBWDurableStoreErrorCapacity) {
      return LBWDurableEngineError(
          LBWErrorKindValidation, @"queue_full", @"durable delivery capacity exceeded");
    }
    if (storeError.code == LBWDurableStoreErrorOwned) {
      return LBWDurableEngineError(
          LBWErrorKindStorage, @"storage_error", @"durable delivery storage is already in use");
    }
  }
  return LBWDurableEngineError(
      LBWErrorKindStorage, @"storage_error", @"durable delivery storage is unavailable");
}

@end
