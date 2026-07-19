#import "LogBrew.h"

NS_ASSUME_NONNULL_BEGIN

@interface LBWDeliveryEngine : NSObject

- (instancetype)initWithAPIKey:(NSString *)apiKey
                       sdkName:(NSString *)sdkName
                    sdkVersion:(NSString *)sdkVersion
                    maxRetries:(NSUInteger)maxRetries;
- (NSUInteger)pendingEvents;
- (nullable NSString *)previewJSONWithError:(NSError *_Nullable *_Nullable)error;
- (BOOL)enqueueEvent:(NSDictionary<NSString *, id> *)event error:(NSError *_Nullable *_Nullable)error;
- (LBWDeliveryHealth *)health;
- (BOOL)startAutomaticDeliveryWithTransport:(id<LBWTransport>)transport
                                    options:(LBWAutomaticDeliveryOptions *)options
                                      error:(NSError *_Nullable *_Nullable)error;
- (BOOL)recoverAutomaticDeliveryWithError:(NSError *_Nullable *_Nullable)error;
- (void)stopAutomaticDelivery;
- (nullable LBWTransportResponse *)flushWithTransport:(id<LBWTransport>)transport
                                                error:(NSError *_Nullable *_Nullable)error;
- (nullable LBWTransportResponse *)flushOwnedTransportWithError:(NSError *_Nullable *_Nullable)error;
- (nullable LBWTransportResponse *)shutdownWithTransport:(id<LBWTransport>)transport
                                                   error:(NSError *_Nullable *_Nullable)error;
- (nullable LBWTransportResponse *)shutdownOwnedTransportWithError:(NSError *_Nullable *_Nullable)error;

@end

@interface LBWDeliveryEngine (Durable)

- (BOOL)enableDurableDeliveryWithOptions:(LBWDurableDeliveryOptions *)options
                                   error:(NSError *_Nullable *_Nullable)error;
- (BOOL)purgeDurableDeliveryWithError:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
