#import "LogBrewNetworkValidation.h"

#import <math.h>

static NSError *LBWNetworkValidationError(NSString *message) {
  return [NSError errorWithDomain:LBWErrorDomain
                             code:LBWErrorKindValidation
                         userInfo:@{
                           LBWErrorStableCodeKey: @"validation_error",
                           LBWErrorRetryableKey: @NO,
                           NSLocalizedDescriptionKey: message
                         }];
}

static void LBWNetworkSetError(NSError *_Nullable *_Nullable error, NSError *value) {
  if (error != NULL) {
    *error = value;
  }
}

BOOL LBWNetworkStringIsBlank(NSString *_Nullable value) {
  if (value == nil) {
    return YES;
  }
  return [[value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] length] == 0U;
}

static NSString *LBWNetworkTrimmedString(NSString *value) {
  return [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

NSString *_Nullable LBWNetworkNormalizedMethod(
    NSString *_Nullable method,
    NSString *label,
    NSString *_Nullable defaultMethod,
    NSError *_Nullable *_Nullable error) {
  NSString *candidate = LBWNetworkStringIsBlank(method) ? defaultMethod : method;
  if (LBWNetworkStringIsBlank(candidate)) {
    LBWNetworkSetError(error, LBWNetworkValidationError([NSString stringWithFormat:@"%@ must be non-empty", label]));
    return nil;
  }
  return [LBWNetworkTrimmedString(candidate) uppercaseString];
}

static NSString *LBWNetworkStripQueryAndFragment(NSString *value) {
  NSString *withoutQuery = [value componentsSeparatedByString:@"?"][0];
  return [withoutQuery componentsSeparatedByString:@"#"][0];
}

NSString *_Nullable LBWNetworkNormalizedRouteTemplate(
    NSString *_Nullable routeTemplate,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  if (LBWNetworkStringIsBlank(routeTemplate)) {
    LBWNetworkSetError(error, LBWNetworkValidationError([NSString stringWithFormat:@"%@ must be non-empty", label]));
    return nil;
  }
  NSString *trimmed = LBWNetworkTrimmedString(routeTemplate);
  NSURLComponents *components = [NSURLComponents componentsWithString:trimmed];
  NSString *scheme = [[components scheme] lowercaseString];
  if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) {
    NSString *path = [[components path] length] == 0U ? @"/" : [components path];
    return LBWNetworkStripQueryAndFragment(path);
  }
  if ([trimmed rangeOfString:@"://"].location != NSNotFound) {
    LBWNetworkSetError(
        error,
        LBWNetworkValidationError([NSString stringWithFormat:@"%@ must be a route template or HTTP(S) URL", label]));
    return nil;
  }
  NSString *sanitized = LBWNetworkStripQueryAndFragment(trimmed);
  if (LBWNetworkStringIsBlank(sanitized)) {
    LBWNetworkSetError(error, LBWNetworkValidationError([NSString stringWithFormat:@"%@ must be non-empty", label]));
    return nil;
  }
  return sanitized;
}

NSNumber *_Nullable LBWNetworkValidatedStatusCode(
    NSNumber *_Nullable statusCode,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  if (statusCode == nil) {
    return nil;
  }
  double doubleValue = [statusCode doubleValue];
  NSInteger integerValue = [statusCode integerValue];
  if (!isfinite(doubleValue) || doubleValue != (double)integerValue || integerValue < 100 || integerValue > 599) {
    LBWNetworkSetError(
        error,
        LBWNetworkValidationError([NSString stringWithFormat:@"%@ must be an integer between 100 and 599", label]));
    return nil;
  }
  return @(integerValue);
}

NSNumber *_Nullable LBWNetworkValidatedDurationMs(
    NSNumber *_Nullable durationMs,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  if (durationMs == nil) {
    return nil;
  }
  double value = [durationMs doubleValue];
  if (!isfinite(value) || value < 0.0) {
    LBWNetworkSetError(
        error,
        LBWNetworkValidationError([NSString stringWithFormat:@"%@ must be finite and non-negative", label]));
    return nil;
  }
  return durationMs;
}
