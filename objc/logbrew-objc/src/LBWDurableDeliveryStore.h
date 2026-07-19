#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSErrorDomain const LBWDurableStoreErrorDomain;

typedef NS_ERROR_ENUM(LBWDurableStoreErrorDomain, LBWDurableStoreErrorCode) {
  LBWDurableStoreErrorCapacity = 1,
  LBWDurableStoreErrorCorrupt = 2,
  LBWDurableStoreErrorInvalidLocation = 3,
  LBWDurableStoreErrorIO = 4,
  LBWDurableStoreErrorOwned = 5
};

@interface LBWDurableRecovery : NSObject

@property(nonatomic, copy, readonly) NSArray<NSDictionary<NSString *, id> *> *events;
@property(nonatomic, copy, readonly) NSArray<NSNumber *> *eventBytes;
@property(nonatomic, copy, readonly) NSArray<NSString *> *eventRecordNames;
@property(nonatomic, copy, readonly, nullable) NSString *frozenBody;
@property(nonatomic, copy, readonly) NSArray<NSString *> *frozenRecordNames;
@property(nonatomic, readonly) NSUInteger frozenBytes;

- (instancetype)init NS_UNAVAILABLE;

@end

@interface LBWDurableDeliveryStore : NSObject

- (nullable instancetype)initWithParentURL:(NSURL *)parentURL
                                       sdk:(NSDictionary<NSString *, NSString *> *)sdk
                                     error:(NSError *_Nullable *_Nullable)error NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

- (LBWDurableRecovery *)recovery;
- (nullable NSString *)appendEvent:(NSDictionary<NSString *, id> *)event
                      encodedBytes:(NSUInteger)encodedBytes
                             error:(NSError *_Nullable *_Nullable)error;
- (nullable NSArray<NSString *> *)appendExistingEvents:(NSArray<NSDictionary<NSString *, id> *> *)events
                                             eventBytes:(NSArray<NSNumber *> *)eventBytes
                                                  error:(NSError *_Nullable *_Nullable)error;
- (BOOL)persistPrefixBody:(NSString *)body
         eventRecordNames:(NSArray<NSString *> *)eventRecordNames
             encodedBytes:(NSUInteger)encodedBytes
                    error:(NSError *_Nullable *_Nullable)error;
- (BOOL)acknowledgeBody:(NSString *)body
       eventRecordNames:(NSArray<NSString *> *)eventRecordNames
                  error:(NSError *_Nullable *_Nullable)error;

+ (BOOL)purgeParentURL:(NSURL *)parentURL error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
