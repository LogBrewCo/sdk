#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSString *const LBRNFatalRecordFileName;
FOUNDATION_EXPORT NSString *const LBRNFatalRecordTemporaryFileName;

typedef BOOL (^LBRNFatalDirectoryPreparation)(NSURL *directoryURL);

@interface LBRNFatalRecordStore : NSObject

- (instancetype)initWithDirectoryURL:(NSURL *)directoryURL;
- (instancetype)initWithDirectoryURL:(NSURL *)directoryURL
                directoryPreparation:(LBRNFatalDirectoryPreparation)directoryPreparation
    NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

- (NSDictionary *)writeRecord:(NSDictionary *)record;
- (NSDictionary *)readRecord;
- (NSDictionary *)acknowledgeRecordId:(NSString *)recordId;
- (NSDictionary *)discardRecord;

@end

NS_ASSUME_NONNULL_END
