#import "LogBrew.h"

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT BOOL LBWValidateTelemetryContext(
    id value,
    NSString *label,
    NSDictionary<NSString *, id> *_Nullable *_Nonnull output,
    NSError *_Nullable *_Nullable error);

FOUNDATION_EXPORT NSDictionary<NSString *, id> *_Nullable LBWMergeTelemetryContexts(
    NSDictionary<NSString *, id> *_Nullable baseContext,
    NSDictionary<NSString *, id> *_Nullable overrideContext,
    NSError *_Nullable *_Nullable error);

FOUNDATION_EXPORT NSDictionary<NSString *, id> *LBWAutomaticTelemetryContext(void);

FOUNDATION_EXPORT NSDictionary<NSString *, id> *LBWTelemetryContextFromTrace(LBWTraceContext *context);

FOUNDATION_EXPORT NSDictionary<NSString *, id> *_Nullable LBWTelemetryContextByReplacingTrace(
    NSDictionary<NSString *, id> *_Nullable context,
    NSDictionary<NSString *, id> *_Nullable trace);

NS_ASSUME_NONNULL_END
