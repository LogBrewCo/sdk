import Foundation
@testable import LogBrew
import Testing

@Suite("Automatic delivery")
struct AutomaticDeliveryTests {
    @Test("manual delivery remains the default")
    func manualDeliveryRemainsDefault() throws {
        let client = try makeClient()

        try captureLog(client, id: "manual-1")

        #expect(client.pendingEvents() == 1)
        #expect(client.deliveryHealth().state == .manual)
        #expect(client.deliveryHealth().queuedEvents == 1)
    }

    @Test("threshold delivery sends without an explicit flush")
    func thresholdDeliverySendsAutomatically() throws {
        let transport = ThreadSafeScriptedTransport(statuses: [202])
        let client = try makeClient()
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(interval: 30, threshold: 2),
        )

        try captureLog(client, id: "threshold-1")
        #expect(!transport.waitForRequestCount(1, timeout: 0.1))
        try captureLog(client, id: "threshold-2")

        #expect(transport.waitForRequestCount(1, timeout: 2))
        #expect(waitUntil(timeout: 2) { client.pendingEvents() == 0 })
        #expect(transport.requestBodies.count == 1)
        #expect(client.deliveryHealth().lastOutcome == .accepted)
        #expect(client.deliveryHealth().acceptedEvents == 2)
        _ = try client.shutdown()
    }

    @Test("interval delivery sends a sub-threshold queue")
    func intervalDeliverySendsAutomatically() throws {
        let transport = ThreadSafeScriptedTransport(statuses: [202])
        let client = try makeClient()
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(interval: 0.05, threshold: 100),
        )

        try captureLog(client, id: "interval-1")

        #expect(transport.waitForRequestCount(1, timeout: 2))
        #expect(waitUntil(timeout: 2) { client.pendingEvents() == 0 })
        _ = try client.shutdown()
    }

    @Test("default options deliver one event within 1.5 s")
    func defaultOptionsDeliverWithinOneAndAHalfSeconds() throws {
        let transport = ThreadSafeScriptedTransport(statuses: [202])
        let client = try makeClient()
        try client.startAutomaticDelivery(transport: transport, options: AutomaticDeliveryOptions())

        try captureLog(client, id: "default-interval-1")

        #expect(transport.waitForRequestCount(1, timeout: 1.5))
        _ = try client.shutdown()
    }

    @Test("retry retains exact prefix while later captures remain ordered")
    func retryRetainsExactPrefixAndLaterCaptures() throws {
        let firstAttemptStarted = DispatchSemaphore(value: 0)
        let releaseFirstAttempt = DispatchSemaphore(value: 0)
        let transport = ThreadSafeScriptedTransport(statuses: [503, 202, 202]) { requestIndex in
            if requestIndex == 0 {
                firstAttemptStarted.signal()
                _ = releaseFirstAttempt.wait(timeout: .now() + 2)
            }
        }
        let client = try makeClient(maxRetries: 2)
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(
                interval: 30,
                threshold: 1,
                retryBaseDelay: 0.02,
                maxRetryDelay: 0.02,
            ),
        )

        try captureLog(client, id: "retry-prefix")
        #expect(firstAttemptStarted.wait(timeout: .now() + 2) == .success)
        try captureLog(client, id: "later-event")
        releaseFirstAttempt.signal()

        #expect(transport.waitForRequestCount(3, timeout: 3))
        #expect(waitUntil(timeout: 2) { client.pendingEvents() == 0 })
        let bodies = transport.requestBodies
        #expect(bodies[0] == bodies[1])
        #expect(bodies[0].contains("retry-prefix"))
        #expect(!bodies[0].contains("later-event"))
        #expect(bodies[2].contains("later-event"))
        _ = try client.shutdown()
    }

    @Test("later capture cannot bypass a frozen prefix retry delay")
    func laterCaptureCannotBypassRetryDelay() throws {
        let firstAttemptStarted = DispatchSemaphore(value: 0)
        let releaseFirstAttempt = DispatchSemaphore(value: 0)
        let transport = ThreadSafeScriptedTransport(statuses: [503, 202, 202]) { requestIndex in
            if requestIndex == 0 {
                firstAttemptStarted.signal()
                _ = releaseFirstAttempt.wait(timeout: .now() + 2)
            }
        }
        let client = try makeClient(maxRetries: 2)
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(
                interval: 30,
                threshold: 1,
                retryBaseDelay: 5,
                maxRetryDelay: 5,
            ),
        )

        try captureLog(client, id: "delayed-prefix")
        #expect(firstAttemptStarted.wait(timeout: .now() + 2) == .success)
        try captureLog(client, id: "queued-behind-prefix")
        releaseFirstAttempt.signal()

        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .retrying })
        #expect(!transport.waitForRequestCount(2, timeout: 0.1))
        client.stopAutomaticDelivery()
    }

    @Test("explicit recovery resumes a terminal pause before its next probe")
    func terminalResponsePausesUntilRecovery() throws {
        let transport = ThreadSafeScriptedTransport(statuses: [401, 202])
        let client = try makeClient()
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(interval: 30, threshold: 1),
        )

        try captureLog(client, id: "paused-1")
        #expect(transport.waitForRequestCount(1, timeout: 2))
        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .paused })
        #expect(client.deliveryHealth().pauseReason == .authentication)
        try captureLog(client, id: "paused-2")
        #expect(!transport.waitForRequestCount(2, timeout: 0.1))

        try client.recoverAutomaticDelivery()

        #expect(transport.waitForRequestCount(2, timeout: 2))
        #expect(waitUntil(timeout: 2) { client.pendingEvents() == 0 })
        _ = try client.shutdown()
    }

    @Test("a 403 pause probes again and resumes without an app call")
    func forbiddenPauseResumesOnItsOwn() throws {
        let transport = ThreadSafeScriptedTransport(statuses: [403, 202])
        let client = try makeClient()
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(interval: 30, threshold: 1, retryBaseDelay: 0.05, maxRetryDelay: 0.2),
        )

        try captureLog(client, id: "forbidden-1")
        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .paused })
        let paused = client.deliveryHealth()
        #expect(paused.pauseReason == .authentication)
        #expect((0 ... 0.2).contains(paused.nextRetryDelay ?? -1))

        try #require(transport.waitForRequestCount(2, timeout: 2))
        #expect(waitUntil(timeout: 2) { client.pendingEvents() == 0 })
        #expect(transport.requestBodies[0] == transport.requestBodies[1])
        #expect(client.deliveryHealth().state == .running)
        #expect(client.deliveryHealth().pauseReason == .none)
        _ = try client.shutdown()
    }

    @Test("an outage that exhausts retries probes again and resumes")
    func exhaustedRetriesResumeOnTheirOwn() throws {
        let transport = ThreadSafeScriptedTransport(statuses: [503, 503, 503, 202])
        let client = try makeClient(maxRetries: 2)
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(interval: 30, threshold: 1, retryBaseDelay: 0.01, maxRetryDelay: 0.2),
        )

        try captureLog(client, id: "outage-1")
        #expect(transport.waitForRequestCount(4, timeout: 3))
        #expect(waitUntil(timeout: 2) { client.pendingEvents() == 0 })
        #expect(client.deliveryHealth().state == .running)
        _ = try client.shutdown()
    }

    @Test("pause probes back off to 5 minutes")
    func pauseProbeDelayIsBounded() {
        #expect(DeliveryEngine.pauseProbeDelay(maxRetryDelay: 30, failures: 1, jitter: 1) == 30)
        #expect(DeliveryEngine.pauseProbeDelay(maxRetryDelay: 30, failures: 1, jitter: 0) == 15)
        #expect(DeliveryEngine.pauseProbeDelay(maxRetryDelay: 30, failures: 3, jitter: 1) == 120)
        #expect(DeliveryEngine.pauseProbeDelay(maxRetryDelay: 30, failures: 9, jitter: 1) == 300)
        #expect(DeliveryEngine.pauseProbeDelay(maxRetryDelay: 30, failures: Int.max, jitter: 1) == 300)
        #expect(DeliveryEngine.pauseProbeDelay(maxRetryDelay: 600, failures: 4, jitter: 1) == 600)
    }

    @Test("recovery clears stale terminal wakes after draining")
    func recoveryClearsStaleTerminalWake() throws {
        let transport = ThreadSafeScriptedTransport(statuses: [401, 202, 202])
        let client = try makeClient()
        try client.startAutomaticDelivery(
            transport: transport,
            options: AutomaticDeliveryOptions(interval: 30, threshold: 2),
        )

        try captureLog(client, id: "terminal-1")
        try captureLog(client, id: "terminal-2")
        #expect(transport.waitForRequestCount(1, timeout: 2))
        #expect(waitUntil(timeout: 2) { client.deliveryHealth().state == .paused })
        try client.recoverAutomaticDelivery()
        #expect(transport.waitForRequestCount(2, timeout: 2))
        #expect(waitUntil(timeout: 2) { client.pendingEvents() == 0 })

        try captureLog(client, id: "after-recovery-1")
        #expect(!transport.waitForRequestCount(3, timeout: 0.1))
        try captureLog(client, id: "after-recovery-2")
        #expect(transport.waitForRequestCount(3, timeout: 2))
        #expect(waitUntil(timeout: 2) { client.pendingEvents() == 0 })
        _ = try client.shutdown()
    }

    @Test("queue and request bounds are enforced")
    func queueAndRequestBoundsAreEnforced() throws {
        let countClient = try makeClient()
        for index in 0 ..< 1000 {
            try captureLog(countClient, id: "count-\(index)")
        }
        #expect(throws: SdkError.self) {
            try captureLog(countClient, id: "count-overflow")
        }
        #expect(countClient.deliveryHealth().queuedEvents == 1000)
        #expect(countClient.deliveryHealth().droppedEvents == 1)

        let byteClient = try makeClient()
        let largeMessage = String(repeating: "x", count: 240_000)
        var acceptedLargeEvents = 0
        while true {
            do {
                try captureLog(byteClient, id: "bytes-\(acceptedLargeEvents)", message: largeMessage)
                acceptedLargeEvents += 1
            } catch let error as SdkError {
                #expect(error.code == "queue_full")
                break
            }
        }
        #expect(acceptedLargeEvents > 1)
        #expect(byteClient.deliveryHealth().queuedBytes <= 4 * 1024 * 1024)

        let oversizedClient = try makeClient()
        #expect(throws: SdkError.self) {
            try captureLog(
                oversizedClient,
                id: "single-oversized",
                message: String(repeating: "y", count: 256 * 1024),
            )
        }
        #expect(oversizedClient.pendingEvents() == 0)

        let batchClient = try makeClient()
        for index in 0 ..< 205 {
            try captureLog(batchClient, id: "batch-\(index)")
        }
        let batchTransport = ThreadSafeScriptedTransport(statuses: [202, 202, 202])
        let response = try batchClient.flush(transport: batchTransport)
        #expect(response.attempts == 3)
        #expect(batchTransport.requestBodies.count == 3)
        for body in batchTransport.requestBodies {
            #expect(Data(body.utf8).count <= 256 * 1024)
            #expect(try eventCount(in: body) <= 100)
        }
    }
}
