#import "LogBrew.h"

#import "LogBrewNetworkValidation.h"

static NSError *LBWLifecycleError(NSString *message) {
  return [NSError errorWithDomain:LBWErrorDomain
                             code:LBWErrorKindValidation
                         userInfo:@{
                           LBWErrorStableCodeKey: @"validation_error",
                           LBWErrorRetryableKey: @NO,
                           NSLocalizedDescriptionKey: message
                         }];
}

static void LBWLifecycleSetError(NSError *_Nullable *_Nullable error, NSError *value) {
  if (error != NULL) {
    *error = value;
  }
}

static NSString *_Nullable LBWLifecycleNormalizedState(
    NSString *_Nullable state,
    NSString *label,
    NSError *_Nullable *_Nullable error) {
  if (LBWNetworkStringIsBlank(state)) {
    NSString *message = [NSString stringWithFormat:@"%@ must be non-empty", label];
    LBWLifecycleSetError(error, LBWLifecycleError(message));
    return nil;
  }
  return [state stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

@implementation LBWClient (Lifecycle)

- (BOOL)captureLifecycleSpanWithID:(NSString *)eventID
                          timestamp:(NSString *)timestamp
                      previousState:(NSString *)previousState
                       currentState:(NSString *)currentState
                         durationMs:(NSNumber *)durationMs
                            context:(NSDictionary<NSString *, id> *)context
                           metadata:(NSDictionary<NSString *, id> *)metadata
                              error:(NSError **)error {
  NSString *checkedPreviousState = LBWLifecycleNormalizedState(previousState, @"lifecycle previousState", error);
  NSString *checkedCurrentState = LBWLifecycleNormalizedState(currentState, @"lifecycle currentState", error);
  NSNumber *checkedDurationMs = LBWNetworkValidatedDurationMs(durationMs, @"lifecycle durationMs", error);
  if (checkedPreviousState == nil || checkedCurrentState == nil || (durationMs != nil && checkedDurationMs == nil)) {
    return NO;
  }

  NSMutableDictionary<NSString *, id> *spanMetadata =
      context != nil ? [context mutableCopy] : [NSMutableDictionary dictionary];
  if (metadata != nil) {
    [spanMetadata addEntriesFromDictionary:metadata];
  }
  spanMetadata[@"source"] = @"objc.lifecycle";
  spanMetadata[@"previousState"] = checkedPreviousState;
  spanMetadata[@"currentState"] = checkedCurrentState;
  if (checkedDurationMs != nil) {
    spanMetadata[@"durationSource"] = @"previous_state";
  }

  LBWTraceContext *sourceContext = [LBWTrace currentContext];
  LBWTraceContext *spanContext = sourceContext != nil ? [sourceContext childContext] : [LBWTraceContext rootContext];
  NSString *name = [NSString stringWithFormat:@"objc.lifecycle:%@->%@", checkedPreviousState, checkedCurrentState];
  NSDictionary<NSString *, id> *attributes =
      [spanContext spanAttributesWithName:name
                                   status:@"ok"
                               durationMs:checkedDurationMs
                                 metadata:spanMetadata
                                    error:error];
  if (attributes == nil) {
    return NO;
  }
  return [self spanWithID:eventID timestamp:timestamp attributes:attributes error:error];
}

@end
