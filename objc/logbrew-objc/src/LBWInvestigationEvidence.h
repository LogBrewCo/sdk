#import "LogBrew.h"

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT BOOL LBWValidateIssueException(
    id value,
    NSDictionary<NSString *, id> *_Nullable *_Nonnull output,
    NSError *_Nullable *_Nullable error);

FOUNDATION_EXPORT BOOL LBWValidateIssueStackFrames(
    id value,
    NSArray<NSDictionary<NSString *, id> *> *_Nullable *_Nonnull output,
    NSError *_Nullable *_Nullable error);

FOUNDATION_EXPORT BOOL LBWValidateIssueBreadcrumb(
    id value,
    NSDictionary<NSString *, id> *_Nullable *_Nonnull output,
    NSError *_Nullable *_Nullable error);

FOUNDATION_EXPORT BOOL LBWValidateIssueBreadcrumbs(
    id value,
    NSArray<NSDictionary<NSString *, id> *> *_Nullable *_Nonnull output,
    BOOL *truncated,
    NSError *_Nullable *_Nullable error);

FOUNDATION_EXPORT BOOL LBWValidateSpanEvents(
    id value,
    NSArray<NSDictionary<NSString *, id> *> *_Nullable *_Nonnull output,
    NSError *_Nullable *_Nullable error);

FOUNDATION_EXPORT BOOL LBWValidateSpanLinks(
    id value,
    NSArray<NSDictionary<NSString *, id> *> *_Nullable *_Nonnull output,
    NSError *_Nullable *_Nullable error);

NS_ASSUME_NONNULL_END
