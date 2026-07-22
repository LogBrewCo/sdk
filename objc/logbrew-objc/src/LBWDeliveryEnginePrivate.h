#import "LBWDeliveryEngine.h"
#import "LBWDurableDeliveryStore.h"

NS_ASSUME_NONNULL_BEGIN

@interface LBWDeliveryEngine ()

@property(nonatomic, copy) NSString *apiKey;
@property(nonatomic, copy) NSDictionary<NSString *, NSString *> *sdk;
@property(nonatomic) NSUInteger maxRetries;
@property(nonatomic) NSLock *stateLock;
@property(nonatomic) NSLock *flushLock;
@property(nonatomic) NSLock *storageLock;
@property(nonatomic) NSMutableArray<NSDictionary<NSString *, id> *> *events;
@property(nonatomic) NSMutableArray<NSNumber *> *eventBytes;
@property(nonatomic) NSMutableArray<id> *eventRecordNames;
@property(nonatomic) NSUInteger queuedBytes;
@property(nonatomic, copy, nullable) NSString *frozenBody;
@property(nonatomic) NSUInteger frozenCount;
@property(nonatomic) NSUInteger frozenBytes;
@property(nonatomic, copy) NSArray<NSString *> *frozenRecordNames;
@property(nonatomic, nullable) LBWDurableDeliveryStore *durableStore;
@property(nonatomic, nullable) NSURL *durableParent;
@property(nonatomic) BOOL closed;
@property(nonatomic) LBWDeliveryState state;
@property(nonatomic) LBWDeliveryOutcome lastOutcome;
@property(nonatomic) LBWDeliveryPauseReason pauseReason;
@property(nonatomic) BOOL inFlight;
@property(nonatomic) NSUInteger acceptedEvents;
@property(nonatomic) NSUInteger droppedEvents;
@property(nonatomic) NSUInteger deliveryAttempts;
@property(nonatomic) NSUInteger consecutiveFailures;
@property(nonatomic, strong, nullable) id<LBWTransport> automaticTransport;
@property(nonatomic, strong, nullable) LBWAutomaticDeliveryOptions *automaticOptions;
@property(nonatomic, nullable) dispatch_queue_t schedulerQueue;
@property(nonatomic, nullable) dispatch_source_t schedulerTimer;
@property(nonatomic) NSTimeInterval nextWakeUptime;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) NSUInteger retryAttempt;

- (nullable NSData *)encodeEvents:(NSArray<NSDictionary<NSString *, id> *> *)events
                            error:(NSError *_Nullable *_Nullable)error;

@end

@interface LBWDeliveryEngine (DurablePrivate)

- (void)recordStorageFailure;
- (NSError *)storageErrorForStoreError:(nullable NSError *)storeError;

@end

NS_ASSUME_NONNULL_END
