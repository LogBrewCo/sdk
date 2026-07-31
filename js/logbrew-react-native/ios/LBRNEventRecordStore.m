#import "LBRNEventRecordStore.h"

#import <dirent.h>
#import <errno.h>
#import <fcntl.h>
#import <limits.h>
#import <math.h>
#import <stdint.h>
#import <stdlib.h>
#import <string.h>
#import <sys/stat.h>
#import <unistd.h>

NSString *const LBRNEventRecordPrefix = @"event-";
NSString *const LBRNEventRecordSuffix = @".record";
NSString *const LBRNEventMarkerPrefix = @"accepted-";
NSString *const LBRNEventMarkerSuffix = @".marker";

static const NSUInteger LBRNEventMaximumBytes = 4 * 1024 * 1024;
static const NSUInteger LBRNEventMaximumQueueBytes = 4 * 1024 * 1024;
static const NSUInteger LBRNEventMaximumQueueRecords = 1000;
static const NSInteger LBRNEventFileSchemaVersion = 1;

@interface LBRNEventRecordStore ()
@property (nonatomic, readonly) NSURL *directoryURL;
@property (nonatomic, readonly, copy)
    LBRNEventDirectoryPreparation directoryPreparation;
@property (nonatomic) BOOL poisoned;
@end

@implementation LBRNEventRecordStore

- (instancetype)initWithDirectoryURL:(NSURL *)directoryURL
{
    return [self initWithDirectoryURL:directoryURL
                 directoryPreparation:^BOOL(__unused NSURL *preparedURL) {
                   return NO;
                 }];
}

- (instancetype)initWithDirectoryURL:(NSURL *)directoryURL
                directoryPreparation:(LBRNEventDirectoryPreparation)directoryPreparation
{
    self = [super init];
    if (self != nil) {
        _directoryURL = directoryURL;
        _directoryPreparation = [directoryPreparation copy];
        _poisoned = NO;
    }
    return self;
}

- (NSDictionary *)loadRecords
{
    @synchronized(self) {
        int directoryFD = [self openPreparedDirectory];
        if (directoryFD < 0) {
            return [self storageError];
        }
        @try {
            NSDictionary *snapshot = [self snapshotFromDirectory:directoryFD];
            return snapshot == nil
                ? [self storageError]
                : @{ @"status" : @"loaded", @"records" : snapshot[@"records"] };
        } @finally {
            close(directoryFD);
        }
    }
}

- (NSDictionary *)appendSerializedEvent:(NSString *)serializedEvent
                              eventBytes:(NSNumber *)eventBytes
{
    @synchronized(self) {
        NSData *eventData = [self validatedEventData:serializedEvent eventBytes:eventBytes];
        if (self.poisoned || eventData == nil) {
            return [self storageError];
        }
        int directoryFD = [self openPreparedDirectory];
        if (directoryFD < 0) {
            return [self storageError];
        }
        @try {
            NSDictionary *snapshot = [self snapshotFromDirectory:directoryFD];
            if (snapshot == nil
                || [snapshot[@"records"] count] >= LBRNEventMaximumQueueRecords
                || [snapshot[@"totalEventBytes"] unsignedLongLongValue] + eventData.length
                    > LBRNEventMaximumQueueBytes) {
                return [self storageError];
            }
            unsigned long long sequence = MAX(
                [snapshot[@"markerSequence"] unsignedLongLongValue],
                [snapshot[@"maximumRecordSequence"] unsignedLongLongValue]);
            if (sequence >= LLONG_MAX) {
                return [self storageError];
            }
            sequence += 1;
            NSDictionary *record = @{
                @"schemaVersion" : @(LBRNEventFileSchemaVersion),
                @"sequence" : @(sequence),
                @"serializedEvent" : serializedEvent,
                @"eventBytes" : eventBytes,
            };
            NSData *data = [self propertyListData:record];
            NSString *filename = [self recordFilename:sequence];
            if (data == nil
                || data.length > LBRNEventMaximumBytes + 4096
                || ![self atomicallyWriteData:data filename:filename directoryFD:directoryFD]) {
                return [self storageError];
            }
            return @{ @"status" : @"appended" };
        } @finally {
            close(directoryFD);
        }
    }
}

- (NSDictionary *)acknowledgeRecordCount:(NSNumber *)count
{
    @synchronized(self) {
        NSUInteger recordCount = 0;
        if (self.poisoned || ![self nonnegativeInteger:count output:&recordCount]) {
            return [self storageError];
        }
        int directoryFD = [self openPreparedDirectory];
        if (directoryFD < 0) {
            return [self storageError];
        }
        @try {
            NSDictionary *snapshot = [self snapshotFromDirectory:directoryFD];
            NSArray *records = snapshot[@"records"];
            if (snapshot == nil || recordCount > records.count) {
                return [self storageError];
            }
            if (recordCount == 0) {
                return @{ @"status" : @"acknowledged" };
            }
            unsigned long long acceptedSequence =
                [records[recordCount - 1][@"sequence"] unsignedLongLongValue];
            if (![self commitMarker:acceptedSequence directoryFD:directoryFD]) {
                return [self storageError];
            }
            [self removeAcceptedRecords:acceptedSequence directoryFD:directoryFD];
            return @{ @"status" : @"acknowledged" };
        } @finally {
            close(directoryFD);
        }
    }
}

- (NSDictionary *)purgeRecords
{
    @synchronized(self) {
        if (self.poisoned) {
            return [self storageError];
        }
        int directoryFD = [self openPreparedDirectory];
        if (directoryFD < 0) {
            return [self storageError];
        }
        @try {
            if (![self removeStaleTemporaryFiles:directoryFD]) {
                return [self storageError];
            }
            NSArray *entries = [self queueEntries:directoryFD];
            if (entries == nil) {
                return [self storageError];
            }
            unsigned long long maximumSequence = 0;
            for (NSDictionary *entry in entries) {
                if (![self safeRegularFilename:entry[@"name"] directoryFD:directoryFD]) {
                    return [self storageError];
                }
                maximumSequence = MAX(
                    maximumSequence, [entry[@"sequence"] unsignedLongLongValue]);
            }
            if (maximumSequence == 0) {
                return @{ @"status" : @"purged" };
            }
            if (maximumSequence >= LLONG_MAX) {
                return [self storageError];
            }
            unsigned long long acceptedSequence = maximumSequence + 1;
            if (![self commitMarker:acceptedSequence directoryFD:directoryFD]) {
                return [self storageError];
            }
            [self removeAcceptedRecords:acceptedSequence directoryFD:directoryFD];
            [self removeMarkersBefore:acceptedSequence directoryFD:directoryFD];
            return @{ @"status" : @"purged" };
        } @finally {
            close(directoryFD);
        }
    }
}

- (NSDictionary *)closeStore
{
    @synchronized(self) {
        return @{ @"status" : self.poisoned ? @"storage_error" : @"closed" };
    }
}

- (NSDictionary *)snapshotFromDirectory:(int)directoryFD
{
    if (self.poisoned || ![self removeStaleTemporaryFiles:directoryFD]) {
        return nil;
    }
    NSArray<NSDictionary *> *entries = [self queueEntries:directoryFD];
    if (entries == nil) {
        return nil;
    }
    NSMutableArray<NSDictionary *> *records = [NSMutableArray array];
    NSMutableArray<NSDictionary *> *markers = [NSMutableArray array];
    unsigned long long markerSequence = 0;
    unsigned long long maximumRecordSequence = 0;
    for (NSDictionary *entry in entries) {
        NSString *name = entry[@"name"];
        if (![self safeRegularFilename:name directoryFD:directoryFD]) {
            return nil;
        }
        unsigned long long sequence = [entry[@"sequence"] unsignedLongLongValue];
        if ([entry[@"kind"] isEqualToString:@"marker"]) {
            markerSequence = MAX(markerSequence, sequence);
            [markers addObject:entry];
        } else {
            maximumRecordSequence = MAX(maximumRecordSequence, sequence);
        }
    }
    if (markerSequence > 0
        && ![self validMarkerFilename:[self markerFilename:markerSequence]
                                sequence:markerSequence
                             directoryFD:directoryFD]) {
        return nil;
    }

    unsigned long long totalEventBytes = 0;
    for (NSDictionary *entry in entries) {
        if (![entry[@"kind"] isEqualToString:@"record"]) {
            continue;
        }
        unsigned long long sequence = [entry[@"sequence"] unsignedLongLongValue];
        if (sequence <= markerSequence) {
            continue;
        }
        NSDictionary *record = [self readRecordFilename:entry[@"name"]
                                              sequence:sequence
                                           directoryFD:directoryFD];
        if (record == nil) {
            return nil;
        }
        totalEventBytes += [record[@"eventBytes"] unsignedLongLongValue];
        if (records.count >= LBRNEventMaximumQueueRecords
            || totalEventBytes > LBRNEventMaximumQueueBytes) {
            return nil;
        }
        [records addObject:record];
    }
    [records sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
      return [left[@"sequence"] compare:right[@"sequence"]];
    }];
    [self removeAcceptedRecords:markerSequence directoryFD:directoryFD];
    [self removeMarkerEntries:markers newestSequence:markerSequence directoryFD:directoryFD];
    return @{
        @"markerSequence" : @(markerSequence),
        @"maximumRecordSequence" : @(maximumRecordSequence),
        @"totalEventBytes" : @(totalEventBytes),
        @"records" : records,
    };
}

- (NSArray<NSDictionary *> *)queueEntries:(int)directoryFD
{
    int duplicateFD = openat(
        directoryFD, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (duplicateFD < 0) {
        return nil;
    }
    DIR *stream = fdopendir(duplicateFD);
    if (stream == NULL) {
        close(duplicateFD);
        return nil;
    }
    NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
    BOOL valid = YES;
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(stream)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
            continue;
        }
        NSString *name = [NSString stringWithUTF8String:entry->d_name];
        NSString *kind = nil;
        unsigned long long sequence = 0;
        if (name == nil
            || ![self parseQueueFilename:name kind:&kind sequence:&sequence]) {
            valid = NO;
            break;
        }
        [entries addObject:@{ @"name" : name, @"kind" : kind, @"sequence" : @(sequence) }];
    }
    if (entry == NULL && errno != 0) {
        valid = NO;
    }
    closedir(stream);
    if (!valid) {
        return nil;
    }
    [entries sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
      NSComparisonResult sequenceOrder = [left[@"sequence"] compare:right[@"sequence"]];
      return sequenceOrder == NSOrderedSame
          ? [left[@"kind"] compare:right[@"kind"]]
          : sequenceOrder;
    }];
    return entries;
}

- (BOOL)parseQueueFilename:(NSString *)name
                      kind:(NSString *_Nullable *_Nonnull)kind
                  sequence:(unsigned long long *)sequence
{
    NSString *prefix = nil;
    NSString *suffix = nil;
    NSString *resolvedKind = nil;
    if ([name hasPrefix:LBRNEventRecordPrefix] && [name hasSuffix:LBRNEventRecordSuffix]) {
        prefix = LBRNEventRecordPrefix;
        suffix = LBRNEventRecordSuffix;
        resolvedKind = @"record";
    } else if ([name hasPrefix:LBRNEventMarkerPrefix]
        && [name hasSuffix:LBRNEventMarkerSuffix]) {
        prefix = LBRNEventMarkerPrefix;
        suffix = LBRNEventMarkerSuffix;
        resolvedKind = @"marker";
    } else {
        return NO;
    }
    NSUInteger digitsLength = name.length - prefix.length - suffix.length;
    if (digitsLength != 20) {
        return NO;
    }
    NSString *digits = [name substringWithRange:NSMakeRange(prefix.length, digitsLength)];
    for (NSUInteger index = 0; index < digits.length; index += 1) {
        unichar value = [digits characterAtIndex:index];
        if (value < '0' || value > '9') {
            return NO;
        }
    }
    errno = 0;
    char *end = NULL;
    unsigned long long value = strtoull(digits.UTF8String, &end, 10);
    if (errno != 0 || end == NULL || *end != '\0' || value == 0 || value > LLONG_MAX) {
        return NO;
    }
    *kind = resolvedKind;
    *sequence = value;
    return YES;
}

- (NSDictionary *)readRecordFilename:(NSString *)filename
                              sequence:(unsigned long long)sequence
                           directoryFD:(int)directoryFD
{
    NSData *data = [self readFilename:filename
                         maximumBytes:LBRNEventMaximumBytes + 4096
                          directoryFD:directoryFD];
    NSDictionary *record = [self propertyListDictionary:data];
    if (record == nil || record.count != 4
        || [record[@"schemaVersion"] integerValue] != LBRNEventFileSchemaVersion
        || [record[@"sequence"] unsignedLongLongValue] != sequence
        || ![record[@"serializedEvent"] isKindOfClass:[NSString class]]) {
        return nil;
    }
    NSData *eventData = [self validatedEventData:record[@"serializedEvent"]
                                      eventBytes:record[@"eventBytes"]];
    if (eventData == nil) {
        return nil;
    }
    return @{
        @"sequence" : @(sequence),
        @"serializedEvent" : record[@"serializedEvent"],
        @"eventBytes" : record[@"eventBytes"],
    };
}

- (BOOL)validMarkerFilename:(NSString *)filename
                    sequence:(unsigned long long)sequence
                 directoryFD:(int)directoryFD
{
    NSDictionary *marker = [self propertyListDictionary:[self readFilename:filename
                                                         maximumBytes:1024
                                                          directoryFD:directoryFD]];
    return marker != nil && marker.count == 2
        && [marker[@"schemaVersion"] integerValue] == LBRNEventFileSchemaVersion
        && [marker[@"sequence"] unsignedLongLongValue] == sequence;
}

- (BOOL)commitMarker:(unsigned long long)sequence directoryFD:(int)directoryFD
{
    NSString *filename = [self markerFilename:sequence];
    struct stat info;
    if (fstatat(directoryFD, filename.UTF8String, &info, AT_SYMLINK_NOFOLLOW) == 0) {
        return S_ISREG(info.st_mode)
            && [self validMarkerFilename:filename sequence:sequence directoryFD:directoryFD];
    }
    if (errno != ENOENT) {
        return NO;
    }
    NSData *data = [self propertyListData:@{
        @"schemaVersion" : @(LBRNEventFileSchemaVersion),
        @"sequence" : @(sequence),
    }];
    return data != nil
        && [self atomicallyWriteData:data filename:filename directoryFD:directoryFD];
}

- (void)removeAcceptedRecords:(unsigned long long)markerSequence
                    directoryFD:(int)directoryFD
{
    if (markerSequence == 0) {
        return;
    }
    NSArray<NSDictionary *> *entries = [self queueEntries:directoryFD];
    BOOL deleted = NO;
    for (NSDictionary *entry in entries ?: @[]) {
        if ([entry[@"kind"] isEqualToString:@"record"]
            && [entry[@"sequence"] unsignedLongLongValue] <= markerSequence
            && [self safeRegularFilename:entry[@"name"] directoryFD:directoryFD]
            && unlinkat(directoryFD, [entry[@"name"] UTF8String], 0) == 0) {
            deleted = YES;
        }
    }
    if (deleted) {
        [self synchronizeDirectory:directoryFD];
    }
}

- (void)removeMarkersBefore:(unsigned long long)markerSequence
                  directoryFD:(int)directoryFD
{
    NSArray<NSDictionary *> *entries = [self queueEntries:directoryFD];
    NSMutableArray<NSDictionary *> *markers = [NSMutableArray array];
    for (NSDictionary *entry in entries ?: @[]) {
        if ([entry[@"kind"] isEqualToString:@"marker"]) {
            [markers addObject:entry];
        }
    }
    [self removeMarkerEntries:markers
                newestSequence:markerSequence
                    directoryFD:directoryFD];
}

- (void)removeMarkerEntries:(NSArray<NSDictionary *> *)markers
               newestSequence:(unsigned long long)newestSequence
                   directoryFD:(int)directoryFD
{
    BOOL deleted = NO;
    for (NSDictionary *entry in markers) {
        if ([entry[@"sequence"] unsignedLongLongValue] < newestSequence
            && [self safeRegularFilename:entry[@"name"] directoryFD:directoryFD]
            && unlinkat(directoryFD, [entry[@"name"] UTF8String], 0) == 0) {
            deleted = YES;
        }
    }
    if (deleted) {
        [self synchronizeDirectory:directoryFD];
    }
}

- (int)openPreparedDirectory
{
    if (self.poisoned || !self.directoryURL.isFileURL) {
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
    BOOL prepared = fstat(directoryFD, &info) == 0
        && S_ISDIR(info.st_mode)
        && fchmod(directoryFD, 0700) == 0;
    @try {
        prepared = prepared && self.directoryPreparation(self.directoryURL);
    } @catch (__unused NSException *exception) {
        prepared = NO;
    }
    if (!prepared || ![self directoryFDMatchesURL:directoryFD]) {
        close(directoryFD);
        return -1;
    }
    return directoryFD;
}

- (BOOL)directoryFDMatchesURL:(int)directoryFD
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

- (BOOL)removeStaleTemporaryFiles:(int)directoryFD
{
    int duplicateFD = openat(
        directoryFD, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (duplicateFD < 0) {
        return NO;
    }
    DIR *stream = fdopendir(duplicateFD);
    if (stream == NULL) {
        close(duplicateFD);
        return NO;
    }
    BOOL succeeded = YES;
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(stream)) != NULL) {
        NSString *name = [NSString stringWithUTF8String:entry->d_name];
        if (name == nil || ![name hasSuffix:@".tmp"]) {
            continue;
        }
        if (![self safeRegularFilename:name directoryFD:directoryFD]
            || unlinkat(directoryFD, name.UTF8String, 0) != 0) {
            succeeded = NO;
            break;
        }
    }
    if (entry == NULL && errno != 0) {
        succeeded = NO;
    }
    closedir(stream);
    return succeeded;
}

- (BOOL)atomicallyWriteData:(NSData *)data
                    filename:(NSString *)filename
                 directoryFD:(int)directoryFD
{
    NSString *temporary = [filename stringByAppendingString:@".tmp"];
    struct stat info;
    if (fstatat(directoryFD, filename.UTF8String, &info, AT_SYMLINK_NOFOLLOW) == 0
        || errno != ENOENT) {
        return NO;
    }
    if (fstatat(directoryFD, temporary.UTF8String, &info, AT_SYMLINK_NOFOLLOW) == 0) {
        if (!S_ISREG(info.st_mode)
            || unlinkat(directoryFD, temporary.UTF8String, 0) != 0) {
            return NO;
        }
    } else if (errno != ENOENT) {
        return NO;
    }

    int fileFD = openat(
        directoryFD,
        temporary.UTF8String,
        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
        0600);
    if (fileFD < 0) {
        return NO;
    }
    BOOL succeeded = fchmod(fileFD, 0600) == 0;
    NSUInteger offset = 0;
    while (succeeded && offset < data.length) {
        ssize_t count = write(
            fileFD, (const uint8_t *)data.bytes + offset, data.length - offset);
        if (count <= 0) {
            succeeded = NO;
        } else {
            offset += (NSUInteger)count;
        }
    }
    if (succeeded && fsync(fileFD) != 0) {
        succeeded = NO;
    }
    if (close(fileFD) != 0) {
        succeeded = NO;
    }
    if (succeeded
        && renameat(
               directoryFD,
               temporary.UTF8String,
               directoryFD,
               filename.UTF8String)
            != 0) {
        succeeded = NO;
    }
    if (succeeded && ![self synchronizeDirectory:directoryFD]) {
        self.poisoned = YES;
        succeeded = NO;
    }
    if (!succeeded) {
        unlinkat(directoryFD, temporary.UTF8String, 0);
    }
    return succeeded;
}

- (NSData *)readFilename:(NSString *)filename
             maximumBytes:(NSUInteger)maximumBytes
              directoryFD:(int)directoryFD
{
    struct stat pathInfo;
    if (fstatat(directoryFD, filename.UTF8String, &pathInfo, AT_SYMLINK_NOFOLLOW) != 0
        || !S_ISREG(pathInfo.st_mode) || S_ISLNK(pathInfo.st_mode)
        || pathInfo.st_size <= 0 || (uint64_t)pathInfo.st_size > maximumBytes) {
        return nil;
    }
    int fileFD = openat(directoryFD, filename.UTF8String, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fileFD < 0) {
        return nil;
    }
    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)pathInfo.st_size];
    BOOL succeeded = YES;
    NSUInteger offset = 0;
    while (offset < data.length) {
        ssize_t count = read(fileFD, (uint8_t *)data.mutableBytes + offset, data.length - offset);
        if (count <= 0) {
            succeeded = NO;
            break;
        }
        offset += (NSUInteger)count;
    }
    struct stat openedInfo;
    if (fstat(fileFD, &openedInfo) != 0 || openedInfo.st_dev != pathInfo.st_dev
        || openedInfo.st_ino != pathInfo.st_ino || !S_ISREG(openedInfo.st_mode)
        || openedInfo.st_size != pathInfo.st_size) {
        succeeded = NO;
    }
    close(fileFD);
    return succeeded ? data : nil;
}

- (BOOL)safeRegularFilename:(NSString *)filename directoryFD:(int)directoryFD
{
    struct stat info;
    return fstatat(directoryFD, filename.UTF8String, &info, AT_SYMLINK_NOFOLLOW) == 0
        && S_ISREG(info.st_mode) && !S_ISLNK(info.st_mode);
}

- (BOOL)synchronizeDirectory:(int)directoryFD
{
    if (fsync(directoryFD) == 0) {
        return YES;
    }
    return errno == EINVAL || errno == ENOTSUP;
}

- (NSData *)validatedEventData:(id)serializedEvent eventBytes:(id)eventBytes
{
    if (![serializedEvent isKindOfClass:[NSString class]]
        || ![eventBytes isKindOfClass:[NSNumber class]]) {
        return nil;
    }
    NSUInteger byteCount = 0;
    if (![self positiveInteger:eventBytes output:&byteCount]
        || byteCount > LBRNEventMaximumBytes) {
        return nil;
    }
    NSData *data = [serializedEvent dataUsingEncoding:NSUTF8StringEncoding];
    return data.length == byteCount ? data : nil;
}

- (BOOL)positiveInteger:(NSNumber *)value output:(NSUInteger *)output
{
    if (strcmp(value.objCType, @encode(BOOL)) == 0) {
        return NO;
    }
    double number = value.doubleValue;
    if (!isfinite(number) || number <= 0 || number > INT_MAX || floor(number) != number) {
        return NO;
    }
    *output = (NSUInteger)number;
    return YES;
}

- (BOOL)nonnegativeInteger:(NSNumber *)value output:(NSUInteger *)output
{
    if (![value isKindOfClass:[NSNumber class]]
        || strcmp(value.objCType, @encode(BOOL)) == 0) {
        return NO;
    }
    double number = value.doubleValue;
    if (!isfinite(number) || number < 0 || number > INT_MAX || floor(number) != number) {
        return NO;
    }
    *output = (NSUInteger)number;
    return YES;
}

- (NSData *)propertyListData:(NSDictionary *)value
{
    NSError *error = nil;
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:value
                                                              format:NSPropertyListBinaryFormat_v1_0
                                                             options:0
                                                               error:&error];
    return error == nil ? data : nil;
}

- (NSDictionary *)propertyListDictionary:(NSData *)data
{
    if (data == nil) {
        return nil;
    }
    NSError *error = nil;
    id value = [NSPropertyListSerialization propertyListWithData:data
                                                         options:NSPropertyListImmutable
                                                          format:nil
                                                           error:&error];
    return error == nil && [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

- (NSString *)recordFilename:(unsigned long long)sequence
{
    return [NSString stringWithFormat:@"%@%020llu%@",
                     LBRNEventRecordPrefix,
                     sequence,
                     LBRNEventRecordSuffix];
}

- (NSString *)markerFilename:(unsigned long long)sequence
{
    return [NSString stringWithFormat:@"%@%020llu%@",
                     LBRNEventMarkerPrefix,
                     sequence,
                     LBRNEventMarkerSuffix];
}

- (NSDictionary *)storageError
{
    return @{ @"status" : @"storage_error" };
}

@end
