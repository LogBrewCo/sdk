import Foundation
import LogBrew
import Testing

func parsePayload(_ json: String) throws -> [String: Any] {
    let value = try JSONSerialization.jsonObject(with: Data(json.utf8))
    return try #require(value as? [String: Any])
}

func fixedTraceContext() throws -> LogBrewTraceContext {
    try LogBrewTraceContext(
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "aaaaaaaaaaaaaaaa",
        parentSpanId: "00f067aa0ba902b7",
        traceFlags: "01",
    )
}

@discardableResult
func expectSdkError(_ operation: () throws -> Void) -> SdkError {
    do {
        try operation()
        Issue.record("expected an SDK error")
    } catch let error as SdkError {
        return error
    } catch {
        Issue.record("expected SdkError, received \(type(of: error))")
    }
    return SdkError(code: "missing_error", message: "operation did not throw SdkError")
}
