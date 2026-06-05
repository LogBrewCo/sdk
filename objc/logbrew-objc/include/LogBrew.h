#ifndef LOGBREW_OBJC_H
#define LOGBREW_OBJC_H

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSString *const LogBrewObjectiveCVersion;
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

@end

NS_ASSUME_NONNULL_END

#endif
