#import "LBWTelemetryContext.h"

#import <TargetConditionals.h>

static NSString *const LBWTelemetryScopeStackKey = @"co.logbrew.sdk.telemetry-scopes";

static NSError *LBWContextError(NSString *message) {
  return [NSError errorWithDomain:LBWErrorDomain
                             code:LBWErrorKindValidation
                         userInfo:@{
                           LBWErrorStableCodeKey: @"validation_error",
                           LBWErrorRetryableKey: @NO,
                           NSLocalizedDescriptionKey: message
                         }];
}

static BOOL LBWContextFail(NSError *_Nullable *_Nullable error, NSString *message) {
  if (error != NULL) {
    *error = LBWContextError(message);
  }
  return NO;
}

static BOOL LBWContextIsBoolean(id value) {
  return [value isKindOfClass:[NSNumber class]] &&
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static NSString *_Nullable LBWContextString(
    id value,
    NSString *label,
    NSUInteger maximum,
    NSError *_Nullable *_Nullable error) {
  if (![value isKindOfClass:[NSString class]]) {
    LBWContextFail(error, [NSString stringWithFormat:@"%@ must be a string", label]);
    return nil;
  }
  NSString *normalized = [(NSString *)value stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if ([normalized length] == 0U || [normalized length] > maximum ||
      [normalized rangeOfCharacterFromSet:[NSCharacterSet controlCharacterSet]].location != NSNotFound) {
    LBWContextFail(error, [NSString stringWithFormat:@"%@ is invalid", label]);
    return nil;
  }
  return normalized;
}

static BOOL LBWContextMachineKey(NSString *value, NSUInteger maximum, NSString *separators) {
  if ([value length] == 0U || [value length] > maximum) {
    return NO;
  }
  unichar first = [value characterAtIndex:0U];
  BOOL firstIsLetter = (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z');
  if (!firstIsLetter) {
    return NO;
  }
  for (NSUInteger index = 1U; index < [value length]; index++) {
    unichar character = [value characterAtIndex:index];
    BOOL isLetter = (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z');
    BOOL isNumber = character >= '0' && character <= '9';
    if (!isLetter && !isNumber && [separators rangeOfString:[NSString stringWithCharacters:&character length:1U]].location == NSNotFound) {
      return NO;
    }
  }
  return YES;
}

static BOOL LBWContextAllowedKeys(
    NSDictionary *value,
    NSArray<NSString *> *allowed,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSSet<NSString *> *allowedKeys = [NSSet setWithArray:allowed];
  for (id key in value) {
    if (![key isKindOfClass:[NSString class]] || ![allowedKeys containsObject:key]) {
      return LBWContextFail(error, [NSString stringWithFormat:@"%@ contains an unsupported field", label]);
    }
  }
  return YES;
}

static NSDictionary *_Nullable LBWContextDictionary(
    id value,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  if (![value isKindOfClass:[NSDictionary class]]) {
    LBWContextFail(error, [NSString stringWithFormat:@"%@ must be a dictionary", label]);
    return nil;
  }
  return value;
}

static NSString *_Nullable LBWOptionalContextString(
    NSDictionary *value,
    NSString *key,
    NSString *label,
    NSUInteger maximum,
    NSError *_Nullable *_Nullable error) {
  id candidate = value[key];
  if (candidate == nil) {
    return nil;
  }
  return LBWContextString(candidate, label, maximum, error);
}

static NSDictionary *_Nullable LBWValidateNamedVersion(
    id rawValue,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *value = LBWContextDictionary(rawValue, label, error);
  if (value == nil || !LBWContextAllowedKeys(value, @[@"name", @"version"], label, error)) {
    return nil;
  }
  NSString *name = LBWContextString(value[@"name"], [label stringByAppendingString:@" name"], 256U, error);
  if (name == nil) {
    return nil;
  }
  NSString *version = LBWOptionalContextString(value, @"version", [label stringByAppendingString:@" version"], 256U, error);
  if (version == nil && value[@"version"] != nil) {
    return nil;
  }
  NSMutableDictionary *clean = [@{@"name": name} mutableCopy];
  if (version != nil) {
    clean[@"version"] = version;
  }
  return [clean copy];
}

static NSDictionary *_Nullable LBWValidateOptionalStringDictionary(
    id rawValue,
    NSArray<NSString *> *keys,
    NSString *requiredKey,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *value = LBWContextDictionary(rawValue, label, error);
  if (value == nil || !LBWContextAllowedKeys(value, keys, label, error)) {
    return nil;
  }
  NSMutableDictionary *clean = [NSMutableDictionary dictionary];
  for (NSString *key in keys) {
    NSString *item = LBWOptionalContextString(
        value, key, [NSString stringWithFormat:@"%@ %@", label, key], 256U, error);
    if (item == nil && value[key] != nil) {
      return nil;
    }
    if (item != nil) {
      clean[key] = item;
    }
  }
  if ([clean count] == 0U || (requiredKey != nil && clean[requiredKey] == nil)) {
    LBWContextFail(error, [NSString stringWithFormat:@"%@ must not be empty", label]);
    return nil;
  }
  return [clean copy];
}

static NSString *_Nullable LBWContextHexID(
    id value,
    NSUInteger length,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSString *string = LBWContextString(value, label, length, error);
  if (string == nil || [string length] != length) {
    if (string != nil) {
      LBWContextFail(error, [NSString stringWithFormat:@"%@ must be a non-zero %lu-character hex value", label, (unsigned long)length]);
    }
    return nil;
  }
  NSString *normalized = [string lowercaseString];
  BOOL nonZero = NO;
  for (NSUInteger index = 0U; index < [normalized length]; index++) {
    unichar character = [normalized characterAtIndex:index];
    BOOL isHex = (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
    if (!isHex) {
      LBWContextFail(error, [NSString stringWithFormat:@"%@ must be a non-zero %lu-character hex value", label, (unsigned long)length]);
      return nil;
    }
    nonZero = nonZero || character != '0';
  }
  if (!nonZero) {
    LBWContextFail(error, [NSString stringWithFormat:@"%@ must be a non-zero %lu-character hex value", label, (unsigned long)length]);
    return nil;
  }
  return normalized;
}

static NSDictionary *_Nullable LBWValidateTrace(
    id rawValue,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *value = LBWContextDictionary(rawValue, label, error);
  if (value == nil || !LBWContextAllowedKeys(
      value, @[@"traceId", @"spanId", @"parentSpanId", @"sampled"], label, error)) {
    return nil;
  }
  NSString *traceID = LBWContextHexID(value[@"traceId"], 32U, [label stringByAppendingString:@" traceId"], error);
  if (traceID == nil) {
    return nil;
  }
  NSMutableDictionary *clean = [@{@"traceId": traceID} mutableCopy];
  for (NSString *key in @[@"spanId", @"parentSpanId"]) {
    if (value[key] == nil) {
      continue;
    }
    NSString *spanID = LBWContextHexID(value[key], 16U, [NSString stringWithFormat:@"%@ %@", label, key], error);
    if (spanID == nil) {
      return nil;
    }
    clean[key] = spanID;
  }
  if (value[@"sampled"] != nil) {
    if (!LBWContextIsBoolean(value[@"sampled"])) {
      LBWContextFail(error, [label stringByAppendingString:@" sampled must be a boolean"]);
      return nil;
    }
    clean[@"sampled"] = value[@"sampled"];
  }
  return [clean copy];
}

static NSDictionary *_Nullable LBWValidateSession(
    id rawValue,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *value = LBWContextDictionary(rawValue, label, error);
  if (value == nil || !LBWContextAllowedKeys(value, @[@"id", @"previousId"], label, error)) {
    return nil;
  }
  NSString *sessionID = LBWContextString(value[@"id"], [label stringByAppendingString:@" id"], 200U, error);
  if (sessionID == nil) {
    return nil;
  }
  NSString *previousID = LBWOptionalContextString(
      value, @"previousId", [label stringByAppendingString:@" previousId"], 200U, error);
  if (previousID == nil && value[@"previousId"] != nil) {
    return nil;
  }
  if ([sessionID isEqualToString:previousID]) {
    LBWContextFail(error, [label stringByAppendingString:@" previousId must differ from id"]);
    return nil;
  }
  NSMutableDictionary *clean = [@{@"id": sessionID} mutableCopy];
  if (previousID != nil) {
    clean[@"previousId"] = previousID;
  }
  return [clean copy];
}

static NSDictionary *_Nullable LBWValidateSubject(
    id rawValue,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *value = LBWContextDictionary(rawValue, label, error);
  if (value == nil || !LBWContextAllowedKeys(value, @[@"id", @"kind"], label, error)) {
    return nil;
  }
  NSString *subjectID = LBWContextString(value[@"id"], [label stringByAppendingString:@" id"], 200U, error);
  NSString *kind = LBWContextString(value[@"kind"], [label stringByAppendingString:@" kind"], 256U, error);
  if (subjectID == nil || kind == nil ||
      (! [kind isEqualToString:@"anonymous"] && ![kind isEqualToString:@"user"])) {
    if (subjectID != nil && kind != nil) {
      LBWContextFail(error, [label stringByAppendingString:@" kind must be anonymous or user"]);
    }
    return nil;
  }
  return @{@"id": subjectID, @"kind": kind};
}

static NSDictionary *_Nullable LBWValidateTags(
    id rawValue,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *value = LBWContextDictionary(rawValue, label, error);
  if (value == nil) {
    return nil;
  }
  if ([value count] == 0U || [value count] > 32U) {
    LBWContextFail(error, [label stringByAppendingString:@" must contain 1-32 entries"]);
    return nil;
  }
  NSMutableDictionary *clean = [NSMutableDictionary dictionary];
  for (id rawKey in value) {
    if (![rawKey isKindOfClass:[NSString class]] || !LBWContextMachineKey(rawKey, 64U, @"_.-")) {
      LBWContextFail(error, [label stringByAppendingString:@" key is invalid"]);
      return nil;
    }
    NSString *item = LBWContextString(
        value[rawKey], [NSString stringWithFormat:@"%@ value for %@", label, rawKey], 256U, error);
    if (item == nil) {
      return nil;
    }
    clean[rawKey] = item;
  }
  return [clean copy];
}

static NSDictionary *_Nullable LBWValidateResource(
    id rawValue,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSArray<NSString *> *keys = @[
    @"service", @"deployment", @"runtime", @"framework", @"operatingSystem", @"device", @"application"
  ];
  NSDictionary *value = LBWContextDictionary(rawValue, label, error);
  if (value == nil || !LBWContextAllowedKeys(value, keys, label, error)) {
    return nil;
  }
  NSMutableDictionary *clean = [NSMutableDictionary dictionary];
  for (NSString *key in @[@"service", @"runtime", @"framework"]) {
    if (value[key] == nil) {
      continue;
    }
    NSDictionary *item = LBWValidateNamedVersion(
        value[key], [NSString stringWithFormat:@"%@ %@", label, key], error);
    if (item == nil) {
      return nil;
    }
    clean[key] = item;
  }
  NSDictionary<NSString *, NSArray<NSString *> *> *fieldKeys = @{
    @"deployment": @[@"environment", @"release"],
    @"operatingSystem": @[@"name", @"version", @"build"],
    @"device": @[@"family", @"model", @"architecture"],
    @"application": @[@"name", @"version", @"build"]
  };
  for (NSString *key in fieldKeys) {
    if (value[key] == nil) {
      continue;
    }
    NSString *requiredKey = [key isEqualToString:@"operatingSystem"] ? @"name" : nil;
    NSDictionary *item = LBWValidateOptionalStringDictionary(
        value[key], fieldKeys[key], requiredKey, [NSString stringWithFormat:@"%@ %@", label, key], error);
    if (item == nil) {
      return nil;
    }
    clean[key] = item;
  }
  if ([clean count] == 0U) {
    LBWContextFail(error, [label stringByAppendingString:@" must not be empty"]);
    return nil;
  }
  return [clean copy];
}

BOOL LBWValidateTelemetryContext(
    id rawValue,
    NSString *label,
    NSDictionary<NSString *, id> **output,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *value = LBWContextDictionary(rawValue, label, error);
  NSArray<NSString *> *keys = @[@"schemaVersion", @"resource", @"trace", @"session", @"subject", @"tags"];
  if (value == nil || !LBWContextAllowedKeys(value, keys, label, error)) {
    return NO;
  }
  id version = value[@"schemaVersion"];
  if (![version isKindOfClass:[NSNumber class]] || LBWContextIsBoolean(version) ||
      [version integerValue] != 1 || [version doubleValue] != 1.0) {
    return LBWContextFail(error, [label stringByAppendingString:@" schemaVersion must be 1"]);
  }
  NSMutableDictionary *clean = [@{@"schemaVersion": @1} mutableCopy];
  if (value[@"resource"] != nil) {
    NSDictionary *resource = LBWValidateResource(value[@"resource"], [label stringByAppendingString:@" resource"], error);
    if (resource == nil) {
      return NO;
    }
    clean[@"resource"] = resource;
  }
  if (value[@"trace"] != nil) {
    NSDictionary *trace = LBWValidateTrace(value[@"trace"], [label stringByAppendingString:@" trace"], error);
    if (trace == nil) {
      return NO;
    }
    clean[@"trace"] = trace;
  }
  if (value[@"session"] != nil) {
    NSDictionary *session = LBWValidateSession(value[@"session"], [label stringByAppendingString:@" session"], error);
    if (session == nil) {
      return NO;
    }
    clean[@"session"] = session;
  }
  if (value[@"subject"] != nil) {
    NSDictionary *subject = LBWValidateSubject(value[@"subject"], [label stringByAppendingString:@" subject"], error);
    if (subject == nil) {
      return NO;
    }
    clean[@"subject"] = subject;
  }
  if (value[@"tags"] != nil) {
    NSDictionary *tags = LBWValidateTags(value[@"tags"], [label stringByAppendingString:@" tags"], error);
    if (tags == nil) {
      return NO;
    }
    clean[@"tags"] = tags;
  }
  if ([clean count] == 1U) {
    return LBWContextFail(error, [label stringByAppendingString:@" must include resource, trace, session, subject, or tags"]);
  }
  *output = [clean copy];
  return YES;
}

static NSDictionary *_Nullable LBWMergeFlatDictionary(
    NSDictionary *_Nullable base,
    NSDictionary *_Nullable override) {
  if (base == nil) {
    return override;
  }
  if (override == nil) {
    return base;
  }
  NSMutableDictionary *merged = [base mutableCopy];
  [merged addEntriesFromDictionary:override];
  return [merged copy];
}

static NSDictionary *_Nullable LBWMergeNamedVersion(NSDictionary *_Nullable base, NSDictionary *_Nullable override) {
  if (base == nil || override == nil) {
    return override != nil ? override : base;
  }
  NSMutableDictionary *merged = [base mutableCopy];
  merged[@"name"] = override[@"name"];
  if (override[@"version"] != nil) {
    merged[@"version"] = override[@"version"];
  }
  return [merged copy];
}

static NSDictionary *_Nullable LBWMergeResource(NSDictionary *_Nullable base, NSDictionary *_Nullable override) {
  if (base == nil || override == nil) {
    return override != nil ? override : base;
  }
  NSMutableDictionary *merged = [base mutableCopy];
  for (NSString *key in @[@"service", @"runtime", @"framework"]) {
    NSDictionary *item = LBWMergeNamedVersion(base[key], override[key]);
    if (item != nil) {
      merged[key] = item;
    }
  }
  for (NSString *key in @[@"deployment", @"operatingSystem", @"device", @"application"]) {
    NSDictionary *item = LBWMergeFlatDictionary(base[key], override[key]);
    if (item != nil) {
      merged[key] = item;
    }
  }
  return [merged copy];
}

NSDictionary<NSString *, id> *_Nullable LBWMergeTelemetryContexts(
    NSDictionary<NSString *, id> *_Nullable baseContext,
    NSDictionary<NSString *, id> *_Nullable overrideContext,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *base = nil;
  NSDictionary *override = nil;
  if (baseContext != nil && !LBWValidateTelemetryContext(baseContext, @"base telemetry context", &base, error)) {
    return nil;
  }
  if (overrideContext != nil && !LBWValidateTelemetryContext(
      overrideContext, @"event telemetry context", &override, error)) {
    return nil;
  }
  if (base == nil || override == nil) {
    return override != nil ? override : base;
  }
  NSMutableDictionary *merged = [@{@"schemaVersion": @1} mutableCopy];
  NSDictionary *resource = LBWMergeResource(base[@"resource"], override[@"resource"]);
  if (resource != nil) {
    merged[@"resource"] = resource;
  }
  for (NSString *key in @[@"trace", @"session", @"subject"]) {
    id value = override[key] != nil ? override[key] : base[key];
    if (value != nil) {
      merged[key] = value;
    }
  }
  NSDictionary *tags = LBWMergeFlatDictionary(base[@"tags"], override[@"tags"]);
  if (tags != nil) {
    merged[@"tags"] = tags;
  }
  NSDictionary *clean = nil;
  if (!LBWValidateTelemetryContext(merged, @"merged telemetry context", &clean, error)) {
    return nil;
  }
  return clean;
}

static NSString *LBWAutomaticOperatingSystemName(void) {
#if defined(TARGET_OS_VISION) && TARGET_OS_VISION
  return @"visionOS";
#elif TARGET_OS_WATCH
  return @"watchOS";
#elif TARGET_OS_TV
  return @"tvOS";
#elif TARGET_OS_IPHONE
  return @"iOS";
#elif TARGET_OS_OSX
  return @"macOS";
#else
  return @"unknown";
#endif
}

static NSString *_Nullable LBWAutomaticArchitecture(void) {
#if defined(__arm64__)
  return @"arm64";
#elif defined(__x86_64__)
  return @"x86_64";
#elif defined(__arm__)
  return @"arm";
#elif defined(__i386__)
  return @"i386";
#else
  return nil;
#endif
}

static NSString *_Nullable LBWAutomaticBundleValue(NSArray<NSString *> *keys) {
  NSBundle *bundle = [NSBundle mainBundle];
  for (NSString *key in keys) {
    id candidate = [bundle objectForInfoDictionaryKey:key];
    if (![candidate isKindOfClass:[NSString class]]) {
      continue;
    }
    NSError *error = nil;
    NSString *value = LBWContextString(candidate, @"automatic application context", 256U, &error);
    if (value != nil) {
      return value;
    }
  }
  return nil;
}

NSDictionary<NSString *, id> *LBWAutomaticTelemetryContext(void) {
  NSOperatingSystemVersion operatingSystem = [[NSProcessInfo processInfo] operatingSystemVersion];
  NSString *version = [NSString stringWithFormat:@"%ld.%ld.%ld",
      (long)operatingSystem.majorVersion,
      (long)operatingSystem.minorVersion,
      (long)operatingSystem.patchVersion];
  NSMutableDictionary *resource = [@{
    @"runtime": @{@"name": @"objective-c"},
    @"operatingSystem": @{@"name": LBWAutomaticOperatingSystemName(), @"version": version}
  } mutableCopy];
  NSString *architecture = LBWAutomaticArchitecture();
  if (architecture != nil) {
    resource[@"device"] = @{@"architecture": architecture};
  }
  NSMutableDictionary *application = [NSMutableDictionary dictionary];
  NSString *name = LBWAutomaticBundleValue(@[@"CFBundleDisplayName", @"CFBundleName"]);
  NSString *appVersion = LBWAutomaticBundleValue(@[@"CFBundleShortVersionString"]);
  NSString *build = LBWAutomaticBundleValue(@[@"CFBundleVersion"]);
  if (name != nil) {
    application[@"name"] = name;
  }
  if (appVersion != nil) {
    application[@"version"] = appVersion;
  }
  if (build != nil) {
    application[@"build"] = build;
  }
  if ([application count] > 0U) {
    resource[@"application"] = [application copy];
  }
  return @{@"schemaVersion": @1, @"resource": [resource copy]};
}

NSDictionary<NSString *, id> *LBWTelemetryContextFromTrace(LBWTraceContext *context) {
  NSMutableDictionary *trace = [@{
    @"traceId": context.traceID,
    @"spanId": context.spanID,
    @"sampled": @(context.sampled)
  } mutableCopy];
  if (context.parentSpanID != nil) {
    trace[@"parentSpanId"] = context.parentSpanID;
  }
  return @{@"schemaVersion": @1, @"trace": [trace copy]};
}

NSDictionary<NSString *, id> *_Nullable LBWTelemetryContextByReplacingTrace(
    NSDictionary<NSString *, id> *_Nullable context,
    NSDictionary<NSString *, id> *_Nullable trace) {
  NSMutableDictionary *output = context != nil ? [context mutableCopy] : [@{@"schemaVersion": @1} mutableCopy];
  if (trace == nil) {
    [output removeObjectForKey:@"trace"];
  } else {
    output[@"trace"] = trace;
  }
  return [output count] == 1U ? nil : [output copy];
}

@interface LBWTelemetryScope ()

@property(nonatomic, copy) NSDictionary<NSString *, id> *context;
@property(nonatomic) NSMutableArray<LBWTelemetryScope *> *stack;
@property(nonatomic) BOOL closed;

@end

@implementation LBWTelemetryScope

- (void)close {
  @synchronized(self.stack) {
    if (self.closed) {
      return;
    }
    self.closed = YES;
    [self.stack removeObjectIdenticalTo:self];
  }
}

- (void)dealloc {
  [self close];
}

@end

static NSMutableArray<LBWTelemetryScope *> *LBWTelemetryScopeStack(void) {
  NSMutableDictionary *threadDictionary = [[NSThread currentThread] threadDictionary];
  NSMutableArray<LBWTelemetryScope *> *stack = threadDictionary[LBWTelemetryScopeStackKey];
  if (stack == nil) {
    stack = [NSMutableArray array];
    threadDictionary[LBWTelemetryScopeStackKey] = stack;
  }
  return stack;
}

@implementation LBWTelemetry

+ (NSDictionary<NSString *, id> *)currentContext {
  NSMutableArray *stack = [[[NSThread currentThread] threadDictionary] objectForKey:LBWTelemetryScopeStackKey];
  @synchronized(stack) {
    return [[stack lastObject] context];
  }
}

+ (LBWTelemetryScope *)activateContext:(NSDictionary<NSString *, id> *)context error:(NSError **)error {
  NSDictionary *merged = LBWMergeTelemetryContexts([self currentContext], context, error);
  if (merged == nil) {
    return nil;
  }
  NSMutableArray<LBWTelemetryScope *> *stack = LBWTelemetryScopeStack();
  LBWTelemetryScope *scope = [[LBWTelemetryScope alloc] init];
  scope.context = merged;
  scope.stack = stack;
  @synchronized(stack) {
    [stack addObject:scope];
  }
  return scope;
}

+ (NSDictionary<NSString *, id> *)contextByMergingBase:(NSDictionary<NSString *, id> *)baseContext
                                                override:(NSDictionary<NSString *, id> *)overrideContext
                                                   error:(NSError **)error {
  return LBWMergeTelemetryContexts(baseContext, overrideContext, error);
}

@end
