import Foundation
@testable import LogBrew
import Testing

@Suite("Automatic delivery lifecycle")
struct AutomaticDeliveryLifecycleTests {
    @Test("automatic delivery rejects operationally unbounded delays")
    func automaticDeliveryRejectsUnboundedDelays() throws {
        let client = try makeClient()
        let transport = RecordingTransport.alwaysAccept()

        #expect(throws: SdkError.self) {
            try client.startAutomaticDelivery(
                transport: transport,
                options: AutomaticDeliveryOptions(interval: 86401),
            )
        }
        #expect(throws: SdkError.self) {
            try client.startAutomaticDelivery(
                transport: transport,
                options: AutomaticDeliveryOptions(maxRetryDelay: 86401),
            )
        }
        #expect(client.deliveryHealth().state == .manual)
    }

    @Test("shutdown rejects captures while waiting for in-flight delivery")
    func shutdownRejectsCapturesWhileWaitingForInFlightDelivery() throws {
        let requestStarted = DispatchSemaphore(value: 0)
        let releaseRequest = DispatchSemaphore(value: 0)
        let shutdownFinished = DispatchSemaphore(value: 0)
        let transport = ThreadSafeScriptedTransport(statuses: [202]) { requestIndex in
            if requestIndex == 0 {
                requestStarted.signal()
                releaseRequest.wait()
            }
        }
        let client = try makeClient()
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(interval: 30, threshold: 1),
        )
        try captureLog(client, id: "shutdown-in-flight")
        #expect(requestStarted.wait(timeout: .now() + 2) == .success)

        let shutdownThread = Thread {
            _ = try? client.shutdown()
            shutdownFinished.signal()
        }
        shutdownThread.start()
        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .shuttingDown })
        #expect(throws: SdkError.self) {
            try captureLog(client, id: "after-shutdown-started")
        }
        #expect(shutdownFinished.wait(timeout: .now() + 0.1) == .timedOut)
        releaseRequest.signal()
        #expect(shutdownFinished.wait(timeout: .now() + 2) == .success)
        #expect(client.deliveryHealth().state == .closed)
        #expect(client.pendingEvents() == 0)
    }

    @Test("stopping during an in-flight send retains the unacknowledged prefix")
    func stopDuringInFlightSendRetainsPrefix() throws {
        let requestStarted = DispatchSemaphore(value: 0)
        let releaseRequest = DispatchSemaphore(value: 0)
        let stopFinished = DispatchSemaphore(value: 0)
        let transport = ThreadSafeScriptedTransport(statuses: [202]) { requestIndex in
            if requestIndex == 0 {
                requestStarted.signal()
                releaseRequest.wait()
            }
        }
        let client = try makeClient()
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(interval: 30, threshold: 1),
        )
        try captureLog(client, id: "stop-in-flight")
        #expect(requestStarted.wait(timeout: .now() + 2) == .success)

        let stopThread = Thread {
            client.stopAutomaticDelivery()
            stopFinished.signal()
        }
        stopThread.start()
        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .manual })
        #expect(stopFinished.wait(timeout: .now() + 0.1) == .timedOut)
        releaseRequest.signal()
        #expect(stopFinished.wait(timeout: .now() + 2) == .success)
        #expect(client.deliveryHealth().state == .manual)
        #expect(client.deliveryHealth().acceptedEvents == 0)
        #expect(client.pendingEvents() == 1)

        _ = try client.flush(transport: RecordingTransport.alwaysAccept())
        #expect(client.pendingEvents() == 0)
    }

    @Test("repeated shutdown preserves the closed-client contract")
    func repeatedShutdownPreservesClosedClientContract() throws {
        let client = try makeClient()
        let transport = RecordingTransport.alwaysAccept()

        _ = try client.shutdown(transport: transport)

        do {
            _ = try client.shutdown(transport: transport)
            Issue.record("expected repeated shutdown to fail")
        } catch let error as SdkError {
            #expect(error.code == "shutdown_error")
        }
    }

    @Test("terminal owned flush pauses automatic delivery")
    func terminalOwnedFlushPausesAutomaticDelivery() throws {
        let transport = ThreadSafeScriptedTransport(statuses: [401])
        let client = try makeClient()
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(interval: 30, threshold: 100),
        )
        try captureLog(client, id: "owned-flush-terminal")

        #expect(throws: SdkError.self) {
            _ = try client.flush()
        }

        #expect(client.deliveryHealth().state == .paused)
        #expect(client.deliveryHealth().pauseReason == .authentication)
        #expect(client.deliveryHealth().deliveryAttempts == 1)
        #expect(client.pendingEvents() == 1)
        client.stopAutomaticDelivery()
        _ = try client.flush(transport: RecordingTransport.alwaysAccept())
    }

    @Test("health is stable JSON without delivery content")
    func healthIsContentFreeJSON() throws {
        let client = try LogBrewClient.create(
            apiKey: "sensitive-health-key",
            sdkName: "health-tests",
            sdkVersion: "0.1.0",
        )
        try captureLog(client, id: "sensitive-event-id", message: "sensitive-event-content")

        let data = try JSONEncoder().encode(client.deliveryHealth())
        let json = try #require(String(data: data, encoding: .utf8))

        #expect(json.contains(#""state":"manual""#))
        #expect(json.contains(#""lastOutcome":"none""#))
        #expect(json.contains(#""pauseReason":"none""#))
        for forbidden in [
            "sensitive-health-key",
            "sensitive-event-id",
            "sensitive-event-content",
            "api.logbrew.co",
            "/home/example",
        ] {
            #expect(!json.contains(forbidden))
        }

        let lifecycleData = try JSONEncoder().encode(
            DeliveryHealth(
                state: .shuttingDown,
                queuedEvents: 1,
                queuedBytes: 2,
                inFlight: true,
                acceptedEvents: 3,
                droppedEvents: 4,
                deliveryAttempts: 5,
                consecutiveFailures: 6,
                lastOutcome: .retryableFailure,
                pauseReason: .retryExhausted,
            ),
        )
        let lifecycleJSON = try #require(String(data: lifecycleData, encoding: .utf8))
        #expect(lifecycleJSON.contains(#""state":"shutting_down""#))
        #expect(lifecycleJSON.contains(#""lastOutcome":"retryable_failure""#))
        #expect(lifecycleJSON.contains(#""pauseReason":"retry_exhausted""#))
    }
}
