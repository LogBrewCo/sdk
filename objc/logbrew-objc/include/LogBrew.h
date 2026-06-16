#ifndef LOGBREW_OBJC_H
#define LOGBREW_OBJC_H

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSString *const LogBrewObjectiveCVersion;
FOUNDATION_EXPORT NSString *const LBWHTTPTransportDefaultEndpoint;
FOUNDATION_EXPORT NSString *const LBWErrorDomain;
FOUNDATION_EXPORT NSString *const LBWErrorStableCodeKey;
FOUNDATION_EXPORT NSString *const LBWErrorRetryableKey;

typedef NS_ENUM(NSInteger, LBWErrorKind) {
  LBWErrorKindConfig = 1,
  LBWErrorKindValidation = 2,
  LBWErrorKindTransport = 3,
  LBWErrorKindShutdown = 4
};

@interface LBWConfig : NSObject

@property(nonatomic, copy) NSString *apiKey;
@property(nonatomic, copy) NSString *sdkName;
@property(nonatomic, copy) NSString *sdkVersion;
@property(nonatomic) NSUInteger maxRetries;

+ (instancetype)configWithAPIKey:(NSString *)apiKey;

@end

@interface LBWTransportResponse : NSObject

@property(nonatomic) NSInteger statusCode;
@property(nonatomic) NSUInteger attempts;

- (instancetype)initWithStatusCode:(NSInteger)statusCode attempts:(NSUInteger)attempts NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@end

@protocol LBWTransport <NSObject>

- (nullable LBWTransportResponse *)sendWithAPIKey:(NSString *)apiKey
                                             body:(NSString *)body
                                            error:(NSError *_Nullable *_Nullable)error;

@end

@interface LBWHTTPTransport : NSObject <LBWTransport>

- (instancetype)init;
- (nullable instancetype)initWithEndpoint:(nullable NSString *)endpoint
                                  headers:(nullable NSDictionary<NSString *, NSString *> *)headers
                                  timeout:(NSTimeInterval)timeout
                                    error:(NSError *_Nullable *_Nullable)error NS_DESIGNATED_INITIALIZER;

@end

@interface LBWRecordingStep : NSObject

+ (instancetype)statusCodeStep:(NSInteger)statusCode;
+ (instancetype)networkFailureWithMessage:(NSString *)message;

@end

@interface LBWRecordingTransport : NSObject <LBWTransport>

@property(nonatomic, copy, readonly) NSArray<NSString *> *sentBodies;
@property(nonatomic, copy, readonly, nullable) NSString *lastBody;

- (instancetype)initWithSteps:(nullable NSArray<LBWRecordingStep *> *)steps NS_DESIGNATED_INITIALIZER;
- (instancetype)init;

@end

@interface LBWTraceContext : NSObject

@property(nonatomic, copy, readonly) NSString *traceID;
@property(nonatomic, copy, readonly) NSString *spanID;
@property(nonatomic, copy, readonly, nullable) NSString *parentSpanID;
@property(nonatomic, copy, readonly) NSString *traceFlags;
@property(nonatomic, readonly) BOOL sampled;
@property(nonatomic, copy, readonly) NSString *traceparent;

+ (instancetype)rootContext;
+ (nullable instancetype)rootContextWithTraceFlags:(NSString *)traceFlags
                                             error:(NSError *_Nullable *_Nullable)error;
+ (nullable instancetype)contextWithTraceID:(NSString *)traceID
                                     spanID:(NSString *)spanID
                               parentSpanID:(nullable NSString *)parentSpanID
                                 traceFlags:(NSString *)traceFlags
                                      error:(NSError *_Nullable *_Nullable)error;
+ (nullable instancetype)contextFromTraceparent:(NSString *)traceparent
                                          error:(NSError *_Nullable *_Nullable)error;
+ (instancetype)continueOrCreateContextFromTraceparent:(nullable NSString *)traceparent;

- (instancetype)childContext;
- (NSDictionary<NSString *, id> *)metadata;
- (NSDictionary<NSString *, NSString *> *)outgoingHeaders;
- (nullable NSDictionary<NSString *, id> *)spanAttributesWithName:(NSString *)name
                                                           status:(NSString *)status
                                                       durationMs:(nullable NSNumber *)durationMs
                                                         metadata:(nullable NSDictionary<NSString *, id> *)metadata
                                                            error:(NSError *_Nullable *_Nullable)error;

@end

@interface LBWTraceScope : NSObject

- (void)close;

@end

@interface LBWURLSessionSpan : NSObject

@property(nonatomic, copy, readonly) NSURLRequest *request;
@property(nonatomic, strong, readonly) LBWTraceContext *traceContext;
@property(nonatomic, copy, readonly) NSString *method;
@property(nonatomic, copy, readonly) NSString *routeTemplate;

- (instancetype)init NS_UNAVAILABLE;

@end

@interface LBWTrace : NSObject

+ (nullable LBWTraceContext *)currentContext;
+ (LBWTraceScope *)activateContext:(LBWTraceContext *)context;
+ (nullable NSDictionary<NSString *, id> *)metadataByMergingActiveContextIntoMetadata:
    (nullable NSDictionary<NSString *, id> *)metadata;
+ (NSDictionary<NSString *, NSString *> *)outgoingHeaders;

@end

@interface LBWTrace (URLSession)

+ (nullable LBWURLSessionSpan *)startURLSessionSpanForRequest:(NSURLRequest *)request
                                                        error:(NSError *_Nullable *_Nullable)error;
+ (nullable LBWURLSessionSpan *)startURLSessionSpanForRequest:(NSURLRequest *)request
                                                routeTemplate:(nullable NSString *)routeTemplate
                                                      context:(nullable LBWTraceContext *)context
                                                        error:(NSError *_Nullable *_Nullable)error;

@end

@interface LBWClient : NSObject

@property(nonatomic, readonly) NSUInteger pendingEvents;

- (nullable instancetype)initWithConfig:(LBWConfig *)config error:(NSError *_Nullable *_Nullable)error
    NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

- (nullable NSString *)previewJSONWithError:(NSError *_Nullable *_Nullable)error;
- (nullable LBWTransportResponse *)flushWithTransport:(id<LBWTransport>)transport
                                                error:(NSError *_Nullable *_Nullable)error;
- (nullable LBWTransportResponse *)shutdownWithTransport:(id<LBWTransport>)transport
                                                   error:(NSError *_Nullable *_Nullable)error;

- (BOOL)releaseWithID:(NSString *)eventID
            timestamp:(NSString *)timestamp
           attributes:(NSDictionary<NSString *, id> *)attributes
                error:(NSError *_Nullable *_Nullable)error;

- (BOOL)environmentWithID:(NSString *)eventID
                timestamp:(NSString *)timestamp
               attributes:(NSDictionary<NSString *, id> *)attributes
                    error:(NSError *_Nullable *_Nullable)error;

- (BOOL)issueWithID:(NSString *)eventID
          timestamp:(NSString *)timestamp
         attributes:(NSDictionary<NSString *, id> *)attributes
              error:(NSError *_Nullable *_Nullable)error;

- (BOOL)logWithID:(NSString *)eventID
        timestamp:(NSString *)timestamp
       attributes:(NSDictionary<NSString *, id> *)attributes
            error:(NSError *_Nullable *_Nullable)error;

- (BOOL)spanWithID:(NSString *)eventID
         timestamp:(NSString *)timestamp
        attributes:(NSDictionary<NSString *, id> *)attributes
             error:(NSError *_Nullable *_Nullable)error;

- (BOOL)actionWithID:(NSString *)eventID
           timestamp:(NSString *)timestamp
          attributes:(NSDictionary<NSString *, id> *)attributes
               error:(NSError *_Nullable *_Nullable)error;

- (BOOL)metricWithID:(NSString *)eventID
           timestamp:(NSString *)timestamp
          attributes:(NSDictionary<NSString *, id> *)attributes
               error:(NSError *_Nullable *_Nullable)error;

- (BOOL)captureProductActionWithID:(NSString *)eventID
                          timestamp:(NSString *)timestamp
                               name:(NSString *)name
                             status:(nullable NSString *)status
                            context:(nullable NSDictionary<NSString *, id> *)context
                           metadata:(nullable NSDictionary<NSString *, id> *)metadata
                              error:(NSError *_Nullable *_Nullable)error;

- (BOOL)captureNetworkMilestoneWithID:(NSString *)eventID
                             timestamp:(NSString *)timestamp
                                method:(NSString *)method
                         routeTemplate:(NSString *)routeTemplate
                            statusCode:(nullable NSNumber *)statusCode
                            durationMs:(nullable NSNumber *)durationMs
                                status:(nullable NSString *)status
                               context:(nullable NSDictionary<NSString *, id> *)context
                               metadata:(nullable NSDictionary<NSString *, id> *)metadata
                                 error:(NSError *_Nullable *_Nullable)error;

@end

@interface LBWClient (URLSession)

- (BOOL)captureURLSessionSpanWithID:(NSString *)eventID
                           timestamp:(NSString *)timestamp
                                span:(LBWURLSessionSpan *)span
                          statusCode:(nullable NSNumber *)statusCode
                          durationMs:(nullable NSNumber *)durationMs
                           errorType:(nullable NSString *)errorType
                            metadata:(nullable NSDictionary<NSString *, id> *)metadata
                               error:(NSError *_Nullable *_Nullable)error;

@end

@interface LBWClient (Lifecycle)

- (BOOL)captureLifecycleSpanWithID:(NSString *)eventID
                          timestamp:(NSString *)timestamp
                      previousState:(NSString *)previousState
                       currentState:(NSString *)currentState
                         durationMs:(nullable NSNumber *)durationMs
                            context:(nullable NSDictionary<NSString *, id> *)context
                           metadata:(nullable NSDictionary<NSString *, id> *)metadata
                              error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END

#endif
