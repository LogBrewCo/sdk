import Foundation

public extension LogBrewClient {
    /// Runs one app-owned operation under a root or child trace and records its span.
    @discardableResult
    func withOperation<Result>(
        _ name: String,
        metadata: Metadata? = nil,
        onOperationError: ((any Error) -> Void)? = nil,
        onCaptureError: ((any Error) -> Void)? = nil,
        operation: () async throws -> Result,
    ) async throws -> Result {
        let operationName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        try requireNonEmpty("operation name", operationName)
        let context = LogBrewTrace.current.map(LogBrewTrace.childContext(of:)) ?? LogBrewTrace
            .continueOrCreateContext(fromTraceparent: nil)
        let startedAtMs = ProcessInfo.processInfo.systemUptime * 1000
        func finish(_ error: (any Error)? = nil) {
            do {
                var evidence = metadata ?? [:]
                evidence["source"] = .string("swift.operation")
                if let error {
                    evidence["errorType"] = .string(String(reflecting: type(of: error)))
                }
                try span(
                    "swift_operation_span_\(context.spanId)",
                    timestamp: currentTelemetryTimestamp(),
                    attributes: LogBrewTrace.spanAttributes(
                        name: operationName,
                        status: error == nil ? .ok : .error,
                        durationMs: max(0, ProcessInfo.processInfo.systemUptime * 1000 - startedAtMs),
                        metadata: evidence,
                        context: context,
                    ),
                )
            } catch {
                onCaptureError?(error)
            }
        }

        return try await LogBrewTrace.withContext(context) {
            do {
                let result = try await operation()
                finish()
                return result
            } catch {
                let operationError = error
                onOperationError?(operationError)
                finish(operationError)
                throw operationError
            }
        }
    }
}
