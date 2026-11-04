import Foundation
import LogBrew
import LogBrewCrash

struct ProbeSetupError: Error {
    let reason: String
}

let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
let session = TelemetrySessionContext(id: "session_123")
let user = TelemetrySubjectContext(id: "user_123", kind: .user)

func now() -> String {
    Date.now.ISO8601Format()
}

func crash(capture: NativeCrashCapture) throws -> Never {
    let trace = LogBrewTrace.continueOrCreateContext(fromTraceparent: traceparent)
    try capture.setCorrelationContext(TelemetryContext(
        trace: TelemetryTraceContext(traceId: trace.traceId, spanId: trace.spanId, sampled: trace.sampled),
        session: session,
        subject: user,
    ))
    try capture.setBreadcrumbs([
        IssueBreadcrumb(timestamp: now(), category: "navigation", type: "navigation", message: "Checkout"),
    ])
    let quantities: [Int] = []
    print(quantities[quantities.count])
    exit(0)
}

func checkout(client: LogBrewClient, backend: URL, refused: URL) async throws {
    let logger = try LogBrewLogger(client: client, subsystem: "co.logbrew.checkout", category: "checkout")
    let tracer = try LogBrewURLSessionTracer(client: client)
    try await LogBrewTelemetry.withContext(TelemetryContext(session: session, subject: user)) {
        try await LogBrewTrace.withContext(LogBrewTrace.continueOrCreateContext(fromTraceparent: traceparent)) {
            try client.addBreadcrumb(IssueBreadcrumb(timestamp: now(), category: "checkout.submit", type: "navigation", message: "Checkout submitted"))
            logger.info("checkout started")
            try await tracer.data(for: URLRequest(url: backend), routeTemplate: "/checkout")
            try client.metric("evt_metric_checkout", timestamp: now(), attributes: MetricAttributes(
                name: "checkout.duration",
                kind: .histogram,
                value: 12,
                unit: "ms",
                temporality: .delta,
            ))
            do {
                try await tracer.data(for: URLRequest(url: refused), routeTemplate: "/payments") { error in
                    try client.issue("evt_issue_payment", timestamp: now(), attributes: IssueAttributes.fromError(error, title: "Payment request failed"))
                }
            } catch {
                logger.error("payment request failed", error: error)
            }
        }
    }
}

let environment = ProcessInfo.processInfo.environment
guard let endpoint = environment["LOGBREW_CAPTURE_ENDPOINT"].flatMap(URL.init(string:)),
      let backend = environment["CAPTURE_BACKEND"].flatMap({ URL(string: "\($0)/checkout") }),
      let refused = URL(string: "http://127.0.0.1:9/payments"),
      let work = environment["LOGBREW_CAPTURE_WORK"]
else {
    throw ProbeSetupError(reason: "LOGBREW_CAPTURE_ENDPOINT, CAPTURE_BACKEND, and LOGBREW_CAPTURE_WORK are required")
}

let crashCapture = try NativeCrashCapture(configuration: NativeCrashConfiguration(
    storageDirectory: URL(fileURLWithPath: work).appendingPathComponent("swift-crashes", isDirectory: true),
    artifactIdentity: NativeArtifactIdentity(
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        release: "checkout@1.2.3",
        environment: "production",
        service: "checkout-ios",
    ),
    hangWatchdog: nil,
))
try crashCapture.install()
if CommandLine.arguments.dropFirst().first == "crash" {
    try crash(capture: crashCapture)
}

let client = try LogBrewClient.create(
    apiKey: "LOGBREW_API_KEY",
    sdkName: "checkout-ios",
    sdkVersion: "1.2.3",
    context: TelemetryContext(resource: TelemetryResource(
        service: TelemetryNamedVersion(name: "checkout-ios", version: "1.2.3"),
        deployment: TelemetryDeployment(environment: "production", release: "checkout@1.2.3"),
    )),
)
let transport = try HTTPTransport(endpoint: endpoint, timeout: 10)
let replay = try crashCapture.replayPendingReports(in: client, transport: transport)
FileHandle.standardError.write(Data("crash replay acknowledged=\(replay.acknowledged) pending=\(replay.pending)\n".utf8))
try await checkout(client: client, backend: backend, refused: refused)
_ = try client.shutdown(transport: transport)
