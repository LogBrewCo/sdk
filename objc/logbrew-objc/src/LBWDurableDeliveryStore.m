#import "LBWDurableDeliveryStore.h"

#import <TargetConditionals.h>
#import <limits.h>
#import <sys/file.h>

NSErrorDomain const LBWDurableStoreErrorDomain = @"co.logbrew.sdk.durable-store";

static NSString *const LBWStoreDirectoryName = @"logbrew-delivery-v1";
static NSString *const LBWStorePrefixName = @"frozen-prefix.json";
static NSString *const LBWStoreLockName = @".lock";
static const NSUInteger LBWStoreVersion = 1U;
static const NSUInteger LBWStoreMaxQueuedEvents = 1000U;
static const NSUInteger LBWStoreMaxQueuedBytes = 4U * 1024U * 1024U;
static const NSUInteger LBWStoreMaxRequestEvents = 100U;
static const NSUInteger LBWStoreMaxRequestBytes = 256U * 1024U;
static const NSUInteger LBWStoreMaxRecordBytes = 2U * LBWStoreMaxRequestBytes;

static NSError *LBWStoreError(LBWDurableStoreErrorCode code) {
  return [NSError errorWithDomain:LBWDurableStoreErrorDomain code:code userInfo:nil];
}

static void LBWStoreSetError(NSError *_Nullable *_Nullable error, LBWDurableStoreErrorCode code) {
  if (error != NULL) {
    *error = LBWStoreError(code);
  }
}

static NSDictionary<NSFileAttributeKey, id> *LBWStoreAttributes(NSNumber *permissions) {
  NSMutableDictionary<NSFileAttributeKey, id> *attributes =
      [@{NSFilePosixPermissions : permissions} mutableCopy];
#if TARGET_OS_IPHONE
  attributes[NSFileProtectionKey] = NSFileProtectionCompleteUntilFirstUserAuthentication;
#endif
  return attributes;
}

static NSData *_Nullable LBWStoreJSONData(id object, NSError *_Nullable *_Nullable error) {
  NSError *serializationError = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                 options:NSJSONWritingSortedKeys
                                                   error:&serializationError];
  if (data == nil) {
    LBWStoreSetError(error, LBWDurableStoreErrorIO);
  }
  return data;
}

static NSString *LBWStoreChecksum(NSData *data) {
  const uint8_t *bytes = data.bytes;
  uint64_t hash = UINT64_C(14695981039346656037);
  for (NSUInteger index = 0U; index < data.length; index += 1U) {
    hash ^= bytes[index];
    hash *= UINT64_C(1099511628211);
  }
  return [NSString stringWithFormat:@"%016llx", hash];
}

static NSString *LBWStoreEventName(unsigned long long sequence) {
  return [NSString stringWithFormat:@"event-%020llu.json", sequence];
}

static BOOL LBWStoreParseSequence(NSString *name, unsigned long long *sequence) {
  if (name.length != 31U || ![name hasPrefix:@"event-"] || ![name hasSuffix:@".json"]) {
    return NO;
  }
  NSString *digits = [name substringWithRange:NSMakeRange(6U, 20U)];
  if ([digits rangeOfCharacterFromSet:[[NSCharacterSet decimalDigitCharacterSet] invertedSet]].location != NSNotFound) {
    return NO;
  }
  unsigned long long parsed = strtoull(digits.UTF8String, NULL, 10);
  if (![LBWStoreEventName(parsed) isEqualToString:name]) {
    return NO;
  }
  if (sequence != NULL) {
    *sequence = parsed;
  }
  return YES;
}

static BOOL LBWStoreIsOwnedName(NSString *name) {
  return [name isEqualToString:LBWStorePrefixName] || LBWStoreParseSequence(name, NULL);
}

static BOOL LBWStoreUnsignedInteger(id value, unsigned long long *result) {
  if (![value isKindOfClass:[NSNumber class]]) {
    return NO;
  }
  NSNumber *number = value;
  const char *type = number.objCType;
  if (strcmp(type, @encode(BOOL)) == 0 || strcmp(type, @encode(char)) == 0 ||
      strcmp(type, @encode(float)) == 0 || strcmp(type, @encode(double)) == 0 ||
      strcmp(type, @encode(long double)) == 0) {
    return NO;
  }
  if ((strcmp(type, @encode(short)) == 0 || strcmp(type, @encode(int)) == 0 ||
       strcmp(type, @encode(long)) == 0 || strcmp(type, @encode(long long)) == 0) &&
      number.longLongValue < 0) {
    return NO;
  }
  if (result != NULL) {
    *result = number.unsignedLongLongValue;
  }
  return YES;
}

@interface LBWDurableRecovery ()

@property(nonatomic, copy) NSArray<NSDictionary<NSString *, id> *> *events;
@property(nonatomic, copy) NSArray<NSNumber *> *eventBytes;
@property(nonatomic, copy) NSArray<NSString *> *eventRecordNames;
@property(nonatomic, copy, nullable) NSString *frozenBody;
@property(nonatomic, copy) NSArray<NSString *> *frozenRecordNames;
@property(nonatomic) NSUInteger frozenBytes;

- (instancetype)initWithEvents:(NSArray<NSDictionary<NSString *, id> *> *)events
                     eventBytes:(NSArray<NSNumber *> *)eventBytes
               eventRecordNames:(NSArray<NSString *> *)eventRecordNames
                     frozenBody:(nullable NSString *)frozenBody
              frozenRecordNames:(NSArray<NSString *> *)frozenRecordNames
                    frozenBytes:(NSUInteger)frozenBytes;

@end

@implementation LBWDurableRecovery

- (instancetype)initWithEvents:(NSArray<NSDictionary<NSString *, id> *> *)events
                     eventBytes:(NSArray<NSNumber *> *)eventBytes
               eventRecordNames:(NSArray<NSString *> *)eventRecordNames
                     frozenBody:(NSString *)frozenBody
              frozenRecordNames:(NSArray<NSString *> *)frozenRecordNames
                    frozenBytes:(NSUInteger)frozenBytes {
  self = [super init];
  if (self != nil) {
    _events = [events copy];
    _eventBytes = [eventBytes copy];
    _eventRecordNames = [eventRecordNames copy];
    _frozenBody = [frozenBody copy];
    _frozenRecordNames = [frozenRecordNames copy];
    _frozenBytes = frozenBytes;
  }
  return self;
}

@end

@interface LBWDurableDeliveryStore ()

@property(nonatomic) NSFileManager *fileManager;
@property(nonatomic) NSURL *directoryURL;
@property(nonatomic, copy) NSDictionary<NSString *, NSString *> *sdk;
@property(nonatomic) NSFileHandle *lockHandle;
@property(nonatomic) NSMutableArray<NSDictionary<NSString *, id> *> *events;
@property(nonatomic) NSMutableArray<NSNumber *> *eventBytes;
@property(nonatomic) NSMutableArray<NSString *> *eventRecordNames;
@property(nonatomic, copy, nullable) NSString *frozenBody;
@property(nonatomic) NSMutableArray<NSString *> *frozenRecordNames;
@property(nonatomic) NSUInteger frozenBytes;
@property(nonatomic) unsigned long long nextSequence;
@property(nonatomic) BOOL failed;

@end

@implementation LBWDurableDeliveryStore

- (instancetype)initWithParentURL:(NSURL *)parentURL
                               sdk:(NSDictionary<NSString *, NSString *> *)sdk
                             error:(NSError **)error {
  self = [super init];
  if (self == nil) {
    return nil;
  }
  _fileManager = [[NSFileManager alloc] init];
  _sdk = [sdk copy];
  _directoryURL = [parentURL URLByAppendingPathComponent:LBWStoreDirectoryName isDirectory:YES];
  _events = [NSMutableArray array];
  _eventBytes = [NSMutableArray array];
  _eventRecordNames = [NSMutableArray array];
  _frozenRecordNames = [NSMutableArray array];
  _nextSequence = 1U;

  if (![[self class] validateParentURL:parentURL fileManager:_fileManager error:error] ||
      ![[self class] prepareDirectoryURL:_directoryURL fileManager:_fileManager error:error]) {
    return nil;
  }
  _lockHandle = [[self class] acquireLockInDirectory:_directoryURL fileManager:_fileManager error:error];
  if (_lockHandle == nil) {
    return nil;
  }
  if (![self loadRecoveryWithError:error]) {
    [[self class] releaseLock:_lockHandle];
    _lockHandle = nil;
    return nil;
  }
  return self;
}

- (void)dealloc {
  if (self.lockHandle != nil) {
    [[self class] releaseLock:self.lockHandle];
  }
}

- (LBWDurableRecovery *)recovery {
  return [[LBWDurableRecovery alloc] initWithEvents:self.events
                                         eventBytes:self.eventBytes
                                   eventRecordNames:self.eventRecordNames
                                         frozenBody:self.frozenBody
                                  frozenRecordNames:self.frozenRecordNames
                                        frozenBytes:self.frozenBytes];
}

- (NSString *)appendEvent:(NSDictionary<NSString *, id> *)event
              encodedBytes:(NSUInteger)encodedBytes
                     error:(NSError **)error {
  if (![self requireHealthy:error]) {
    return nil;
  }
  NSUInteger queuedBytes = 0U;
  for (NSNumber *value in self.eventBytes) {
    queuedBytes += value.unsignedIntegerValue;
  }
  if (self.events.count >= LBWStoreMaxQueuedEvents || encodedBytes > LBWStoreMaxQueuedBytes ||
      queuedBytes > LBWStoreMaxQueuedBytes - encodedBytes) {
    LBWStoreSetError(error, LBWDurableStoreErrorCapacity);
    return nil;
  }
  if (self.nextSequence >= ULLONG_MAX) {
    LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
    return nil;
  }
  NSData *eventData = LBWStoreJSONData(event, error);
  if (eventData == nil || eventData.length != encodedBytes) {
    LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
    return nil;
  }
  NSString *name = LBWStoreEventName(self.nextSequence);
  NSDictionary<NSString *, id> *record = @{
    @"version": @(LBWStoreVersion),
    @"sequence": @(self.nextSequence),
    @"sdk": self.sdk,
    @"encoded_bytes": @(encodedBytes),
    @"checksum": LBWStoreChecksum(eventData),
    @"event": event
  };
  NSData *recordData = LBWStoreJSONData(record, error);
  if (recordData == nil) {
    return nil;
  }
  if (recordData.length > LBWStoreMaxRecordBytes) {
    LBWStoreSetError(error, LBWDurableStoreErrorCapacity);
    return nil;
  }
  if (![self writeData:recordData name:name error:error]) {
    self.failed = YES;
    return nil;
  }
  [self.events addObject:[event copy]];
  [self.eventBytes addObject:@(encodedBytes)];
  [self.eventRecordNames addObject:name];
  self.nextSequence += 1U;
  return name;
}

- (NSArray<NSString *> *)appendExistingEvents:(NSArray<NSDictionary<NSString *, id> *> *)events
                                     eventBytes:(NSArray<NSNumber *> *)eventBytes
                                          error:(NSError **)error {
  if (self.events.count != 0U || self.frozenBody != nil || events.count != eventBytes.count) {
    LBWStoreSetError(error, LBWDurableStoreErrorOwned);
    return nil;
  }
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  for (NSUInteger index = 0U; index < events.count; index += 1U) {
    NSString *name = [self appendEvent:events[index]
                          encodedBytes:eventBytes[index].unsignedIntegerValue
                                 error:error];
    if (name == nil) {
      for (NSString *writtenName in names) {
        [self.fileManager removeItemAtURL:[self.directoryURL URLByAppendingPathComponent:writtenName] error:nil];
      }
      [self.events removeAllObjects];
      [self.eventBytes removeAllObjects];
      [self.eventRecordNames removeAllObjects];
      self.nextSequence = 1U;
      return nil;
    }
    [names addObject:name];
  }
  return names;
}

- (BOOL)persistPrefixBody:(NSString *)body
         eventRecordNames:(NSArray<NSString *> *)eventRecordNames
             encodedBytes:(NSUInteger)encodedBytes
                    error:(NSError **)error {
  if (![self requireHealthy:error]) {
    return NO;
  }
  NSData *bodyData = [body dataUsingEncoding:NSUTF8StringEncoding];
  if (bodyData == nil || bodyData.length > LBWStoreMaxRequestBytes || eventRecordNames.count == 0U ||
      eventRecordNames.count > LBWStoreMaxRequestEvents || eventRecordNames.count > self.eventRecordNames.count ||
      ![[self.eventRecordNames subarrayWithRange:NSMakeRange(0U, eventRecordNames.count)]
          isEqualToArray:eventRecordNames]) {
    LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
    return NO;
  }
  if (self.frozenBody != nil) {
    if ([self.frozenBody isEqualToString:body] && [self.frozenRecordNames isEqualToArray:eventRecordNames] &&
        self.frozenBytes == encodedBytes) {
      return YES;
    }
    LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
    return NO;
  }
  NSDictionary<NSString *, id> *record = @{
    @"version": @(LBWStoreVersion),
    @"sdk": self.sdk,
    @"event_record_names": eventRecordNames,
    @"encoded_bytes": @(encodedBytes),
    @"body": body
  };
  NSData *recordData = LBWStoreJSONData(record, error);
  if (recordData == nil || recordData.length > LBWStoreMaxRecordBytes) {
    if (recordData != nil) {
      LBWStoreSetError(error, LBWDurableStoreErrorCapacity);
    }
    return NO;
  }
  if (![self writeData:recordData name:LBWStorePrefixName error:error]) {
    self.failed = YES;
    return NO;
  }
  self.frozenBody = [body copy];
  self.frozenRecordNames = [eventRecordNames mutableCopy];
  self.frozenBytes = encodedBytes;
  return YES;
}

- (BOOL)acknowledgeBody:(NSString *)body
       eventRecordNames:(NSArray<NSString *> *)eventRecordNames
                  error:(NSError **)error {
  if (![self requireHealthy:error]) {
    return NO;
  }
  if (self.frozenBody == nil || ![self.frozenBody isEqualToString:body] ||
      ![self.frozenRecordNames isEqualToArray:eventRecordNames] ||
      eventRecordNames.count > self.eventRecordNames.count ||
      ![[self.eventRecordNames subarrayWithRange:NSMakeRange(0U, eventRecordNames.count)]
          isEqualToArray:eventRecordNames]) {
    LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
    return NO;
  }
  if (![self.fileManager removeItemAtURL:[self.directoryURL URLByAppendingPathComponent:LBWStorePrefixName]
                                   error:error]) {
    self.failed = YES;
    LBWStoreSetError(error, LBWDurableStoreErrorIO);
    return NO;
  }
  for (NSString *name in eventRecordNames) {
    if (![self.fileManager removeItemAtURL:[self.directoryURL URLByAppendingPathComponent:name] error:error]) {
      self.failed = YES;
      LBWStoreSetError(error, LBWDurableStoreErrorIO);
      return NO;
    }
  }
  NSRange acknowledged = NSMakeRange(0U, eventRecordNames.count);
  [self.events removeObjectsInRange:acknowledged];
  [self.eventBytes removeObjectsInRange:acknowledged];
  [self.eventRecordNames removeObjectsInRange:acknowledged];
  self.frozenBody = nil;
  [self.frozenRecordNames removeAllObjects];
  self.frozenBytes = 0U;
  return YES;
}

+ (BOOL)purgeParentURL:(NSURL *)parentURL error:(NSError **)error {
  NSFileManager *fileManager = [[NSFileManager alloc] init];
  if (![self validateParentURL:parentURL fileManager:fileManager error:error]) {
    return NO;
  }
  NSURL *directory = [parentURL URLByAppendingPathComponent:LBWStoreDirectoryName isDirectory:YES];
  if (![fileManager fileExistsAtPath:directory.path]) {
    return YES;
  }
  if (![self validateDirectoryURL:directory fileManager:fileManager error:error]) {
    return NO;
  }
  NSFileHandle *handle = [self acquireLockInDirectory:directory fileManager:fileManager error:error];
  if (handle == nil) {
    return NO;
  }
  BOOL removed = [fileManager removeItemAtURL:directory error:error];
  [self releaseLock:handle];
  if (!removed) {
    LBWStoreSetError(error, LBWDurableStoreErrorIO);
  }
  return removed;
}

- (BOOL)loadRecoveryWithError:(NSError **)error {
  NSArray<NSURL *> *children = [self.fileManager contentsOfDirectoryAtURL:self.directoryURL
                                               includingPropertiesForKeys:@[
                                                 NSURLIsRegularFileKey,
                                                 NSURLIsSymbolicLinkKey,
                                                 NSURLFileSizeKey
                                               ]
                                                                  options:0
                                                                    error:error];
  if (children == nil) {
    LBWStoreSetError(error, LBWDurableStoreErrorIO);
    return NO;
  }
  NSMutableArray<NSDictionary<NSString *, id> *> *recovered = [NSMutableArray array];
  NSDictionary<NSString *, id> *prefix = nil;
  for (NSURL *child in children) {
    NSString *name = child.lastPathComponent;
    if ([name isEqualToString:LBWStoreLockName]) {
      continue;
    }
    NSDictionary<NSURLResourceKey, id> *values = [child resourceValuesForKeys:@[
      NSURLIsRegularFileKey,
      NSURLIsSymbolicLinkKey,
      NSURLFileSizeKey
    ] error:error];
    if (values == nil || [values[NSURLIsSymbolicLinkKey] boolValue] || ![values[NSURLIsRegularFileKey] boolValue] ||
        [values[NSURLFileSizeKey] unsignedIntegerValue] > LBWStoreMaxRecordBytes ||
        ![[self class] hardenFileURL:child fileManager:self.fileManager error:error]) {
      LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
      return NO;
    }
    NSData *data = [NSData dataWithContentsOfURL:child options:NSDataReadingMappedIfSafe error:error];
    id object = data == nil ? nil : [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
    if (![object isKindOfClass:[NSDictionary class]]) {
      LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
      return NO;
    }
    NSDictionary<NSString *, id> *record = object;
    if ([name isEqualToString:LBWStorePrefixName]) {
      if (prefix != nil || ![self validatePrefixRecord:record error:error]) {
        LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
        return NO;
      }
      prefix = record;
      continue;
    }
    unsigned long long sequence = 0U;
    if (!LBWStoreParseSequence(name, &sequence) || sequence == ULLONG_MAX ||
        ![self validateEventRecord:record sequence:sequence error:error]) {
      LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
      return NO;
    }
    [recovered addObject:@{
      @"sequence": @(sequence),
      @"event": record[@"event"],
      @"encoded_bytes": record[@"encoded_bytes"],
      @"name": name
    }];
  }
  [recovered sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    return [left[@"sequence"] compare:right[@"sequence"]];
  }];
  NSUInteger totalBytes = 0U;
  for (NSDictionary<NSString *, id> *item in recovered) {
    NSUInteger value = [item[@"encoded_bytes"] unsignedIntegerValue];
    if (value > LBWStoreMaxQueuedBytes || totalBytes > LBWStoreMaxQueuedBytes - value) {
      LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
      return NO;
    }
    totalBytes += value;
    [self.events addObject:item[@"event"]];
    [self.eventBytes addObject:item[@"encoded_bytes"]];
    [self.eventRecordNames addObject:item[@"name"]];
  }
  if (self.events.count > LBWStoreMaxQueuedEvents) {
    LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
    return NO;
  }
  if (prefix != nil) {
    NSArray<NSString *> *names = prefix[@"event_record_names"];
    NSUInteger prefixBytes = [prefix[@"encoded_bytes"] unsignedIntegerValue];
    if (names.count == 0U || names.count > LBWStoreMaxRequestEvents || names.count > self.eventRecordNames.count ||
        ![[self.eventRecordNames subarrayWithRange:NSMakeRange(0U, names.count)] isEqualToArray:names]) {
      LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
      return NO;
    }
    NSUInteger expectedBytes = 0U;
    for (NSUInteger index = 0U; index < names.count; index += 1U) {
      expectedBytes += self.eventBytes[index].unsignedIntegerValue;
    }
    if (expectedBytes != prefixBytes) {
      LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
      return NO;
    }
    self.frozenBody = prefix[@"body"];
    self.frozenRecordNames = [names mutableCopy];
    self.frozenBytes = prefixBytes;
  }
  if (recovered.count != 0U) {
    self.nextSequence = [recovered.lastObject[@"sequence"] unsignedLongLongValue] + 1U;
  }
  return YES;
}

- (BOOL)validateEventRecord:(NSDictionary<NSString *, id> *)record
                   sequence:(unsigned long long)sequence
                      error:(NSError **)error {
  id recordSDK = record[@"sdk"];
  id event = record[@"event"];
  id checksum = record[@"checksum"];
  unsigned long long version = 0U;
  unsigned long long recordSequence = 0U;
  unsigned long long encodedBytes = 0U;
  if (!LBWStoreUnsignedInteger(record[@"version"], &version) || version != LBWStoreVersion ||
      !LBWStoreUnsignedInteger(record[@"sequence"], &recordSequence) || recordSequence != sequence ||
      !LBWStoreUnsignedInteger(record[@"encoded_bytes"], &encodedBytes) || encodedBytes > NSUIntegerMax ||
      ![recordSDK isKindOfClass:[NSDictionary class]] || ![recordSDK isEqualToDictionary:self.sdk] ||
      ![event isKindOfClass:[NSDictionary class]] || ![checksum isKindOfClass:[NSString class]]) {
    return NO;
  }
  NSData *eventData = LBWStoreJSONData(event, error);
  return eventData != nil && eventData.length == (NSUInteger)encodedBytes &&
      [LBWStoreChecksum(eventData) isEqualToString:checksum];
}

- (BOOL)validatePrefixRecord:(NSDictionary<NSString *, id> *)record error:(NSError **)error {
  id recordSDK = record[@"sdk"];
  id names = record[@"event_record_names"];
  id body = record[@"body"];
  unsigned long long version = 0U;
  unsigned long long encodedBytes = 0U;
  if (!LBWStoreUnsignedInteger(record[@"version"], &version) || version != LBWStoreVersion ||
      !LBWStoreUnsignedInteger(record[@"encoded_bytes"], &encodedBytes) || encodedBytes > NSUIntegerMax ||
      ![recordSDK isKindOfClass:[NSDictionary class]] || ![recordSDK isEqualToDictionary:self.sdk] ||
      ![names isKindOfClass:[NSArray class]] || ![body isKindOfClass:[NSString class]]) {
    return NO;
  }
  for (id name in names) {
    if (![name isKindOfClass:[NSString class]] || !LBWStoreParseSequence(name, NULL)) {
      return NO;
    }
  }
  NSData *bodyData = [body dataUsingEncoding:NSUTF8StringEncoding];
  return bodyData != nil && bodyData.length <= LBWStoreMaxRequestBytes;
}

- (BOOL)requireHealthy:(NSError **)error {
  if (!self.failed) {
    return YES;
  }
  LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
  return NO;
}

- (BOOL)writeData:(NSData *)data name:(NSString *)name error:(NSError **)error {
  if (!LBWStoreIsOwnedName(name)) {
    LBWStoreSetError(error, LBWDurableStoreErrorCorrupt);
    return NO;
  }
  NSURL *destination = [self.directoryURL URLByAppendingPathComponent:name isDirectory:NO];
  if (![data writeToURL:destination options:NSDataWritingAtomic error:error] ||
      ![[self class] hardenFileURL:destination fileManager:self.fileManager error:error]) {
    LBWStoreSetError(error, LBWDurableStoreErrorIO);
    return NO;
  }
  return YES;
}

+ (BOOL)validateParentURL:(NSURL *)parentURL
               fileManager:(NSFileManager *)fileManager
                      error:(NSError **)error {
  if (!parentURL.isFileURL) {
    LBWStoreSetError(error, LBWDurableStoreErrorInvalidLocation);
    return NO;
  }
  NSDictionary<NSURLResourceKey, id> *values = [parentURL resourceValuesForKeys:@[
    NSURLIsDirectoryKey,
    NSURLIsSymbolicLinkKey
  ] error:error];
  NSDictionary<NSFileAttributeKey, id> *attributes =
      [fileManager attributesOfItemAtPath:parentURL.path error:error];
  NSUInteger permissions = [attributes[NSFilePosixPermissions] unsignedIntegerValue];
  if (values == nil || attributes == nil || [values[NSURLIsSymbolicLinkKey] boolValue] ||
      ![values[NSURLIsDirectoryKey] boolValue] || (permissions & 0022U) != 0U) {
    LBWStoreSetError(error, LBWDurableStoreErrorInvalidLocation);
    return NO;
  }
  return YES;
}

+ (BOOL)prepareDirectoryURL:(NSURL *)directory
                 fileManager:(NSFileManager *)fileManager
                        error:(NSError **)error {
  if ([fileManager fileExistsAtPath:directory.path]) {
    if (![self validateDirectoryURL:directory fileManager:fileManager error:error]) {
      return NO;
    }
  } else if (![fileManager createDirectoryAtURL:directory
                    withIntermediateDirectories:NO
                                     attributes:LBWStoreAttributes(@0700)
                                          error:error]) {
    LBWStoreSetError(error, LBWDurableStoreErrorIO);
    return NO;
  }
  if (![fileManager setAttributes:LBWStoreAttributes(@0700) ofItemAtPath:directory.path error:error] ||
      ![directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:error]) {
    LBWStoreSetError(error, LBWDurableStoreErrorIO);
    return NO;
  }
  return YES;
}

+ (BOOL)validateDirectoryURL:(NSURL *)directory
                  fileManager:(NSFileManager *)fileManager
                         error:(NSError **)error {
  NSDictionary<NSURLResourceKey, id> *values = [directory resourceValuesForKeys:@[
    NSURLIsDirectoryKey,
    NSURLIsSymbolicLinkKey
  ] error:error];
  NSDictionary<NSFileAttributeKey, id> *attributes =
      [fileManager attributesOfItemAtPath:directory.path error:error];
  NSUInteger permissions = [attributes[NSFilePosixPermissions] unsignedIntegerValue];
  if (values == nil || attributes == nil || [values[NSURLIsSymbolicLinkKey] boolValue] ||
      ![values[NSURLIsDirectoryKey] boolValue] || (permissions & 0077U) != 0U) {
    LBWStoreSetError(error, LBWDurableStoreErrorInvalidLocation);
    return NO;
  }
  return YES;
}

+ (BOOL)hardenFileURL:(NSURL *)fileURL
            fileManager:(NSFileManager *)fileManager
                   error:(NSError **)error {
  if (![fileManager setAttributes:LBWStoreAttributes(@0600) ofItemAtPath:fileURL.path error:error]) {
    LBWStoreSetError(error, LBWDurableStoreErrorIO);
    return NO;
  }
  return YES;
}

+ (NSFileHandle *)acquireLockInDirectory:(NSURL *)directory
                              fileManager:(NSFileManager *)fileManager
                                     error:(NSError **)error {
  NSURL *lockURL = [directory URLByAppendingPathComponent:LBWStoreLockName isDirectory:NO];
  if (![fileManager fileExistsAtPath:lockURL.path] &&
      ![fileManager createFileAtPath:lockURL.path contents:[NSData data] attributes:LBWStoreAttributes(@0600)]) {
    LBWStoreSetError(error, LBWDurableStoreErrorIO);
    return nil;
  }
  NSDictionary<NSURLResourceKey, id> *values = [lockURL resourceValuesForKeys:@[
    NSURLIsRegularFileKey,
    NSURLIsSymbolicLinkKey
  ] error:error];
  if (values == nil || [values[NSURLIsSymbolicLinkKey] boolValue] || ![values[NSURLIsRegularFileKey] boolValue] ||
      ![self hardenFileURL:lockURL fileManager:fileManager error:error]) {
    LBWStoreSetError(error, LBWDurableStoreErrorInvalidLocation);
    return nil;
  }
  NSFileHandle *handle = [NSFileHandle fileHandleForUpdatingURL:lockURL error:error];
  if (handle == nil) {
    LBWStoreSetError(error, LBWDurableStoreErrorIO);
    return nil;
  }
  if (flock(handle.fileDescriptor, LOCK_EX | LOCK_NB) != 0) {
    [handle closeAndReturnError:nil];
    LBWStoreSetError(error, LBWDurableStoreErrorOwned);
    return nil;
  }
  return handle;
}

+ (void)releaseLock:(NSFileHandle *)handle {
  flock(handle.fileDescriptor, LOCK_UN);
  [handle closeAndReturnError:nil];
}

@end
