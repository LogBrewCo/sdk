#import "LBRNFatalStoreModule.h"

#import "LBRNFatalRecordStore.h"

#ifdef RCT_NEW_ARCH_ENABLED
#import <LogBrewReactNativeSpec/LogBrewReactNativeSpec.h>
#endif

static NSDictionary *LBRNStorageError(void)
{
    return @{ @"status" : @"storage_error" };
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
        if (baseURL != nil) {
            NSURL *directoryURL = [baseURL URLByAppendingPathComponent:@"LogBrewFatalJS"
                                                           isDirectory:YES];
            LBRNFatalDirectoryPreparation directoryPreparation = ^BOOL(NSURL *preparedURL) {
              NSError *writeError = nil;
              if (![preparedURL setResourceValue:@YES
                                          forKey:NSURLIsExcludedFromBackupKey
                                           error:&writeError]
                  || writeError != nil) {
                  return NO;
              }
              NSNumber *excluded = nil;
              NSError *readError = nil;
              return [preparedURL getResourceValue:&excluded
                                            forKey:NSURLIsExcludedFromBackupKey
                                             error:&readError]
                  && readError == nil && excluded.boolValue;
            };
            _store = [[LBRNFatalRecordStore alloc]
                initWithDirectoryURL:directoryURL
                directoryPreparation:directoryPreparation];
        }
    }
    return self;
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

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeLogBrewFatalStoreSpecJSI>(params);
}
#endif

@end
