import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

extension NativeCrashDeliveryTests {
    @Test("one bounded correlation snapshot is updated and cleared atomically")
    func correlationSnapshotUpdatesAtomically() throws {
        let driver = FakeCrashEngineDriver(store: FakeCrashReportStore())
        let capture = try makeCapture(driver: driver)
        let context = correlatedContext()

        #expect(throws: NativeCrashError.self) {
            try capture.setCorrelationContext(context)
        }
        try capture.install()
        try capture.setCorrelationContext(context)

        let update = try #require(driver.userInfoUpdates.first)
        #expect(update.key == "logbrew_native_correlation")
        let data = try #require(update.value?.data(using: .utf8))
        let value = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(value as NSDictionary == correlationJSONObject() as NSDictionary)
        #expect(data.count <= 1024)

        try capture.setCorrelationContext(nil)
        #expect(driver.userInfoUpdates.count == 2)
        #expect(driver.userInfoUpdates[1].key == "logbrew_native_correlation")
        #expect(driver.userInfoUpdates[1].value == nil)
    }

    @Test("correlation accepts only trace session and opaque subject identity")
    func correlationRejectsBroaderOrIdentifyingContext() throws {
        let driver = FakeCrashEngineDriver(store: FakeCrashReportStore())
        let capture = try makeCapture(driver: driver)
        try capture.install()
        let rejected = [
            TelemetryContext(resource: TelemetryResource(service: TelemetryNamedVersion(name: "ios-app"))),
            TelemetryContext(tags: ["feature": "checkout"]),
            TelemetryContext(session: TelemetrySessionContext(id: "192.0.2.1")),
            TelemetryContext(subject: TelemetrySubjectContext(id: "person@example.test", kind: .user)),
        ]

        for context in rejected {
            do {
                try capture.setCorrelationContext(context)
                Issue.record("expected correlation context to fail closed")
            } catch let error as NativeCrashError {
                #expect(error.code == .invalidConfiguration)
            }
        }
        #expect(driver.userInfoUpdates.isEmpty)
    }

    @Test("captured correlation survives restart and joins the native issue")
    func persistedCorrelationJoinsNativeIssue() throws {
        let client = try makeClient(name: "native-correlation-test")
        let record = try #require(correlationCapture(value: correlationJSONString()).pendingReports().first)

        try record.enqueue(in: client)

        let attributes = try #require(try firstEvent(in: client)["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        let context = try #require(attributes["context"] as? [String: Any])
        #expect(metadata["crash.correlation"] as? String == "captured")
        #expect(context as NSDictionary == correlationJSONObject() as NSDictionary)
    }

    @Test("corrupt optional correlation keeps the crash and exposes no raw value")
    func corruptCorrelationDoesNotDiscardCrash() throws {
        let privateValue = "person@example.test"
        let capture = try correlationCapture(
            value: "{\"schemaVersion\":1,\"subject\":{\"id\":\"(privateValue)\",\"kind\":\"user\"}}",
        )
        let client = try makeClient(name: "invalid-native-correlation-test")

        let result = try capture.replayPendingReports { record in
            try? record.enqueue(in: client)
            return true
        }

        let attributes = try #require(try firstEvent(in: client)["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        #expect(result.acknowledged == 1)
        #expect(result.discarded == 0)
        #expect(metadata["crash.correlation"] as? String == "unavailable")
        #expect(attributes["context"] == nil)
        #expect(try !client.previewJSON().contains(privateValue))
    }

    private func correlationCapture(value: String) throws -> NativeCrashCapture {
        var report = sampleRawReport()
        report["system"] = [:]
        report["user"] = ["logbrew_native_correlation": value]
        let capture = try makeCapture(
            driver: FakeCrashEngineDriver(store: FakeCrashReportStore(reports: [1: report])),
        )
        try capture.install()
        return capture
    }
}

private func correlatedContext() -> TelemetryContext {
    TelemetryContext(
        trace: TelemetryTraceContext(
            traceId: "11111111222233334444555555555555",
            spanId: "6666666677777777",
            parentSpanId: "8888888899999999",
            sampled: true,
        ),
        session: TelemetrySessionContext(id: "session_current", previousId: "session_previous"),
        subject: TelemetrySubjectContext(id: "subject_01", kind: .user),
    )
}

private func correlationJSONObject() -> [String: Any] {
    [
        "schemaVersion": 1,
        "trace": [
            "traceId": "11111111222233334444555555555555",
            "spanId": "6666666677777777",
            "parentSpanId": "8888888899999999",
            "sampled": true,
        ],
        "session": ["id": "session_current", "previousId": "session_previous"],
        "subject": ["id": "subject_01", "kind": "user"],
    ]
}

private func correlationJSONString() throws -> String {
    let data = try JSONSerialization.data(withJSONObject: correlationJSONObject(), options: [.sortedKeys])
    return try #require(String(data: data, encoding: .utf8))
}
