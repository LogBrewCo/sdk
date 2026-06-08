# LogBrew Objective-C SDK

Public Objective-C SDK for Apple and mixed Swift/Objective-C apps. It ships as a small Foundation-based source/header package with no third-party runtime dependencies.

## Install From Source

Copy `include/LogBrew.h` and `src/LogBrew.m` into your app target, or vendor the source package and compile it with Foundation:

```bash
clang -fobjc-arc -Iobjc/logbrew-objc/include \
  objc/logbrew-objc/src/LogBrew.m \
  your_app.m \
  -framework Foundation \
  -o your_app
```

## Basic Usage

Use a clearly fake placeholder key in examples:

```objective-c
#import "LogBrew.h"

NSError *error = nil;
LBWConfig *config = [LBWConfig configWithAPIKey:@"LOGBREW_API_KEY"];
LBWClient *client = [[LBWClient alloc] initWithConfig:config error:&error];

[client releaseWithID:@"evt_release_001"
            timestamp:@"2026-06-02T10:00:00Z"
           attributes:@{@"version": @"1.2.3"}
                error:&error];

[client captureNetworkMilestoneWithID:@"evt_network_milestone_001"
                             timestamp:@"2026-06-02T10:00:08Z"
                                method:@"POST"
                         routeTemplate:@"/api/checkout"
                            statusCode:@202
                            durationMs:@184.5
                                status:nil
                               context:@{@"sessionId": @"session_123", @"screen": @"Checkout"}
                              metadata:nil
                                 error:&error];

LBWRecordingTransport *transport = [[LBWRecordingTransport alloc] init];
[client flushWithTransport:transport error:&error];
```

## Example Source

The `examples` directory contains copyable source for creating a client, previewing queued JSON, flushing through a transport, and handling SDK `NSError` values in your own Apple app.

## Product Timelines

Use `captureProductActionWithID:...` when your Objective-C or mixed Swift/Objective-C app owns a meaningful product step:

```objective-c
[client captureProductActionWithID:@"evt_product_action_001"
                          timestamp:@"2026-06-02T10:00:07Z"
                               name:@"checkout.pay_tapped"
                             status:nil
                            context:@{
                              @"sessionId": @"session_123",
                              @"screen": @"Checkout",
                              @"traceId": @"trace_abc",
                              @"funnel": @"checkout",
                              @"step": @"payment"
                            }
                           metadata:@{@"component": @"pay-button"}
                              error:&error];
```

Use `captureNetworkMilestoneWithID:...` for app-owned API milestones that should line up with actions, errors, logs, and traces:

```objective-c
[client captureNetworkMilestoneWithID:@"evt_network_milestone_001"
                             timestamp:@"2026-06-02T10:00:08Z"
                                method:@"POST"
                         routeTemplate:@"/api/checkout"
                            statusCode:@503
                            durationMs:@184.5
                                status:nil
                               context:@{@"sessionId": @"session_123", @"screen": @"Checkout"}
                              metadata:@{@"retryable": @YES}
                                 error:&error];
```

Network helpers normalize the method, strip query strings and fragments from route templates, default HTTP `4xx` and `5xx` milestones to `failure`, and store primitive metadata such as `sessionId`, `screen`, `traceId`, `funnel`, and `step`. They do not patch `NSURLSession`, record visual replay, collect headers, or capture request or response bodies. Keep user-entered text, raw URLs, query strings, headers, and payloads out of timeline metadata.

## Error Shape

SDK failures are returned as `NSError` values using `LBWErrorDomain`. The stable machine-readable code is stored in `error.userInfo[LBWErrorStableCodeKey]`, with values such as `validation_error`, `unauthenticated`, `network_failure`, `transport_error`, and `shutdown_error`.
