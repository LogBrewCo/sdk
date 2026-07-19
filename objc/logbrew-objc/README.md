# LogBrew Objective-C SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Objective-C SDK for Apple and mixed Swift/Objective-C apps. It ships as a small Foundation-based source/header package with no third-party runtime dependencies.

Start new Apple setup flows with the Swift/SwiftPM SDK in [`swift/logbrew-swift`](../../swift/logbrew-swift) when your app can use SwiftPM. Use this Objective-C package as an advanced source/header variant for Objective-C-only targets, mixed legacy apps, or apps that intentionally vendor SDK source.

Objective-C and mixed targets that use SwiftPM can add the separate `LogBrewCrash` product for explicit native fatal-crash capture and next-launch replay. It exports `LBWNativeCrashConfiguration`, `LBWNativeCrashCapture`, and `LBWNativeCrashRecord` through `@import LogBrewCrash;`. The source/header-only Objective-C SDK does not silently add a crash engine. See the Swift SDK's [Native Fatal Crashes](../../swift/logbrew-swift#native-fatal-crashes) section for ownership, privacy, retention, acknowledgement, and symbolication limits.

## Install From Source

Copy `include/LogBrew.h` and the Objective-C files in `src/` into your app target, or vendor the source package and compile it with Foundation:

```bash
clang -fobjc-arc -Iobjc/logbrew-objc/include \
  objc/logbrew-objc/src/*.m \
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

## Metrics

Use `metricWithID:timestamp:attributes:error:` for explicit product, service, or mobile measurements that your app already owns:

```objective-c
[client metricWithID:@"evt_metric_001"
           timestamp:@"2026-06-02T10:00:06Z"
          attributes:@{
            @"name": @"checkout.latency",
            @"kind": @"histogram",
            @"value": @184.5,
            @"unit": @"ms",
            @"temporality": @"delta",
            @"metadata": @{
              @"routeTemplate": @"/api/checkout",
              @"platform": @"ios"
            }
          }
               error:&error];
```

Metric kinds are `counter`, `gauge`, and `histogram`. Gauges use `instant` temporality; counters and histograms use `delta` or `cumulative` temporality and must be non-negative. Keep metric metadata low-cardinality and primitive, such as route templates, feature names, plan tiers, or platform names. Do not place user IDs, session IDs, trace IDs, raw URLs, query strings, headers, payloads, or free-form user text in metric metadata.

## Sending To LogBrew

Use `LBWHTTPTransport` when your application is ready to send events to the hosted LogBrew intake:

```bash
clang -fobjc-arc -Iobjc/logbrew-objc/include \
  objc/logbrew-objc/src/*.m \
  your_app.m \
  -framework Foundation \
  -o your_app
```

```objective-c
LBWHTTPTransport *transport =
    [[LBWHTTPTransport alloc] initWithEndpoint:LBWHTTPTransportDefaultEndpoint
                                      headers:@{@"x-logbrew-source": @"objc-app"}
                                      timeout:10.0
                                        error:&error];

[client flushWithTransport:transport error:&error];
```

`LBWHTTPTransport` uses Foundation `NSURLSession`, so it does not add third-party dependencies. It validates `http://` and `https://` endpoints, sends `authorization: Bearer <api key>` and `content-type: application/json`, rejects custom overrides for those reserved headers, supports safe additional headers, and maps request failures into retryable transport errors. It does not patch global `NSURLSession` behavior, inspect application traffic, collect request or response payloads, or capture arbitrary headers from your app.

## Automatic Delivery (Opt-In)

Manual delivery remains the default. To let one client own delivery, provide an app-owned transport and explicit options before capturing events:

```objective-c
LBWAutomaticDeliveryOptions *options = [[LBWAutomaticDeliveryOptions alloc] init];
options.interval = 5.0;
options.threshold = 100U;

[client startAutomaticDeliveryWithTransport:transport options:options error:&error];
[client logWithID:@"evt_log_automatic_001"
         timestamp:@"2026-06-02T10:00:03Z"
        attributes:@{ @"message": @"worker started", @"level": @"info" }
             error:&error];

LBWDeliveryHealth *health = client.deliveryHealth;
NSLog(@"state=%ld queued=%lu dropped=%lu",
      (long)health.state,
      (unsigned long)health.queuedEvents,
      (unsigned long)health.droppedEvents);
[client shutdownOwnedTransportWithError:&error];
```

Automatic delivery keeps at most 1,000 events and 4 MiB in memory, sends at most 100 events and 256 KiB per request, and retains the exact failed prefix for bounded retry. Interval and retry-delay options must not exceed 24 hours. Authentication, quota, validation, and other terminal failures pause delivery without dropping the queue; correct the condition and call `recoverAutomaticDeliveryWithError:`. `stopAutomaticDelivery` returns the client to manual mode while preserving unacknowledged events. `deliveryHealth` exposes fixed counters and enums only, never event content, identifiers, API keys, endpoints, headers, or raw transport errors. The queue is process-memory only; call `shutdownOwnedTransportWithError:` during an orderly app termination when the platform gives your app time to finish work.

## Durable Delivery (Opt-In)

Durable delivery is separate from automatic delivery. Enable it before starting automatic delivery when accepted events must survive process termination:

```objective-c
NSURL *applicationSupport = [[[NSFileManager defaultManager]
    URLsForDirectory:NSApplicationSupportDirectory
           inDomains:NSUserDomainMask] firstObject];
NSURL *logBrewDirectory = [applicationSupport URLByAppendingPathComponent:@"LogBrew"
                                                               isDirectory:YES];
[[NSFileManager defaultManager] createDirectoryAtURL:logBrewDirectory
                          withIntermediateDirectories:YES
                                           attributes:@{NSFilePosixPermissions: @0700}
                                                error:&error];

LBWDurableDeliveryOptions *durable =
    [[LBWDurableDeliveryOptions alloc] initWithDirectoryURL:logBrewDirectory];
[client enableDurableDeliveryWithOptions:durable error:&error];
[client startAutomaticDeliveryWithTransport:transport options:options error:&error];
```

Pass a private Application Support directory owned by your app. The SDK creates and exclusively owns only its fixed `logbrew-delivery-v1` child. It applies owner-only permissions, Apple file protection where available, and backup exclusion. Event payloads are stored, but API keys, endpoints, headers, and raw transport errors are not. One process and one client may own the child at a time.

Durable delivery preserves FIFO order and the exact failed request prefix across restart. Corrupt, unknown, or unreadable durable state pauses capture and delivery instead of silently deleting data. After inspecting the cause, call `purgeDurableDeliveryWithError:` to remove only the SDK-owned child and explicitly discard its queued events. At-least-once delivery can duplicate a request when a process stops after the server accepts it but before local acknowledgement completes. Atomic records detect incomplete or corrupt state; they do not guarantee survival when the operating system has not committed a write before sudden power loss. Manual and process-memory delivery remain the defaults.

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

## Tracing

Use `LBWTraceContext` and `LBWTrace` when your app receives or creates W3C trace context and wants issues, logs, product actions, network milestones, metrics, and spans to line up in LogBrew:

```objective-c
LBWTraceContext *trace =
    [LBWTraceContext continueOrCreateContextFromTraceparent:incomingTraceparent];
LBWTraceScope *scope = [LBWTrace activateContext:trace];

[client logWithID:@"evt_trace_log_001"
        timestamp:@"2026-06-02T10:00:03Z"
       attributes:@{
         @"message": @"checkout retry scheduled",
         @"level": @"warning",
         @"logger": @"checkout"
       }
            error:&error];

NSDictionary *spanAttributes =
    [trace spanAttributesWithName:@"POST /api/checkout"
                           status:@"error"
                       durationMs:@184.5
                         metadata:@{@"routeTemplate": @"/api/checkout"}
                            error:&error];
[client spanWithID:@"evt_trace_span_001"
         timestamp:@"2026-06-02T10:00:07Z"
        attributes:spanAttributes
             error:&error];

NSMutableURLRequest *request =
    [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"https://api.example.com/api/checkout?cart=123#pay"]];
request.HTTPMethod = @"POST";
LBWURLSessionSpan *urlSessionSpan = [LBWTrace startURLSessionSpanForRequest:request error:&error];
LBWURLSessionTimings *urlSessionTimings =
    [LBWURLSessionTimings timingsWithFetchMs:@188.5
                                  redirectMs:@3.25
                                nameLookupMs:@2.5
                                   connectMs:@10
                                       tlsMs:@6.5
                                      sendMs:@4
                                      waitMs:@120.25
                                   receiveMs:@25
                            requestBodyBytes:@512
                           responseBodyBytes:@4096
                                       error:&error];

// If your NSURLSessionTaskDelegate receives task metrics, prefer the typed helper:
// urlSessionTimings = [LBWURLSessionTimings timingsWithTaskMetrics:metrics error:&error];

// Use urlSessionSpan.request with your own NSURLSession call, then capture the completion.
[client captureURLSessionSpanWithID:@"evt_trace_urlsession_001"
                           timestamp:@"2026-06-02T10:00:08Z"
                                span:urlSessionSpan
                          statusCode:@503
                          durationMs:@184.5
                           errorType:nil
                            metadata:@{@"component": @"pay-api"}
                             timings:urlSessionTimings
                               error:&error];

[client captureLifecycleSpanWithID:@"evt_trace_lifecycle_001"
                          timestamp:@"2026-06-02T10:00:09Z"
                      previousState:@"active"
                       currentState:@"background"
                         durationMs:@1532.25
                            context:@{@"screen": @"Checkout"}
                           metadata:@{@"component": @"app-delegate"}
                              error:&error];

NSDictionary *headers = [LBWTrace outgoingHeaders];
[scope close];
```

If your Objective-C layer already owns an OpenTelemetry `SpanContext`, copy only the validated trace ID, span ID, and trace flags into LogBrew without adding OpenTelemetry as a LogBrew dependency:

```objective-c
LBWOpenTelemetrySpanContext *otelParent =
    [LBWTrace openTelemetrySpanContextWithTraceID:@"4bf92f3577b34da6a3ce929d0e0e4736"
                                           spanID:@"00f067aa0ba902b7"
                                       traceFlags:@"01"
                                            error:&error];

LBWTraceContext *trace = [LBWTrace contextFromOpenTelemetrySpanContext:otelParent];
NSDictionary *spanAttributes =
    [LBWTrace spanAttributesFromOpenTelemetrySpanContext:otelParent
                                                    name:@"POST /api/checkout"
                                                  status:@"ok"
                                              durationMs:@42
                                                metadata:@{@"routeTemplate": @"/api/checkout"}
                                                   error:&error];
```

If your app already has an Objective-C-compatible live span object, pass either the span context object or a span object that exposes `context`, `traceId`, `spanId`, and either `traceFlags` or `isSampled`. This is useful for mixed apps that wrap OpenTelemetry Swift state in an app-owned `NSObject` adapter:

```objective-c
LBWOpenTelemetrySpanContext *otelParent =
    [LBWTrace openTelemetrySpanContextFromSpanObject:appOwnedOpenTelemetrySpan error:&error];

LBWTraceContext *trace = [LBWTrace contextFromOpenTelemetrySpanObject:appOwnedOpenTelemetrySpan error:&error];
NSDictionary *spanAttributes =
    [LBWTrace spanAttributesFromOpenTelemetrySpanObject:appOwnedOpenTelemetrySpan
                                                  name:@"POST /api/checkout"
                                                status:@"ok"
                                            durationMs:@42
                                              metadata:@{@"routeTemplate": @"/api/checkout"}
                                                 error:&error];
```

`continueOrCreateContextFromTraceparent:` accepts valid W3C `traceparent` values, creates a fresh local span ID, and falls back to a local root trace for malformed propagation. While a scope is active on the current thread, issue, log, action, and metric metadata receive `traceId`, `spanId`, `parentSpanId`, `traceFlags`, and `traceSampled`; active trace fields override caller-supplied trace metadata so telemetry stays internally consistent. `outgoingHeaders` returns only a normalized `traceparent` header for app-owned HTTP clients. `startURLSessionSpanForRequest:error:` copies your request, adds only `traceparent`, strips query strings and fragments from the span route, and returns a child span context for `captureURLSessionSpanWithID:...` when your request completes. `LBWURLSessionTimings` lets your own `NSURLSessionTaskDelegate` pass `NSURLSessionTaskMetrics` directly or provide numeric phase durations and request/response byte counts; timing values overwrite spoofed timing keys from caller metadata.

Use `captureLifecycleSpanWithID:...` from app-owned AppDelegate, SceneDelegate, UIKit, or AppKit lifecycle hooks when a foreground/background or view lifecycle transition is already known to your app. It creates a child span under the active trace, stores primitive lifecycle metadata such as `previousState`, `currentState`, `screen`, and `durationSource`, and leaves session-health decisions to your application and backend-owned setup state.

The OpenTelemetry helpers are copy helpers only: they do not install OpenTelemetry exporters, processors, or global context hooks, and they do not ingest baggage or tracestate. Swift-only OpenTelemetry values may need an app-owned `NSObject` adapter before Objective-C can inspect them. The trace helpers do not patch `NSURLSession`, do not observe application lifecycle notifications, do not swizzle UIKit/AppKit methods, do not collect headers or payloads, do not serialize the raw incoming `traceparent`, and do not capture query strings or fragments. URLSession timing metadata is limited to numeric phase durations and byte counts; do not place raw URLs, headers, payloads, cookies, or user-entered text in timing or span metadata. Use only the project-scoped client key shown by LogBrew setup examples when sending telemetry.

## Error Shape

SDK failures are returned as `NSError` values using `LBWErrorDomain`. The stable machine-readable code is stored in `error.userInfo[LBWErrorStableCodeKey]`, with values such as `validation_error`, `unauthenticated`, `network_failure`, `transport_error`, and `shutdown_error`.
