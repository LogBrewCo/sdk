#import "LogBrew.h"

#import <objc/message.h>

static NSString *const LBWZeroTraceID = @"00000000000000000000000000000000";
static NSString *const LBWZeroSpanID = @"0000000000000000";
static NSString *const LBWTraceScopeStackKey = @"co.logbrew.sdk.traceScopeStack";

@interface LBWTraceContext ()

@property(nonatomic, copy) NSString *traceID;
@property(nonatomic, copy) NSString *spanID;
@property(nonatomic, copy, nullable) NSString *parentSpanID;
@property(nonatomic, copy) NSString *traceFlags;
@property(nonatomic) BOOL sampled;

- (instancetype)initWithValidatedTraceID:(NSString *)traceID
                                  spanID:(NSString *)spanID
                            parentSpanID:(nullable NSString *)parentSpanID
                              traceFlags:(NSString *)traceFlags NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@end

@interface LBWOpenTelemetrySpanContext ()

@property(nonatomic, copy) NSString *traceID;
@property(nonatomic, copy) NSString *spanID;
@property(nonatomic, copy) NSString *traceFlags;
@property(nonatomic) BOOL sampled;

- (instancetype)initWithValidatedTraceID:(NSString *)traceID
                                  spanID:(NSString *)spanID
                              traceFlags:(NSString *)traceFlags NS_DESIGNATED_INITIALIZER;

@end

@interface LBWTraceScope ()

@property(nonatomic, strong) LBWTraceContext *context;
@property(nonatomic) BOOL closed;

- (instancetype)initWithContext:(LBWTraceContext *)context NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@end

static NSError *LBWTraceError(NSString *message) {
  return [NSError errorWithDomain:LBWErrorDomain
                             code:LBWErrorKindValidation
                         userInfo:@{
                           LBWErrorStableCodeKey: @"validation_error",
                           LBWErrorRetryableKey: @NO,
                           NSLocalizedDescriptionKey: message
                         }];
}

static void LBWTraceSetError(NSError *_Nullable *_Nullable error, NSError *value) {
  if (error != NULL) {
    *error = value;
  }
}

static BOOL LBWTraceIsBlank(NSString *_Nullable value) {
  if (value == nil) {
    return YES;
  }
  return [[value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] length] == 0U;
}

static BOOL LBWTraceIsHex(NSString *value) {
  NSCharacterSet *hex = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdefABCDEF"];
  return [value rangeOfCharacterFromSet:[hex invertedSet]].location == NSNotFound;
}

static NSString *_Nullable LBWTraceNormalizeHex(
    NSString *label,
    NSString *_Nullable value,
    NSUInteger length,
    NSString *_Nullable zeroValue,
    NSError *_Nullable *_Nullable error) {
  if (LBWTraceIsBlank(value)) {
    NSString *message = [NSString stringWithFormat:@"%@ must be non-empty", label];
    LBWTraceSetError(error, LBWTraceError(message));
    return nil;
  }
  NSString *normalized = [[value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      lowercaseString];
  if ([normalized length] != length || !LBWTraceIsHex(normalized)) {
    NSString *message = [NSString stringWithFormat:@"%@ must be %lu hex characters", label, (unsigned long)length];
    LBWTraceSetError(error, LBWTraceError(message));
    return nil;
  }
  if (zeroValue != nil && [normalized isEqualToString:zeroValue]) {
    NSString *message = [NSString stringWithFormat:@"%@ must not be all zeros", label];
    LBWTraceSetError(error, LBWTraceError(message));
    return nil;
  }
  return normalized;
}

static NSString *_Nullable LBWTraceNormalizeFlags(NSString *_Nullable value, NSError *_Nullable *_Nullable error) {
  return LBWTraceNormalizeHex(@"traceFlags", value, 2U, nil, error);
}

static NSString *LBWTraceRandomHex(NSUInteger length, NSString *zeroValue) {
  NSString *value = [[[NSUUID UUID] UUIDString] stringByReplacingOccurrencesOfString:@"-" withString:@""];
  value = [[value lowercaseString] substringToIndex:length];
  return [value isEqualToString:zeroValue] ? [zeroValue stringByReplacingCharactersInRange:NSMakeRange(length - 1U, 1U)
                                                                               withString:@"1"] :
                                             value;
}

static NSMutableArray<LBWTraceScope *> *_Nullable LBWTraceExistingScopeStack(void) {
  NSMutableDictionary *threadDictionary = [[NSThread currentThread] threadDictionary];
  return threadDictionary[LBWTraceScopeStackKey];
}

static NSMutableArray<LBWTraceScope *> *LBWTraceScopeStack(void) {
  NSMutableDictionary *threadDictionary = [[NSThread currentThread] threadDictionary];
  NSMutableArray<LBWTraceScope *> *stack = LBWTraceExistingScopeStack();
  if (stack == nil) {
    stack = [NSMutableArray array];
    threadDictionary[LBWTraceScopeStackKey] = stack;
  }
  return stack;
}

static void LBWTraceDropEmptyScopeStack(void) {
  NSMutableDictionary *threadDictionary = [[NSThread currentThread] threadDictionary];
  NSMutableArray *stack = threadDictionary[LBWTraceScopeStackKey];
  if ([stack count] == 0U) {
    [threadDictionary removeObjectForKey:LBWTraceScopeStackKey];
  }
}

static NSDictionary<NSString *, id> *_Nullable LBWTraceMetadataByMergingContext(
    NSDictionary<NSString *, id> *_Nullable metadata,
    LBWTraceContext *_Nullable context) {
  if (context == nil) {
    return [metadata count] > 0U ? [metadata copy] : nil;
  }
  NSMutableDictionary<NSString *, id> *merged =
      metadata != nil ? [metadata mutableCopy] : [NSMutableDictionary dictionary];
  [merged addEntriesFromDictionary:[context metadata]];
  return [merged count] > 0U ? [merged copy] : nil;
}

static id _Nullable LBWTraceObjectValue(id _Nullable object, SEL selector) {
  if (object == nil || ![object respondsToSelector:selector]) {
    return nil;
  }
  id (*send)(id, SEL) = (id (*)(id, SEL))objc_msgSend;
  return send(object, selector);
}

static BOOL LBWTraceObjectBoolValue(id _Nullable object, SEL selector, BOOL *value) {
  if (object == nil || ![object respondsToSelector:selector]) {
    return NO;
  }
  BOOL (*send)(id, SEL) = (BOOL (*)(id, SEL))objc_msgSend;
  *value = send(object, selector);
  return YES;
}

static NSString *_Nullable LBWTraceStringValueFromObject(id _Nullable value, NSArray<NSString *> *stringSelectors) {
  if (value == nil || value == (id)[NSNull null]) {
    return nil;
  }
  if ([value isKindOfClass:[NSString class]]) {
    return value;
  }
  for (NSString *selectorName in stringSelectors) {
    id selected = LBWTraceObjectValue(value, NSSelectorFromString(selectorName));
    if ([selected isKindOfClass:[NSString class]]) {
      return selected;
    }
  }
  return nil;
}

static NSString *_Nullable LBWTraceFirstStringValue(id _Nullable object, NSArray<NSString *> *selectors) {
  for (NSString *selectorName in selectors) {
    id selected = LBWTraceObjectValue(object, NSSelectorFromString(selectorName));
    NSString *value = LBWTraceStringValueFromObject(selected, @[
      @"hexString",
      @"sentryIdString",
      @"sentrySpanIdString",
      @"stringValue"
    ]);
    if (value != nil) {
      return value;
    }
  }
  return nil;
}

static NSString *_Nullable LBWTraceFlagsValueFromObject(id _Nullable object) {
  for (NSString *selectorName in @[@"traceFlags", @"traceFlag"]) {
    id selected = LBWTraceObjectValue(object, NSSelectorFromString(selectorName));
    if ([selected isKindOfClass:[NSNumber class]]) {
      return [NSString stringWithFormat:@"%02x", [selected unsignedIntValue] & 0xffU];
    }
    NSString *value = LBWTraceStringValueFromObject(selected, @[@"hexString", @"stringValue"]);
    if (value != nil) {
      return value;
    }
  }
  BOOL sampled = NO;
  if (LBWTraceObjectBoolValue(object, @selector(isSampled), &sampled) ||
      LBWTraceObjectBoolValue(object, @selector(sampled), &sampled)) {
    return sampled ? @"01" : @"00";
  }
  return nil;
}

static BOOL LBWTraceObjectIsExplicitlyInvalid(id _Nullable object) {
  BOOL valid = YES;
  return LBWTraceObjectBoolValue(object, @selector(isValid), &valid) && !valid;
}

static LBWOpenTelemetrySpanContext *_Nullable LBWTraceOpenTelemetrySpanContextFromObject(
    id _Nullable object,
    NSError *_Nullable *_Nullable error) {
  if (object == nil || LBWTraceObjectIsExplicitlyInvalid(object)) {
    return nil;
  }
  NSString *traceID = LBWTraceFirstStringValue(object, @[@"traceID", @"traceId"]);
  NSString *spanID = LBWTraceFirstStringValue(object, @[@"spanID", @"spanId"]);
  NSString *traceFlags = LBWTraceFlagsValueFromObject(object);
  if (traceID == nil || spanID == nil || traceFlags == nil) {
    LBWTraceSetError(error, LBWTraceError(@"OpenTelemetry span context object must expose trace ID, span ID, and trace flags"));
    return nil;
  }
  return [LBWOpenTelemetrySpanContext contextWithTraceID:traceID
                                                  spanID:spanID
                                              traceFlags:traceFlags
                                                   error:error];
}

static LBWOpenTelemetrySpanContext *_Nullable LBWTraceOpenTelemetrySpanContextFromSpanObject(
    id _Nullable span,
    NSError *_Nullable *_Nullable error) {
  if (span == nil) {
    return nil;
  }
  id context = LBWTraceObjectValue(span, @selector(context));
  if (context == nil) {
    context = LBWTraceObjectValue(span, @selector(spanContext));
  }
  if (context != nil) {
    return LBWTraceOpenTelemetrySpanContextFromObject(context, error);
  }
  return LBWTraceOpenTelemetrySpanContextFromObject(span, error);
}

@implementation LBWTraceContext

- (instancetype)initWithValidatedTraceID:(NSString *)traceID
                                  spanID:(NSString *)spanID
                            parentSpanID:(NSString *)parentSpanID
                              traceFlags:(NSString *)traceFlags {
  self = [super init];
  if (self != nil) {
    _traceID = [traceID copy];
    _spanID = [spanID copy];
    _parentSpanID = [parentSpanID copy];
    _traceFlags = [traceFlags copy];
    unsigned int flags = 0U;
    [[NSScanner scannerWithString:_traceFlags] scanHexInt:&flags];
    _sampled = (flags & 1U) == 1U;
  }
  return self;
}

+ (instancetype)rootContext {
  return [[LBWTraceContext alloc] initWithValidatedTraceID:LBWTraceRandomHex(32U, LBWZeroTraceID)
                                                    spanID:LBWTraceRandomHex(16U, LBWZeroSpanID)
                                              parentSpanID:nil
                                                traceFlags:@"01"];
}

+ (instancetype)rootContextWithTraceFlags:(NSString *)traceFlags error:(NSError **)error {
  NSString *normalizedFlags = LBWTraceNormalizeFlags(traceFlags, error);
  if (normalizedFlags == nil) {
    return nil;
  }
  return [[LBWTraceContext alloc] initWithValidatedTraceID:LBWTraceRandomHex(32U, LBWZeroTraceID)
                                                    spanID:LBWTraceRandomHex(16U, LBWZeroSpanID)
                                              parentSpanID:nil
                                                traceFlags:normalizedFlags];
}

+ (instancetype)contextWithTraceID:(NSString *)traceID
                            spanID:(NSString *)spanID
                      parentSpanID:(NSString *)parentSpanID
                        traceFlags:(NSString *)traceFlags
                             error:(NSError **)error {
  NSString *normalizedTraceID = LBWTraceNormalizeHex(@"traceID", traceID, 32U, LBWZeroTraceID, error);
  NSString *normalizedSpanID = LBWTraceNormalizeHex(@"spanID", spanID, 16U, LBWZeroSpanID, error);
  NSString *normalizedParentSpanID = nil;
  if (parentSpanID != nil) {
    normalizedParentSpanID = LBWTraceNormalizeHex(@"parentSpanID", parentSpanID, 16U, LBWZeroSpanID, error);
  }
  NSString *normalizedFlags = LBWTraceNormalizeFlags(traceFlags, error);
  if (normalizedTraceID == nil || normalizedSpanID == nil ||
      (parentSpanID != nil && normalizedParentSpanID == nil) || normalizedFlags == nil) {
    return nil;
  }
  return [[LBWTraceContext alloc] initWithValidatedTraceID:normalizedTraceID
                                                    spanID:normalizedSpanID
                                              parentSpanID:normalizedParentSpanID
                                                traceFlags:normalizedFlags];
}

+ (instancetype)contextFromTraceparent:(NSString *)traceparent error:(NSError **)error {
  NSArray<NSString *> *parts =
      [[traceparent stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
          componentsSeparatedByString:@"-"];
  if ([parts count] != 4U) {
    LBWTraceSetError(error, LBWTraceError(@"traceparent must use W3C version-traceID-parentSpanID-traceFlags format"));
    return nil;
  }
  NSString *version = LBWTraceNormalizeHex(@"traceparent version", parts[0], 2U, nil, error);
  if (version == nil) {
    return nil;
  }
  if ([version isEqualToString:@"ff"]) {
    LBWTraceSetError(error, LBWTraceError(@"traceparent version must not be ff"));
    return nil;
  }
  NSString *traceID = LBWTraceNormalizeHex(@"traceparent traceID", parts[1], 32U, LBWZeroTraceID, error);
  NSString *parentSpanID = LBWTraceNormalizeHex(@"traceparent parentSpanID", parts[2], 16U, LBWZeroSpanID, error);
  NSString *traceFlags = LBWTraceNormalizeFlags(parts[3], error);
  if (traceID == nil || parentSpanID == nil || traceFlags == nil) {
    return nil;
  }
  return [[LBWTraceContext alloc] initWithValidatedTraceID:traceID
                                                    spanID:parentSpanID
                                              parentSpanID:nil
                                                traceFlags:traceFlags];
}

+ (instancetype)continueOrCreateContextFromTraceparent:(NSString *)traceparent {
  if (LBWTraceIsBlank(traceparent)) {
    return [LBWTraceContext rootContext];
  }
  LBWTraceContext *remoteParent = [LBWTraceContext contextFromTraceparent:traceparent error:nil];
  return remoteParent != nil ? [remoteParent childContext] : [LBWTraceContext rootContext];
}

- (instancetype)childContext {
  return [[LBWTraceContext alloc] initWithValidatedTraceID:self.traceID
                                                    spanID:LBWTraceRandomHex(16U, LBWZeroSpanID)
                                              parentSpanID:self.spanID
                                                traceFlags:self.traceFlags];
}

- (NSString *)traceparent {
  return [NSString stringWithFormat:@"00-%@-%@-%@", self.traceID, self.spanID, self.traceFlags];
}

- (NSDictionary<NSString *, id> *)metadata {
  NSMutableDictionary<NSString *, id> *metadata = [@{
    @"traceId": self.traceID,
    @"spanId": self.spanID,
    @"traceFlags": self.traceFlags,
    @"traceSampled": @(self.sampled)
  } mutableCopy];
  if (self.parentSpanID != nil) {
    metadata[@"parentSpanId"] = self.parentSpanID;
  }
  return metadata;
}

- (NSDictionary<NSString *, NSString *> *)outgoingHeaders {
  return @{@"traceparent": self.traceparent};
}

- (NSDictionary<NSString *, id> *)spanAttributesWithName:(NSString *)name
                                                   status:(NSString *)status
                                               durationMs:(NSNumber *)durationMs
                                                 metadata:(NSDictionary<NSString *, id> *)metadata
                                                    error:(NSError **)error {
  if (LBWTraceIsBlank(name)) {
    LBWTraceSetError(error, LBWTraceError(@"span name must be non-empty"));
    return nil;
  }
  if (!([status isEqualToString:@"ok"] || [status isEqualToString:@"error"])) {
    LBWTraceSetError(error, LBWTraceError(@"span status must be ok or error"));
    return nil;
  }
  NSMutableDictionary<NSString *, id> *attributes = [@{
    @"name": name,
    @"traceId": self.traceID,
    @"spanId": self.spanID,
    @"status": status
  } mutableCopy];
  if (self.parentSpanID != nil) {
    attributes[@"parentSpanId"] = self.parentSpanID;
  }
  if (durationMs != nil) {
    attributes[@"durationMs"] = durationMs;
  }
  NSDictionary<NSString *, id> *mergedMetadata = LBWTraceMetadataByMergingContext(metadata, self);
  if ([mergedMetadata count] > 0U) {
    attributes[@"metadata"] = mergedMetadata;
  }
  return attributes;
}

@end

@implementation LBWOpenTelemetrySpanContext

- (instancetype)initWithValidatedTraceID:(NSString *)traceID
                                  spanID:(NSString *)spanID
                              traceFlags:(NSString *)traceFlags {
  self = [super init];
  if (self != nil) {
    _traceID = [traceID copy];
    _spanID = [spanID copy];
    _traceFlags = [traceFlags copy];
    unsigned int flags = 0U;
    [[NSScanner scannerWithString:_traceFlags] scanHexInt:&flags];
    _sampled = (flags & 1U) == 1U;
  }
  return self;
}

+ (instancetype)contextWithTraceID:(NSString *)traceID
                            spanID:(NSString *)spanID
                        traceFlags:(NSString *)traceFlags
                             error:(NSError **)error {
  NSString *normalizedTraceID = LBWTraceNormalizeHex(@"OpenTelemetry traceID", traceID, 32U, LBWZeroTraceID, error);
  NSString *normalizedSpanID = LBWTraceNormalizeHex(@"OpenTelemetry spanID", spanID, 16U, LBWZeroSpanID, error);
  NSString *normalizedFlags = LBWTraceNormalizeFlags(traceFlags, error);
  if (normalizedTraceID == nil || normalizedSpanID == nil || normalizedFlags == nil) {
    return nil;
  }
  return [[LBWOpenTelemetrySpanContext alloc] initWithValidatedTraceID:normalizedTraceID
                                                                spanID:normalizedSpanID
                                                            traceFlags:normalizedFlags];
}

+ (instancetype)contextWithTraceID:(NSString *)traceID
                            spanID:(NSString *)spanID
                           sampled:(BOOL)sampled
                             error:(NSError **)error {
  return [self contextWithTraceID:traceID spanID:spanID traceFlags:(sampled ? @"01" : @"00") error:error];
}

@end

@implementation LBWTraceScope

- (instancetype)initWithContext:(LBWTraceContext *)context {
  self = [super init];
  if (self != nil) {
    _context = context;
    _closed = NO;
  }
  return self;
}

- (void)close {
  if (self.closed) {
    return;
  }
  self.closed = YES;
  NSMutableArray<LBWTraceScope *> *stack = LBWTraceScopeStack();
  [stack removeObjectIdenticalTo:self];
  LBWTraceDropEmptyScopeStack();
}

- (void)dealloc {
  [self close];
}

@end

@implementation LBWTrace

+ (LBWTraceContext *)currentContext {
  return [LBWTraceExistingScopeStack() lastObject].context;
}

+ (LBWTraceScope *)activateContext:(LBWTraceContext *)context {
  LBWTraceScope *scope = [[LBWTraceScope alloc] initWithContext:context];
  [LBWTraceScopeStack() addObject:scope];
  return scope;
}

+ (NSDictionary<NSString *, id> *)metadataByMergingActiveContextIntoMetadata:(NSDictionary<NSString *, id> *)metadata {
  return LBWTraceMetadataByMergingContext(metadata, [LBWTrace currentContext]);
}

+ (NSDictionary<NSString *, NSString *> *)outgoingHeaders {
  LBWTraceContext *context = [LBWTrace currentContext];
  return context != nil ? [context outgoingHeaders] : @{};
}

+ (LBWOpenTelemetrySpanContext *)openTelemetrySpanContextWithTraceID:(NSString *)traceID
                                                              spanID:(NSString *)spanID
                                                          traceFlags:(NSString *)traceFlags
                                                               error:(NSError **)error {
  return [LBWOpenTelemetrySpanContext contextWithTraceID:traceID
                                                  spanID:spanID
                                              traceFlags:traceFlags
                                                   error:error];
}

+ (LBWOpenTelemetrySpanContext *)openTelemetrySpanContextWithTraceID:(NSString *)traceID
                                                              spanID:(NSString *)spanID
                                                             sampled:(BOOL)sampled
                                                               error:(NSError **)error {
  return [LBWOpenTelemetrySpanContext contextWithTraceID:traceID spanID:spanID sampled:sampled error:error];
}

+ (LBWOpenTelemetrySpanContext *)openTelemetrySpanContextFromSpanContextObject:(id)spanContext error:(NSError **)error {
  return LBWTraceOpenTelemetrySpanContextFromObject(spanContext, error);
}

+ (LBWOpenTelemetrySpanContext *)openTelemetrySpanContextFromSpanObject:(id)span error:(NSError **)error {
  return LBWTraceOpenTelemetrySpanContextFromSpanObject(span, error);
}

+ (LBWTraceContext *)contextFromOpenTelemetrySpanContext:(LBWOpenTelemetrySpanContext *)context {
  return [[LBWTraceContext alloc] initWithValidatedTraceID:context.traceID
                                                    spanID:LBWTraceRandomHex(16U, LBWZeroSpanID)
                                              parentSpanID:context.spanID
                                                traceFlags:context.traceFlags];
}

+ (LBWTraceContext *)contextFromOpenTelemetrySpanObject:(id)span error:(NSError **)error {
  LBWOpenTelemetrySpanContext *context = [self openTelemetrySpanContextFromSpanObject:span error:error];
  return context != nil ? [self contextFromOpenTelemetrySpanContext:context] : nil;
}

+ (NSDictionary<NSString *, id> *)spanAttributesFromOpenTelemetrySpanContext:(LBWOpenTelemetrySpanContext *)context
                                                                        name:(NSString *)name
                                                                      status:(NSString *)status
                                                                  durationMs:(NSNumber *)durationMs
                                                                    metadata:(NSDictionary<NSString *, id> *)metadata
                                                                       error:(NSError **)error {
  LBWTraceContext *traceContext = [self contextFromOpenTelemetrySpanContext:context];
  return [traceContext spanAttributesWithName:name
                                       status:status
                                   durationMs:durationMs
                                     metadata:metadata
                                        error:error];
}

+ (NSDictionary<NSString *, id> *)spanAttributesFromOpenTelemetrySpanObject:(id)span
                                                                       name:(NSString *)name
                                                                     status:(NSString *)status
                                                                 durationMs:(NSNumber *)durationMs
                                                                   metadata:(NSDictionary<NSString *, id> *)metadata
                                                                      error:(NSError **)error {
  LBWOpenTelemetrySpanContext *context = [self openTelemetrySpanContextFromSpanObject:span error:error];
  if (context == nil) {
    return nil;
  }
  return [self spanAttributesFromOpenTelemetrySpanContext:context
                                                     name:name
                                                   status:status
                                               durationMs:durationMs
                                                 metadata:metadata
                                                    error:error];
}

@end
