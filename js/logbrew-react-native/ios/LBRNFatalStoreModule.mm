#import "LBRNFatalStoreModule.h"

#import "LBRNEventRecordStore.h"
#import "LBRNFatalRecordStore.h"
#import "LBRNPrivateStorage.h"

#import <CommonCrypto/CommonDigest.h>
#import <TargetConditionals.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <LogBrewReactNativeSpec/LogBrewReactNativeSpec.h>
#endif

static NSDictionary *LBRNStorageError(void)
{
    return @{ @"status" : @"storage_error" };
}

static BOOL LBRNPrepareProtectedDirectory(NSURL *directoryURL)
{
    NSError *writeError = nil;
    if (![directoryURL setResourceValue:@YES
                                 forKey:NSURLIsExcludedFromBackupKey
                                  error:&writeError]
        || writeError != nil) {
        return NO;
    }
#if TARGET_OS_IPHONE
    writeError = nil;
    if (![directoryURL setResourceValue:NSFileProtectionCompleteUntilFirstUserAuthentication
                                 forKey:NSURLFileProtectionKey
                                  error:&writeError]
        || writeError != nil) {
        return NO;
    }
#endif
    NSNumber *excluded = nil;
    NSError *readError = nil;
    return [directoryURL getResourceValue:&excluded
                                   forKey:NSURLIsExcludedFromBackupKey
                                    error:&readError]
        && readError == nil && excluded.boolValue;
}

static NSString *LBRNQueueHash(NSString *queueKey)
{
    if (![queueKey isKindOfClass:[NSString class]]
        || [queueKey stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]].length == 0) {
        return nil;
    }
    NSData *data = [queueKey dataUsingEncoding:NSUTF8StringEncoding];
    if (data.length == 0 || data.length > 4096) {
        return nil;
    }
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *value = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
        [value appendFormat:@"%02x", digest[index]];
    }
    return value;
}

static NSDictionary *LBRNNormalizeRecord(NSDictionary *record)
{
    if (![record isKindOfClass:[NSDictionary class]]) {
        return @{};
    }
    id framesValue = record[@"stackFrames"];
    if (![framesValue isKindOfClass:[NSArray class]]) {
        return record;
    }
    NSMutableArray *frames = [NSMutableArray arrayWithCapacity:[framesValue count]];
    for (id value in framesValue) {
        if (![value isKindOfClass:[NSDictionary class]]) {
            return record;
        }
        NSMutableDictionary *frame = [value mutableCopy];
        NSString *filename = frame[@"filename"];
        if ([filename isKindOfClass:[NSString class]]
            && [filename hasPrefix:@"/"]
            && [[filename substringFromIndex:1] rangeOfString:@"/"].location == NSNotFound) {
            frame[@"filename"] = [filename substringFromIndex:1];
        }
        [frames addObject:frame];
    }
    NSMutableDictionary *normalized = [record mutableCopy];
    normalized[@"stackFrames"] = frames;
    return normalized;
}

@interface LBRNFatalStoreModule ()
#ifdef RCT_NEW_ARCH_ENABLED
<NativeLogBrewFatalStoreSpec>
#endif
@property (nonatomic, nullable) LBRNFatalRecordStore *store;
@property (nonatomic, nullable) NSURL *eventStoreParentURL;
@property (nonatomic) NSMutableDictionary<NSString *, LBRNEventRecordStore *> *eventStores;
@end

@implementation LBRNFatalStoreModule

RCT_EXPORT_MODULE(LogBrewFatalStore)

+ (BOOL)requiresMainQueueSetup
{
    return NO;
}

- (instancetype)init
{
    self = [super init];
    if (self != nil) {
        NSURL *baseURL =
            [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                    inDomains:NSUserDomainMask].firstObject;
        if (baseURL != nil && LBRNPreparePrivateRootDirectory(baseURL)) {
            _eventStoreParentURL = baseURL;
            _eventStores = [NSMutableDictionary dictionary];
            NSURL *directoryURL = [baseURL URLByAppendingPathComponent:@"LogBrewFatalJS"
                                                           isDirectory:YES];
            LBRNFatalDirectoryPreparation directoryPreparation = ^BOOL(NSURL *preparedURL) {
              return LBRNPrepareProtectedDirectory(preparedURL);
            };
            _store = [[LBRNFatalRecordStore alloc]
                initWithDirectoryURL:directoryURL
                directoryPreparation:directoryPreparation];
        }
    }
    return self;
}

- (nullable LBRNEventRecordStore *)eventStoreForQueueKey:(NSString *)queueKey
{
    NSString *queueHash = LBRNQueueHash(queueKey);
    if (queueHash == nil || self.eventStoreParentURL == nil) {
        return nil;
    }
    @synchronized(self) {
        LBRNEventRecordStore *existing = self.eventStores[queueHash];
        if (existing != nil) {
            return existing;
        }
        NSURL *directoryURL = [self.eventStoreParentURL
            URLByAppendingPathComponent:[@"LogBrewEventsV1-" stringByAppendingString:queueHash]
                            isDirectory:YES];
        LBRNEventRecordStore *created = [[LBRNEventRecordStore alloc]
            initWithDirectoryURL:directoryURL
            directoryPreparation:^BOOL(NSURL *preparedURL) {
              return LBRNPrepareProtectedDirectory(preparedURL);
            }];
        self.eventStores[queueHash] = created;
        return created;
    }
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(writeFatalRecord:(NSDictionary *)record)
{
    if (self.store == nil) {
        return LBRNStorageError();
    }
    @try {
        return [self.store writeRecord:LBRNNormalizeRecord(record)];
    } @catch (__unused NSException *exception) {
        return LBRNStorageError();
    }
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(readFatalRecord)
{
    if (self.store == nil) {
        return LBRNStorageError();
    }
    @try {
        return [self.store readRecord];
    } @catch (__unused NSException *exception) {
        return LBRNStorageError();
    }
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(acknowledgeFatalRecord:(NSString *)recordId)
{
    if (self.store == nil || ![recordId isKindOfClass:[NSString class]]) {
        return LBRNStorageError();
    }
    @try {
        return [self.store acknowledgeRecordId:recordId];
    } @catch (__unused NSException *exception) {
        return LBRNStorageError();
    }
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(discardFatalRecord)
{
    if (self.store == nil) {
        return LBRNStorageError();
    }
    @try {
        return [self.store discardRecord];
    } @catch (__unused NSException *exception) {
        return LBRNStorageError();
    }
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(loadEventRecords:(NSString *)queueKey)
{
    LBRNEventRecordStore *eventStore = [self eventStoreForQueueKey:queueKey];
    if (eventStore == nil) {
        return LBRNStorageError();
    }
    @try {
        return [eventStore loadRecords];
    } @catch (__unused NSException *exception) {
        return LBRNStorageError();
    }
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(appendEventRecord:(NSString *)queueKey
                                  serializedEvent:(NSString *)serializedEvent
                                       eventBytes:(double)eventBytes)
{
    LBRNEventRecordStore *eventStore = [self eventStoreForQueueKey:queueKey];
    if (eventStore == nil) {
        return LBRNStorageError();
    }
    @try {
        return [eventStore appendSerializedEvent:serializedEvent eventBytes:@(eventBytes)];
    } @catch (__unused NSException *exception) {
        return LBRNStorageError();
    }
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(acknowledgeEventRecords:(NSString *)queueKey
                                                      count:(double)count)
{
    LBRNEventRecordStore *eventStore = [self eventStoreForQueueKey:queueKey];
    if (eventStore == nil) {
        return LBRNStorageError();
    }
    @try {
        return [eventStore acknowledgeRecordCount:@(count)];
    } @catch (__unused NSException *exception) {
        return LBRNStorageError();
    }
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(purgeEventRecords:(NSString *)queueKey)
{
    LBRNEventRecordStore *eventStore = [self eventStoreForQueueKey:queueKey];
    if (eventStore == nil) {
        return LBRNStorageError();
    }
    @try {
        return [eventStore purgeRecords];
    } @catch (__unused NSException *exception) {
        return LBRNStorageError();
    }
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(closeEventStore:(NSString *)queueKey)
{
    NSString *queueHash = LBRNQueueHash(queueKey);
    if (queueHash == nil) {
        return LBRNStorageError();
    }
    LBRNEventRecordStore *eventStore = nil;
    @synchronized(self) {
        eventStore = self.eventStores[queueHash];
    }
    if (eventStore == nil) {
        return @{ @"status" : @"closed" };
    }
    @try {
        return [eventStore closeStore];
    } @catch (__unused NSException *exception) {
        return LBRNStorageError();
    } @finally {
        @synchronized(self) {
            [self.eventStores removeObjectForKey:queueHash];
        }
    }
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeLogBrewFatalStoreSpecJSI>(params);
}
#endif

@end
