#import "LBRNFatalRecordStore.h"

#import <errno.h>
#import <fcntl.h>
#import <math.h>
#import <stdint.h>
#import <sys/stat.h>
#import <unistd.h>

NSString *const LBRNFatalRecordFileName = @"fatal-js-v1.record";
NSString *const LBRNFatalRecordTemporaryFileName = @"fatal-js-v1.tmp";

static const NSUInteger LBRNMaximumRecordBytes = 16 * 1024;
static const NSUInteger LBRNMaximumFrames = 24;
static const NSUInteger LBRNMaximumFilenameBytes = 512;
static const NSUInteger LBRNMaximumIdentifierBytes = 96;
static const int32_t LBRNMaximumCounter = INT32_MAX;

@interface LBRNFatalRecordStore ()
@property (nonatomic, readonly) NSURL *directoryURL;
@property (nonatomic, readonly, copy)
    LBRNFatalDirectoryPreparation directoryPreparation;
@end

@implementation LBRNFatalRecordStore

- (instancetype)initWithDirectoryURL:(NSURL *)directoryURL
{
    return [self initWithDirectoryURL:directoryURL
                 directoryPreparation:^BOOL(__unused NSURL *preparedURL) {
                   return NO;
                 }];
}

- (instancetype)initWithDirectoryURL:(NSURL *)directoryURL
                directoryPreparation:(LBRNFatalDirectoryPreparation)directoryPreparation
{
    self = [super init];
    if (self != nil) {
        _directoryURL = directoryURL;
        _directoryPreparation = [directoryPreparation copy];
    }
    return self;
}

- (NSDictionary *)writeRecord:(NSDictionary *)record
{
    @synchronized(self) {
        NSDictionary *validated = [self validatedRecord:record requireZeroCounters:YES];
        if (validated == nil) {
            return @{ @"status" : @"invalid_record" };
        }

        int directoryFD = [self openPrivateDirectory];
        if (directoryFD < 0) {
            return @{ @"status" : @"storage_error" };
        }
        @try {
            BOOL directoryPrepared = NO;
            @try {
                directoryPrepared = self.directoryPreparation(self.directoryURL);
            } @catch (__unused NSException *exception) {
                directoryPrepared = NO;
            }
            if (!directoryPrepared || ![self directoryFDMatchesDirectoryURL:directoryFD]) {
                return @{ @"status" : @"storage_error" };
            }

            NSDictionary *existing = [self readRecordFromDirectory:directoryFD];
            NSString *status = existing[@"status"];
            if ([status isEqualToString:@"storage_error"]) {
                return existing;
            }
            if ([status isEqualToString:@"pending"]) {
                NSMutableDictionary *preserved = [existing[@"record"] mutableCopy];
                int32_t dropped = [preserved[@"droppedRecords"] intValue];
                if (dropped < LBRNMaximumCounter) {
                    dropped += 1;
                }
                preserved[@"droppedRecords"] = @(dropped);
                if (![self atomicallyWriteRecord:preserved directoryFD:directoryFD]) {
                    return @{ @"status" : @"storage_error" };
                }
                return @{
                    @"status" : @"dropped_pending",
                    @"recordId" : preserved[@"id"],
                    @"droppedRecords" : @(dropped),
                };
            }

            NSMutableDictionary *stored = [validated mutableCopy];
            BOOL recoveredCorruption = [status isEqualToString:@"corrupt_discarded"];
            if (recoveredCorruption) {
                stored[@"corruptRecords"] = @1;
            }
            if (![self atomicallyWriteRecord:stored directoryFD:directoryFD]) {
                return @{ @"status" : @"storage_error" };
            }
            return @{
                @"status" : recoveredCorruption ? @"stored_after_corruption" : @"stored",
                @"recordId" : stored[@"id"],
                @"corruptRecords" : stored[@"corruptRecords"],
            };
        } @finally {
            close(directoryFD);
        }
    }
}

- (NSDictionary *)readRecord
{
    @synchronized(self) {
        int directoryFD = [self openPrivateDirectory];
        if (directoryFD < 0) {
            return @{ @"status" : @"storage_error" };
        }
        @try {
            return [self readRecordFromDirectory:directoryFD];
        } @finally {
            close(directoryFD);
        }
    }
}

- (NSDictionary *)acknowledgeRecordId:(NSString *)recordId
{
    @synchronized(self) {
        if (![self validIdentifier:recordId]) {
            return @{ @"status" : @"id_mismatch" };
        }
        int directoryFD = [self openPrivateDirectory];
        if (directoryFD < 0) {
            return @{ @"status" : @"storage_error" };
        }
        @try {
            NSDictionary *existing = [self readRecordFromDirectory:directoryFD];
            if (![existing[@"status"] isEqualToString:@"pending"]) {
                return existing;
            }
            NSDictionary *record = existing[@"record"];
            if (![record[@"id"] isEqualToString:recordId]) {
                return @{
                    @"status" : @"id_mismatch",
                    @"recordId" : record[@"id"],
                };
            }
            if (unlinkat(directoryFD, LBRNFatalRecordFileName.UTF8String, 0) != 0
                || fsync(directoryFD) != 0) {
                return @{ @"status" : @"storage_error" };
            }
            return @{
                @"status" : @"acknowledged",
                @"recordId" : recordId,
            };
        } @finally {
            close(directoryFD);
        }
    }
}

- (NSDictionary *)discardRecord
{
    @synchronized(self) {
        int directoryFD = [self openPrivateDirectory];
        if (directoryFD < 0) {
            return @{ @"status" : @"storage_error" };
        }
        @try {
            NSDictionary *existing = [self readRecordFromDirectory:directoryFD];
            if (![existing[@"status"] isEqualToString:@"pending"]) {
                return existing;
            }
            NSDictionary *record = existing[@"record"];
            if (unlinkat(directoryFD, LBRNFatalRecordFileName.UTF8String, 0) != 0
                || fsync(directoryFD) != 0) {
                return @{ @"status" : @"storage_error" };
            }
            return @{
                @"status" : @"discarded",
                @"recordId" : record[@"id"],
            };
        } @finally {
            close(directoryFD);
        }
    }
}

- (int)openPrivateDirectory
{
    if (!self.directoryURL.isFileURL) {
        return -1;
    }
    const char *path = self.directoryURL.fileSystemRepresentation;
    struct stat info;
    if (lstat(path, &info) != 0) {
        if (errno != ENOENT || mkdir(path, 0700) != 0) {
            return -1;
        }
    } else if (!S_ISDIR(info.st_mode) || S_ISLNK(info.st_mode)) {
        return -1;
    }

    int directoryFD = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (directoryFD < 0) {
        return -1;
    }
    if (fstat(directoryFD, &info) != 0 || !S_ISDIR(info.st_mode)
        || fchmod(directoryFD, 0700) != 0) {
        close(directoryFD);
        return -1;
    }
    return directoryFD;
}

- (BOOL)directoryFDMatchesDirectoryURL:(int)directoryFD
{
    struct stat openedInfo;
    struct stat pathInfo;
    if (fstat(directoryFD, &openedInfo) != 0
        || lstat(self.directoryURL.fileSystemRepresentation, &pathInfo) != 0) {
        return NO;
    }
    return S_ISDIR(openedInfo.st_mode) && S_ISDIR(pathInfo.st_mode)
        && !S_ISLNK(pathInfo.st_mode) && openedInfo.st_dev == pathInfo.st_dev
        && openedInfo.st_ino == pathInfo.st_ino;
}

- (NSDictionary *)readRecordFromDirectory:(int)directoryFD
{
    if (![self removeStaleTemporaryFile:directoryFD]) {
        return @{ @"status" : @"storage_error" };
    }

    struct stat pathInfo;
    if (fstatat(
            directoryFD,
            LBRNFatalRecordFileName.UTF8String,
            &pathInfo,
            AT_SYMLINK_NOFOLLOW)
        != 0) {
        return errno == ENOENT ? @{ @"status" : @"empty" }
                              : @{ @"status" : @"storage_error" };
    }
    if (!S_ISREG(pathInfo.st_mode) || S_ISLNK(pathInfo.st_mode)) {
        return @{ @"status" : @"storage_error" };
    }
    if (pathInfo.st_size < 0 || (uint64_t)pathInfo.st_size > LBRNMaximumRecordBytes) {
        return [self discardCorruptRecord:directoryFD];
    }

    int fileFD = openat(
        directoryFD,
        LBRNFatalRecordFileName.UTF8String,
        O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fileFD < 0) {
        return @{ @"status" : @"storage_error" };
    }
    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)pathInfo.st_size];
    BOOL readSucceeded = YES;
    NSUInteger offset = 0;
    while (offset < data.length) {
        ssize_t count =
            read(fileFD, (uint8_t *)data.mutableBytes + offset, data.length - offset);
        if (count <= 0) {
            readSucceeded = NO;
            break;
        }
        offset += (NSUInteger)count;
    }
    struct stat openedInfo;
    if (fstat(fileFD, &openedInfo) != 0 || openedInfo.st_dev != pathInfo.st_dev
        || openedInfo.st_ino != pathInfo.st_ino || !S_ISREG(openedInfo.st_mode)) {
        readSucceeded = NO;
    }
    close(fileFD);
    if (!readSucceeded) {
        return @{ @"status" : @"storage_error" };
    }

    NSError *error = nil;
    id object = [NSPropertyListSerialization propertyListWithData:data
                                                          options:NSPropertyListImmutable
                                                           format:nil
                                                            error:&error];
    NSDictionary *record =
        [object isKindOfClass:[NSDictionary class]]
        ? [self validatedRecord:(NSDictionary *)object requireZeroCounters:NO]
        : nil;
    if (record == nil) {
        return [self discardCorruptRecord:directoryFD];
    }
    return @{
        @"status" : @"pending",
        @"record" : record,
    };
}

- (NSDictionary *)discardCorruptRecord:(int)directoryFD
{
    if (unlinkat(directoryFD, LBRNFatalRecordFileName.UTF8String, 0) != 0
        || fsync(directoryFD) != 0) {
        return @{ @"status" : @"storage_error" };
    }
    return @{
        @"status" : @"corrupt_discarded",
        @"corruptRecords" : @1,
    };
}

- (BOOL)removeStaleTemporaryFile:(int)directoryFD
{
    struct stat info;
    if (fstatat(
            directoryFD,
            LBRNFatalRecordTemporaryFileName.UTF8String,
            &info,
            AT_SYMLINK_NOFOLLOW)
        != 0) {
        return errno == ENOENT;
    }
    if (!S_ISREG(info.st_mode) || S_ISLNK(info.st_mode)) {
        return NO;
    }
    return unlinkat(directoryFD, LBRNFatalRecordTemporaryFileName.UTF8String, 0) == 0;
}

- (BOOL)atomicallyWriteRecord:(NSDictionary *)record directoryFD:(int)directoryFD
{
    NSError *serializationError = nil;
    NSData *data =
        [NSPropertyListSerialization dataWithPropertyList:record
                                                   format:NSPropertyListBinaryFormat_v1_0
                                                  options:0
                                                    error:&serializationError];
    if (data == nil || data.length == 0 || data.length > LBRNMaximumRecordBytes) {
        return NO;
    }
    if (![self removeStaleTemporaryFile:directoryFD]) {
        return NO;
    }

    int fileFD = openat(
        directoryFD,
        LBRNFatalRecordTemporaryFileName.UTF8String,
        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
        0600);
    if (fileFD < 0) {
        return NO;
    }
    BOOL succeeded = fchmod(fileFD, 0600) == 0;
    NSUInteger offset = 0;
    while (succeeded && offset < data.length) {
        ssize_t count =
            write(fileFD, (const uint8_t *)data.bytes + offset, data.length - offset);
        if (count <= 0) {
            succeeded = NO;
        } else {
            offset += (NSUInteger)count;
        }
    }
    if (succeeded) {
        succeeded = fsync(fileFD) == 0;
    }
    if (close(fileFD) != 0) {
        succeeded = NO;
    }
    if (succeeded) {
        succeeded = renameat(
                        directoryFD,
                        LBRNFatalRecordTemporaryFileName.UTF8String,
                        directoryFD,
                        LBRNFatalRecordFileName.UTF8String)
            == 0;
    }
    if (succeeded) {
        succeeded = fsync(directoryFD) == 0;
    }
    if (!succeeded) {
        unlinkat(directoryFD, LBRNFatalRecordTemporaryFileName.UTF8String, 0);
    }
    return succeeded;
}

- (nullable NSDictionary *)validatedRecord:(NSDictionary *)record
                        requireZeroCounters:(BOOL)requireZeroCounters
{
    NSSet *expectedKeys = [NSSet setWithArray:@[
        @"schemaVersion",
        @"id",
        @"timestamp",
        @"errorName",
        @"stackFrames",
        @"droppedRecords",
        @"corruptRecords",
    ]];
    if (![expectedKeys isEqualToSet:[NSSet setWithArray:record.allKeys]]
        || ![record[@"schemaVersion"] isEqual:@1]
        || ![self validIdentifier:record[@"id"]]
        || ![self validTimestamp:record[@"timestamp"]]
        || ![self validErrorName:record[@"errorName"]]
        || ![record[@"stackFrames"] isKindOfClass:[NSArray class]]) {
        return nil;
    }

    NSArray *frames = record[@"stackFrames"];
    if (frames.count > LBRNMaximumFrames) {
        return nil;
    }
    NSMutableArray *validatedFrames = [NSMutableArray arrayWithCapacity:frames.count];
    for (id candidate in frames) {
        if (![candidate isKindOfClass:[NSDictionary class]]) {
            return nil;
        }
        NSDictionary *frame = candidate;
        NSSet *frameKeys =
            [NSSet setWithArray:@[ @"filename", @"line", @"column" ]];
        if (![frameKeys isEqualToSet:[NSSet setWithArray:frame.allKeys]]
            || ![self validFilename:frame[@"filename"]]
            || ![self validPositiveInteger:frame[@"line"]]
            || ![self validPositiveInteger:frame[@"column"]]) {
            return nil;
        }
        [validatedFrames addObject:@{
            @"filename" : frame[@"filename"],
            @"line" : frame[@"line"],
            @"column" : frame[@"column"],
        }];
    }

    NSNumber *dropped = record[@"droppedRecords"];
    NSNumber *corrupt = record[@"corruptRecords"];
    if (![self validCounter:dropped] || ![self validCounter:corrupt]
        || (requireZeroCounters && (dropped.intValue != 0 || corrupt.intValue != 0))) {
        return nil;
    }
    return @{
        @"schemaVersion" : @1,
        @"id" : record[@"id"],
        @"timestamp" : record[@"timestamp"],
        @"errorName" : record[@"errorName"],
        @"stackFrames" : validatedFrames,
        @"droppedRecords" : @(dropped.intValue),
        @"corruptRecords" : @(corrupt.intValue),
    };
}

- (BOOL)validIdentifier:(id)value
{
    if (![value isKindOfClass:[NSString class]]
        || [(NSString *)value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > LBRNMaximumIdentifierBytes) {
        return NO;
    }
    NSRegularExpression *pattern =
        [NSRegularExpression regularExpressionWithPattern:@"^evt_rn_fatal_[a-z0-9]+(?:_[a-z0-9]+)*$"
                                                   options:0
                                                     error:nil];
    NSString *identifier = value;
    return [pattern firstMatchInString:identifier
                               options:0
                                 range:NSMakeRange(0, identifier.length)]
        != nil;
}

- (BOOL)validTimestamp:(id)value
{
    if (![value isKindOfClass:[NSString class]]) {
        return NO;
    }
    NSString *timestamp = value;
    if (timestamp.length < 20 || timestamp.length > 35) {
        return NO;
    }
    NSRegularExpression *pattern =
        [NSRegularExpression regularExpressionWithPattern:
                                 @"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$"
                                                   options:0
                                                     error:nil];
    return [pattern firstMatchInString:timestamp
                               options:0
                                 range:NSMakeRange(0, timestamp.length)]
        != nil;
}

- (BOOL)validErrorName:(id)value
{
    static NSSet *allowedNames;
    static dispatch_once_t onceGuard;
    dispatch_once(&onceGuard, ^{
      allowedNames = [NSSet setWithArray:@[
          @"Error",
          @"EvalError",
          @"RangeError",
          @"ReferenceError",
          @"SyntaxError",
          @"TypeError",
          @"URIError",
      ]];
    });
    return [value isKindOfClass:[NSString class]] && [allowedNames containsObject:value];
}

- (BOOL)validFilename:(id)value
{
    if (![value isKindOfClass:[NSString class]]) {
        return NO;
    }
    NSString *filename = value;
    if (filename.length == 0
        || [filename lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > LBRNMaximumFilenameBytes
        || [filename hasPrefix:@"/"] || [filename containsString:@"\\"]
        || [filename containsString:@"://"] || [filename containsString:@"?"]
        || [filename containsString:@"#"]) {
        return NO;
    }
    for (NSString *component in [filename componentsSeparatedByString:@"/"]) {
        if ([component isEqualToString:@".."]) {
            return NO;
        }
    }
    NSCharacterSet *control = [NSCharacterSet controlCharacterSet];
    return [filename rangeOfCharacterFromSet:control].location == NSNotFound;
}

- (BOOL)validPositiveInteger:(id)value
{
    if (![value isKindOfClass:[NSNumber class]]) {
        return NO;
    }
    double number = [value doubleValue];
    return isfinite(number) && number >= 1 && number <= INT32_MAX && floor(number) == number;
}

- (BOOL)validCounter:(id)value
{
    if (![value isKindOfClass:[NSNumber class]]) {
        return NO;
    }
    double number = [value doubleValue];
    return isfinite(number) && number >= 0 && number <= LBRNMaximumCounter && floor(number) == number;
}

@end
