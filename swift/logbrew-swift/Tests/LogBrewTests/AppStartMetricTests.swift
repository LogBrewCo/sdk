import Foundation
@testable import LogBrew
import Testing

private let firstFrame = Notification.Name("LogBrewTestsFirstFrame")
private let launchEndMs = 1_800_000_000_000.0

private func appStartSource(
    processStartMs: Double? = launchEndMs - 1500,
    isPrewarmed: Bool = false,
    center: NotificationCenter,
) -> AppStartSource {
    AppStartSource(
        processStartMs: processStartMs,
        isPrewarmed: isPrewarmed,
        firstFrameNotification: firstFrame,
        notificationCenter: center,
        nowMs: { launchEndMs },
    )
}

private func appStartClient(
    _ source: AppStartSource,
    includeAppStartMetric: Bool = true,
) throws -> LogBrewClient {
    try LogBrewClient(
        config: ClientConfig(
            apiKey: "LOGBREW_API_KEY",
            sdkName: "test",
            sdkVersion: "0.1.0",
            includeAppStartMetric: includeAppStartMetric,
        ),
        appStart: AppStartRecorder(source: source),
    )
}

private func drainMainQueue() async {
    for _ in 0 ..< 2 {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}

private func metricEvents(_ client: LogBrewClient) throws -> [[String: Any]] {
    guard client.pendingEvents() > 0 else {
        return []
    }
    let events = try #require(parsePayload(client.previewJSON())["events"] as? [[String: Any]])
    return events.filter { $0["type"] as? String == "metric" }
}

@Suite("LogBrew Swift SDK app start metric")
struct AppStartMetricTests {
    @Test("client sends one cold start metric on the first frame by default")
    @MainActor
    func sendsOneColdStartMetricOnFirstFrame() async throws {
        #expect(ClientConfig(apiKey: "k", sdkName: "s", sdkVersion: "1").includeAppStartMetric)
        let center = NotificationCenter()
        let client = try appStartClient(appStartSource(center: center))

        center.post(name: firstFrame, object: nil)
        await drainMainQueue()
        center.post(name: firstFrame, object: nil)
        await drainMainQueue()

        let events = try metricEvents(client)
        #expect(events.count == 1)
        let event = try #require(events.first)
        let attributes = try #require(event["attributes"] as? [String: Any])
        let metadata = try #require(attributes["metadata"] as? [String: Any])
        #expect((event["id"] as? String)?.hasPrefix("evt_app_start_") == true)
        #expect(attributes["name"] as? String == "app.start.duration")
        #expect(attributes["kind"] as? String == "histogram")
        #expect(attributes["temporality"] as? String == "delta")
        #expect(attributes["unit"] as? String == "ms")
        #expect((attributes["value"] as? NSNumber)?.doubleValue == 1500)
        #expect(attributes["description"] as? String == "Time from process start to the first frame.")
        #expect(metadata["startType"] as? String == "cold")
        #expect(client.markAppReady() == false)
    }

    @Test("app-ready call before the first frame ends the measurement once")
    @MainActor
    func appReadyCallEndsMeasurementOnce() async throws {
        let center = NotificationCenter()
        let client = try appStartClient(appStartSource(center: center))

        #expect(client.markAppReady())
        #expect(client.markAppReady() == false)
        center.post(name: firstFrame, object: nil)
        await drainMainQueue()

        #expect(try metricEvents(client).count == 1)
    }

    @Test("opt-out, prewarmed, and implausible launches send no metric")
    @MainActor
    func skippedLaunchesSendNoMetric() async throws {
        let cases: [(source: AppStartSource, enabled: Bool)] = [
            (appStartSource(center: NotificationCenter()), false),
            (appStartSource(isPrewarmed: true, center: NotificationCenter()), true),
            (appStartSource(processStartMs: launchEndMs - 60001, center: NotificationCenter()), true),
            (appStartSource(processStartMs: launchEndMs + 1, center: NotificationCenter()), true),
            (appStartSource(processStartMs: nil, center: NotificationCenter()), true),
        ]
        for (source, enabled) in cases {
            let client = try appStartClient(source, includeAppStartMetric: enabled)
            source.notificationCenter.post(name: firstFrame, object: nil)
            await drainMainQueue()
            #expect(client.markAppReady() == false)
            #expect(try metricEvents(client).isEmpty)
        }
    }

    @Test("kernel process start time precedes now")
    func kernelProcessStartPrecedesNow() throws {
        let startMs = try #require(AppStartSource.current.processStartMs)
        let nowMs = Date().timeIntervalSince1970 * 1000
        #expect(startMs > 0)
        #expect(startMs <= nowMs)
        #expect(nowMs - startMs < ProcessInfo.processInfo.systemUptime * 1000)
    }
}
