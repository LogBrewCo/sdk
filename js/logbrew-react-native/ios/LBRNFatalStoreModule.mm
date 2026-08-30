#import "LBRNFatalStoreModule.h"

#import "LBRNEventRecordStore.h"
#import "LBRNPrivateStorage.h"

#import <CommonCrypto/CommonDigest.h>
#import <Security/SecRandom.h>
#import <TargetConditionals.h>
#import <math.h>

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

@interface LBRNFatalStoreModule ()
#ifdef RCT_NEW_ARCH_ENABLED
<NativeLogBrewFatalStoreSpec>
#endif
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
        }
    }
    return self;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(secureRandomHex:(double)length)
{
    if (!isfinite(length) || length < 1 || length > 64 || floor(length) != length) {
        return @"";
    }
    uint8_t bytes[64];
    NSUInteger byteCount = (NSUInteger)length;
    if (SecRandomCopyBytes(kSecRandomDefault, byteCount, bytes) != errSecSuccess) {
        return @"";
    }
    NSMutableString *output = [NSMutableString stringWithCapacity:byteCount * 2];
    for (NSUInteger index = 0; index < byteCount; index += 1) {
        [output appendFormat:@"%02x", bytes[index]];
    }
    return output;
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

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(installAndroidDiagnostics:(NSDictionary *)configuration)
{
    return @{ @"status" : @"error", @"code" : @"unsupported_platform" };
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(androidDiagnosticsStatus)
{
    return @{ @"status" : @"not_installed", @"pending" : @0 };
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(uninstallAndroidDiagnostics)
{
    return @{ @"status" : @"not_installed", @"pending" : @0 };
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeLogBrewFatalStoreSpecJSI>(params);
}
#endif

@end
