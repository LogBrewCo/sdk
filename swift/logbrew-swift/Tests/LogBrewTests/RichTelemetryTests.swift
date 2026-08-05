import Foundation
import LogBrew
import Testing

@Suite("Swift rich telemetry context")
struct RichTelemetryTests {
    @Test("shared context merges across all signals and active trace correlation")
    func sharedContextAcrossAllSignals() throws {
        let client = try contextualClient()
        let ambient = TelemetryContext(
            resource: TelemetryResource(
                deployment: TelemetryDeployment(environment: "production", release: "checkout@2.4.0"),
            ),
            session: TelemetrySessionContext(id: "session_01", previousId: "session_00"),
            tags: ["journey": "checkout"],
        )
        let eventContext = TelemetryContext(
            subject: TelemetrySubjectContext(id: "subject_01", kind: .user),
            tags: ["step": "confirm"],
        )
        let trace = try LogBrewTraceContext(
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
            parentSpanId: "1111111111111111",
        )

        try captureContextualSignals(client, ambient: ambient, event: eventContext, trace: trace)

        let events = try richParsedEvents(client)
        #expect(events.count == 7)
        for event in events {
            try assertMergedContext(event, trace: trace)
        }
    }

    @Test("automatic context is conservative and can be disabled")
    func automaticContextIsConservativeAndOptional() throws {
        let automaticClient = try LogBrewClient.create(
            apiKey: "LOGBREW_API_KEY",
            sdkName: "test",
            sdkVersion: "0.1.0",
        )
        try automaticClient.log(
            "automatic",
            timestamp: "2026-08-06T10:00:00Z",
            attributes: LogAttributes(message: "app started", level: .info),
        )
        let context = try richContext(automaticClient)
        let resource = try #require(context["resource"] as? [String: Any])
        let runtime = try #require(resource["runtime"] as? [String: Any])
        let operatingSystem = try #require(resource["operatingSystem"] as? [String: Any])
        let device = try #require(resource["device"] as? [String: Any])

        #expect(runtime["name"] as? String == "swift")
        #expect((operatingSystem["name"] as? String)?.isEmpty == false)
        #expect((operatingSystem["version"] as? String)?.isEmpty == false)
        #expect((device["architecture"] as? String)?.isEmpty == false)
        #expect(device["family"] == nil)
        #expect(device["model"] == nil)
        #expect(context["session"] == nil)
        #expect(context["subject"] == nil)
        #expect(context["tags"] == nil)

        let optOutClient = try richClient()
        try optOutClient.log(
            "opt-out",
            timestamp: "2026-08-06T10:00:00Z",
            attributes: LogAttributes(message: "app started", level: .info),
        )
        #expect(try richParsedAttributes(optOutClient)["context"] == nil)
    }

    @Test("task-local telemetry context survives async work and isolates sibling tasks")
    func taskLocalTelemetryContextIsAsyncSafe() async throws {
        async let first = LogBrewTelemetry.withContext(TelemetryContext(tags: ["task": "first"])) {
            await Task.yield()
            return LogBrewTelemetry.current?.tags?["task"]
        }
        async let second = LogBrewTelemetry.withContext(TelemetryContext(tags: ["task": "second"])) {
            await Task.yield()
            return LogBrewTelemetry.current?.tags?["task"]
        }

        let values = try await [first, second]
        #expect(values == ["first", "second"])
        #expect(LogBrewTelemetry.current == nil)
    }

    @Test("unsafe or contradictory contexts fail before queue admission")
    func unsafeContextsFailClosed() throws {
        let wrongVersion = try JSONDecoder().decode(
            TelemetryContext.self,
            from: Data(#"{"schemaVersion":2,"tags":{"plan":"team"}}"#.utf8),
        )
        let invalidContexts = [
            wrongVersion,
            TelemetryContext(),
            TelemetryContext(session: TelemetrySessionContext(id: "same", previousId: "same")),
            TelemetryContext(session: TelemetrySessionContext(id: String(repeating: "s", count: 201))),
            TelemetryContext(trace: TelemetryTraceContext(traceId: String(repeating: "ａ", count: 32))),
            TelemetryContext(trace: TelemetryTraceContext(traceId: String(repeating: "0", count: 32))),
        ]

        for context in invalidContexts {
            #expect(throws: SdkError.self) {
                _ = try LogBrewClient.create(
                    apiKey: "LOGBREW_API_KEY",
                    sdkName: "test",
                    sdkVersion: "0.1.0",
                    context: context,
                    includeAutomaticContext: false,
                )
            }
        }
    }
}

private func contextualClient() throws -> LogBrewClient {
    try LogBrewClient.create(
        apiKey: "LOGBREW_API_KEY",
        sdkName: "test",
        sdkVersion: "0.1.0",
        context: TelemetryContext(
            resource: TelemetryResource(
                service: TelemetryNamedVersion(name: "checkout-api", version: "2.4.0"),
                runtime: TelemetryNamedVersion(name: "swift"),
            ),
            tags: ["plan": "team"],
        ),
        includeAutomaticContext: false,
    )
}

private func captureContextualSignals(
    _ client: LogBrewClient,
    ambient: TelemetryContext,
    event: TelemetryContext,
    trace: LogBrewTraceContext,
) throws {
    try LogBrewTelemetry.withContext(ambient) {
        try LogBrewTrace.withContext(trace) {
            try captureReleaseThroughLog(client, context: event)
            try captureSpanThroughMetric(client, context: event, trace: trace)
        }
    }
}

private func captureReleaseThroughLog(_ client: LogBrewClient, context: TelemetryContext) throws {
    try client.release(
        "release",
        timestamp: "2026-08-06T10:00:00Z",
        attributes: ReleaseAttributes(version: "2.4.0", context: context),
    )
    try client.environment(
        "environment",
        timestamp: "2026-08-06T10:00:01Z",
        attributes: EnvironmentAttributes(name: "production", context: context),
    )
    try client.issue(
        "issue",
        timestamp: "2026-08-06T10:00:02Z",
        attributes: IssueAttributes(title: "Checkout failed", level: .error, context: context),
    )
    try client.log(
        "log",
        timestamp: "2026-08-06T10:00:03Z",
        attributes: LogAttributes(message: "Checkout started", level: .info, context: context),
    )
}

private func captureSpanThroughMetric(
    _ client: LogBrewClient,
    context: TelemetryContext,
    trace: LogBrewTraceContext,
) throws {
    try client.span(
        "span",
        timestamp: "2026-08-06T10:00:04Z",
        attributes: SpanAttributes(
            name: "checkout.submit",
            traceId: trace.traceId,
            spanId: trace.spanId,
            parentSpanId: trace.parentSpanId,
            status: .error,
            context: context,
        ),
    )
    try client.action(
        "action",
        timestamp: "2026-08-06T10:00:05Z",
        attributes: ActionAttributes(name: "checkout.submit", status: .failure, context: context),
    )
    try client.metric(
        "metric",
        timestamp: "2026-08-06T10:00:06Z",
        attributes: MetricAttributes(
            name: "checkout.duration",
            kind: .histogram,
            value: 420,
            unit: "ms",
            temporality: .delta,
            context: context,
        ),
    )
}

private func assertMergedContext(_ event: [String: Any], trace: LogBrewTraceContext) throws {
    let attributes = try #require(event["attributes"] as? [String: Any])
    let context = try #require(attributes["context"] as? [String: Any])
    let resource = try #require(context["resource"] as? [String: Any])
    let service = try #require(resource["service"] as? [String: Any])
    let deployment = try #require(resource["deployment"] as? [String: Any])
    let traceContext = try #require(context["trace"] as? [String: Any])
    let session = try #require(context["session"] as? [String: Any])
    let subject = try #require(context["subject"] as? [String: Any])
    let tags = try #require(context["tags"] as? [String: Any])

    #expect(context["schemaVersion"] as? Int == 1)
    #expect(service["name"] as? String == "checkout-api")
    #expect(service["version"] as? String == "2.4.0")
    #expect(deployment["environment"] as? String == "production")
    #expect(deployment["release"] as? String == "checkout@2.4.0")
    #expect(traceContext["traceId"] as? String == trace.traceId)
    #expect(traceContext["spanId"] as? String == trace.spanId)
    #expect(traceContext["parentSpanId"] as? String == trace.parentSpanId)
    #expect(traceContext["sampled"] as? Bool == true)
    #expect(session["id"] as? String == "session_01")
    #expect(subject["id"] as? String == "subject_01")
    #expect(subject["kind"] as? String == "user")
    #expect(tags as NSDictionary == ["plan": "team", "journey": "checkout", "step": "confirm"] as NSDictionary)
}
