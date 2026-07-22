#import "LogBrew.h"

@interface LBWBlockingAcceptedTransport : NSObject <LBWTransport>

@property(nonatomic) dispatch_semaphore_t started;
@property(nonatomic) dispatch_semaphore_t releaseRequest;

@end


@implementation LBWBlockingAcceptedTransport

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _started = dispatch_semaphore_create(0);
    _releaseRequest = dispatch_semaphore_create(0);
  }
  return self;
}

- (LBWTransportResponse *)sendWithAPIKey:(NSString *)apiKey body:(NSString *)body error:(NSError **)error {
  (void)apiKey;
  (void)body;
  (void)error;
  dispatch_semaphore_signal(self.started);
  dispatch_semaphore_wait(self.releaseRequest, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  return [[LBWTransportResponse alloc] initWithStatusCode:202 attempts:1U];
}

@end

static void LBWAssert(BOOL condition, NSString *message) {
  if (!condition) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
  }
}

static LBWClient *LBWNewClient(NSUInteger maxRetries) {
  LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
  config.sdkName = @"logbrew-objc-durable-recovery";
  config.maxRetries = maxRetries;
  NSError *error = nil;
  LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];
  LBWAssert(client != nil && error == nil, @"durable recovery client init failed");
  return client;
}

static NSURL *LBWTemporaryParent(void) {
  NSFileManager *fileManager = [NSFileManager defaultManager];
  NSURL *parent = [[fileManager temporaryDirectory]
      URLByAppendingPathComponent:NSUUID.UUID.UUIDString
                       isDirectory:YES];
  NSError *error = nil;
  LBWAssert([fileManager createDirectoryAtURL:parent
                  withIntermediateDirectories:NO
                                   attributes:@{NSFilePosixPermissions : @0700}
                                        error:&error],
            @"durable recovery parent creation failed");
  return parent;
}

static void LBWCapture(LBWClient *client, NSString *eventID) {
  NSError *error = nil;
  LBWAssert([client logWithID:eventID
                   timestamp:@"2026-07-18T12:00:00Z"
                  attributes:@{ @"message" : @"durable recovery", @"level" : @"info" }
                       error:&error],
            @"durable recovery capture failed");
}

static void LBWTestExclusiveOwnership(void) {
  NSURL *parent = LBWTemporaryParent();
  LBWClient *waiting = LBWNewClient(1U);
  @autoreleasepool {
    LBWClient *owner = LBWNewClient(1U);
    NSError *error = nil;
    LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
    LBWAssert([owner enableDurableDeliveryWithOptions:options error:&error], @"first durable owner failed");
    error = nil;
    LBWAssert(![waiting enableDurableDeliveryWithOptions:options error:&error],
              @"second durable owner was accepted");
    LBWAssert([error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"storage_error"],
              @"second durable owner returned unstable error");
  }
  NSError *error = nil;
  LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
  LBWAssert([waiting enableDurableDeliveryWithOptions:options error:&error],
            @"durable owner did not release on deallocation");
  LBWAssert([waiting purgeDurableDeliveryWithError:&error], @"exclusive durable purge failed");
  LBWAssert([[NSFileManager defaultManager] removeItemAtURL:parent error:&error],
            @"exclusive parent cleanup failed");
}

static void LBWTestExactPrefixReplay(void) {
  NSURL *parent = LBWTemporaryParent();
  __block NSString *failedBody = nil;
  @autoreleasepool {
    LBWClient *client = LBWNewClient(1U);
    NSError *error = nil;
    LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
    LBWAssert([client enableDurableDeliveryWithOptions:options error:&error], @"prefix durability enable failed");
    for (NSUInteger index = 0U; index < 101U; index += 1U) {
      LBWCapture(client, [NSString stringWithFormat:@"objc-durable-batch-%lu", (unsigned long)index]);
    }
    LBWRecordingTransport *failed = [[LBWRecordingTransport alloc] initWithSteps:@[
      [LBWRecordingStep statusCodeStep:503],
      [LBWRecordingStep statusCodeStep:503]
    ]];
    LBWAssert([client flushWithTransport:failed error:&error] == nil, @"retryable durable prefix was accepted");
    LBWAssert(failed.sentBodies.count == 2U && [failed.sentBodies[0] isEqualToString:failed.sentBodies[1]],
              @"durable retry changed frozen request bytes");
    failedBody = failed.sentBodies[0];
    LBWAssert(![failedBody containsString:@"objc-durable-batch-100"],
              @"durable frozen prefix included later work");
    NSURL *prefix = [[parent URLByAppendingPathComponent:@"logbrew-delivery-v1" isDirectory:YES]
        URLByAppendingPathComponent:@"frozen-prefix.json" isDirectory:NO];
    LBWAssert([[NSFileManager defaultManager] fileExistsAtPath:prefix.path],
              @"failed durable prefix was not persisted");
  }

  @autoreleasepool {
    LBWClient *recovered = LBWNewClient(1U);
    NSError *error = nil;
    LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
    LBWAssert([recovered enableDurableDeliveryWithOptions:options error:&error], @"prefix recovery failed");
    LBWRecordingTransport *accepted = [[LBWRecordingTransport alloc] initWithSteps:@[
      [LBWRecordingStep statusCodeStep:202],
      [LBWRecordingStep statusCodeStep:202]
    ]];
    LBWAssert([recovered flushWithTransport:accepted error:&error] != nil, @"recovered prefix flush failed");
    LBWAssert(accepted.sentBodies.count == 2U, @"recovered FIFO did not use two bounded requests");
    LBWAssert([accepted.sentBodies[0] isEqualToString:failedBody], @"restart changed frozen request bytes");
    LBWAssert([accepted.sentBodies[1] containsString:@"objc-durable-batch-100"],
              @"restart lost later FIFO work");
  }

  LBWClient *afterAck = LBWNewClient(1U);
  NSError *error = nil;
  LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
  LBWAssert([afterAck enableDurableDeliveryWithOptions:options error:&error], @"post-prefix restart failed");
  LBWAssert(afterAck.pendingEvents == 0U, @"acknowledged prefix returned after restart");
  LBWAssert([afterAck purgeDurableDeliveryWithError:&error], @"prefix durable purge failed");
  LBWAssert([[NSFileManager defaultManager] removeItemAtURL:parent error:&error], @"prefix parent cleanup failed");
}

static void LBWTestBoundedPrivateRecovery(void) {
  NSURL *parent = LBWTemporaryParent();
  NSURL *owned = [parent URLByAppendingPathComponent:@"logbrew-delivery-v1" isDirectory:YES];
  @autoreleasepool {
    LBWClient *client = LBWNewClient(1U);
    NSError *error = nil;
    LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
    LBWAssert([client enableDurableDeliveryWithOptions:options error:&error], @"bounded durability enable failed");
    for (NSUInteger index = 0U; index < 1000U; index += 1U) {
      LBWCapture(client, [NSString stringWithFormat:@"objc-durable-capacity-%lu", (unsigned long)index]);
    }
    error = nil;
    LBWAssert(![client logWithID:@"objc-durable-capacity-overflow"
                       timestamp:@"2026-07-18T12:00:00Z"
                      attributes:@{ @"message" : @"overflow", @"level" : @"info" }
                           error:&error],
              @"durable queue accepted more than its event bound");
    LBWAssert([error.userInfo[LBWErrorStableCodeKey] isEqualToString:@"queue_full"],
              @"durable queue bound returned unstable error");

    NSNumber *excluded = nil;
    LBWAssert([owned getResourceValue:&excluded forKey:NSURLIsExcludedFromBackupKey error:&error] && excluded.boolValue,
              @"durable directory was not excluded from backup");
    NSArray<NSURL *> *children = [[NSFileManager defaultManager] contentsOfDirectoryAtURL:owned
                                                               includingPropertiesForKeys:nil
                                                                                  options:0
                                                                                    error:&error];
    LBWAssert(children.count == 1001U, @"durable queue wrote an unexpected owned file count");
    NSData *apiKey = [@"LOGBREW_API_KEY" dataUsingEncoding:NSUTF8StringEncoding];
    for (NSURL *child in children) {
      NSDictionary<NSFileAttributeKey, id> *attributes =
          [[NSFileManager defaultManager] attributesOfItemAtPath:child.path error:&error];
      LBWAssert([attributes[NSFilePosixPermissions] unsignedIntegerValue] == 0600U,
                @"durable owned file permissions were not private");
      NSData *bytes = [NSData dataWithContentsOfURL:child options:0 error:&error];
      LBWAssert([bytes rangeOfData:apiKey options:0 range:NSMakeRange(0U, bytes.length)].location == NSNotFound,
                @"durable storage persisted authentication data");
    }
  }

  LBWClient *recovered = LBWNewClient(1U);
  NSError *error = nil;
  LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
  LBWAssert([recovered enableDurableDeliveryWithOptions:options error:&error], @"bounded restart failed");
  LBWAssert(recovered.pendingEvents == 1000U, @"bounded restart changed event count");
  NSString *preview = [recovered previewJSONWithError:&error];
  NSData *previewData = [preview dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary<NSString *, id> *payload = [NSJSONSerialization JSONObjectWithData:previewData options:0 error:&error];
  NSArray<NSDictionary<NSString *, id> *> *events = payload[@"events"];
  LBWAssert(events.count == 1000U, @"bounded preview changed event count");
  LBWAssert([events.firstObject[@"id"] isEqualToString:@"objc-durable-capacity-0"],
            @"bounded restart changed FIFO head");
  LBWAssert([events.lastObject[@"id"] isEqualToString:@"objc-durable-capacity-999"],
            @"bounded restart changed FIFO tail");
  LBWAssert([recovered purgeDurableDeliveryWithError:&error], @"bounded durable purge failed");
  LBWAssert([[NSFileManager defaultManager] removeItemAtURL:parent error:&error], @"bounded parent cleanup failed");
}

static void LBWTestStopRetainsDurablePrefix(void) {
  NSURL *parent = LBWTemporaryParent();
  @autoreleasepool {
    LBWClient *client = LBWNewClient(1U);
    NSError *error = nil;
    LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
    LBWAssert([client enableDurableDeliveryWithOptions:options error:&error], @"stop race durability enable failed");
    LBWBlockingAcceptedTransport *transport = [[LBWBlockingAcceptedTransport alloc] init];
    LBWAutomaticDeliveryOptions *automatic = [[LBWAutomaticDeliveryOptions alloc] init];
    automatic.interval = 30.0;
    automatic.threshold = 1U;
    LBWAssert([client startAutomaticDeliveryWithTransport:transport options:automatic error:&error],
              @"stop race automatic start failed");
    LBWCapture(client, @"objc-durable-stop-race");
    LBWAssert(dispatch_semaphore_wait(transport.started,
                                     dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) == 0,
              @"stop race request did not start");
    dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      [client stopAutomaticDelivery];
      dispatch_semaphore_signal(stopped);
    });
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2.0];
    while (client.deliveryHealth.state != LBWDeliveryStateManual &&
           [[NSDate date] compare:deadline] == NSOrderedAscending) {
      [NSThread sleepForTimeInterval:0.005];
    }
    LBWAssert(client.deliveryHealth.state == LBWDeliveryStateManual, @"stop race did not invalidate delivery");
    LBWAssert(dispatch_semaphore_wait(stopped,
                                     dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC)) != 0,
              @"stop race returned before the in-flight sender finished");
    dispatch_semaphore_signal(transport.releaseRequest);
    LBWAssert(dispatch_semaphore_wait(stopped,
                                     dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) == 0,
              @"stop race did not finish");
    LBWAssert(client.pendingEvents == 1U, @"stop race removed the in-memory prefix");
  }

  LBWClient *recovered = LBWNewClient(1U);
  NSError *error = nil;
  LBWDurableDeliveryOptions *options = [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:parent];
  LBWAssert([recovered enableDurableDeliveryWithOptions:options error:&error], @"stop race restart failed");
  LBWAssert(recovered.pendingEvents == 1U, @"stop race removed the durable prefix");
  LBWAssert([[recovered previewJSONWithError:&error] containsString:@"objc-durable-stop-race"],
            @"stop race changed the durable prefix");
  LBWAssert([recovered purgeDurableDeliveryWithError:&error], @"stop race purge failed");
  LBWAssert([[NSFileManager defaultManager] removeItemAtURL:parent error:&error], @"stop race cleanup failed");
}

int main(void) {
  @autoreleasepool {
    LBWTestExclusiveOwnership();
    LBWTestExactPrefixReplay();
    LBWTestBoundedPrivateRecovery();
    LBWTestStopRetainsDurablePrefix();
  }
  return 0;
}
