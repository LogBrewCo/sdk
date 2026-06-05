# LogBrew Swift SDK

Public Swift SDK for creating LogBrew event batches, validating them locally, and flushing them through a transport.

## Install

```swift
.package(url: "https://github.com/LogBrewCo/LogBrewCo-sdk.git", from: "0.1.0")
```

Use the `LogBrew` product from the `swift/logbrew-swift` package directory.

## Local Commands

```bash
swift build
swift test
swift package archive-source
swift run ReadmeExample
swift run RealUserSmoke
cd examples && make
cd examples && make run-readme-example
cd examples && make run
cd examples && make run-real-user-smoke
```

The package ships a `LogBrew` library product plus `ReadmeExample` and `RealUserSmoke` executable targets so users can inspect a README-sized example and a stronger retry-backed smoke path from a normal SwiftPM checkout. The examples use the fake `LOGBREW_API_KEY` placeholder and print `previewJSON()` output before flushing through `RecordingTransport`.

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

Use a clearly fake placeholder like `LOGBREW_API_KEY` in local examples and tests. Call `flush(transport:)` or `shutdown(transport:)` to send queued events through a transport, and use `previewJSON()` when you want a stable local JSON preview without sending anything.

## HTTP Delivery

Use `HTTPTransport` when the app is ready to send queued batches to LogBrew. It posts JSON to the production intake by default, passes the SDK key through the `authorization` header, and supports custom endpoints, headers, and timeouts for local collectors, proxies, and tests:

```swift
let transport = try HTTPTransport(
    endpoint: URL(string: "https://api.logbrew.com/v1/events")!,
    headers: ["x-logbrew-source": "checkout-ios"],
    timeout: 10
)

let response = try client.flush(transport: transport)
print("status=\(response.statusCode) attempts=\(response.attempts)")
```

Keep personally sensitive values out of event messages and metadata before calling `flush(transport:)`. Use `RecordingTransport` in tests when you want deterministic local JSON without network delivery.

`LogBrewLogger` is an opt-in logger facade for Swift and Apple-platform apps. It mirrors common Apple logging levels such as `debug`, `info`, `notice`, `warning`, `error`, `fault`, and `critical`, records the category as the LogBrew logger name, adds subsystem/category and exact Swift level metadata, generates event ids and timestamps by default, and reports capture failures through `onError` instead of throwing from normal logging calls.
