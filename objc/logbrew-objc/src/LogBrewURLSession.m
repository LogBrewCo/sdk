#import "LogBrew.h"

#import "LogBrewNetworkValidation.h"

#import <math.h>

@interface LBWURLSessionSpan ()

@property(nonatomic, copy) NSURLRequest *request;
@property(nonatomic, strong) LBWTraceContext *traceContext;
@property(nonatomic, copy) NSString *method;
@property(nonatomic, copy) NSString *routeTemplate;

- (instancetype)initWithRequest:(NSURLRequest *)request
                   traceContext:(LBWTraceContext *)traceContext
                          method:(NSString *)method
                   routeTemplate:(NSString *)routeTemplate NS_DESIGNATED_INITIALIZER;

@end

@interface LBWURLSessionTimings ()

@property(nonatomic, copy) NSDictionary<NSString *, NSNumber *> *metadata;

- (instancetype)initWithMetadata:(NSDictionary<NSString *, NSNumber *> *)metadata NS_DESIGNATED_INITIALIZER;

@end

static NSError *LBWURLSessionError(NSString *message) {
  return [NSError errorWithDomain:LBWErrorDomain
                             code:LBWErrorKindValidation
                         userInfo:@{
                           LBWErrorStableCodeKey: @"validation_error",
                           LBWErrorRetryableKey: @NO,
                           NSLocalizedDescriptionKey: message
                         }];
}

static void LBWURLSessionSetError(NSError *_Nullable *_Nullable error, NSError *value) {
  if (error != NULL) {
    *error = value;
  }
}

static NSString *LBWURLSessionSpanStatus(NSNumber *_Nullable statusCode, NSString *_Nullable errorType) {
  if (!LBWNetworkStringIsBlank(errorType)) {
    return @"error";
  }
  return statusCode != nil && [statusCode integerValue] >= 400 ? @"error" : @"ok";
}

static BOOL LBWURLSessionAddTimingDuration(
    NSMutableDictionary<NSString *, NSNumber *> *metadata,
    NSString *key,
    NSNumber *_Nullable value,
    NSError *_Nullable *_Nullable error) {
  NSNumber *checkedValue = LBWNetworkValidatedDurationMs(value, @"URLSession timing values", error);
  if (value != nil && checkedValue == nil) {
    return NO;
  }
  if (checkedValue != nil) {
    metadata[key] = checkedValue;
  }
  return YES;
}

static BOOL LBWURLSessionAddByteCount(
    NSMutableDictionary<NSString *, NSNumber *> *metadata,
    NSString *key,
    NSNumber *_Nullable value,
    NSError *_Nullable *_Nullable error) {
  if (value == nil) {
    return YES;
  }
  double doubleValue = [value doubleValue];
  long long integerValue = [value longLongValue];
  if (!isfinite(doubleValue) || doubleValue != (double)integerValue || integerValue < 0LL) {
    LBWURLSessionSetError(error, LBWURLSessionError(@"URLSession byte counts must be non-negative integers"));
    return NO;
  }
  metadata[key] = @(integerValue);
  return YES;
}

static BOOL LBWURLSessionAddDateDuration(
    NSMutableDictionary<NSString *, NSNumber *> *metadata,
    NSString *key,
    NSDate *_Nullable startDate,
    NSDate *_Nullable endDate,
    NSError *_Nullable *_Nullable error) {
  if (startDate == nil || endDate == nil) {
    return YES;
  }
  return LBWURLSessionAddTimingDuration(metadata, key, @([endDate timeIntervalSinceDate:startDate] * 1000.0), error);
}

static NSArray<NSURLSessionTaskTransactionMetrics *> *LBWURLSessionNetworkTransactions(
    NSURLSessionTaskMetrics *metrics) {
  NSMutableArray<NSURLSessionTaskTransactionMetrics *> *transactions = [NSMutableArray array];
  for (NSURLSessionTaskTransactionMetrics *transaction in metrics.transactionMetrics) {
    if (transaction.resourceFetchType != NSURLSessionTaskMetricsResourceFetchTypeLocalCache) {
      [transactions addObject:transaction];
    }
  }
  return transactions;
}

@implementation LBWURLSessionSpan

- (instancetype)initWithRequest:(NSURLRequest *)request
                   traceContext:(LBWTraceContext *)traceContext
                          method:(NSString *)method
                   routeTemplate:(NSString *)routeTemplate {
  self = [super init];
  if (self != nil) {
    _request = [request copy];
    _traceContext = traceContext;
    _method = [method copy];
    _routeTemplate = [routeTemplate copy];
  }
  return self;
}

@end

@implementation LBWURLSessionTimings

- (instancetype)initWithMetadata:(NSDictionary<NSString *, NSNumber *> *)metadata {
  self = [super init];
  if (self != nil) {
    _metadata = [metadata copy];
  }
  return self;
}

+ (LBWURLSessionTimings *)timingsWithFetchMs:(NSNumber *)fetchMs
                                  redirectMs:(NSNumber *)redirectMs
                                nameLookupMs:(NSNumber *)nameLookupMs
                                   connectMs:(NSNumber *)connectMs
                                       tlsMs:(NSNumber *)tlsMs
                                      sendMs:(NSNumber *)sendMs
                                      waitMs:(NSNumber *)waitMs
                                   receiveMs:(NSNumber *)receiveMs
                            requestBodyBytes:(NSNumber *)requestBodyBytes
                           responseBodyBytes:(NSNumber *)responseBodyBytes
                                       error:(NSError **)error {
  NSMutableDictionary<NSString *, NSNumber *> *metadata = [NSMutableDictionary dictionary];
  if (!LBWURLSessionAddTimingDuration(metadata, @"requestFetchMs", fetchMs, error) ||
      !LBWURLSessionAddTimingDuration(metadata, @"requestRedirectMs", redirectMs, error) ||
      !LBWURLSessionAddTimingDuration(metadata, @"requestNameLookupMs", nameLookupMs, error) ||
      !LBWURLSessionAddTimingDuration(metadata, @"requestConnectMs", connectMs, error) ||
      !LBWURLSessionAddTimingDuration(metadata, @"requestTlsMs", tlsMs, error) ||
      !LBWURLSessionAddTimingDuration(metadata, @"requestSendMs", sendMs, error) ||
      !LBWURLSessionAddTimingDuration(metadata, @"requestWaitMs", waitMs, error) ||
      !LBWURLSessionAddTimingDuration(metadata, @"requestReceiveMs", receiveMs, error) ||
      !LBWURLSessionAddByteCount(metadata, @"requestBodyBytes", requestBodyBytes, error) ||
      !LBWURLSessionAddByteCount(metadata, @"responseBodyBytes", responseBodyBytes, error)) {
    return nil;
  }
  return [[LBWURLSessionTimings alloc] initWithMetadata:metadata];
}

+ (LBWURLSessionTimings *)timingsWithTaskMetrics:(NSURLSessionTaskMetrics *)metrics error:(NSError **)error {
  if (metrics == nil) {
    LBWURLSessionSetError(error, LBWURLSessionError(@"URLSession task metrics are required"));
    return nil;
  }

  NSMutableDictionary<NSString *, NSNumber *> *metadata = [NSMutableDictionary dictionary];
  NSDateInterval *taskInterval = metrics.taskInterval;
  if (taskInterval != nil &&
      !LBWURLSessionAddTimingDuration(metadata, @"requestFetchMs", @(taskInterval.duration * 1000.0), error)) {
    return nil;
  }

  NSArray<NSURLSessionTaskTransactionMetrics *> *transactions = LBWURLSessionNetworkTransactions(metrics);
  NSURLSessionTaskTransactionMetrics *mainTransaction = [transactions lastObject];
  if ([transactions count] > 1) {
    NSURLSessionTaskTransactionMetrics *firstRedirect = transactions[0];
    NSURLSessionTaskTransactionMetrics *lastRedirect = transactions[[transactions count] - 2];
    if (!LBWURLSessionAddDateDuration(metadata,
                                      @"requestRedirectMs",
                                      firstRedirect.fetchStartDate,
                                      lastRedirect.responseEndDate,
                                      error)) {
      return nil;
    }
  }

  if (mainTransaction != nil) {
    if (!LBWURLSessionAddDateDuration(metadata,
                                      @"requestNameLookupMs",
                                      mainTransaction.domainLookupStartDate,
                                      mainTransaction.domainLookupEndDate,
                                      error) ||
        !LBWURLSessionAddDateDuration(metadata,
                                      @"requestConnectMs",
                                      mainTransaction.connectStartDate,
                                      mainTransaction.connectEndDate,
                                      error) ||
        !LBWURLSessionAddDateDuration(metadata,
                                      @"requestTlsMs",
                                      mainTransaction.secureConnectionStartDate,
                                      mainTransaction.secureConnectionEndDate,
                                      error) ||
        !LBWURLSessionAddDateDuration(metadata,
                                      @"requestSendMs",
                                      mainTransaction.requestStartDate,
                                      mainTransaction.requestEndDate,
                                      error) ||
        !LBWURLSessionAddDateDuration(metadata,
                                      @"requestWaitMs",
                                      mainTransaction.requestEndDate,
                                      mainTransaction.responseStartDate,
                                      error) ||
        !LBWURLSessionAddDateDuration(metadata,
                                      @"requestReceiveMs",
                                      mainTransaction.responseStartDate,
                                      mainTransaction.responseEndDate,
                                      error)) {
      return nil;
    }

    if (@available(macOS 10.15, iOS 13.0, tvOS 13.0, watchOS 6.0, *)) {
      if (!LBWURLSessionAddByteCount(metadata,
                                     @"requestBodyBytes",
                                     @(mainTransaction.countOfRequestBodyBytesSent),
                                     error) ||
          !LBWURLSessionAddByteCount(metadata,
                                     @"responseBodyBytes",
                                     @(mainTransaction.countOfResponseBodyBytesReceived),
                                     error)) {
        return nil;
      }
    }
  }

  return [[LBWURLSessionTimings alloc] initWithMetadata:metadata];
}

@end

@implementation LBWTrace (URLSession)

+ (LBWURLSessionSpan *)startURLSessionSpanForRequest:(NSURLRequest *)request error:(NSError **)error {
  return [self startURLSessionSpanForRequest:request routeTemplate:nil context:nil error:error];
}

+ (LBWURLSessionSpan *)startURLSessionSpanForRequest:(NSURLRequest *)request
                                      routeTemplate:(NSString *)routeTemplate
                                            context:(LBWTraceContext *)context
                                              error:(NSError **)error {
  if (request.URL == nil) {
    LBWURLSessionSetError(error, LBWURLSessionError(@"URLSession request URL is required"));
    return nil;
  }
  NSString *method = LBWNetworkNormalizedMethod(request.HTTPMethod, @"URLSession method", @"GET", error);
  NSString *route = LBWNetworkNormalizedRouteTemplate(
      routeTemplate != nil ? routeTemplate : [request.URL absoluteString],
      @"URLSession routeTemplate",
      error);
  if (method == nil || route == nil) {
    return nil;
  }

  LBWTraceContext *sourceContext = context != nil ? context : [LBWTrace currentContext];
  LBWTraceContext *spanContext = sourceContext != nil ? [sourceContext childContext] : [LBWTraceContext rootContext];
  NSMutableURLRequest *tracedRequest = [request mutableCopy];
  [tracedRequest setValue:spanContext.traceparent forHTTPHeaderField:@"traceparent"];

  return [[LBWURLSessionSpan alloc] initWithRequest:tracedRequest
                                      traceContext:spanContext
                                             method:method
                                      routeTemplate:route];
}

@end

@implementation LBWClient (URLSession)

- (BOOL)captureURLSessionSpanWithID:(NSString *)eventID
                           timestamp:(NSString *)timestamp
                                span:(LBWURLSessionSpan *)span
                          statusCode:(NSNumber *)statusCode
                          durationMs:(NSNumber *)durationMs
                           errorType:(NSString *)errorType
                            metadata:(NSDictionary<NSString *, id> *)metadata
                               error:(NSError **)error {
  return [self captureURLSessionSpanWithID:eventID
                                 timestamp:timestamp
                                      span:span
                                statusCode:statusCode
                                durationMs:durationMs
                                 errorType:errorType
                                  metadata:metadata
                                   timings:nil
                                     error:error];
}

- (BOOL)captureURLSessionSpanWithID:(NSString *)eventID
                           timestamp:(NSString *)timestamp
                                span:(LBWURLSessionSpan *)span
                          statusCode:(NSNumber *)statusCode
                          durationMs:(NSNumber *)durationMs
                           errorType:(NSString *)errorType
                            metadata:(NSDictionary<NSString *, id> *)metadata
                             timings:(LBWURLSessionTimings *)timings
                               error:(NSError **)error {
  if (span == nil) {
    LBWURLSessionSetError(error, LBWURLSessionError(@"URLSession span is required"));
    return NO;
  }
  NSNumber *checkedStatusCode = LBWNetworkValidatedStatusCode(statusCode, @"URLSession statusCode", error);
  NSNumber *checkedDurationMs = LBWNetworkValidatedDurationMs(durationMs, @"URLSession durationMs", error);
  if ((statusCode != nil && checkedStatusCode == nil) || (durationMs != nil && checkedDurationMs == nil)) {
    return NO;
  }

  NSMutableDictionary<NSString *, id> *spanMetadata =
      metadata != nil ? [metadata mutableCopy] : [NSMutableDictionary dictionary];
  spanMetadata[@"source"] = @"objc.urlsession";
  spanMetadata[@"method"] = span.method;
  spanMetadata[@"routeTemplate"] = span.routeTemplate;
  if (checkedStatusCode != nil) {
    spanMetadata[@"statusCode"] = checkedStatusCode;
  }
  if (!LBWNetworkStringIsBlank(errorType)) {
    spanMetadata[@"errorType"] = errorType;
  }
  if (timings != nil) {
    [spanMetadata addEntriesFromDictionary:timings.metadata];
  }

  NSString *name = [NSString stringWithFormat:@"%@ %@", span.method, span.routeTemplate];
  NSDictionary<NSString *, id> *attributes =
      [span.traceContext spanAttributesWithName:name
                                         status:LBWURLSessionSpanStatus(checkedStatusCode, errorType)
                                     durationMs:checkedDurationMs
                                       metadata:spanMetadata
                                          error:error];
  if (attributes == nil) {
    return NO;
  }
  return [self spanWithID:eventID timestamp:timestamp attributes:attributes error:error];
}

@end
