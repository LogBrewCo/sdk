import Foundation
@testable import LogBrew
import Testing

final class ThreadSafeScriptedTransport: Transport, @unchecked Sendable {
    private let condition = NSCondition()
    private var statuses: [Int]
    private var bodies: [String] = []
    private let onRequest: ((Int) -> Void)?

    init(statuses: [Int], onRequest: ((Int) -> Void)? = nil) {
        self.statuses = statuses
        self.onRequest = onRequest
    }

    var requestBodies: [String] {
        condition.lock()
        defer { condition.unlock() }
        return bodies
    }

    func send(apiKey _: String, body: Data) throws -> TransportResponse {
        let bodyText = try #require(String(data: body, encoding: .utf8))
        condition.lock()
        let index = bodies.count
        bodies.append(bodyText)
        let status = statuses.isEmpty ? 202 : statuses.removeFirst()
        condition.broadcast()
        condition.unlock()
        onRequest?(index)
        return TransportResponse(statusCode: status, attempts: 1)
    }

    func waitForRequestCount(_ count: Int, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock()
        defer { condition.unlock() }
        while bodies.count < count {
            if !condition.wait(until: deadline) {
                return bodies.count >= count
            }
        }
        return true
    }
}

func makeClient(maxRetries: Int = 2) throws -> LogBrewClient {
    try LogBrewClient.create(
        apiKey: "LOGBREW_API_KEY",
        sdkName: "automatic-delivery-tests",
        sdkVersion: "0.1.0",
        maxRetries: maxRetries,
    )
}

func captureLog(
    _ client: LogBrewClient,
    id: String,
    message: String = "automatic delivery",
) throws {
    try client.log(
        id,
        timestamp: "2026-07-18T12:00:00Z",
        attributes: LogAttributes(message: message, level: .info),
    )
}

func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() {
            return true
        }
        Thread.sleep(forTimeInterval: 0.005)
    }
    return condition()
}

func eventCount(in body: String) throws -> Int {
    let object = try JSONSerialization.jsonObject(with: Data(body.utf8))
    let payload = try #require(object as? [String: Any])
    return try #require(payload["events"] as? [[String: Any]]).count
}
