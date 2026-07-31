#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSString *const LBRNEventRecordPrefix;
FOUNDATION_EXPORT NSString *const LBRNEventRecordSuffix;
FOUNDATION_EXPORT NSString *const LBRNEventMarkerPrefix;
FOUNDATION_EXPORT NSString *const LBRNEventMarkerSuffix;

typedef BOOL (^LBRNEventDirectoryPreparation)(NSURL *directoryURL);

@interface LBRNEventRecordStore : NSObject

- (instancetype)initWithDirectoryURL:(NSURL *)directoryURL;
- (instancetype)initWithDirectoryURL:(NSURL *)directoryURL
                directoryPreparation:(LBRNEventDirectoryPreparation)directoryPreparation
    NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

- (NSDictionary *)loadRecords;
- (NSDictionary *)appendSerializedEvent:(NSString *)serializedEvent
                              eventBytes:(NSNumber *)eventBytes;
- (NSDictionary *)acknowledgeRecordCount:(NSNumber *)count;
- (NSDictionary *)purgeRecords;
- (NSDictionary *)closeStore;

@end

NS_ASSUME_NONNULL_END
