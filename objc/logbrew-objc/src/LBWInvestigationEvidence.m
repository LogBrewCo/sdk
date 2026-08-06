#import "LBWInvestigationEvidence.h"

#import "LBWTelemetryContext.h"

#import <math.h>

static NSError *LBWEvidenceError(NSString *message) {
  return [NSError errorWithDomain:LBWErrorDomain
                             code:LBWErrorKindValidation
                         userInfo:@{
                           LBWErrorStableCodeKey: @"validation_error",
                           LBWErrorRetryableKey: @NO,
                           NSLocalizedDescriptionKey: message
                         }];
}

static BOOL LBWEvidenceFail(NSError *_Nullable *_Nullable error, NSString *message) {
  if (error != NULL) {
    *error = LBWEvidenceError(message);
  }
  return NO;
}

static BOOL LBWEvidenceIsBoolean(id value) {
  return [value isKindOfClass:[NSNumber class]] &&
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static NSString *_Nullable LBWEvidenceString(
    id value,
    NSString *label,
    NSUInteger maximum,
    BOOL disallowLocationDelimiters,
    NSError *_Nullable *_Nullable error) {
  if (![value isKindOfClass:[NSString class]]) {
    LBWEvidenceFail(error, [NSString stringWithFormat:@"%@ must be a string", label]);
    return nil;
  }
  NSString *normalized = [(NSString *)value stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
  BOOL hasLocationDelimiter = [normalized rangeOfString:@"?"].location != NSNotFound ||
      [normalized rangeOfString:@"#"].location != NSNotFound;
  if ([normalized length] == 0U || [normalized length] > maximum ||
      [normalized rangeOfCharacterFromSet:[NSCharacterSet controlCharacterSet]].location != NSNotFound ||
      (disallowLocationDelimiters && hasLocationDelimiter)) {
    LBWEvidenceFail(error, [NSString stringWithFormat:@"%@ is invalid", label]);
    return nil;
  }
  return normalized;
}

static BOOL LBWEvidenceMachineKey(NSString *value, NSUInteger maximum, NSString *separators) {
  if ([value length] == 0U || [value length] > maximum) {
    return NO;
  }
  for (NSUInteger index = 0U; index < [value length]; index++) {
    unichar character = [value characterAtIndex:index];
    BOOL isLetter = (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z');
    BOOL isNumber = character >= '0' && character <= '9';
    BOOL isSeparator = index > 0U &&
        [separators rangeOfString:[NSString stringWithCharacters:&character length:1U]].location != NSNotFound;
    if (!isLetter && !(index > 0U && isNumber) && !isSeparator) {
      return NO;
    }
  }
  return YES;
}

static BOOL LBWEvidenceAllowedKeys(
    NSDictionary *value,
    NSArray<NSString *> *allowed,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSSet<NSString *> *allowedKeys = [NSSet setWithArray:allowed];
  for (id key in value) {
    if (![key isKindOfClass:[NSString class]] || ![allowedKeys containsObject:key]) {
      return LBWEvidenceFail(error, [NSString stringWithFormat:@"%@ contains an unsupported field", label]);
    }
  }
  return YES;
}

static NSDictionary *_Nullable LBWEvidenceDictionary(
    id value,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  if (![value isKindOfClass:[NSDictionary class]]) {
    LBWEvidenceFail(error, [NSString stringWithFormat:@"%@ must be a dictionary", label]);
    return nil;
  }
  return value;
}

static NSString *_Nullable LBWEvidenceTimestamp(
    id value,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSString *timestamp = LBWEvidenceString(value, label, 256U, NO, error);
  if (timestamp == nil) {
    return nil;
  }
  NSRange separator = [timestamp rangeOfString:@"T"];
  if (separator.location == NSNotFound) {
    LBWEvidenceFail(error, [label stringByAppendingString:@" must include a time separator"]);
    return nil;
  }
  NSString *timePart = [timestamp substringFromIndex:separator.location + 1U];
  if (![timestamp hasSuffix:@"Z"] && [timePart rangeOfString:@"+"].location == NSNotFound &&
      [timePart rangeOfString:@"-"].location == NSNotFound) {
    LBWEvidenceFail(error, [label stringByAppendingString:@" must include a timezone offset"]);
    return nil;
  }
  return timestamp;
}

static NSDictionary *_Nullable LBWValidatePrimitiveMetadata(
    id rawValue,
    NSString *label,
    NSUInteger maximumEntries,
    BOOL boundedStrings,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *value = LBWEvidenceDictionary(rawValue, label, error);
  if (value == nil) {
    return nil;
  }
  if (maximumEntries > 0U && [value count] > maximumEntries) {
    LBWEvidenceFail(error, [NSString stringWithFormat:@"%@ must contain at most %lu entries", label, (unsigned long)maximumEntries]);
    return nil;
  }
  NSMutableDictionary *clean = [NSMutableDictionary dictionary];
  for (id rawKey in value) {
    if (![rawKey isKindOfClass:[NSString class]] ||
        (boundedStrings && !LBWEvidenceMachineKey(rawKey, 64U, @"_.-")) ||
        (!boundedStrings && [(NSString *)rawKey length] == 0U)) {
      LBWEvidenceFail(error, [label stringByAppendingString:@" key is invalid"]);
      return nil;
    }
    id item = value[rawKey];
    if ([item isKindOfClass:[NSNull class]] || LBWEvidenceIsBoolean(item)) {
      clean[rawKey] = item;
    } else if ([item isKindOfClass:[NSString class]]) {
      if (boundedStrings) {
        NSString *string = LBWEvidenceString(
            item, [NSString stringWithFormat:@"%@ value for %@", label, rawKey], 256U, NO, error);
        if (string == nil) {
          return nil;
        }
        clean[rawKey] = string;
      } else {
        clean[rawKey] = item;
      }
    } else if ([item isKindOfClass:[NSNumber class]] && isfinite([item doubleValue])) {
      clean[rawKey] = item;
    } else {
      LBWEvidenceFail(error, [label stringByAppendingString:@" values must be finite primitives"]);
      return nil;
    }
  }
  return [clean copy];
}

static NSNumber *_Nullable LBWEvidencePositiveInteger(
    id value,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  if (![value isKindOfClass:[NSNumber class]] || LBWEvidenceIsBoolean(value)) {
    LBWEvidenceFail(error, [label stringByAppendingString:@" must be a positive 32-bit integer"]);
    return nil;
  }
  double number = [value doubleValue];
  if (!isfinite(number) || number < 1.0 || number > 2147483647.0 || floor(number) != number) {
    LBWEvidenceFail(error, [label stringByAppendingString:@" must be a positive 32-bit integer"]);
    return nil;
  }
  return @((int32_t)number);
}

static NSString *_Nullable LBWSanitizedFilename(id value, NSError *_Nullable *_Nullable error) {
  if (![value isKindOfClass:[NSString class]]) {
    LBWEvidenceFail(error, @"issue stack frame filename must be a string");
    return nil;
  }
  NSString *normalized = [[(NSString *)value stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]] stringByReplacingOccurrencesOfString:@"\\" withString:@"/"];
  NSRange question = [normalized rangeOfString:@"?"];
  NSRange fragment = [normalized rangeOfString:@"#"];
  NSUInteger delimiter = NSNotFound;
  if (question.location != NSNotFound) {
    delimiter = question.location;
  }
  if (fragment.location != NSNotFound && (delimiter == NSNotFound || fragment.location < delimiter)) {
    delimiter = fragment.location;
  }
  if (delimiter != NSNotFound) {
    normalized = [normalized substringToIndex:delimiter];
  }
  BOOL windowsAbsolute = [normalized length] >= 3U && [normalized characterAtIndex:1U] == ':' &&
      [normalized characterAtIndex:2U] == '/';
  if ([normalized hasPrefix:@"/"] || [[normalized lowercaseString] hasPrefix:@"file://"] || windowsAbsolute) {
    NSArray<NSString *> *components = [normalized componentsSeparatedByString:@"/"];
    for (NSString *component in [components reverseObjectEnumerator]) {
      if ([component length] > 0U) {
        normalized = component;
        break;
      }
    }
  }
  return LBWEvidenceString(normalized, @"issue stack frame filename", 2048U, YES, error);
}

BOOL LBWValidateIssueException(
    id rawValue,
    NSDictionary<NSString *, id> **output,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *value = LBWEvidenceDictionary(rawValue, @"issue exception", error);
  if (value == nil || !LBWEvidenceAllowedKeys(value, @[@"type", @"mechanism"], @"issue exception", error)) {
    return NO;
  }
  NSString *type = LBWEvidenceString(value[@"type"], @"issue exception type", 256U, YES, error);
  if (type == nil) {
    return NO;
  }
  NSMutableDictionary *clean = [@{@"type": type} mutableCopy];
  if (value[@"mechanism"] != nil) {
    NSDictionary *mechanism = LBWEvidenceDictionary(value[@"mechanism"], @"issue exception mechanism", error);
    if (mechanism == nil || !LBWEvidenceAllowedKeys(
        mechanism, @[@"type", @"handled"], @"issue exception mechanism", error)) {
      return NO;
    }
    id rawType = mechanism[@"type"];
    if (![rawType isKindOfClass:[NSString class]] ||
        !LBWEvidenceMachineKey(rawType, 64U, @"_.:-")) {
      return LBWEvidenceFail(error, @"issue exception mechanism type is invalid");
    }
    if (!LBWEvidenceIsBoolean(mechanism[@"handled"])) {
      return LBWEvidenceFail(error, @"issue exception mechanism handled must be a boolean");
    }
    clean[@"mechanism"] = @{@"type": rawType, @"handled": mechanism[@"handled"]};
  }
  *output = [clean copy];
  return YES;
}

BOOL LBWValidateIssueStackFrames(
    id rawValue,
    NSArray<NSDictionary<NSString *, id> *> **output,
    NSError *_Nullable *_Nullable error) {
  if (![rawValue isKindOfClass:[NSArray class]] || [(NSArray *)rawValue count] == 0U) {
    return LBWEvidenceFail(error, @"issue stackFrames must be a non-empty array");
  }
  NSArray *values = rawValue;
  NSMutableArray *cleanFrames = [NSMutableArray array];
  NSUInteger count = [values count] < 32U ? [values count] : 32U;
  for (NSUInteger index = 0U; index < count; index++) {
    NSDictionary *frame = LBWEvidenceDictionary(values[index], @"issue stack frame", error);
    if (frame == nil || !LBWEvidenceAllowedKeys(
        frame, @[@"filename", @"line", @"column", @"function", @"module", @"inApp", @"debugId"],
        @"issue stack frame", error)) {
      return NO;
    }
    NSString *filename = LBWSanitizedFilename(frame[@"filename"], error);
    NSNumber *line = LBWEvidencePositiveInteger(frame[@"line"], @"issue stack frame line", error);
    NSNumber *column = LBWEvidencePositiveInteger(frame[@"column"], @"issue stack frame column", error);
    if (filename == nil || line == nil || column == nil) {
      return NO;
    }
    NSMutableDictionary *clean = [@{@"filename": filename, @"line": line, @"column": column} mutableCopy];
    if (frame[@"function"] != nil) {
      NSString *function = LBWEvidenceString(frame[@"function"], @"issue stack frame function", 256U, NO, error);
      if (function == nil) {
        return NO;
      }
      clean[@"function"] = function;
    }
    if (frame[@"module"] != nil) {
      NSString *module = LBWEvidenceString(frame[@"module"], @"issue stack frame module", 512U, YES, error);
      if (module == nil) {
        return NO;
      }
      clean[@"module"] = module;
    }
    if (frame[@"inApp"] != nil) {
      if (!LBWEvidenceIsBoolean(frame[@"inApp"])) {
        return LBWEvidenceFail(error, @"issue stack frame inApp must be a boolean");
      }
      clean[@"inApp"] = frame[@"inApp"];
    }
    if (frame[@"debugId"] != nil) {
      NSString *debugID = LBWEvidenceString(frame[@"debugId"], @"issue stack frame debugId", 36U, NO, error);
      NSUUID *uuid = debugID != nil ? [[NSUUID alloc] initWithUUIDString:debugID] : nil;
      if (uuid == nil) {
        return LBWEvidenceFail(error, @"issue stack frame debugId must be a UUID");
      }
      clean[@"debugId"] = [[uuid UUIDString] lowercaseString];
    }
    [cleanFrames addObject:[clean copy]];
  }
  *output = [cleanFrames copy];
  return YES;
}

BOOL LBWValidateIssueBreadcrumb(
    id rawValue,
    NSDictionary<NSString *, id> **output,
    NSError *_Nullable *_Nullable error) {
  NSDictionary *value = LBWEvidenceDictionary(rawValue, @"issue breadcrumb", error);
  if (value == nil || !LBWEvidenceAllowedKeys(
      value, @[@"timestamp", @"type", @"category", @"level", @"message", @"data"],
      @"issue breadcrumb", error)) {
    return NO;
  }
  NSString *timestamp = LBWEvidenceTimestamp(value[@"timestamp"], @"issue breadcrumb timestamp", error);
  if (timestamp == nil) {
    return NO;
  }
  id category = value[@"category"];
  if (![category isKindOfClass:[NSString class]] || !LBWEvidenceMachineKey(category, 64U, @"_.:-")) {
    return LBWEvidenceFail(error, @"issue breadcrumb category is invalid");
  }
  NSMutableDictionary *clean = [@{@"timestamp": timestamp, @"category": category} mutableCopy];
  if (value[@"type"] != nil) {
    id type = value[@"type"];
    if (![type isKindOfClass:[NSString class]] || !LBWEvidenceMachineKey(type, 64U, @"_.:-")) {
      return LBWEvidenceFail(error, @"issue breadcrumb type is invalid");
    }
    clean[@"type"] = type;
  }
  if (value[@"level"] != nil) {
    id level = value[@"level"];
    NSArray *allowed = @[@"debug", @"info", @"warning", @"error", @"critical"];
    if (![level isKindOfClass:[NSString class]] || ![allowed containsObject:level]) {
      return LBWEvidenceFail(error, @"issue breadcrumb level is invalid");
    }
    clean[@"level"] = level;
  }
  if (value[@"message"] != nil) {
    NSString *message = LBWEvidenceString(value[@"message"], @"issue breadcrumb message", 512U, NO, error);
    if (message == nil) {
      return NO;
    }
    clean[@"message"] = message;
  }
  if (value[@"data"] != nil) {
    NSDictionary *data = LBWValidatePrimitiveMetadata(value[@"data"], @"issue breadcrumb data", 8U, YES, error);
    if (data == nil) {
      return NO;
    }
    clean[@"data"] = data;
  }
  *output = [clean copy];
  return YES;
}

BOOL LBWValidateIssueBreadcrumbs(
    id rawValue,
    NSArray<NSDictionary<NSString *, id> *> **output,
    BOOL *truncated,
    NSError *_Nullable *_Nullable error) {
  if (![rawValue isKindOfClass:[NSArray class]] || [(NSArray *)rawValue count] == 0U) {
    return LBWEvidenceFail(error, @"issue breadcrumbs must be a non-empty array");
  }
  NSArray *values = rawValue;
  NSUInteger start = [values count] > 64U ? [values count] - 64U : 0U;
  NSMutableArray *clean = [NSMutableArray array];
  for (NSUInteger index = start; index < [values count]; index++) {
    NSDictionary *breadcrumb = nil;
    if (!LBWValidateIssueBreadcrumb(values[index], &breadcrumb, error)) {
      return NO;
    }
    [clean addObject:breadcrumb];
  }
  *truncated = [values count] > 64U;
  *output = [clean copy];
  return YES;
}

static NSString *_Nullable LBWEvidenceHexID(
    id value,
    NSUInteger length,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  NSString *string = LBWEvidenceString(value, label, length, NO, error);
  if (string == nil || [string length] != length) {
    if (string != nil) {
      LBWEvidenceFail(error, [NSString stringWithFormat:@"%@ must be a non-zero hex value", label]);
    }
    return nil;
  }
  NSString *normalized = [string lowercaseString];
  BOOL nonZero = NO;
  for (NSUInteger index = 0U; index < length; index++) {
    unichar character = [normalized characterAtIndex:index];
    BOOL hex = (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
    if (!hex) {
      LBWEvidenceFail(error, [NSString stringWithFormat:@"%@ must be a non-zero hex value", label]);
      return nil;
    }
    nonZero = nonZero || character != '0';
  }
  if (!nonZero) {
    LBWEvidenceFail(error, [NSString stringWithFormat:@"%@ must be a non-zero hex value", label]);
    return nil;
  }
  return normalized;
}

BOOL LBWValidateSpanEvents(
    id rawValue,
    NSArray<NSDictionary<NSString *, id> *> **output,
    NSError *_Nullable *_Nullable error) {
  if (![rawValue isKindOfClass:[NSArray class]] || [(NSArray *)rawValue count] > 8U) {
    return LBWEvidenceFail(error, @"span events must be an array with at most 8 entries");
  }
  NSMutableArray *cleanEvents = [NSMutableArray array];
  for (id rawEvent in (NSArray *)rawValue) {
    NSDictionary *event = LBWEvidenceDictionary(rawEvent, @"span event", error);
    if (event == nil || !LBWEvidenceAllowedKeys(event, @[@"name", @"timestamp", @"metadata"], @"span event", error)) {
      return NO;
    }
    NSString *name = LBWEvidenceString(event[@"name"], @"span event name", NSUIntegerMax, NO, error);
    if (name == nil) {
      return NO;
    }
    NSMutableDictionary *clean = [@{@"name": name} mutableCopy];
    if (event[@"timestamp"] != nil) {
      NSString *timestamp = LBWEvidenceTimestamp(event[@"timestamp"], @"span event timestamp", error);
      if (timestamp == nil) {
        return NO;
      }
      clean[@"timestamp"] = timestamp;
    }
    if (event[@"metadata"] != nil) {
      NSDictionary *metadata = LBWValidatePrimitiveMetadata(event[@"metadata"], @"span event metadata", 0U, NO, error);
      if (metadata == nil) {
        return NO;
      }
      clean[@"metadata"] = metadata;
    }
    [cleanEvents addObject:[clean copy]];
  }
  *output = [cleanEvents copy];
  return YES;
}

BOOL LBWValidateSpanLinks(
    id rawValue,
    NSArray<NSDictionary<NSString *, id> *> **output,
    NSError *_Nullable *_Nullable error) {
  if (![rawValue isKindOfClass:[NSArray class]] || [(NSArray *)rawValue count] > 8U) {
    return LBWEvidenceFail(error, @"span links must be an array with at most 8 entries");
  }
  NSMutableArray *cleanLinks = [NSMutableArray array];
  for (id rawLink in (NSArray *)rawValue) {
    NSDictionary *link = LBWEvidenceDictionary(rawLink, @"span link", error);
    if (link == nil || !LBWEvidenceAllowedKeys(
        link, @[@"traceId", @"spanId", @"sampled", @"metadata"], @"span link", error)) {
      return NO;
    }
    NSString *traceID = LBWEvidenceHexID(link[@"traceId"], 32U, @"span link traceId", error);
    NSString *spanID = LBWEvidenceHexID(link[@"spanId"], 16U, @"span link spanId", error);
    if (traceID == nil || spanID == nil) {
      return NO;
    }
    NSMutableDictionary *clean = [@{@"traceId": traceID, @"spanId": spanID} mutableCopy];
    if (link[@"sampled"] != nil) {
      if (!LBWEvidenceIsBoolean(link[@"sampled"])) {
        return LBWEvidenceFail(error, @"span link sampled must be a boolean");
      }
      clean[@"sampled"] = link[@"sampled"];
    }
    if (link[@"metadata"] != nil) {
      NSDictionary *metadata = LBWValidatePrimitiveMetadata(link[@"metadata"], @"span link metadata", 0U, NO, error);
      if (metadata == nil) {
        return NO;
      }
      clean[@"metadata"] = metadata;
    }
    [cleanLinks addObject:[clean copy]];
  }
  *output = [cleanLinks copy];
  return YES;
}

static NSString *LBWCanonicalIssueLevel(NSString *value) {
  if ([value isEqualToString:@"trace"] || [value isEqualToString:@"debug"] || [value isEqualToString:@"info"]) {
    return @"info";
  }
  if ([value isEqualToString:@"warn"] || [value isEqualToString:@"warning"]) {
    return @"warning";
  }
  if ([value isEqualToString:@"error"]) {
    return @"error";
  }
  if ([value isEqualToString:@"fatal"] || [value isEqualToString:@"critical"]) {
    return @"critical";
  }
  return @"";
}

@implementation LBWIssueDiagnostics

+ (NSDictionary<NSString *, id> *)attributesForError:(NSError *)capturedError
                                                title:(NSString *)title
                                                level:(NSString *)level
                                            mechanism:(NSString *)mechanism
                                               handled:(BOOL)handled
                                                  file:(NSString *)file
                                                  line:(NSUInteger)line
                                                column:(NSUInteger)column
                                              function:(NSString *)function
                                              metadata:(NSDictionary<NSString *, id> *)metadata
                                               context:(NSDictionary<NSString *, id> *)context
                                                 error:(NSError **)error {
  NSString *exceptionType = LBWEvidenceString(capturedError.domain, @"issue exception type", 256U, YES, nil);
  if (exceptionType == nil) {
    exceptionType = NSStringFromClass([capturedError class]);
  }
  NSString *cleanTitle = title != nil
      ? LBWEvidenceString(title, @"issue title", NSUIntegerMax, NO, error)
      : exceptionType;
  NSString *cleanLevel = LBWCanonicalIssueLevel(level);
  if (cleanTitle == nil || [cleanLevel length] == 0U ||
      !LBWEvidenceMachineKey(mechanism, 64U, @"_.:-")) {
    if (cleanTitle != nil && [cleanLevel length] == 0U) {
      LBWEvidenceFail(error, @"issue level has an unsupported value");
    } else if (cleanTitle != nil) {
      LBWEvidenceFail(error, @"issue exception mechanism type is invalid");
    }
    return nil;
  }
  NSString *filename = LBWSanitizedFilename(file, error);
  NSNumber *cleanLine = LBWEvidencePositiveInteger(@(line), @"issue stack frame line", error);
  NSNumber *cleanColumn = LBWEvidencePositiveInteger(@(column), @"issue stack frame column", error);
  if (filename == nil || cleanLine == nil || cleanColumn == nil) {
    return nil;
  }
  NSMutableDictionary *frame = [@{
    @"filename": filename,
    @"line": cleanLine,
    @"column": cleanColumn,
    @"inApp": @YES
  } mutableCopy];
  if (function != nil) {
    NSString *cleanFunction = LBWEvidenceString(function, @"issue stack frame function", 256U, NO, error);
    if (cleanFunction == nil) {
      return nil;
    }
    frame[@"function"] = cleanFunction;
  }
  NSMutableDictionary *attributes = [@{
    @"title": cleanTitle,
    @"level": cleanLevel,
    @"exception": @{
      @"type": exceptionType,
      @"mechanism": @{@"type": mechanism, @"handled": @(handled)}
    },
    @"stackFrames": @[[frame copy]]
  } mutableCopy];
  if (metadata != nil) {
    NSDictionary *cleanMetadata = LBWValidatePrimitiveMetadata(metadata, @"issue metadata", 0U, NO, error);
    if (cleanMetadata == nil) {
      return nil;
    }
    attributes[@"metadata"] = cleanMetadata;
  }
  if (context != nil) {
    NSDictionary *cleanContext = nil;
    if (!LBWValidateTelemetryContext(context, @"issue telemetry context", &cleanContext, error)) {
      return nil;
    }
    attributes[@"context"] = cleanContext;
  }
  return [attributes copy];
}

@end
