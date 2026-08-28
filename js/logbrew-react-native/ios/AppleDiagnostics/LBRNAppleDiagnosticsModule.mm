#import "LBRNAppleDiagnosticsModule.h"

#if __has_include(<LogBrewReactNative/LogBrewReactNative-Swift.h>)
#import <LogBrewReactNative/LogBrewReactNative-Swift.h>
#elif __has_include("LogBrewReactNative-Swift.h")
#import "LogBrewReactNative-Swift.h"
#else
#error "LogBrew React Native Apple diagnostics requires its generated Swift interface"
#endif

#ifdef RCT_NEW_ARCH_ENABLED
#import <LogBrewReactNativeSpec/LogBrewReactNativeSpec.h>
#endif

@interface LBRNAppleDiagnosticsModule ()
#ifdef RCT_NEW_ARCH_ENABLED
<NativeLogBrewAppleDiagnosticsSpec>
#endif
@end

@implementation LBRNAppleDiagnosticsModule

RCT_EXPORT_MODULE(LogBrewAppleDiagnostics)

+ (BOOL)requiresMainQueueSetup
{
    return YES;
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(installNativeDiagnostics:(NSDictionary *)configuration)
{
    return [LBRNAppleNativeDiagnostics installWithConfiguration:configuration];
}

RCT_EXPORT_METHOD(replayNativeDiagnostics:(RCTPromiseResolveBlock)resolve
                  reject:(__unused RCTPromiseRejectBlock)reject)
{
    [LBRNAppleNativeDiagnostics replayWithCompletion:^(NSDictionary *result) {
      resolve(result);
    }];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(setNativeDiagnosticsContext:(NSDictionary *)context)
{
    return [LBRNAppleNativeDiagnostics setCorrelationContext:context];
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(nativeDiagnosticsStatus)
{
    return [LBRNAppleNativeDiagnostics status];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeLogBrewAppleDiagnosticsSpecJSI>(params);
}
#endif

@end
