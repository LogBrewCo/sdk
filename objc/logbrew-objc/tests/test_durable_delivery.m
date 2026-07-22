#import "LogBrew.h"

static void LBWAssert(BOOL condition, NSString *message) {
  if (!condition) {
    fprintf(stderr, "%s\n", [message UTF8String]);
    exit(1);
  }
}

static LBWClient *LBWNewDurableClient(void) {
  NSError *error = nil;
  LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  config.sdkName = @"logbrew-objc-durable-tests";
  LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
  LBWAssert(client != nil && error == nil, @"client init failed");
  return client;
}

static BOOL LBWWaitForPendingEvents(LBWClient *client, NSUInteger count) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
  while ([[NSDate date] compare:deadline] == NSOrderedAscending) {
    if (client.pendingEvents == count) {
      return YES;
    }
    [NSThread sleepForTimeInterval:0.005];
  }
  return client.pendingEvents == count;
}

static void LBWTestWrongRecordTypesFailClosed(void) {
  NSFileManager *fileManager = [NSFileManager defaultManager];
  NSURL *parent = [[fileManager temporaryDirectory]
      URLByAppendingPathComponent:NSUUID.UUID.UUIDString
                       isDirectory:YES];
  NSError *error = nil;
  LBWAssert([fileManager createDirectoryAtURL:parent
                  withIntermediateDirectories:NO
                                   attributes:@{NSFilePosixPermissions : @0700}
                                        error:&error],
            @"typed corruption parent creation failed");
  @autoreleasepool {
    LBWClient *client = LBWNewDurableClient();
    LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
    LBWAssert([client enableDurableDeliveryWithOptions:options error:&error],
              @"typed corruption durability enable failed");
    LBWAssert([client logWithID:@"typed-corruption"
                     timestamp:@"2026-07-18T12:00:00Z"
                    attributes:@{ @"message" : @"typed", @"level" : @"info" }
                         error:&error],
              @"typed corruption capture failed");
  }

  NSURL *owned = [parent URLByAppendingPathComponent:@"logbrew-delivery-v1" isDirectory:YES];
  NSArray<NSURL *> *children = [fileManager contentsOfDirectoryAtURL:owned
                                           includingPropertiesForKeys:nil
                                                              options:0
                                                                error:&error];
  NSPredicate *eventPredicate = [NSPredicate predicateWithBlock:^BOOL(NSURL *file, NSDictionary *bindings) {
    (void)bindings;
    return [file.lastPathComponent hasPrefix:@"event-"];
  }];
  NSURL *eventFile = [[children filteredArrayUsingPredicate:eventPredicate] firstObject];
  LBWAssert(eventFile != nil, @"typed corruption record missing");
  NSData *data = [NSData dataWithContentsOfURL:eventFile options:0 error:&error];
  NSMutableDictionary<NSString *, id> *record =
      [[NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:&error] mutableCopy];
  record[@"version"] = @[];
  NSData *malformed = [NSJSONSerialization dataWithJSONObject:record options:NSJSONWritingSortedKeys error:&error];
  LBWAssert([malformed writeToURL:eventFile options:NSDataWritingAtomic error:&error],
            @"typed corruption record write failed");
  LBWAssert([fileManager setAttributes:@{NSFilePosixPermissions : @0600}
                               ofItemAtPath:eventFile.path
                                        error:&error],
            @"typed corruption permissions failed");

  LBWClient *recovered = LBWNewDurableClient();
  LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
  error = nil;
  LBWAssert(![recovered enableDurableDeliveryWithOptions:options error:&error],
            @"wrong durable record types were accepted");
  LBWAssert([error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"storage_corrupt"],
            @"wrong durable record types returned unstable recovery");
  LBWAssert([recovered purgeDurableDeliveryWithError:&error], @"typed corruption purge failed");
  LBWAssert([fileManager removeItemAtURL:parent error:&error], @"typed corruption parent cleanup failed");
}

int main(void) {
  @autoreleasepool {
    LBWTestWrongRecordTypesFailClosed();
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSURL *root = [[fileManager temporaryDirectory]
        URLByAppendingPathComponent:[[NSUUID UUID] UUIDString]
                         isDirectory:YES];
    NSError *error = nil;
    LBWAssert([fileManager createDirectoryAtURL:root
                   withIntermediateDirectories:NO
                                    attributes:@{NSFilePosixPermissions : @0700}
                                         error:&error],
              @"temporary parent creation failed");

    @autoreleasepool {
      LBWClient *client = LBWNewDurableClient();
      LBWAssert([client logWithID:@"objc-durable"
                       timestamp:@"2026-07-18T12:00:00Z"
                      attributes:@{ @"message" : @"durable", @"level" : @"info" }
                           error:&error],
                @"pre-enable durable capture failed");
      LBWDurableDeliveryOptions *options =
          [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:root];
      LBWAssert([client enableDurableDeliveryWithOptions:options error:&error],
                @"durable delivery enable failed");
      LBWAssert(client.pendingEvents == 1U, @"durable capture was not queued");
    }

    @autoreleasepool {
      LBWClient *recovered = LBWNewDurableClient();
      LBWDurableDeliveryOptions *recoveryOptions =
          [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:root];
      LBWAssert([recovered enableDurableDeliveryWithOptions:recoveryOptions error:&error],
                @"durable restart recovery failed");
      LBWAssert(recovered.pendingEvents == 1U, @"durable restart queue was not recovered");
      LBWRecordingTransport *accepted =
          [[LBWRecordingTransport alloc] initWithSteps:@[[LBWRecordingStep statusCodeStep:202]]];
      LBWAssert([recovered flushWithTransport:accepted error:&error] != nil,
                @"durable accepted flush failed");
      LBWAssert(recovered.pendingEvents == 0U, @"accepted durable event remained in memory");
    }

    LBWClient *afterAcknowledgement = LBWNewDurableClient();
    LBWDurableDeliveryOptions *afterAcknowledgementOptions =
        [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:root];
    LBWAssert([afterAcknowledgement enableDurableDeliveryWithOptions:afterAcknowledgementOptions error:&error],
              @"durable post-ack restart failed");
    LBWAssert(afterAcknowledgement.pendingEvents == 0U, @"accepted durable event returned after restart");

    NSDictionary<NSString *, id> *health = afterAcknowledgement.deliveryHealth.dictionaryValue;
    NSData *healthData = [NSJSONSerialization dataWithJSONObject:health options:0 error:&error];
    NSString *healthJSON = [[NSString alloc] initWithData:healthData encoding:NSUTF8StringEncoding];
    LBWAssert(healthJSON != nil && ![healthJSON containsString:@"objc-durable"],
              @"durable health exposed event content");
    LBWAssert(![healthJSON containsString:[root path]], @"durable health exposed storage path");

    LBWAssert([afterAcknowledgement purgeDurableDeliveryWithError:&error], @"durable purge failed");
    LBWAssert(afterAcknowledgement.pendingEvents == 0U, @"durable purge retained queued work");

    LBWAssert([fileManager removeItemAtURL:root error:&error], @"temporary parent cleanup failed");

    NSURL *automaticRoot = [[fileManager temporaryDirectory]
        URLByAppendingPathComponent:[[NSUUID UUID] UUIDString]
                         isDirectory:YES];
    LBWAssert([fileManager createDirectoryAtURL:automaticRoot
                    withIntermediateDirectories:NO
                                     attributes:@{NSFilePosixPermissions : @0700}
                                          error:&error],
              @"automatic temporary parent creation failed");
    @autoreleasepool {
      LBWClient *automaticClient = LBWNewDurableClient();
      LBWDurableDeliveryOptions *options =
          [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:automaticRoot];
      LBWAssert([automaticClient enableDurableDeliveryWithOptions:options error:&error],
                @"automatic durability enable failed");
      LBWAutomaticDeliveryOptions *automaticOptions = [[LBWAutomaticDeliveryOptions alloc] init];
      automaticOptions.interval = 30.0;
      automaticOptions.threshold = 1U;
      LBWRecordingTransport *transport = [[LBWRecordingTransport alloc] init];
      LBWAssert([automaticClient startAutomaticDeliveryWithTransport:transport
                                                              options:automaticOptions
                                                                error:&error],
                @"automatic durable delivery start failed");
      LBWAssert([automaticClient logWithID:@"objc-durable-automatic"
                                 timestamp:@"2026-07-18T12:00:00Z"
                                attributes:@{ @"message" : @"automatic", @"level" : @"info" }
                                     error:&error],
                @"automatic durable capture failed");
      LBWAssert(LBWWaitForPendingEvents(automaticClient, 0U), @"automatic durable event was not accepted");
      [automaticClient stopAutomaticDelivery];
    }
    LBWClient *afterAutomatic = LBWNewDurableClient();
    LBWDurableDeliveryOptions *afterAutomaticOptions =
        [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:automaticRoot];
    LBWAssert([afterAutomatic enableDurableDeliveryWithOptions:afterAutomaticOptions error:&error],
              @"automatic post-ack restart failed");
    LBWAssert(afterAutomatic.pendingEvents == 0U, @"automatic accepted event returned after restart");
    LBWAssert([afterAutomatic purgeDurableDeliveryWithError:&error], @"automatic durable purge failed");
    LBWAssert([fileManager removeItemAtURL:automaticRoot error:&error],
              @"automatic temporary parent cleanup failed");

    NSURL *ackFailureRoot = [[fileManager temporaryDirectory]
        URLByAppendingPathComponent:[[NSUUID UUID] UUIDString]
                         isDirectory:YES];
    LBWAssert([fileManager createDirectoryAtURL:ackFailureRoot
                    withIntermediateDirectories:NO
                                     attributes:@{NSFilePosixPermissions : @0700}
                                          error:&error],
              @"ack failure parent creation failed");
    LBWClient *ackFailureClient = LBWNewDurableClient();
    LBWDurableDeliveryOptions *ackFailureOptions =
        [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:ackFailureRoot];
    LBWAssert([ackFailureClient enableDurableDeliveryWithOptions:ackFailureOptions error:&error],
              @"ack failure durability enable failed");
    LBWAssert([ackFailureClient logWithID:@"objc-durable-ack-failure"
                                timestamp:@"2026-07-18T12:00:00Z"
                               attributes:@{ @"message" : @"ack failure", @"level" : @"info" }
                                    error:&error],
              @"ack failure capture failed");
    NSURL *ackFailureOwned =
        [ackFailureRoot URLByAppendingPathComponent:@"logbrew-delivery-v1" isDirectory:YES];
    LBWAssert([fileManager setAttributes:@{NSFilePosixPermissions : @0500}
                                 ofItemAtPath:ackFailureOwned.path
                                          error:&error],
              @"ack failure permission setup failed");
    error = nil;
    LBWAssert([ackFailureClient shutdownWithTransport:[[LBWRecordingTransport alloc] init] error:&error] == nil,
              @"shutdown accepted an uncommitted durable prefix");
    LBWAssert([error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"storage_error"],
              @"shutdown storage failure returned unstable recovery");
    LBWAssert(ackFailureClient.deliveryHealth.state == LBWDeliveryStatePaused &&
                  ackFailureClient.deliveryHealth.pauseReason == LBWDeliveryPauseReasonStorage,
              @"shutdown erased the durable storage pause");
    LBWAssert([fileManager setAttributes:@{NSFilePosixPermissions : @0700}
                                 ofItemAtPath:ackFailureOwned.path
                                          error:&error],
              @"ack failure permission reset failed");
    LBWAssert([ackFailureClient purgeDurableDeliveryWithError:&error], @"ack failure durable purge failed");
    LBWAssert([fileManager removeItemAtURL:ackFailureRoot error:&error], @"ack failure parent cleanup failed");

    NSURL *corruptRoot = [[fileManager temporaryDirectory]
        URLByAppendingPathComponent:[[NSUUID UUID] UUIDString]
                         isDirectory:YES];
    LBWAssert([fileManager createDirectoryAtURL:corruptRoot
                    withIntermediateDirectories:NO
                                     attributes:@{NSFilePosixPermissions : @0700}
                                          error:&error],
              @"corrupt temporary parent creation failed");
    NSURL *owned = [corruptRoot URLByAppendingPathComponent:@"logbrew-delivery-v1" isDirectory:YES];
    LBWAssert([fileManager createDirectoryAtURL:owned
                    withIntermediateDirectories:NO
                                     attributes:@{NSFilePosixPermissions : @0700}
                                          error:&error],
              @"corrupt owned directory creation failed");
    NSURL *unknown = [owned URLByAppendingPathComponent:@"unknown.record" isDirectory:NO];
    LBWAssert([[@"unknown" dataUsingEncoding:NSUTF8StringEncoding] writeToURL:unknown
                                                                      options:NSDataWritingAtomic
                                                                        error:&error],
              @"unknown record creation failed");
    LBWClient *corruptClient = LBWNewDurableClient();
    LBWDurableDeliveryOptions *corruptOptions =
        [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:corruptRoot];
    error = nil;
    LBWAssert(![corruptClient enableDurableDeliveryWithOptions:corruptOptions error:&error],
              @"unknown durable record was accepted");
    LBWAssert([error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"storage_corrupt"],
              @"unknown durable record returned unsafe recovery");
    LBWAssert(corruptClient.deliveryHealth.pauseReason == LBWDeliveryPauseReasonStorage,
              @"unknown durable record did not pause storage");
    error = nil;
    LBWAssert(![corruptClient logWithID:@"must-not-bypass-storage"
                              timestamp:@"2026-07-18T12:00:00Z"
                             attributes:@{ @"message" : @"blocked", @"level" : @"info" }
                                  error:&error],
              @"capture bypassed corrupt storage");
    LBWAssert([error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"storage_corrupt"],
              @"capture corruption recovery was unstable");
    error = nil;
    LBWAssert([corruptClient flushWithTransport:[[LBWRecordingTransport alloc] init] error:&error] == nil,
              @"manual flush bypassed corrupt storage");
    LBWAssert([error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"storage_corrupt"],
              @"flush corruption recovery was unstable");
    error = nil;
    LBWAssert([corruptClient shutdownWithTransport:[[LBWRecordingTransport alloc] init] error:&error] == nil,
              @"shutdown bypassed corrupt storage");
    LBWAssert([error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"storage_corrupt"],
              @"shutdown corruption recovery was unstable");
    error = nil;
    LBWAssert(![corruptClient startAutomaticDeliveryWithTransport:[[LBWRecordingTransport alloc] init]
                                                           options:[[LBWAutomaticDeliveryOptions alloc] init]
                                                             error:&error],
              @"automatic start bypassed corrupt storage");
    LBWAssert([error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"storage_corrupt"],
              @"automatic corruption recovery was unstable");
    LBWAssert([fileManager fileExistsAtPath:unknown.path], @"corrupt record was deleted implicitly");
    LBWAssert([corruptClient purgeDurableDeliveryWithError:&error], @"corrupt durable purge failed");
    LBWAssert(![fileManager fileExistsAtPath:owned.path], @"corrupt durable purge retained owned storage");
    LBWAssert([fileManager removeItemAtURL:corruptRoot error:&error], @"corrupt parent cleanup failed");
  }
  return 0;
}
