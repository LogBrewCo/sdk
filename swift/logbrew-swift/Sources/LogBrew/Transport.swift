import Foundation
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

public struct SdkError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var description: String {
        "\(code): \(message)"
    }
}

public struct TransportError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: String
    public let message: String
    public let retryable: Bool

    public init(code: String, message: String, retryable: Bool = false) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }

    public static func network(_ message: String) -> TransportError {
        TransportError(code: "network_failure", message: message, retryable: true)
    }

    public var description: String {
        message
    }
}

public struct TransportResponse: Codable, Equatable, Sendable {
    public let statusCode: Int
    public let attempts: Int

    public init(statusCode: Int, attempts: Int) {
        self.statusCode = statusCode
        self.attempts = attempts
    }
}

public protocol Transport: AnyObject {
    func send(apiKey: String, body: Data) throws -> TransportResponse
}

public typealias HTTPTransportRequester = (URLRequest) throws -> Int

public final class HTTPTransport: Transport {
    public static let defaultEndpoint = URL(string: "https://api.logbrew.com/v1/events")!
    public static let defaultTimeout: TimeInterval = 10

    public let endpoint: URL
    public let headers: [String: String]
    public let timeout: TimeInterval

    private let requester: HTTPTransportRequester?
    private let session: URLSession

    public init(
        endpoint: URL = HTTPTransport.defaultEndpoint,
        headers: [String: String] = [:],
        timeout: TimeInterval = HTTPTransport.defaultTimeout,
        session: URLSession = .shared,
        requester: HTTPTransportRequester? = nil,
    ) throws {
        self.endpoint = try Self.validateEndpoint(endpoint)
        self.headers = try Self.copyHeaders(headers)
        self.timeout = try Self.validateTimeout(timeout)
        self.session = session
        self.requester = requester
    }

    public func send(apiKey: String, body: Data) throws -> TransportResponse {
        try requireNonEmpty("api_key", apiKey)
        var request = URLRequest(url: endpoint, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "authorization")
        for (name, value) in headers {
            request.setValue(value, forHTTPHeaderField: name)
        }

        if let requester {
            return try TransportResponse(statusCode: requester(request), attempts: 1)
        }

        return try TransportResponse(statusCode: sendWithURLSession(request), attempts: 1)
    }

    private func sendWithURLSession(_ request: URLRequest) throws -> Int {
        let semaphore = DispatchSemaphore(value: 0)
        let result = HTTPTransportResultBox()
        let task = session.dataTask(with: request) { _, response, error in
            defer {
                semaphore.signal()
            }
            if let error {
                result.value = .failure(TransportError.network("http transport failed: \(error.localizedDescription)"))
                return
            }
            guard let httpResponse = response as? HTTPURLResponse else {
                result.value = .failure(TransportError.network("http transport did not return an HTTP response"))
                return
            }
            result.value = .success(httpResponse.statusCode)
        }
        task.resume()

        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            task.cancel()
            throw TransportError.network("http transport timed out")
        }

        guard let value = result.value else {
            throw TransportError.network("http transport completed without a response")
        }
        return try value.get()
    }

    private static func validateEndpoint(_ endpoint: URL) throws -> URL {
        guard let scheme = endpoint.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw SdkError(code: "configuration_error", message: "HTTP transport endpoint must use http or https")
        }
        guard endpoint.host != nil else {
            throw SdkError(code: "configuration_error", message: "HTTP transport endpoint must include a host")
        }
        return endpoint
    }

    private static func validateTimeout(_ timeout: TimeInterval) throws -> TimeInterval {
        if timeout <= 0 {
            throw SdkError(code: "configuration_error", message: "HTTP transport timeout must be positive")
        }
        return timeout
    }

    private static func copyHeaders(_ headers: [String: String]) throws -> [String: String] {
        var safeHeaders: [String: String] = [:]
        for (name, value) in headers {
            try requireNonEmpty("HTTP header name", name)
            try requireNonEmpty("HTTP header value", value)
            safeHeaders[name] = value
        }
        return safeHeaders
    }
}

private final class HTTPTransportResultBox: @unchecked Sendable {
    var value: Result<Int, Error>?
}

public enum ScriptedTransportResponse: Equatable, Sendable {
    case status(Int)
    case failure(TransportError)
}

public final class RecordingTransport: Transport {
    private var scriptedResponses: [ScriptedTransportResponse]
    public private(set) var sentBodies: [String] = []

    public init(scriptedResponses: [ScriptedTransportResponse] = [.status(202)]) {
        self.scriptedResponses = scriptedResponses.isEmpty ? [.status(202)] : scriptedResponses
    }

    public static func alwaysAccept() -> RecordingTransport {
        RecordingTransport(scriptedResponses: [.status(202)])
    }

    public func lastBody() -> String? {
        sentBodies.last
    }

    public func send(apiKey: String, body: Data) throws -> TransportResponse {
        try requireNonEmpty("api_key", apiKey)
        guard let bodyText = String(data: body, encoding: .utf8) else {
            throw TransportError(code: "invalid_request_body", message: "request body was not valid UTF-8")
        }
        sentBodies.append(bodyText)

        let next: ScriptedTransportResponse = if scriptedResponses.isEmpty {
            .status(202)
        } else {
            scriptedResponses.removeFirst()
        }

        switch next {
        case let .status(statusCode):
            return TransportResponse(statusCode: statusCode, attempts: 1)
        case let .failure(error):
            throw error
        }
    }
}
