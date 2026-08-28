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

    @Test("one bounded breadcrumb snapshot keeps newest entries and clears atomically")
    func breadcrumbSnapshotUpdatesAtomically() throws {
        let driver = FakeCrashEngineDriver(store: FakeCrashReportStore())
        let capture = try makeCapture(driver: driver)
        try capture.install()

        try capture.setBreadcrumbs((0 ... 64).map(breadcrumb))

        let update = try #require(driver.userInfoUpdates.first)
        let snapshot = try snapshotObject(update.value)
        let breadcrumbs = try #require(snapshot["breadcrumbs"] as? [[String: Any]])
        #expect(update.key == "logbrew_native_breadcrumbs")
        #expect(breadcrumbs.count == 64)
        #expect(breadcrumbs.first?["category"] as? String == "step.1")
        #expect(breadcrumbs.last?["category"] as? String == "step.64")
        #expect(snapshot["truncated"] as? Bool == true)
        #expect(try #require(update.value?.utf8.count) <= 64 * 1024)

        try capture.setBreadcrumbs(nil)
        #expect(driver.userInfoUpdates.count == 2)
        #expect(driver.userInfoUpdates[1].key == "logbrew_native_breadcrumbs")
        #expect(driver.userInfoUpdates[1].value == nil)
    }

    @Test("breadcrumb byte cap drops oldest complete entries")
    func breadcrumbSnapshotCapsBytes() throws {
        let driver = FakeCrashEngineDriver(store: FakeCrashReportStore())
        let capture = try makeCapture(driver: driver)
        try capture.install()
        let data = Dictionary(uniqueKeysWithValues: (0 ..< 8).map {
            ("field_\($0)", MetadataValue.string(String(repeating: "v", count: 256)))
        })

        try capture.setBreadcrumbs((0 ..< 64).map {
            IssueBreadcrumb(
                timestamp: "2026-08-28T03:00:\(String(format: "%02d", $0 % 60))Z",
                category: "step.\($0)",
                message: String(repeating: "m", count: 512),
                data: data,
            )
        })

        let update = try #require(driver.userInfoUpdates.first)
        let snapshot = try snapshotObject(update.value)
        let breadcrumbs = try #require(snapshot["breadcrumbs"] as? [[String: Any]])
        #expect((1 ..< 64).contains(breadcrumbs.count))
        #expect(breadcrumbs.last?["category"] as? String == "step.63")
        #expect(snapshot["truncated"] as? Bool == true)
        #expect(try #require(update.value?.utf8.count) <= 64 * 1024)
    }

    @Test("captured breadcrumbs survive restart and join the native issue")
    func persistedBreadcrumbsJoinNativeIssue() throws {
        let driver = FakeCrashEngineDriver(store: FakeCrashReportStore())
        let writer = try makeCapture(driver: driver)
        try writer.install()
        try writer.setBreadcrumbs([breadcrumb(1), breadcrumb(2)], truncated: true)
        var report = sampleRawReport()
        report["user"] = try ["logbrew_native_breadcrumbs": #require(driver.userInfoUpdates.first?.value)]
        let reader = try makeCapture(driver: FakeCrashEngineDriver(
            store: FakeCrashReportStore(reports: [1: report]),
        ))
        try reader.install()
        let client = try makeClient(name: "native-breadcrumb-test")

        try #require(reader.pendingReports().first).enqueue(in: client)

        let attributes = try #require(try firstEvent(in: client)["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        let breadcrumbs = try #require(attributes["breadcrumbs"] as? [[String: Any]])
        #expect(metadata["crash.breadcrumbs"] as? String == "captured")
        #expect(breadcrumbs.map { $0["category"] as? String } == ["step.1", "step.2"])
        #expect(attributes["breadcrumbsTruncated"] as? Bool == true)
    }

    @Test("corrupt optional breadcrumbs keep the crash and expose no raw value")
    func corruptBreadcrumbsDoNotDiscardCrash() throws {
        let privateValue = "person@example.test"
        var report = sampleRawReport()
        let corruptSnapshot = """
        {"breadcrumbs":[{"category":"ui","message":"\(privateValue)",
        "timestamp":"2026-08-28T03:00:00Z"}],"schemaVersion":1,"truncated":"invalid"}
        """
        report["user"] = [
            "logbrew_native_breadcrumbs": corruptSnapshot,
        ]
        let capture = try makeCapture(driver: FakeCrashEngineDriver(
            store: FakeCrashReportStore(reports: [1: report]),
        ))
        try capture.install()
        let client = try makeClient(name: "invalid-native-breadcrumb-test")

        let result = try capture.replayPendingReports { record in
            try? record.enqueue(in: client)
            return true
        }

        let attributes = try #require(try firstEvent(in: client)["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        #expect(result.acknowledged == 1)
        #expect(metadata["crash.breadcrumbs"] as? String == "unavailable")
        #expect(attributes["breadcrumbs"] == nil)
        #expect(try !client.previewJSON().contains(privateValue))
    }

    @Test("invalid breadcrumb snapshot cannot replace the last atomic value")
    func invalidBreadcrumbSnapshotIsRejectedBeforeWrite() throws {
        let driver = FakeCrashEngineDriver(store: FakeCrashReportStore())
        let capture = try makeCapture(driver: driver)
        try capture.install()

        #expect(throws: NativeCrashError.self) {
            try capture.setBreadcrumbs([
                IssueBreadcrumb(timestamp: "not-a-time", category: "unsafe category"),
            ])
        }
        #expect(driver.userInfoUpdates.isEmpty)
    }

    @Test("legacy queued crash without breadcrumb state remains idempotent")
    func legacyQueuedCrashWithoutBreadcrumbStateMatches() throws {
        let record = try makeRecord()
        let client = try makeClient(name: "legacy-breadcrumb-test")
        try client.issueDetached(
            record.eventID,
            timestamp: record.timestamp,
            attributes: IssueAttributes(
                title: "Native application crash",
                level: .fatal,
                metadata: ["crash.mechanism": "signal", "crash.replayed": true],
                nativeStackFrames: nil,
            ),
        )

        try record.enqueue(in: client)

        #expect(client.pendingEvents() == 1)
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

private func breadcrumb(_ index: Int) -> IssueBreadcrumb {
    IssueBreadcrumb(
        timestamp: "2026-08-28T03:00:\(String(format: "%02d", index % 60))Z",
        category: "step.\(index)",
        type: "navigation",
        level: .info,
        message: "Screen \(index)",
        data: ["sequence": .int(index)],
    )
}

private func snapshotObject(_ value: String?) throws -> [String: Any] {
    let data = try #require(value?.data(using: .utf8))
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
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
