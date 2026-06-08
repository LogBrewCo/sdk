#import "LogBrew.h"

#import <dispatch/dispatch.h>
#import <math.h>

NSString *const LBWHTTPTransportDefaultEndpoint = @"https://api.logbrew.com/v1/events";

@interface LBWHTTPTransport ()

@property(nonatomic, copy) NSString *endpoint;
@property(nonatomic, copy) NSDictionary<NSString *, NSString *> *headers;
@property(nonatomic) NSTimeInterval timeout;

@end

static NSError *LBWHTTPMakeError(LBWErrorKind kind, NSString *stableCode, NSString *message, BOOL retryable) {
  return [NSError errorWithDomain:LBWErrorDomain
                             code:kind
                         userInfo:@{
                           LBWErrorStableCodeKey: stableCode,
                           LBWErrorRetryableKey: @(retryable),
                           NSLocalizedDescriptionKey: message
                         }];
}

static void LBWHTTPSetError(NSError *_Nullable *_Nullable error, NSError *value) {
  if (error != NULL) {
    *error = value;
  }
}

static BOOL LBWHTTPIsBlank(NSString *_Nullable value) {
  if (value == nil) {
    return YES;
  }
  NSCharacterSet *whitespace = [NSCharacterSet whitespaceAndNewlineCharacterSet];
  return [[value stringByTrimmingCharactersInSet:whitespace] length] == 0U;
}

static BOOL LBWHTTPHeaderNameIsSafe(NSString *name) {
  if (LBWHTTPIsBlank(name)) {
    return NO;
  }
  for (NSUInteger index = 0U; index < [name length]; index += 1U) {
    unichar character = [name characterAtIndex:index];
    if (character <= 0x20U || character == 0x7FU || character == ':') {
      return NO;
    }
  }
  return YES;
}

static BOOL LBWHTTPHeaderValueIsSafe(NSString *value) {
  if (value == nil) {
    return NO;
  }
  return [value rangeOfString:@"\r"].location == NSNotFound &&
      [value rangeOfString:@"\n"].location == NSNotFound;
}

static BOOL LBWHTTPHeaderNameIsReserved(NSString *name) {
  NSString *lowercase = [name lowercaseString];
  return [lowercase isEqualToString:@"authorization"] || [lowercase isEqualToString:@"content-type"];
}

static NSString *LBWResolvedHTTPEndpoint(NSString *_Nullable endpoint) {
  return LBWHTTPIsBlank(endpoint) ? LBWHTTPTransportDefaultEndpoint : endpoint;
}

static BOOL LBWValidateHTTPEndpoint(NSString *endpoint, NSError *_Nullable *_Nullable error) {
  NSURLComponents *components = [NSURLComponents componentsWithString:endpoint];
  NSString *scheme = [[components scheme] lowercaseString];
  if (![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"]) {
    LBWHTTPSetError(error, LBWHTTPMakeError(
        LBWErrorKindConfig, @"configuration_error", @"HTTP transport endpoint must use http or https", NO));
    return NO;
  }
  if (LBWHTTPIsBlank([components host])) {
    LBWHTTPSetError(error, LBWHTTPMakeError(
        LBWErrorKindConfig, @"configuration_error", @"HTTP transport endpoint must include a host", NO));
    return NO;
  }
  return YES;
}

static NSDictionary<NSString *, NSString *> *_Nullable LBWValidatedHTTPHeaders(
    NSDictionary<NSString *, NSString *> *_Nullable headers,
    NSError *_Nullable *_Nullable error) {
  if (headers == nil) {
    return @{};
  }
  NSMutableDictionary<NSString *, NSString *> *clean = [NSMutableDictionary dictionary];
  for (id rawName in headers) {
    id rawValue = headers[rawName];
    if (![rawName isKindOfClass:[NSString class]] || ![rawValue isKindOfClass:[NSString class]] ||
        !LBWHTTPHeaderNameIsSafe(rawName) || !LBWHTTPHeaderValueIsSafe(rawValue)) {
      LBWHTTPSetError(error, LBWHTTPMakeError(
          LBWErrorKindConfig,
          @"configuration_error",
          @"HTTP transport headers must have safe string names and values",
          NO));
      return nil;
    }
    if (LBWHTTPHeaderNameIsReserved(rawName)) {
      LBWHTTPSetError(error, LBWHTTPMakeError(
          LBWErrorKindConfig,
          @"configuration_error",
          @"HTTP transport headers cannot override authorization or content-type",
          NO));
      return nil;
    }
    clean[rawName] = rawValue;
  }
  return clean;
}

@implementation LBWHTTPTransport

- (instancetype)init {
  NSError *error = nil;
  self = [self initWithEndpoint:nil headers:nil timeout:10.0 error:&error];
  return self;
}

- (instancetype)initWithEndpoint:(NSString *)endpoint
                          headers:(NSDictionary<NSString *, NSString *> *)headers
                          timeout:(NSTimeInterval)timeout
                            error:(NSError **)error {
  self = [super init];
  if (self == nil) {
    return nil;
  }
  NSString *resolvedEndpoint = LBWResolvedHTTPEndpoint(endpoint);
  NSDictionary<NSString *, NSString *> *cleanHeaders = LBWValidatedHTTPHeaders(headers, error);
  if (cleanHeaders == nil || !LBWValidateHTTPEndpoint(resolvedEndpoint, error)) {
    return nil;
  }
  if (timeout <= 0.0 || !isfinite(timeout)) {
    LBWHTTPSetError(error, LBWHTTPMakeError(
        LBWErrorKindConfig, @"configuration_error", @"HTTP transport timeout must be positive", NO));
    return nil;
  }
  _endpoint = [resolvedEndpoint copy];
  _headers = [cleanHeaders copy];
  _timeout = timeout;
  return self;
}

- (LBWTransportResponse *)sendWithAPIKey:(NSString *)apiKey body:(NSString *)body error:(NSError **)error {
  if (LBWHTTPIsBlank(apiKey)) {
    LBWHTTPSetError(error, LBWHTTPMakeError(
        LBWErrorKindValidation, @"validation_error", @"api_key must be non-empty", NO));
    return nil;
  }
  NSData *bodyData = [body dataUsingEncoding:NSUTF8StringEncoding];
  if (bodyData == nil) {
    LBWHTTPSetError(error, LBWHTTPMakeError(
        LBWErrorKindValidation, @"validation_error", @"body must be valid UTF-8", NO));
    return nil;
  }
  NSURL *url = [NSURL URLWithString:self.endpoint];
  if (url == nil) {
    LBWHTTPSetError(error, LBWHTTPMakeError(
        LBWErrorKindConfig, @"configuration_error", @"HTTP transport endpoint is invalid", NO));
    return nil;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"POST";
  request.HTTPBody = bodyData;
  request.timeoutInterval = self.timeout;
  [request setValue:@"application/json" forHTTPHeaderField:@"content-type"];
  [request setValue:[NSString stringWithFormat:@"Bearer %@", apiKey] forHTTPHeaderField:@"authorization"];
  for (NSString *name in self.headers) {
    [request setValue:self.headers[name] forHTTPHeaderField:name];
  }

  NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  configuration.timeoutIntervalForRequest = self.timeout;
  configuration.timeoutIntervalForResource = self.timeout;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block NSInteger statusCode = 0;
  __block NSError *requestError = nil;
  NSURLSessionDataTask *task = [session dataTaskWithRequest:request
                                          completionHandler:^(NSData *data, NSURLResponse *response, NSError *taskError) {
                                            (void)data;
                                            requestError = taskError;
                                            if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
                                              statusCode = [(NSHTTPURLResponse *)response statusCode];
                                            }
                                            dispatch_semaphore_signal(semaphore);
                                          }];
  [task resume];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  [session finishTasksAndInvalidate];

  if (requestError != nil) {
    LBWHTTPSetError(error, LBWHTTPMakeError(
        LBWErrorKindTransport, @"network_failure", [requestError localizedDescription], YES));
    return nil;
  }
  if (statusCode <= 0) {
    LBWHTTPSetError(error, LBWHTTPMakeError(
        LBWErrorKindTransport, @"network_failure", @"HTTP transport did not receive a response status", YES));
    return nil;
  }
  return [[LBWTransportResponse alloc] initWithStatusCode:statusCode attempts:1U];
}

@end
