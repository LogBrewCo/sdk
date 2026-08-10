# LogBrew Swift SDK

<p align="center">
  <img src="https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-transparent-512.png" alt="LogBrew logo" width="96" height="96">
</p>

Public Swift SDK for sending logs, errors, spans, actions, releases, environments, and explicit metrics from your Swift or Apple-platform app to the hosted LogBrew observability service.

For Apple app setup flows, choose the Swift path first. Use this SDK for iOS, macOS, tvOS, and watchOS Swift apps through SwiftPM. Objective-C and mixed Swift/Objective-C apps that cannot consume the Swift package can use the advanced source/header variant in [`objc/logbrew-objc`](../../objc/logbrew-objc).

## Install

```swift
.package(url: "https://github.com/LogBrewCo/sdk.git", from: "0.1.9")
```

Use the `LogBrew` product from the repository root SwiftPM package. Add the separate `LogBrewCrash` product only when your Apple app explicitly opts into native fatal-crash capture. Local contributors can also open the Swift package directly from `swift/logbrew-swift`.

The package ships a `LogBrew` library product plus copyable examples for creating a client, previewing queued JSON, flushing through a transport, and using the Swift logger facade in your own app. If you use an AI coding assistant, ask it to install the `LogBrew` product, create one app-owned client, wire your chosen signals, and keep personally sensitive values out of messages and metadata.

## Example

```swift
import LogBrew

let client = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "logbrew-swift",
    sdkVersion: "0.1.0"
)

try client.release(
    "evt_release_001",
    timestamp: "2026-06-02T10:00:00Z",
    attributes: ReleaseAttributes(version: "1.2.3", commit: "abc123def456", notes: "Public release marker")
)
try client.log(
    "evt_log_001",
    timestamp: "2026-06-02T10:00:03Z",
    attributes: LogAttributes(message: "worker started", level: .info, logger: "job-runner")
)
try client.metric(
    "evt_metric_001",
    timestamp: "2026-06-02T10:00:06Z",
    attributes: MetricAttributes(
        name: "queue.depth",
        kind: .gauge,
        value: 42,
        unit: "items",
        temporality: .instant,
        metadata: ["queue": "checkout"],
        description: "Number of items waiting in the checkout queue."
    )
)
try client.captureNetworkMilestone(
    "evt_network_milestone_001",
    timestamp: "2026-06-02T10:00:08Z",
    method: "POST",
    routeTemplate: "/api/checkout",
    statusCode: 202,
    durationMs: 184.5,
    context: ProductTimelineContext(sessionId: "session_123", screen: "Checkout")
)

let logger = try LogBrewLogger(
    client: client,
    subsystem: "co.logbrew.app",
    category: "checkout",
    metadata: ["build": "debug"]
)
logger.warning("checkout button tapped", metadata: ["screen": "Checkout"])

print(try client.previewJSON())

let transport = RecordingTransport.alwaysAccept()
let response = try client.shutdown(transport: transport)
print("status=\(response.statusCode) attempts=\(response.attempts)")
```

Use a clearly fake placeholder like `LOGBREW_API_KEY` in examples. Call `flush(transport:)` or `shutdown(transport:)` to send queued events through a transport, and use `previewJSON()` when you want a stable local JSON preview before sending anything.

## Rich Investigation Context

The client automatically adds conservative Swift runtime, Apple operating-system version, application bundle, and CPU architecture context to every release, environment, issue, log, span, action, and metric. It does not automatically collect a device identifier, hardware model, host name, account name, locale, IP address, user identity, or session identity. Disable even this conservative context with `includeAutomaticContext: false` when an app needs a fully explicit capture policy.

Add stable app-owned context once on the client, then refine it for a task or one event:

```swift
let client = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "checkout-ios",
    sdkVersion: "0.1.0",
    context: TelemetryContext(
        resource: TelemetryResource(
            service: TelemetryNamedVersion(name: "checkout-app", version: "2.4.0"),
            deployment: TelemetryDeployment(environment: "production", release: "checkout@2.4.0")
        ),
        tags: ["plan": "team"]
    )
)

try await LogBrewTelemetry.withContext(
    TelemetryContext(
        session: TelemetrySessionContext(id: "opaque-session-01"),
        subject: TelemetrySubjectContext(id: "opaque-subject-01", kind: .user),
        tags: ["journey": "checkout"]
    )
) {
    try client.log(
        "evt_checkout_started",
        timestamp: "2026-08-06T10:00:00Z",
        attributes: LogAttributes(
            message: "Checkout started",
            level: .info,
            context: TelemetryContext(tags: ["step": "confirm"])
        )
    )
}
```

Context merge order is automatic, client, task-local, active trace, then event; later layers win while resource fields and tags merge. On spans, valid first-class `traceId`, `spanId`, and `parentSpanId` values always replace `context.trace` so one event cannot contradict itself; legacy non-W3C span IDs remain supported without emitting a conflicting typed trace object. Context is schema-versioned, copied into the queued event, and bounded to 256-character values, 200-character opaque IDs, and 32 low-cardinality tags. Trace IDs use W3C hex shapes. Session and subject IDs must be app-owned opaque identifiers; never use names, email addresses, IP addresses, authentication material, or raw user input. `LogBrewTelemetry` uses Swift task-local storage, so nested synchronous and asynchronous scopes unwind without global mutable identity.

## Issue Diagnostics and Breadcrumbs

Use `IssueAttributes.fromError(...)` for a handled Swift error. It records the dynamic error type, a stable mechanism and handled state, and a safe call-site frame using `#fileID`, `#line`, `#column`, and `#function`. It deliberately does not format the error, copy its description, capture raw stack text, read locals or arguments, or send an absolute source path. Pass an explicit `message` only when the application has approved that value for display.

```swift
enum CheckoutError: Error {
    case authorizationDeclined
}

try client.addBreadcrumb(
    IssueBreadcrumb(
        timestamp: "2026-08-06T09:59:59Z",
        category: "checkout.submit",
        type: "navigation",
        level: .info,
        message: "Payment step submitted",
        data: ["attempt": 2]
    )
)

do {
    try await submitCheckout()
} catch {
    try client.issue(
        "evt_checkout_error",
        timestamp: "2026-08-06T10:00:00Z",
        attributes: IssueAttributes.fromError(
            error,
            title: "Payment authorization failed",
            mechanism: "swift.task",
            handled: true
        )
    )
}
```

The client retains the newest 64 validated breadcrumbs, attaches a detached oldest-to-newest snapshot to each later issue, and sets `breadcrumbsTruncated` when older history was evicted. `clearBreadcrumbs()` affects only future issues. Breadcrumbs accept stable machine categories, an optional bounded message, and at most eight flat finite primitive data fields. Explicit issue frames are capped at 32 and keep only bounded filename, positive coordinates, optional function/module ownership, and an optional Debug ID. Absolute file prefixes and query or fragment data are removed before queue admission.

## Automatic Delivery (Opt-In)

Manual capture and delivery remain the default. When the client should own delivery, start one explicit scheduler with an app-owned transport before capturing events:

```swift
let transport = try HTTPTransport(timeout: 5)
try client.startAutomaticDelivery(
    transport: transport,
    options: AutomaticDeliveryOptions(interval: 5, threshold: 100)
)

try client.log(
    "evt_log_automatic_001",
    timestamp: "2026-06-02T10:00:03Z",
    attributes: LogAttributes(message: "worker started", level: .info)
)

let health = client.deliveryHealth()
print("state=\(health.state) queued=\(health.queuedEvents) dropped=\(health.droppedEvents)")
_ = try client.shutdown()
```

Automatic delivery keeps at most 1,000 events and 4 MiB in memory, sends at most 100 events and 256 KiB per request, and retains the exact failed prefix for bounded retry. Interval and retry-delay options must not exceed 24 hours. Authentication, quota, validation, and other terminal failures pause delivery without dropping the queue; correct the condition and call `recoverAutomaticDelivery()`. `stopAutomaticDelivery()` returns the client to manual mode and preserves unacknowledged events. `deliveryHealth()` contains fixed counters and states only, never event content, identifiers, API keys, endpoints, headers, or raw transport errors. The queue is process-memory only; call `shutdown()` during an orderly app termination when the platform gives your app time to finish work.

## Durable Delivery (Opt-In)

Durable delivery is separate from automatic delivery. Enable it before starting automatic delivery when accepted events must survive process termination:

```swift
let applicationSupport = try FileManager.default.url(
    for: .applicationSupportDirectory,
    in: .userDomainMask,
    appropriateFor: nil,
    create: true
)
let logBrewDirectory = applicationSupport.appendingPathComponent("LogBrew", isDirectory: true)
try FileManager.default.createDirectory(
    at: logBrewDirectory,
    withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o700]
)

try client.enableDurableDelivery(
    options: DurableDeliveryOptions(directory: logBrewDirectory)
)
try client.startAutomaticDelivery(transport: transport)
```

Pass a private Application Support directory owned by your app. The SDK creates and exclusively owns only its fixed `logbrew-delivery-v1` child. It applies owner-only permissions, Apple file protection where available, and backup exclusion. Event payloads are stored, but API keys, endpoints, headers, and raw transport errors are not. One process and one client may own the child at a time.

Durable delivery preserves FIFO order and the exact failed request prefix across restart. Corrupt, unknown, or unreadable durable state pauses capture and delivery instead of silently deleting data. After inspecting the cause, call `purgeDurableDelivery()` to remove only the SDK-owned child and explicitly discard its queued events. At-least-once delivery can duplicate a request when a process stops after the server accepts it but before local acknowledgement completes. Atomic records detect incomplete or corrupt state; they do not guarantee survival when the operating system has not committed a write before sudden power loss. Manual and process-memory delivery remain the defaults.

## Metrics

Use `client.metric(...)` when your app owns a numeric measurement you want to send to LogBrew:

```swift
try client.metric(
    "evt_metric_001",
    timestamp: "2026-06-02T10:00:06Z",
    attributes: MetricAttributes(
        name: "checkout.queue.depth",
        kind: .gauge,
        value: 12,
        unit: "items",
        temporality: .instant,
        metadata: ["queue": "checkout"]
    )
)
```

Supported metric kinds are `counter`, `gauge`, and `histogram`. Counters and histograms use `delta` or `cumulative` temporality and must be non-negative. Gauges use `instant` temporality and may be negative. An optional `description` gives people and investigation tools the stable meaning of the measurement. Keep it generic, single-line, between 1 and 1,024 Unicode scalar values, and free of identifiers, personal data, or changing values. It is not a query dimension. Keep metric metadata low-cardinality and primitive, such as route template or queue name. Put shared service, deployment, runtime, session, subject, trace, and tag evidence in `TelemetryContext` so the metric can be compared with related issues, logs, actions, and spans. Avoid raw URLs, query strings, stack traces, authentication data, and unbounded labels.

The Swift SDK does not automatically collect app runtime, URLSession, SwiftUI, or database metrics. Add explicit measurements where they are meaningful for your product, or keep those signals in framework-owned integrations when you add them.

## Product Timelines

Use `captureProductAction(...)` when your Swift, iOS, macOS, watchOS, or tvOS app owns a meaningful product step:

```swift
let context = ProductTimelineContext(
    sessionId: "session_123",
    screen: "Checkout",
    traceId: "trace_abc",
    funnel: "checkout",
    step: "payment"
)

try client.captureProductAction(
    "evt_product_action_001",
    timestamp: "2026-06-02T10:00:07Z",
    name: "checkout.pay_tapped",
    context: context,
    metadata: ["component": "pay-button"]
)
```

Use `captureNetworkMilestone(...)` for app-owned API milestones that should line up with actions, errors, logs, and traces:

```swift
try client.captureNetworkMilestone(
    "evt_network_milestone_001",
    timestamp: "2026-06-02T10:00:08Z",
    method: "POST",
    routeTemplate: "/api/checkout",
    statusCode: 503,
    durationMs: 184.5,
    context: context,
    metadata: ["retryable": true]
)
```

Product timeline helpers preserve primitive metadata such as `sessionId`, `screen`, `traceId`, `funnel`, and `step`, and also promote `sessionId` into typed telemetry session context so actions can correlate with issues, logs, traces, and metrics without relying on one flattened key. Network helpers normalize the method, strip query strings and fragments from route templates, and default HTTP `4xx` and `5xx` milestones to `failure`. They do not patch `URLSession`, record visual replay, collect headers, or capture request or response bodies. Keep user-entered text, raw URLs, query strings, headers, and payloads out of timeline metadata.

## Trace Correlation

Use `LogBrewTrace` when app-owned Swift work should keep logs, errors, product actions, metrics, and spans on the same W3C trace. Valid incoming `traceparent` values continue the upstream trace with a fresh local span id; missing or malformed propagation starts a local root trace without throwing into your app:

```swift
let trace = LogBrewTrace.continueOrCreateContext(
    fromTraceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
)

try await LogBrewTrace.withContext(trace) {
    logger.warning("checkout retry scheduled", metadata: ["screen": "Checkout"])
    try client.issue(
        "evt_issue_001",
        timestamp: "2026-06-02T10:00:02Z",
        attributes: IssueAttributes(title: "Checkout timeout", level: .error)
    )
    try client.captureNetworkMilestone(
        "evt_network_milestone_001",
        timestamp: "2026-06-02T10:00:08Z",
        method: "POST",
        routeTemplate: "/api/checkout",
        statusCode: 503,
        durationMs: 184.5
    )
    try client.span(
        "evt_span_001",
        timestamp: "2026-06-02T10:00:09Z",
        attributes: try LogBrewTrace.spanAttributes(name: "POST /api/checkout", status: .error, durationMs: 184.5)
    )

    var request = URLRequest(url: URL(string: "https://api.example.com/api/checkout")!)
    request.httpMethod = "POST"
    let requestSpan = try LogBrewTrace.startURLSessionSpan(for: request)
    // Send requestSpan.request with your app-owned URLSession.
    let timings = try LogBrewURLSessionTimings(
        fetchMs: 184.5,
        nameLookupMs: 2.5,
        connectMs: 10,
        tlsMs: 6.5,
        sendMs: 4,
        waitMs: 120.25,
        receiveMs: 25,
        responseBodyBytes: 4096
    )
    try client.captureURLSessionSpan(
        "evt_urlsession_span_001",
        timestamp: "2026-06-02T10:00:10Z",
        span: requestSpan,
        statusCode: 503,
        durationMs: 184.5,
        timings: timings,
        metadata: ["component": "checkout-api"]
    )

    let urlSessionTracer = try LogBrewURLSessionTracer(
        client: client,
        onCaptureError: { error in
            // Telemetry capture failures should not break app networking.
            print("LogBrew URLSession span capture failed: \(error)")
        }
    )
    let (_, response) = try await urlSessionTracer.data(
        for: request,
        routeTemplate: "/api/checkout",
        metadata: ["component": "checkout-api"]
    )
    print("status=\((response as? HTTPURLResponse)?.statusCode ?? 0)")

    let lifecycleTracker = try LogBrewLifecycleTracker(
        client: client,
        initialState: "active",
        initialTimestampMs: 1000,
        eventIDPrefix: "evt_lifecycle_span",
        context: ["screen": "Checkout"]
    )
    try lifecycleTracker.captureTransition(
        to: "background",
        timestamp: "2026-06-02T10:00:11Z",
        atMs: 2532.25,
        metadata: ["component": "scene-delegate"]
    )
}
```

If your app already uses OpenTelemetry, copy only the stable W3C fields from the app-owned `SpanContext` and let LogBrew create its own child span. This keeps LogBrew dependency-free and avoids installing an exporter or processor:

```swift
let otelParent = try LogBrewTrace.openTelemetrySpanContext(
    traceId: otelSpanContext.traceId.hexString,
    spanId: otelSpanContext.spanId.hexString,
    traceFlags: otelSpanContext.traceFlags.hexString
)
let trace = LogBrewTrace.context(fromOpenTelemetrySpanContext: otelParent)
```

For a live OpenTelemetry `SpanContext`, keep the conformance in your app target so LogBrew still does not depend on OpenTelemetry:

```swift
extension SpanContext: LogBrewOpenTelemetrySpanContextCarrier {
    public var logBrewOpenTelemetryTraceId: String { traceId.hexString }
    public var logBrewOpenTelemetrySpanId: String { spanId.hexString }
    public var logBrewOpenTelemetryTraceFlags: String { traceFlags.hexString }
    public var logBrewOpenTelemetryIsValid: Bool { isValid }
}

if let otelParent = try LogBrewTrace.openTelemetrySpanContext(from: appOwnedOpenTelemetrySpan.context) {
    let trace = LogBrewTrace.context(fromOpenTelemetrySpanContext: otelParent)
    // Run LogBrew work under trace.
}
```

`LogBrewTrace.current` is task-local, so async work started inside `withContext(...)` can read the active context without global state. `LogBrewClient` writes the active `traceId`, `spanId`, `parentSpanId`, and sampled decision into typed `TelemetryContext` and keeps primitive correlation metadata for compatibility on issues, logs, actions, and metrics. `LogBrewLogger` receives the same correlation through the client. `LogBrewTrace.spanAttributes(...)` reuses the active span id for a span event, `LogBrewTrace.outgoingHeaders()` creates only a normalized `traceparent` header for app-owned requests, and `LogBrewTrace.startURLSessionSpan(...)` creates a child span context plus a copied `URLRequest` with only `traceparent` injected. Call `captureURLSessionSpan(...)` after your URLSession completion to record sanitized method, route template, status, duration, and primitive metadata. Use `LogBrewURLSessionTracer` when you want a small app-owned wrapper around `URLSession.data(for:)`: it injects one `traceparent`, measures monotonic duration, captures success or failure spans, reports span-capture failures through `onCaptureError`, and rethrows the original request error. If your app collects `URLSessionTaskMetrics` through its own delegate, pass `try LogBrewURLSessionTimings(taskMetrics: metrics)` or app-supplied `LogBrewURLSessionTimings(...)` to include bounded phase timings such as name lookup, connect, TLS, send, wait, receive, and body byte counts.

Add up to eight typed span milestones and eight W3C span links when a trace needs more than one duration row:

```swift
let span = SpanAttributes(
    name: "checkout.submit",
    traceId: trace.traceId,
    spanId: trace.spanId,
    parentSpanId: trace.parentSpanId,
    status: .error,
    durationMs: 420,
    events: [
        SpanEventSummary(
            name: "payment.retry",
            timestamp: "2026-08-06T10:00:00.200Z",
            metadata: ["attempt": 2]
        ),
        SpanEventSummary(name: "payment.rejected", metadata: ["retryable": false])
    ],
    links: [
        SpanLinkSummary(
            traceId: "11111111111111111111111111111111",
            spanId: "2222222222222222",
            sampled: true,
            metadata: ["relationship": "follows_from"]
        )
    ]
)
```

Milestones preserve bounded names, optional RFC 3339 timestamps, and flat primitive metadata. Links preserve only non-zero W3C trace/span IDs, an optional sampling decision, and flat primitive metadata. Invalid or oversized evidence fails before queue admission instead of silently creating a contradictory trace.

Use `LogBrewLifecycleTracker` from your own SwiftUI, UIKit, AppKit, or SceneDelegate lifecycle hooks when you want app state transitions such as `active -> background` to appear as child spans on the active trace. The tracker dedupes repeated states, computes previous-state duration from app-owned timestamps, records primitive metadata only, and overwrites spoofed trace metadata with the active child span context. Use the lower-level `captureLifecycleSpan(...)` helper only when your app already owns previous/current state and duration values.

The Swift SDK does not patch `URLSession`, install notification observers, swizzle SwiftUI/UIKit/AppKit lifecycle APIs, add an OpenTelemetry dependency, install OpenTelemetry exporters or processors, read baggage or tracestate, collect arbitrary headers, capture request or response bodies, serialize the raw `traceparent` value into event metadata, derive local session health, or start automatic database/network child spans. URLSession timing metadata is explicit and limited to numeric phase durations and byte counts; it does not include URLs, headers, payloads, cookies, or response text. URLSession and lifecycle spans are explicit and app-owned; keep route templates low-cardinality and query-free, and add richer framework instrumentation only in a dedicated integration package.

## Native Fatal Crashes

Add the opt-in `LogBrewCrash` SwiftPM product when one app-owned integration should capture fatal Apple process crashes and replay a privacy-bounded issue on the next launch. `LogBrewCrash` uses the established KSCrash recording engine; LogBrew does not implement signal or Mach exception handling itself.

```swift
import Foundation
import LogBrew
import LogBrewCrash

let applicationSupport = try FileManager.default.url(
    for: .applicationSupportDirectory,
    in: .userDomainMask,
    appropriateFor: nil,
    create: true
)
let crashCapture = NativeCrashCapture(
    configuration: try NativeCrashConfiguration(
        storageDirectory: applicationSupport.appendingPathComponent("LogBrewCrash", isDirectory: true),
        maxStoredReports: 5
    )
)

try crashCapture.install()

let replay = try crashCapture.replayPendingReports(in: client, transport: transport)
print("acknowledged=\(replay.acknowledged) pending=\(replay.pending)")
```

Enable durable delivery on the client before replay when a failed request must survive another restart. The direct replay method deletes a raw report only after the existing delivery engine accepts its exact issue prefix. The handler-based overload remains available when an app owns a different delivery boundary; its handler must return `true` only after acceptance. Returning `false` retains that report and every later valid report. Replay is oldest-first, uses the crash report's stable UUID as the event id, verifies the raw report did not change before acknowledgement, discards malformed or oversized reports without reflecting their contents, and fails closed on replaced or undeletable reports. Enqueueing the same retained crash into the same client is idempotent, while a different event with that ID fails closed. `purge()` is an explicit local deletion operation; `status()` exposes only lifecycle and bounded acknowledgement, discard, and pending facts with a fixed outcome enum. KSCrash does not expose a directory-fsync acknowledgement API, so a power loss immediately after deletion can conservatively replay the same stable event ID on a later launch rather than silently dropping a visible pending report.

Capture is process-wide and intentionally single-owner because fatal signal and Mach exception handlers cannot be safely stacked. Installation is idempotent for the owning object, but ownership cannot be transferred or the KSCrash handler uninstalled until process restart, and an inherited post-fork object fails closed. `stopReplay()` prevents further replay through that adapter and retains pending reports; it does not claim to remove the process-lifetime engine handler. Use a dedicated directory whose parent already exists. LogBrew normalizes it, rejects a symlink or non-directory target, pins its inode for the integration lifetime, and tightens it to owner-only access before engine installation. The engine keeps at most five raw reports by default; replay discards a raw report larger than 4 MiB by default. KSCrash's raw app-local report can still contain stack, binary, system, and application details even though memory introspection, queue names, user context, and console capture are disabled. Treat that directory as app-controlled sensitive data and apply your own cloud-synchronization, data-protection, consent, and retention policy.

Only fixed title, severity, replay marker, typed `AppleNativeCrash` or `AppleNativeHang` exception identity, allowlisted mechanism and handled state, and privacy-bounded native frame identities and offsets are added to the LogBrew issue. Raw reports, exception reasons, messages, stack memory, thread names, console logs, paths, process data, user data, headers, authentication data, and device identity are not uploaded by this integration. This capture feature does not upload debug objects itself. Use the released `logbrew debug-artifacts upload` and `logbrew debug-artifacts lookup` commands with the exact project, release, environment, service, Mach-O UUID, and architecture to enable hosted native symbolication.

To bind native frames to an uploaded Apple debug object, configure the exact
project, release, environment, and active project service name used by the
artifact pipeline. LogBrew does not derive or substitute any of these values.
Each runtime frame retains its canonical Mach-O UUID and one supported
architecture (`arm64`, `arm64e`, or `x86_64`) alongside that identity.
Fatal reports persist that exact capture-time identity in one SDK-owned,
validated report field. Reports created by older LogBrew versions replay
without artifact identity rather than borrowing identity from a newer launch.

App-hang capture is a separate, explicit opt-in on the same capture owner:

```swift
let identity = try NativeArtifactIdentity(
    projectId: "550e8400-e29b-41d4-a716-446655440000",
    release: "com.example.app@1.2.3+45",
    environment: "production",
    service: "ios-app"
)
let watchdog = try NativeHangWatchdogConfiguration(
    threshold: 2,
    diagnosticsHandler: { diagnostic in
        // Fixed diagnostic code only; no stack, payload, path, or error text.
        print(diagnostic.code.rawValue)
    }
)
let crashCapture = NativeCrashCapture(
    configuration: try NativeCrashConfiguration(
        storageDirectory: applicationSupport.appendingPathComponent("LogBrewCrash", isDirectory: true),
        artifactIdentity: identity,
        hangWatchdog: watchdog
    )
)
try crashCapture.install()
```

Install on the main thread before root UI registration. The watchdog observes
standard UIKit active-state notifications without swizzling, pings the main
queue from a private timer, and captures at most 32 native UUID/architecture/
offset tuples after the configured threshold. It suppresses capture while the
app is inactive, under a debugger, during serious or critical thermal state, or
when the watchdog timer itself resumes too late to distinguish a scheduler
stall. A recovered hang is durably marked handled before it can be replayed;
an ongoing record left by process termination replays as an unhandled critical
hang. Both use a stable event ID, retain the record after rejected admission,
and delete it only after accepted delivery. Hang issues include one numeric
`durationMs` metadata value measured from the watchdog's monotonic clock. For
an ongoing incident it is the elapsed duration at capture; for a recovered
incident it is the elapsed duration when the main thread responds or the active
lifecycle ends. Older records without duration continue to replay without
inventing one.

The watchdog stores no raw message, symbols, image names, all-thread snapshot,
breadcrumbs, URL, payload, or user context. It is supported for UIKit
applications and is disabled by default. `stopReplay()` also stops its timer
and observers, marks an in-flight hang recovered, and retains pending work.
Watchdog capture does not guarantee operating-system termination, upload debug
objects, or provide runtime symbolication on its own.

The same product exposes Objective-C names through its generated module header for mixed and Objective-C SwiftPM targets:

```objective-c
@import LogBrewCrash;

NSError *error = nil;
LBWNativeCrashConfiguration *configuration =
    [[LBWNativeCrashConfiguration alloc] initWithStorageDirectory:directoryURL
                                                 maxStoredReports:5
                                                   maxReplayBytes:4 * 1024 * 1024
                                                              error:&error];
LBWNativeCrashCapture *capture =
    [[LBWNativeCrashCapture alloc] initWithConfiguration:configuration];
[capture installAndReturnError:&error];

LBWNativeCrashReplayResult *result =
    [capture replayPendingReportsWithHandler:^BOOL(LBWNativeCrashRecord *record) {
      // Send one fixed critical issue with record.eventID, record.timestamp, and record.mechanism.
      // Return YES only after the app's LogBrew transport accepts it.
      return NO;
    } error:&error];
```

## HTTP Delivery

Use `HTTPTransport` when the app is ready to send queued batches to LogBrew. It posts JSON to the production intake by default, passes the SDK key through the `authorization` header, and supports custom endpoints, headers, and timeouts for local collectors or proxies:

```swift
let transport = try HTTPTransport(
    endpoint: URL(string: "https://api.logbrew.co/v1/events")!,
    headers: ["x-logbrew-source": "checkout-ios"],
    timeout: 10
)

let response = try client.flush(transport: transport)
print("status=\(response.statusCode) attempts=\(response.attempts)")
```

Keep personally sensitive values out of event messages and metadata before calling `flush(transport:)`. Use `RecordingTransport` when you want to inspect queued JSON before network delivery.

`LogBrewLogger` is an opt-in logger facade for Swift and Apple-platform apps. It mirrors common Apple logging levels such as `debug`, `info`, `notice`, `warning`, `error`, `fault`, and `critical`, but serializes LogBrew severities as `info`, `warning`, `error`, or `critical`. It records the category as the LogBrew logger name, adds subsystem/category and exact Swift level metadata, generates event ids and timestamps by default, and reports capture failures through `onError` instead of throwing from normal logging calls.
