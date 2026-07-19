import Foundation

public enum DeliveryState: String, Codable, Sendable {
    case manual
    case running
    case retrying
    case paused
    case shuttingDown = "shutting_down"
    case closed
}

public enum DeliveryOutcome: String, Codable, Sendable {
    case none
    case accepted
    case retryableFailure = "retryable_failure"
    case terminalFailure = "terminal_failure"
    case dropped
}

public enum DeliveryPauseReason: String, Codable, Sendable {
    case none
    case authentication
    case quota
    case validation
    case nonRetryable = "non_retryable"
    case retryExhausted = "retry_exhausted"
    case storage
}

public struct DurableDeliveryOptions: Equatable, Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }
}

public struct AutomaticDeliveryOptions: Equatable, Sendable {
    public let interval: TimeInterval
    public let threshold: Int
    public let retryBaseDelay: TimeInterval
    public let maxRetryDelay: TimeInterval

    public init(
        interval: TimeInterval = 5,
        threshold: Int = 100,
        retryBaseDelay: TimeInterval = 0.25,
        maxRetryDelay: TimeInterval = 30,
    ) {
        self.interval = interval
        self.threshold = threshold
        self.retryBaseDelay = retryBaseDelay
        self.maxRetryDelay = maxRetryDelay
    }
}

public struct DeliveryHealth: Codable, Equatable, Sendable {
    public let state: DeliveryState
    public let queuedEvents: Int
    public let queuedBytes: Int
    public let inFlight: Bool
    public let acceptedEvents: Int
    public let droppedEvents: Int
    public let deliveryAttempts: Int
    public let consecutiveFailures: Int
    public let lastOutcome: DeliveryOutcome
    public let pauseReason: DeliveryPauseReason
}
