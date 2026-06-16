#import "LogBrew.h"

NS_ASSUME_NONNULL_BEGIN

BOOL LBWNetworkStringIsBlank(NSString *_Nullable value);
NSString *_Nullable LBWNetworkNormalizedMethod(
    NSString *_Nullable method,
    NSString *label,
    NSString *_Nullable defaultMethod,
    NSError *_Nullable *_Nullable error);
NSString *_Nullable LBWNetworkNormalizedRouteTemplate(
    NSString *_Nullable routeTemplate,
    NSString *label,
    NSError *_Nullable *_Nullable error);
NSNumber *_Nullable LBWNetworkValidatedStatusCode(
    NSNumber *_Nullable statusCode,
    NSString *label,
    NSError *_Nullable *_Nullable error);
NSNumber *_Nullable LBWNetworkValidatedDurationMs(
    NSNumber *_Nullable durationMs,
    NSString *label,
    NSError *_Nullable *_Nullable error);

NS_ASSUME_NONNULL_END
