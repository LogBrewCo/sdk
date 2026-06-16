#import "LogBrew.h"

#import "LogBrewNetworkValidation.h"

#import <math.h>

NSString *const LogBrewObjectiveCVersion = @"0.1.0";
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
@property(nonatomic) NSUInteger maxRetries;
@property(nonatomic) BOOL closed;
@property(nonatomic) NSMutableArray<NSDictionary<NSString *, id> *> *events;

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

static NSString *LBWStatusFromStatusCode(NSNumber *_Nullable statusCode) {
  if (statusCode != nil && [statusCode integerValue] >= 400) {
    return @"failure";
  }
  return @"success";
}

@implementation LBWConfig

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _apiKey = @"";
    _sdkName = @"logbrew-objc";
    _sdkVersion = LogBrewObjectiveCVersion;
    _maxRetries = 2U;
  }
  return self;
}

+ (instancetype)configWithAPIKey:(NSString *)apiKey {
  LBWConfig *config = [[LBWConfig alloc] init];
  config.apiKey = apiKey;
  return config;
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
  return [self.mutableSentBodies copy];
}

- (NSString *)lastBody {
  return [self.mutableSentBodies lastObject];
}

- (LBWTransportResponse *)sendWithAPIKey:(NSString *)apiKey body:(NSString *)body error:(NSError **)error {
  if (!LBWRequireNonEmpty(@"api_key", apiKey, error)) {
    return nil;
  }
  [self.mutableSentBodies addObject:body];
  LBWRecordingStep *step = [LBWRecordingStep statusCodeStep:202];
  if (self.cursor < [self.steps count]) {
    step = self.steps[self.cursor];
    self.cursor += 1U;
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
  _maxRetries = config.maxRetries == 0U ? 2U : config.maxRetries;
  _closed = NO;
  _events = [NSMutableArray array];
  return self;
}

- (NSUInteger)pendingEvents {
  return [self.events count];
}

- (NSString *)previewJSONWithError:(NSError **)error {
  NSDictionary<NSString *, id> *payload = @{
    @"sdk": @{
      @"name": self.sdkName,
      @"language": @"objc",
      @"version": self.sdkVersion
    },
    @"events": self.events
  };
  NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:error];
  if (json == nil) {
    return nil;
  }
  return [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
}

- (LBWTransportResponse *)flushWithTransport:(id<LBWTransport>)transport error:(NSError **)error {
  if (self.closed) {
    LBWSetError(error, LBWMakeError(
        LBWErrorKindShutdown, @"shutdown_error", @"client is already shut down", NO));
    return nil;
  }
  return [self flushInternalWithTransport:transport error:error];
}

- (LBWTransportResponse *)shutdownWithTransport:(id<LBWTransport>)transport error:(NSError **)error {
  if (self.closed) {
    LBWSetError(error, LBWMakeError(
        LBWErrorKindShutdown, @"shutdown_error", @"client is already shut down", NO));
    return nil;
  }
  LBWTransportResponse *response = [self flushInternalWithTransport:transport error:error];
  if (response == nil) {
    return nil;
  }
  self.closed = YES;
  return response;
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
  NSDictionary<NSString *, id> *metadata = LBWMetadataAttribute(attributes, @"metadata", @"issue metadata", error);
  if (metadata == nil && attributes[@"metadata"] != nil) {
    return NO;
  }
  NSDictionary<NSString *, id> *traceMetadata = [LBWTrace metadataByMergingActiveContextIntoMetadata:metadata];
  if (traceMetadata != nil) {
    clean[@"metadata"] = traceMetadata;
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
  NSDictionary<NSString *, id> *traceMetadata = [LBWTrace metadataByMergingActiveContextIntoMetadata:metadata];
  if (traceMetadata != nil) {
    clean[@"metadata"] = traceMetadata;
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
  NSDictionary<NSString *, id> *metadata = LBWMetadataAttribute(attributes, @"metadata", @"span metadata", error);
  if (metadata == nil && attributes[@"metadata"] != nil) {
    return NO;
  }
  if (metadata != nil) {
    clean[@"metadata"] = metadata;
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
  NSDictionary<NSString *, id> *traceMetadata = [LBWTrace metadataByMergingActiveContextIntoMetadata:metadata];
  if (traceMetadata != nil) {
    clean[@"metadata"] = traceMetadata;
  }
  return [self pushEventWithType:@"action" eventID:eventID timestamp:timestamp attributes:clean error:error];
}

- (BOOL)metricWithID:(NSString *)eventID
           timestamp:(NSString *)timestamp
          attributes:(NSDictionary<NSString *, id> *)attributes
               error:(NSError **)error {
  NSMutableDictionary<NSString *, id> *clean = [NSMutableDictionary dictionary];
  NSString *name = LBWStringAttribute(attributes, @"name", @"metric name", YES, YES, error);
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
  clean[@"kind"] = kind;
  clean[@"value"] = value;
  clean[@"unit"] = unit;
  clean[@"temporality"] = temporality;
  NSDictionary<NSString *, id> *metadata = LBWMetadataAttribute(attributes, @"metadata", @"metric metadata", error);
  if (metadata == nil && attributes[@"metadata"] != nil) {
    return NO;
  }
  NSDictionary<NSString *, id> *traceMetadata = [LBWTrace metadataByMergingActiveContextIntoMetadata:metadata];
  if (traceMetadata != nil) {
    clean[@"metadata"] = traceMetadata;
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
  if (self.closed) {
    LBWSetError(error, LBWMakeError(
        LBWErrorKindShutdown, @"shutdown_error", @"client is already shut down", NO));
    return NO;
  }
  if (!LBWRequireNonEmpty(@"id", eventID, error) || !LBWRequireTimestamp(timestamp, error)) {
    return NO;
  }
  [self.events addObject:@{
    @"type": type,
    @"timestamp": timestamp,
    @"id": eventID,
    @"attributes": attributes
  }];
  return YES;
}

- (LBWTransportResponse *)flushInternalWithTransport:(id<LBWTransport>)transport error:(NSError **)error {
  if ([self.events count] == 0U) {
    return [[LBWTransportResponse alloc] initWithStatusCode:204 attempts:0U];
  }
  NSString *body = [self previewJSONWithError:error];
  if (body == nil) {
    return nil;
  }
  NSUInteger maxAttempts = self.maxRetries + 1U;
  for (NSUInteger attempt = 1U; attempt <= maxAttempts; attempt += 1U) {
    NSError *transportError = nil;
    LBWTransportResponse *response = [transport sendWithAPIKey:self.apiKey body:body error:&transportError];
    if (response == nil) {
      NSString *stableCode = transportError.userInfo[LBWErrorStableCodeKey];
      if (stableCode == nil) {
        stableCode = @"transport_error";
      }
      BOOL retryable = [transportError.userInfo[LBWErrorRetryableKey] boolValue];
      if (retryable && attempt < maxAttempts) {
        continue;
      }
      NSString *message = [transportError localizedDescription];
      if (message == nil) {
        message = @"transport failed";
      }
      LBWSetError(error, LBWMakeError(LBWErrorKindTransport, stableCode, message, retryable));
      return nil;
    }
    response.attempts = attempt;
    if (response.statusCode == 401) {
      LBWSetError(error, LBWMakeError(
          LBWErrorKindTransport, @"unauthenticated", @"transport rejected the API key", NO));
      return nil;
    }
    if (response.statusCode >= 200 && response.statusCode < 300) {
      [self.events removeAllObjects];
      return response;
    }
    if (response.statusCode >= 500 && attempt < maxAttempts) {
      continue;
    }
    LBWSetError(error, LBWMakeError(
        LBWErrorKindTransport, @"transport_error", @"unexpected transport status", NO));
    return nil;
  }
  LBWSetError(error, LBWMakeError(
      LBWErrorKindTransport, @"transport_error", @"exhausted retry budget", NO));
  return nil;
}

@end
