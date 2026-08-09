#import "LogBrew.h"

#import "LogBrewNetworkValidation.h"
#import "LBWInvestigationEvidence.h"
#import "LBWTelemetryContext.h"
#import "LBWDeliveryEngine.h"

#import <math.h>

NSString *const LogBrewObjectiveCVersion = @"0.2.1";
NSString *const LBWErrorDomain = @"co.logbrew.sdk";
NSString *const LBWErrorStableCodeKey = @"LBWStableCode";
NSString *const LBWErrorRetryableKey = @"LBWRetryable";

@interface LBWRecordingStep ()

@property(nonatomic) BOOL errorStep;
@property(nonatomic) NSInteger statusCode;
@property(nonatomic, copy) NSString *stableCode;
@property(nonatomic, copy) NSString *message;
@property(nonatomic) BOOL retryable;

@end

@interface LBWRecordingTransport ()

@property(nonatomic, copy) NSArray<LBWRecordingStep *> *steps;
@property(nonatomic) NSUInteger cursor;
@property(nonatomic) NSMutableArray<NSString *> *mutableSentBodies;

@end

@interface LBWClient ()

@property(nonatomic, copy) NSString *apiKey;
@property(nonatomic, copy) NSString *sdkName;
@property(nonatomic, copy) NSString *sdkVersion;
@property(nonatomic, copy, nullable) NSDictionary<NSString *, id> *baseContext;
@property(nonatomic) NSMutableArray<NSDictionary<NSString *, id> *> *breadcrumbs;
@property(nonatomic) BOOL breadcrumbsTruncated;
@property(nonatomic) LBWDeliveryEngine *deliveryEngine;

@end

static NSError *LBWMakeError(LBWErrorKind kind, NSString *stableCode, NSString *message, BOOL retryable) {
  return [NSError errorWithDomain:LBWErrorDomain
                             code:kind
                         userInfo:@{
                           LBWErrorStableCodeKey: stableCode,
                           LBWErrorRetryableKey: @(retryable),
                           NSLocalizedDescriptionKey: message
                         }];
}

static void LBWSetError(NSError *_Nullable *_Nullable error, NSError *value) {
  if (error != NULL) {
    *error = value;
  }
}

static BOOL LBWIsBlank(NSString *_Nullable value) {
  if (value == nil) {
    return YES;
  }
  NSCharacterSet *whitespace = [NSCharacterSet whitespaceAndNewlineCharacterSet];
  return [[value stringByTrimmingCharactersInSet:whitespace] length] == 0U;
}

static BOOL LBWRequireNonEmpty(NSString *label, NSString *_Nullable value, NSError *_Nullable *_Nullable error) {
  if (!LBWIsBlank(value)) {
    return YES;
  }
  NSString *message = [NSString stringWithFormat:@"%@ must be non-empty", label];
  LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
  return NO;
}

static BOOL LBWRequireTimestamp(NSString *timestamp, NSError *_Nullable *_Nullable error) {
  if (!LBWRequireNonEmpty(@"timestamp", timestamp, error)) {
    return NO;
  }
  NSRange separator = [timestamp rangeOfString:@"T"];
  if (separator.location == NSNotFound) {
    LBWSetError(error, LBWMakeError(
        LBWErrorKindValidation, @"validation_error", @"timestamp must include a time separator", NO));
    return NO;
  }
  NSString *timePart = [timestamp substringFromIndex:separator.location + separator.length];
  if ([timestamp hasSuffix:@"Z"] || [timePart rangeOfString:@"+"].location != NSNotFound ||
      [timePart rangeOfString:@"-"].location != NSNotFound) {
    return YES;
  }
  LBWSetError(error, LBWMakeError(
      LBWErrorKindValidation, @"validation_error", @"timestamp must include a timezone offset", NO));
  return NO;
}

static BOOL LBWRequireAllowed(
    NSString *label,
    NSString *value,
    NSArray<NSString *> *allowed,
    NSError *_Nullable *_Nullable error) {
  if (!LBWRequireNonEmpty(label, value, error)) {
    return NO;
  }
  if ([allowed containsObject:value]) {
    return YES;
  }
  NSString *message = [NSString stringWithFormat:@"%@ has unsupported value: %@", label, value];
  LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
  return NO;
}

static NSString *_Nullable LBWNormalizeSeverity(NSString *label, NSString *value, NSError *_Nullable *_Nullable error) {
  if (!LBWRequireAllowed(label, value, @[@"trace", @"debug", @"info", @"warn", @"warning", @"error", @"fatal", @"critical"], error)) {
    return nil;
  }
  if ([value isEqualToString:@"trace"] || [value isEqualToString:@"debug"] || [value isEqualToString:@"info"]) {
    return @"info";
  }
  if ([value isEqualToString:@"warn"] || [value isEqualToString:@"warning"]) {
    return @"warning";
  }
  if ([value isEqualToString:@"error"]) {
    return @"error";
  }
  return @"critical";
}

static NSString *_Nullable LBWStringAttribute(
    NSDictionary<NSString *, id> *attributes,
    NSString *key,
    NSString *label,
    BOOL required,
    BOOL requireNonBlank,
    NSError *_Nullable *_Nullable error) {
  id value = attributes[key];
  if (value == nil) {
    if (required) {
      NSString *message = [NSString stringWithFormat:@"%@ must be non-empty", label];
      LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
    }
    return nil;
  }
  if (![value isKindOfClass:[NSString class]]) {
    NSString *message = [NSString stringWithFormat:@"%@ must be a string", label];
    LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
    return nil;
  }
  NSString *stringValue = (NSString *)value;
  if (requireNonBlank && !LBWRequireNonEmpty(label, stringValue, error)) {
    return nil;
  }
  return stringValue;
}

static NSNumber *_Nullable LBWNumberAttribute(
    NSDictionary<NSString *, id> *attributes,
    NSString *key,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  id value = attributes[key];
  if (value == nil) {
    return nil;
  }
  if (![value isKindOfClass:[NSNumber class]]) {
    NSString *message = [NSString stringWithFormat:@"%@ must be a number", label];
    LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
    return nil;
  }
  NSNumber *numberValue = (NSNumber *)value;
  double doubleValue = [numberValue doubleValue];
  if (!isfinite(doubleValue) || doubleValue < 0.0) {
    NSString *message = [NSString stringWithFormat:@"%@ must be finite and non-negative", label];
    LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
    return nil;
  }
  return numberValue;
}

static NSNumber *_Nullable LBWFiniteNumberAttribute(
    NSDictionary<NSString *, id> *attributes,
    NSString *key,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  id value = attributes[key];
  if (value == nil) {
    NSString *message = [NSString stringWithFormat:@"%@ must be a number", label];
    LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
    return nil;
  }
  if (![value isKindOfClass:[NSNumber class]]) {
    NSString *message = [NSString stringWithFormat:@"%@ must be a number", label];
    LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
    return nil;
  }
  NSNumber *numberValue = (NSNumber *)value;
  if (!isfinite([numberValue doubleValue])) {
    NSString *message = [NSString stringWithFormat:@"%@ must be finite", label];
    LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
    return nil;
  }
  return numberValue;
}

static NSDictionary<NSString *, id> *_Nullable LBWMetadataAttribute(
    NSDictionary<NSString *, id> *attributes,
    NSString *key,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  id value = attributes[key];
  if (value == nil) {
    return nil;
  }
  if (![value isKindOfClass:[NSDictionary class]]) {
    NSString *message = [NSString stringWithFormat:@"%@ must be a dictionary", label];
    LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
    return nil;
  }
  NSMutableDictionary<NSString *, id> *clean = [NSMutableDictionary dictionary];
  NSDictionary *metadata = (NSDictionary *)value;
  for (id rawKey in metadata) {
    if (![rawKey isKindOfClass:[NSString class]] || LBWIsBlank(rawKey)) {
      LBWSetError(error, LBWMakeError(
          LBWErrorKindValidation, @"validation_error", @"metadata keys must be non-empty strings", NO));
      return nil;
    }
    id rawValue = metadata[rawKey];
    if (rawValue == nil) {
      clean[rawKey] = [NSNull null];
    } else if ([rawValue isKindOfClass:[NSNull class]] || [rawValue isKindOfClass:[NSString class]]) {
      clean[rawKey] = rawValue;
    } else if ([rawValue isKindOfClass:[NSNumber class]]) {
      double doubleValue = [(NSNumber *)rawValue doubleValue];
      if (!isfinite(doubleValue)) {
        NSString *message = [NSString stringWithFormat:@"metadata value for %@ must be finite", rawKey];
        LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
        return nil;
      }
      clean[rawKey] = rawValue;
    } else {
      NSString *message = [NSString stringWithFormat:@"%@ values must be primitive", label];
      LBWSetError(error, LBWMakeError(LBWErrorKindValidation, @"validation_error", message, NO));
      return nil;
    }
  }
  return clean;
}

static BOOL LBWCopyMetadata(
    NSMutableDictionary<NSString *, id> *target,
    NSDictionary<NSString *, id> *_Nullable metadata,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  if (metadata == nil) {
    return YES;
  }
  NSDictionary<NSString *, id> *clean = LBWMetadataAttribute(@{@"metadata": metadata}, @"metadata", label, error);
  if (clean == nil) {
    return NO;
  }
  [target addEntriesFromDictionary:clean];
  return YES;
}

static BOOL LBWIsBoolean(id value) {
  return [value isKindOfClass:[NSNumber class]] &&
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL LBWCopyContextAttribute(
    NSMutableDictionary<NSString *, id> *target,
    NSDictionary<NSString *, id> *attributes,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  id rawContext = attributes[@"context"];
  if (rawContext == nil) {
    return YES;
  }
  NSDictionary<NSString *, id> *context = nil;
  if (!LBWValidateTelemetryContext(rawContext, label, &context, error)) {
    return NO;
  }
  target[@"context"] = context;
  return YES;
}

static NSString *LBWStatusFromStatusCode(NSNumber *_Nullable statusCode) {
  if (statusCode != nil && [statusCode integerValue] >= 400) {
    return @"failure";
  }
  return @"success";
}

static NSString *_Nullable LBWBoundedProductAnalyticsSurface(
    NSDictionary<NSString *, id> *_Nullable context) {
  id routeValue = context[@"routeTemplate"];
  id screenValue = context[@"screen"];
  NSString *surface = nil;
  if ([routeValue isKindOfClass:[NSString class]]) {
    surface = LBWNetworkNormalizedRouteTemplate(
        (NSString *)routeValue,
        @"product routeTemplate",
        nil);
  }
  if (surface == nil && [screenValue isKindOfClass:[NSString class]]) {
    surface = (NSString *)screenValue;
  }
  if (surface == nil) {
    return nil;
  }
  NSString *normalized = [surface stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if ([normalized length] == 0U ||
      [normalized rangeOfCharacterFromSet:[NSCharacterSet controlCharacterSet]].location != NSNotFound) {
    return nil;
  }
  NSUInteger index = 0U;
  NSUInteger characterCount = 0U;
  while (index < [normalized length]) {
    unichar character = [normalized characterAtIndex:index];
    index++;
    if (CFStringIsSurrogateHighCharacter(character) && index < [normalized length] &&
        CFStringIsSurrogateLowCharacter([normalized characterAtIndex:index])) {
      index++;
    }
    characterCount++;
    if (characterCount > 256U) {
      return nil;
    }
  }
  return normalized;
}

static NSString *_Nullable LBWNormalizeMetricDescription(
    NSString *value,
    NSError *_Nullable *_Nullable error) {
  NSString *normalized = [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  NSUInteger index = 0U;
  NSUInteger scalarCount = 0U;
  BOOL invalid = [normalized length] == 0U;
  while (!invalid && index < [normalized length]) {
    unichar first = [normalized characterAtIndex:index++];
    UTF32Char scalar = first;
    if (CFStringIsSurrogateHighCharacter(first)) {
      if (index >= [normalized length]) {
        invalid = YES;
        break;
      }
      unichar second = [normalized characterAtIndex:index++];
      if (!CFStringIsSurrogateLowCharacter(second)) {
        invalid = YES;
        break;
      }
      scalar = CFStringGetLongCharacterForSurrogatePair(first, second);
    } else if (CFStringIsSurrogateLowCharacter(first)) {
      invalid = YES;
      break;
    }
    scalarCount++;
    invalid = scalarCount > 1024U || scalar <= 0x1FU || (scalar >= 0x7FU && scalar <= 0x9FU) ||
        scalar == 0x2028U || scalar == 0x2029U;
  }
  if (invalid) {
    LBWSetError(error, LBWMakeError(
        LBWErrorKindValidation,
        @"validation_error",
        @"metric description must be a non-blank string of at most 1024 non-control characters",
        NO));
    return nil;
  }
  return normalized;
}

@implementation LBWConfig

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _apiKey = @"";
    _sdkName = @"logbrew-objc";
    _sdkVersion = LogBrewObjectiveCVersion;
    _maxRetries = 2U;
    _context = nil;
    _includeAutomaticContext = YES;
  }
  return self;
}

+ (instancetype)configWithAPIKey:(NSString *)apiKey {
  LBWConfig *config = [[LBWConfig alloc] init];
  config.apiKey = apiKey;
  return config;
}

@end

@implementation LBWDurableDeliveryOptions

- (instancetype)initWithDirectoryURL:(NSURL *)directoryURL {
  self = [super init];
  if (self != nil) {
    _directoryURL = [directoryURL copy];
  }
  return self;
}

@end

@implementation LBWTransportResponse

- (instancetype)initWithStatusCode:(NSInteger)statusCode attempts:(NSUInteger)attempts {
  self = [super init];
  if (self != nil) {
    _statusCode = statusCode;
    _attempts = attempts;
  }
  return self;
}

@end

@implementation LBWRecordingStep

+ (instancetype)statusCodeStep:(NSInteger)statusCode {
  LBWRecordingStep *step = [[LBWRecordingStep alloc] init];
  step.errorStep = NO;
  step.statusCode = statusCode;
  step.stableCode = @"transport_error";
  step.message = @"transport failed";
  step.retryable = NO;
  return step;
}

+ (instancetype)networkFailureWithMessage:(NSString *)message {
  LBWRecordingStep *step = [[LBWRecordingStep alloc] init];
  step.errorStep = YES;
  step.statusCode = 0;
  step.stableCode = @"network_failure";
  step.message = message;
  step.retryable = YES;
  return step;
}

@end

@implementation LBWRecordingTransport

- (instancetype)init {
  return [self initWithSteps:nil];
}

- (instancetype)initWithSteps:(NSArray<LBWRecordingStep *> *)steps {
  self = [super init];
  if (self != nil) {
    NSArray<LBWRecordingStep *> *copiedSteps = [steps copy];
    _steps = copiedSteps != nil ? copiedSteps : @[];
    _cursor = 0U;
    _mutableSentBodies = [NSMutableArray array];
  }
  return self;
}

- (NSArray<NSString *> *)sentBodies {
  @synchronized(self) {
    return [self.mutableSentBodies copy];
  }
}

- (NSString *)lastBody {
  @synchronized(self) {
    return [self.mutableSentBodies lastObject];
  }
}

- (LBWTransportResponse *)sendWithAPIKey:(NSString *)apiKey body:(NSString *)body error:(NSError **)error {
  if (!LBWRequireNonEmpty(@"api_key", apiKey, error)) {
    return nil;
  }
  LBWRecordingStep *step;
  @synchronized(self) {
    [self.mutableSentBodies addObject:body];
    step = [LBWRecordingStep statusCodeStep:202];
    if (self.cursor < [self.steps count]) {
      step = self.steps[self.cursor];
      self.cursor += 1U;
    }
  }
  if (step.errorStep) {
    LBWSetError(error, LBWMakeError(LBWErrorKindTransport, step.stableCode, step.message, step.retryable));
    return nil;
  }
  return [[LBWTransportResponse alloc] initWithStatusCode:step.statusCode attempts:1U];
}

@end

@implementation LBWClient

- (instancetype)initWithConfig:(LBWConfig *)config error:(NSError **)error {
  self = [super init];
  if (self == nil) {
    return nil;
  }
  if (!LBWRequireNonEmpty(@"api_key", config.apiKey, error) ||
      !LBWRequireNonEmpty(@"sdk_name", config.sdkName, error) ||
      !LBWRequireNonEmpty(@"sdk_version", config.sdkVersion, error)) {
    return nil;
  }
  _apiKey = [config.apiKey copy];
  _sdkName = [config.sdkName copy];
  _sdkVersion = [config.sdkVersion copy];
  NSDictionary *automaticContext = config.includeAutomaticContext ? LBWAutomaticTelemetryContext() : nil;
  _baseContext = LBWMergeTelemetryContexts(automaticContext, config.context, error);
  if ((automaticContext != nil || config.context != nil) && _baseContext == nil) {
    return nil;
  }
  _breadcrumbs = [NSMutableArray array];
  _breadcrumbsTruncated = NO;
  _deliveryEngine = [[LBWDeliveryEngine alloc] initWithAPIKey:_apiKey
                                                     sdkName:_sdkName
                                                  sdkVersion:_sdkVersion
                                                  maxRetries:config.maxRetries == 0U ? 2U : config.maxRetries];
  return self;
}

- (NSUInteger)pendingEvents {
  return [self.deliveryEngine pendingEvents];
}

- (NSString *)previewJSONWithError:(NSError **)error {
  return [self.deliveryEngine previewJSONWithError:error];
}

- (LBWTransportResponse *)flushWithTransport:(id<LBWTransport>)transport error:(NSError **)error {
  return [self.deliveryEngine flushWithTransport:transport error:error];
}

- (LBWTransportResponse *)shutdownWithTransport:(id<LBWTransport>)transport error:(NSError **)error {
  return [self.deliveryEngine shutdownWithTransport:transport error:error];
}

- (BOOL)startAutomaticDeliveryWithTransport:(id<LBWTransport>)transport
                                    options:(LBWAutomaticDeliveryOptions *)options
                                      error:(NSError **)error {
  return [self.deliveryEngine startAutomaticDeliveryWithTransport:transport options:options error:error];
}

- (BOOL)recoverAutomaticDeliveryWithError:(NSError **)error {
  return [self.deliveryEngine recoverAutomaticDeliveryWithError:error];
}

- (void)stopAutomaticDelivery {
  [self.deliveryEngine stopAutomaticDelivery];
}

- (BOOL)enableDurableDeliveryWithOptions:(LBWDurableDeliveryOptions *)options error:(NSError **)error {
  return [self.deliveryEngine enableDurableDeliveryWithOptions:options error:error];
}

- (BOOL)purgeDurableDeliveryWithError:(NSError **)error {
  return [self.deliveryEngine purgeDurableDeliveryWithError:error];
}

- (LBWDeliveryHealth *)deliveryHealth {
  return [self.deliveryEngine health];
}

- (LBWTransportResponse *)flushOwnedTransportWithError:(NSError **)error {
  return [self.deliveryEngine flushOwnedTransportWithError:error];
}

- (LBWTransportResponse *)shutdownOwnedTransportWithError:(NSError **)error {
  return [self.deliveryEngine shutdownOwnedTransportWithError:error];
}

- (BOOL)addBreadcrumb:(NSDictionary<NSString *, id> *)breadcrumb error:(NSError **)error {
  NSDictionary<NSString *, id> *clean = nil;
  if (!LBWValidateIssueBreadcrumb(breadcrumb, &clean, error)) {
    return NO;
  }
  @synchronized(self.breadcrumbs) {
    if ([self.breadcrumbs count] == 64U) {
      [self.breadcrumbs removeObjectAtIndex:0U];
      self.breadcrumbsTruncated = YES;
    }
    [self.breadcrumbs addObject:clean];
  }
  return YES;
}

- (void)clearBreadcrumbs {
  @synchronized(self.breadcrumbs) {
    [self.breadcrumbs removeAllObjects];
    self.breadcrumbsTruncated = NO;
  }
}

- (BOOL)releaseWithID:(NSString *)eventID
            timestamp:(NSString *)timestamp
           attributes:(NSDictionary<NSString *, id> *)attributes
                error:(NSError **)error {
  NSMutableDictionary<NSString *, id> *clean = [NSMutableDictionary dictionary];
  NSString *version = LBWStringAttribute(attributes, @"version", @"release version", YES, YES, error);
  if (version == nil) {
    return NO;
  }
  clean[@"version"] = version;
  NSString *commit = LBWStringAttribute(attributes, @"commit", @"commit", NO, YES, error);
  if (commit == nil && attributes[@"commit"] != nil) {
    return NO;
  }
  if (commit != nil) {
    clean[@"commit"] = commit;
  }
  NSString *notes = LBWStringAttribute(attributes, @"notes", @"notes", NO, NO, error);
  if (notes == nil && attributes[@"notes"] != nil) {
    return NO;
  }
  if (notes != nil) {
    clean[@"notes"] = notes;
  }
  NSDictionary<NSString *, id> *metadata = LBWMetadataAttribute(attributes, @"metadata", @"release metadata", error);
  if (metadata == nil && attributes[@"metadata"] != nil) {
    return NO;
  }
  if (metadata != nil) {
    clean[@"metadata"] = metadata;
  }
  if (!LBWCopyContextAttribute(clean, attributes, @"release telemetry context", error)) {
    return NO;
  }
  return [self pushEventWithType:@"release" eventID:eventID timestamp:timestamp attributes:clean error:error];
}

- (BOOL)environmentWithID:(NSString *)eventID
                timestamp:(NSString *)timestamp
               attributes:(NSDictionary<NSString *, id> *)attributes
                    error:(NSError **)error {
  NSMutableDictionary<NSString *, id> *clean = [NSMutableDictionary dictionary];
  NSString *name = LBWStringAttribute(attributes, @"name", @"environment name", YES, YES, error);
  if (name == nil) {
    return NO;
  }
  clean[@"name"] = name;
  NSString *region = LBWStringAttribute(attributes, @"region", @"region", NO, NO, error);
  if (region == nil && attributes[@"region"] != nil) {
    return NO;
  }
  if (region != nil) {
    clean[@"region"] = region;
  }
  NSDictionary<NSString *, id> *metadata = LBWMetadataAttribute(attributes, @"metadata", @"environment metadata", error);
  if (metadata == nil && attributes[@"metadata"] != nil) {
    return NO;
  }
  if (metadata != nil) {
    clean[@"metadata"] = metadata;
  }
  if (!LBWCopyContextAttribute(clean, attributes, @"environment telemetry context", error)) {
    return NO;
  }
  return [self pushEventWithType:@"environment" eventID:eventID timestamp:timestamp attributes:clean error:error];
}

- (BOOL)issueWithID:(NSString *)eventID
          timestamp:(NSString *)timestamp
         attributes:(NSDictionary<NSString *, id> *)attributes
              error:(NSError **)error {
  NSMutableDictionary<NSString *, id> *clean = [NSMutableDictionary dictionary];
  NSString *title = LBWStringAttribute(attributes, @"title", @"issue title", YES, YES, error);
  NSString *level = LBWStringAttribute(attributes, @"level", @"issue level", YES, YES, error);
  NSString *normalizedLevel = level == nil ? nil : LBWNormalizeSeverity(@"issue level", level, error);
  if (title == nil || normalizedLevel == nil) {
    return NO;
  }
  clean[@"title"] = title;
  clean[@"level"] = normalizedLevel;
  NSString *message = LBWStringAttribute(attributes, @"message", @"message", NO, NO, error);
  if (message == nil && attributes[@"message"] != nil) {
    return NO;
  }
  if (message != nil) {
    clean[@"message"] = message;
  }
  if (attributes[@"exception"] != nil) {
    NSDictionary<NSString *, id> *exception = nil;
    if (!LBWValidateIssueException(attributes[@"exception"], &exception, error)) {
      return NO;
    }
    clean[@"exception"] = exception;
  }
  if (attributes[@"stackFrames"] != nil) {
    NSArray<NSDictionary<NSString *, id> *> *stackFrames = nil;
    if (!LBWValidateIssueStackFrames(attributes[@"stackFrames"], &stackFrames, error)) {
      return NO;
    }
    clean[@"stackFrames"] = stackFrames;
  }
  NSArray<NSDictionary<NSString *, id> *> *storedBreadcrumbs;
  BOOL storedTruncated;
  @synchronized(self.breadcrumbs) {
    storedBreadcrumbs = [self.breadcrumbs copy];
    storedTruncated = self.breadcrumbsTruncated;
  }
  NSArray<NSDictionary<NSString *, id> *> *explicitBreadcrumbs = nil;
  BOOL explicitTruncated = NO;
  if (attributes[@"breadcrumbs"] != nil &&
      !LBWValidateIssueBreadcrumbs(attributes[@"breadcrumbs"], &explicitBreadcrumbs, &explicitTruncated, error)) {
    return NO;
  }
  BOOL requestedTruncated = NO;
  if (attributes[@"breadcrumbsTruncated"] != nil) {
    if (!LBWIsBoolean(attributes[@"breadcrumbsTruncated"])) {
      LBWSetError(error, LBWMakeError(
          LBWErrorKindValidation, @"validation_error", @"issue breadcrumbsTruncated must be a boolean", NO));
      return NO;
    }
    requestedTruncated = [attributes[@"breadcrumbsTruncated"] boolValue];
  }
  NSMutableArray<NSDictionary<NSString *, id> *> *combinedBreadcrumbs = [NSMutableArray arrayWithArray:storedBreadcrumbs];
  if (explicitBreadcrumbs != nil) {
    [combinedBreadcrumbs addObjectsFromArray:explicitBreadcrumbs];
  }
  BOOL combinedTruncated = [combinedBreadcrumbs count] > 64U;
  if (combinedTruncated) {
    NSRange retainedRange = NSMakeRange([combinedBreadcrumbs count] - 64U, 64U);
    combinedBreadcrumbs = [[combinedBreadcrumbs subarrayWithRange:retainedRange] mutableCopy];
  }
  if ([combinedBreadcrumbs count] > 0U) {
    clean[@"breadcrumbs"] = [combinedBreadcrumbs copy];
  }
  if (storedTruncated || explicitTruncated || combinedTruncated || requestedTruncated) {
    clean[@"breadcrumbsTruncated"] = @YES;
  }
  NSDictionary<NSString *, id> *metadata = LBWMetadataAttribute(attributes, @"metadata", @"issue metadata", error);
  if (metadata == nil && attributes[@"metadata"] != nil) {
    return NO;
  }
  if (metadata != nil) {
    clean[@"metadata"] = metadata;
  }
  if (!LBWCopyContextAttribute(clean, attributes, @"issue telemetry context", error)) {
    return NO;
  }
  return [self pushEventWithType:@"issue" eventID:eventID timestamp:timestamp attributes:clean error:error];
}

- (BOOL)logWithID:(NSString *)eventID
        timestamp:(NSString *)timestamp
       attributes:(NSDictionary<NSString *, id> *)attributes
            error:(NSError **)error {
  NSMutableDictionary<NSString *, id> *clean = [NSMutableDictionary dictionary];
  NSString *message = LBWStringAttribute(attributes, @"message", @"log message", YES, YES, error);
  NSString *level = LBWStringAttribute(attributes, @"level", @"log level", YES, YES, error);
  NSString *normalizedLevel = level == nil ? nil : LBWNormalizeSeverity(@"log level", level, error);
  if (message == nil || normalizedLevel == nil) {
    return NO;
  }
  clean[@"message"] = message;
  clean[@"level"] = normalizedLevel;
  NSString *logger = LBWStringAttribute(attributes, @"logger", @"logger", NO, NO, error);
  if (logger == nil && attributes[@"logger"] != nil) {
    return NO;
  }
  if (logger != nil) {
    clean[@"logger"] = logger;
  }
  NSDictionary<NSString *, id> *metadata = LBWMetadataAttribute(attributes, @"metadata", @"log metadata", error);
  if (metadata == nil && attributes[@"metadata"] != nil) {
    return NO;
  }
  if (metadata != nil) {
    clean[@"metadata"] = metadata;
  }
  if (!LBWCopyContextAttribute(clean, attributes, @"log telemetry context", error)) {
    return NO;
  }
  return [self pushEventWithType:@"log" eventID:eventID timestamp:timestamp attributes:clean error:error];
}

- (BOOL)spanWithID:(NSString *)eventID
         timestamp:(NSString *)timestamp
        attributes:(NSDictionary<NSString *, id> *)attributes
             error:(NSError **)error {
  NSMutableDictionary<NSString *, id> *clean = [NSMutableDictionary dictionary];
  NSString *name = LBWStringAttribute(attributes, @"name", @"span name", YES, YES, error);
  NSString *traceID = LBWStringAttribute(attributes, @"traceId", @"span traceId", YES, YES, error);
  NSString *spanID = LBWStringAttribute(attributes, @"spanId", @"span spanId", YES, YES, error);
  NSString *status = LBWStringAttribute(attributes, @"status", @"span status", YES, YES, error);
  if (name == nil || traceID == nil || spanID == nil || status == nil ||
      !LBWRequireAllowed(@"span status", status, @[@"ok", @"error"], error)) {
    return NO;
  }
  clean[@"name"] = name;
  clean[@"traceId"] = traceID;
  clean[@"spanId"] = spanID;
  NSString *parentSpanID = LBWStringAttribute(attributes, @"parentSpanId", @"parentSpanId", NO, YES, error);
  if (parentSpanID == nil && attributes[@"parentSpanId"] != nil) {
    return NO;
  }
  if (parentSpanID != nil) {
    clean[@"parentSpanId"] = parentSpanID;
  }
  clean[@"status"] = status;
  NSNumber *durationMs = LBWNumberAttribute(attributes, @"durationMs", @"span durationMs", error);
  if (durationMs == nil && attributes[@"durationMs"] != nil) {
    return NO;
  }
  if (durationMs != nil) {
    clean[@"durationMs"] = durationMs;
  }
  if (attributes[@"events"] != nil) {
    NSArray<NSDictionary<NSString *, id> *> *events = nil;
    if (!LBWValidateSpanEvents(attributes[@"events"], &events, error)) {
      return NO;
    }
    clean[@"events"] = events;
  }
  if (attributes[@"links"] != nil) {
    NSArray<NSDictionary<NSString *, id> *> *links = nil;
    if (!LBWValidateSpanLinks(attributes[@"links"], &links, error)) {
      return NO;
    }
    clean[@"links"] = links;
  }
  NSDictionary<NSString *, id> *metadata = LBWMetadataAttribute(attributes, @"metadata", @"span metadata", error);
  if (metadata == nil && attributes[@"metadata"] != nil) {
    return NO;
  }
  if (metadata != nil) {
    clean[@"metadata"] = metadata;
  }
  if (!LBWCopyContextAttribute(clean, attributes, @"span telemetry context", error)) {
    return NO;
  }
  return [self pushEventWithType:@"span" eventID:eventID timestamp:timestamp attributes:clean error:error];
}

- (BOOL)actionWithID:(NSString *)eventID
           timestamp:(NSString *)timestamp
          attributes:(NSDictionary<NSString *, id> *)attributes
               error:(NSError **)error {
  NSMutableDictionary<NSString *, id> *clean = [NSMutableDictionary dictionary];
  NSString *name = LBWStringAttribute(attributes, @"name", @"action name", YES, YES, error);
  NSString *status = LBWStringAttribute(attributes, @"status", @"action status", YES, YES, error);
  if (name == nil || status == nil ||
      !LBWRequireAllowed(@"action status", status, @[@"queued", @"running", @"success", @"failure"], error)) {
    return NO;
  }
  clean[@"name"] = name;
  clean[@"status"] = status;
  NSDictionary<NSString *, id> *metadata = LBWMetadataAttribute(attributes, @"metadata", @"action metadata", error);
  if (metadata == nil && attributes[@"metadata"] != nil) {
    return NO;
  }
  if (metadata != nil) {
    clean[@"metadata"] = metadata;
  }
  if (!LBWCopyContextAttribute(clean, attributes, @"action telemetry context", error)) {
    return NO;
  }
  return [self pushEventWithType:@"action" eventID:eventID timestamp:timestamp attributes:clean error:error];
}

- (BOOL)metricWithID:(NSString *)eventID
           timestamp:(NSString *)timestamp
          attributes:(NSDictionary<NSString *, id> *)attributes
               error:(NSError **)error {
  NSMutableDictionary<NSString *, id> *clean = [NSMutableDictionary dictionary];
  NSString *name = LBWStringAttribute(attributes, @"name", @"metric name", YES, YES, error);
  NSString *description = LBWStringAttribute(attributes, @"description", @"metric description", NO, YES, error);
  if (description == nil && attributes[@"description"] != nil) {
    return NO;
  }
  if (description != nil) {
    description = LBWNormalizeMetricDescription(description, error);
    if (description == nil) {
      return NO;
    }
  }
  NSString *kind = LBWStringAttribute(attributes, @"kind", @"metric kind", YES, YES, error);
  NSNumber *value = LBWFiniteNumberAttribute(attributes, @"value", @"metric value", error);
  NSString *unit = LBWStringAttribute(attributes, @"unit", @"metric unit", YES, YES, error);
  NSString *temporality = LBWStringAttribute(attributes, @"temporality", @"metric temporality", YES, YES, error);
  if (name == nil || kind == nil || value == nil || unit == nil || temporality == nil ||
      !LBWRequireAllowed(@"metric kind", kind, @[@"counter", @"gauge", @"histogram"], error)) {
    return NO;
  }
  if ([kind isEqualToString:@"gauge"]) {
    if (!LBWRequireAllowed(@"metric temporality", temporality, @[@"instant"], error)) {
      return NO;
    }
  } else {
    if (!LBWRequireAllowed(@"metric temporality", temporality, @[@"delta", @"cumulative"], error)) {
      return NO;
    }
    if ([value doubleValue] < 0.0) {
      LBWSetError(error, LBWMakeError(
          LBWErrorKindValidation,
          @"validation_error",
          @"metric value must be non-negative for counter and histogram metrics",
          NO));
      return NO;
    }
  }
  clean[@"name"] = name;
  if (description != nil) {
    clean[@"description"] = description;
  }
  clean[@"kind"] = kind;
  clean[@"value"] = value;
  clean[@"unit"] = unit;
  clean[@"temporality"] = temporality;
  NSDictionary<NSString *, id> *metadata = LBWMetadataAttribute(attributes, @"metadata", @"metric metadata", error);
  if (metadata == nil && attributes[@"metadata"] != nil) {
    return NO;
  }
  if (metadata != nil) {
    clean[@"metadata"] = metadata;
  }
  if (!LBWCopyContextAttribute(clean, attributes, @"metric telemetry context", error)) {
    return NO;
  }
  return [self pushEventWithType:@"metric" eventID:eventID timestamp:timestamp attributes:clean error:error];
}

- (BOOL)captureProductActionWithID:(NSString *)eventID
                          timestamp:(NSString *)timestamp
                               name:(NSString *)name
                             status:(NSString *)status
                            context:(NSDictionary<NSString *, id> *)context
                           metadata:(NSDictionary<NSString *, id> *)metadata
                              error:(NSError **)error {
  NSMutableDictionary<NSString *, id> *timelineMetadata = [NSMutableDictionary dictionary];
  if (!LBWCopyMetadata(timelineMetadata, context, @"product action context", error) ||
      !LBWCopyMetadata(timelineMetadata, metadata, @"product action metadata", error)) {
    return NO;
  }
  timelineMetadata[@"source"] = @"objc.action";
  timelineMetadata[@"analyticsSchemaVersion"] = @1;
  timelineMetadata[@"analyticsKind"] = @"interaction";
  NSString *analyticsSurface = LBWBoundedProductAnalyticsSurface(context);
  if (analyticsSurface == nil) {
    [timelineMetadata removeObjectForKey:@"analyticsSurface"];
  } else {
    timelineMetadata[@"analyticsSurface"] = analyticsSurface;
  }
  return [self actionWithID:eventID
                 timestamp:timestamp
                attributes:@{
                  @"name": name,
                  @"status": status != nil ? status : @"success",
                  @"metadata": timelineMetadata
                }
                     error:error];
}

- (BOOL)captureNetworkMilestoneWithID:(NSString *)eventID
                             timestamp:(NSString *)timestamp
                                method:(NSString *)method
                         routeTemplate:(NSString *)routeTemplate
                            statusCode:(NSNumber *)statusCode
                            durationMs:(NSNumber *)durationMs
                                status:(NSString *)status
                               context:(NSDictionary<NSString *, id> *)context
                              metadata:(NSDictionary<NSString *, id> *)metadata
                                 error:(NSError **)error {
  NSString *normalizedMethod = LBWNetworkNormalizedMethod(method, @"network method", nil, error);
  NSString *normalizedRoute = LBWNetworkNormalizedRouteTemplate(routeTemplate, @"network routeTemplate", error);
  NSNumber *checkedStatusCode = LBWNetworkValidatedStatusCode(statusCode, @"network statusCode", error);
  NSNumber *checkedDurationMs = LBWNetworkValidatedDurationMs(durationMs, @"network durationMs", error);
  if (normalizedMethod == nil || normalizedRoute == nil ||
      (statusCode != nil && checkedStatusCode == nil) ||
      (durationMs != nil && checkedDurationMs == nil)) {
    return NO;
  }
  NSMutableDictionary<NSString *, id> *timelineMetadata = [NSMutableDictionary dictionary];
  if (!LBWCopyMetadata(timelineMetadata, context, @"network milestone context", error) ||
      !LBWCopyMetadata(timelineMetadata, metadata, @"network milestone metadata", error)) {
    return NO;
  }
  timelineMetadata[@"source"] = @"objc.network";
  timelineMetadata[@"method"] = normalizedMethod;
  timelineMetadata[@"routeTemplate"] = normalizedRoute;
  if (checkedStatusCode != nil) {
    timelineMetadata[@"statusCode"] = checkedStatusCode;
  }
  if (checkedDurationMs != nil) {
    timelineMetadata[@"durationMs"] = checkedDurationMs;
  }
  NSString *name = [NSString stringWithFormat:@"%@ %@", normalizedMethod, normalizedRoute];
  return [self actionWithID:eventID
                 timestamp:timestamp
                attributes:@{
                  @"name": name,
                  @"status": status != nil ? status : LBWStatusFromStatusCode(checkedStatusCode),
                  @"metadata": timelineMetadata
                }
                     error:error];
}

- (BOOL)pushEventWithType:(NSString *)type
                  eventID:(NSString *)eventID
                timestamp:(NSString *)timestamp
               attributes:(NSDictionary<NSString *, id> *)attributes
                    error:(NSError *_Nullable *_Nullable)error {
  if (!LBWRequireNonEmpty(@"id", eventID, error) || !LBWRequireTimestamp(timestamp, error)) {
    return NO;
  }
  NSMutableDictionary<NSString *, id> *resolvedAttributes = [attributes mutableCopy];
  NSDictionary<NSString *, id> *eventContext = resolvedAttributes[@"context"];
  [resolvedAttributes removeObjectForKey:@"context"];
  NSDictionary<NSString *, id> *context = self.baseContext;
  NSDictionary<NSString *, id> *ambientContext = [LBWTelemetry currentContext];
  if (ambientContext != nil) {
    context = LBWMergeTelemetryContexts(context, ambientContext, error);
    if (context == nil) {
      return NO;
    }
  }
  LBWTraceContext *activeTrace = [LBWTrace currentContext];
  if (activeTrace != nil) {
    context = LBWMergeTelemetryContexts(context, LBWTelemetryContextFromTrace(activeTrace), error);
    if (context == nil) {
      return NO;
    }
  }
  if (eventContext != nil) {
    context = LBWMergeTelemetryContexts(context, eventContext, error);
    if (context == nil) {
      return NO;
    }
  }
  if ([type isEqualToString:@"span"]) {
    NSMutableDictionary<NSString *, id> *trace = [@{
      @"traceId": resolvedAttributes[@"traceId"],
      @"spanId": resolvedAttributes[@"spanId"]
    } mutableCopy];
    if (resolvedAttributes[@"parentSpanId"] != nil) {
      trace[@"parentSpanId"] = resolvedAttributes[@"parentSpanId"];
    }
    NSDictionary *inheritedTrace = context[@"trace"];
    if (inheritedTrace != nil &&
        [inheritedTrace[@"traceId"] caseInsensitiveCompare:resolvedAttributes[@"traceId"]] == NSOrderedSame &&
        inheritedTrace[@"sampled"] != nil) {
      trace[@"sampled"] = inheritedTrace[@"sampled"];
    }
    NSDictionary<NSString *, id> *validatedSpanContext = nil;
    NSError *ignoredSpanContextError = nil;
    BOOL hasTypedSpanContext = LBWValidateTelemetryContext(
        @{@"schemaVersion": @1, @"trace": trace},
        @"span telemetry context",
        &validatedSpanContext,
        &ignoredSpanContextError);
    context = LBWTelemetryContextByReplacingTrace(
        context, hasTypedSpanContext ? validatedSpanContext[@"trace"] : nil);
  }
  if (context != nil) {
    resolvedAttributes[@"context"] = context;
  }
  if ([type isEqualToString:@"issue"] || [type isEqualToString:@"log"] ||
      [type isEqualToString:@"action"] || [type isEqualToString:@"metric"]) {
    NSDictionary *trace = context[@"trace"];
    if (trace != nil) {
      NSMutableDictionary *metadata = resolvedAttributes[@"metadata"] != nil
          ? [resolvedAttributes[@"metadata"] mutableCopy]
          : [NSMutableDictionary dictionary];
      metadata[@"traceId"] = trace[@"traceId"];
      if (trace[@"spanId"] != nil) {
        metadata[@"spanId"] = trace[@"spanId"];
      }
      if (trace[@"parentSpanId"] != nil) {
        metadata[@"parentSpanId"] = trace[@"parentSpanId"];
      }
      BOOL activeTraceMatches = activeTrace != nil &&
          [activeTrace.traceID caseInsensitiveCompare:trace[@"traceId"]] == NSOrderedSame &&
          (trace[@"spanId"] == nil ||
              [activeTrace.spanID caseInsensitiveCompare:trace[@"spanId"]] == NSOrderedSame) &&
          (trace[@"sampled"] == nil || [trace[@"sampled"] boolValue] == activeTrace.sampled);
      if (activeTraceMatches) {
        metadata[@"traceFlags"] = activeTrace.traceFlags;
        metadata[@"traceSampled"] = @(activeTrace.sampled);
      } else if (trace[@"sampled"] != nil) {
        metadata[@"traceSampled"] = trace[@"sampled"];
      }
      resolvedAttributes[@"metadata"] = [metadata copy];
    }
  }
  return [self.deliveryEngine enqueueEvent:@{
    @"type": type,
    @"timestamp": timestamp,
    @"id": eventID,
    @"attributes": [resolvedAttributes copy]
  } error:error];
}

@end
