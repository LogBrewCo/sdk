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

Use a clearly fake placeholder key in examples and tests:

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

## Examples

```bash
make -C objc/logbrew-objc/examples
make -C objc/logbrew-objc/examples run-readme-example
make -C objc/logbrew-objc/examples run
make -C objc/logbrew-objc/examples run-real-user-smoke
```

`run-readme-example` prints a contract-valid event batch as JSON on stdout. `run-real-user-smoke` also exercises empty flush, validation failure, unauthenticated response, retry recovery, retry-budget failure, non-retryable status handling, graceful shutdown, and post-shutdown rejection.

## Error Shape

SDK failures are returned as `NSError` values using `LBWErrorDomain`. The stable machine-readable code is stored in `error.userInfo[LBWErrorStableCodeKey]`, with values such as `validation_error`, `unauthenticated`, `network_failure`, `transport_error`, and `shutdown_error`.

## Package Checks

```bash
bash scripts/check_objc_package.sh
bash scripts/real_user_objc_smoke.sh
```

The package checker compiles tests and examples with `-fobjc-arc -Wall -Wextra -Wpedantic -Werror`, validates example JSON against the shared contract/parity fixtures, inspects the source archive, and builds the extracted package. The real-user smoke installs that archive into a fresh temp native app under `vendor/logbrew-objc`, proves source package remove/add behavior, runs a consumer app, and verifies shipped examples from the installed package.
