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

LBWRecordingTransport *transport = [[LBWRecordingTransport alloc] init];
[client flushWithTransport:transport error:&error];
```

## Example Source

The `examples` directory contains copyable source for creating a client, previewing queued JSON, flushing through a transport, and handling SDK `NSError` values in your own Apple app.

## Error Shape

SDK failures are returned as `NSError` values using `LBWErrorDomain`. The stable machine-readable code is stored in `error.userInfo[LBWErrorStableCodeKey]`, with values such as `validation_error`, `unauthenticated`, `network_failure`, `transport_error`, and `shutdown_error`.
