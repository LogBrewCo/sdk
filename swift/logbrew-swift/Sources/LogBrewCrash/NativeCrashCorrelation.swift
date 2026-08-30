import Foundation
@_spi(CrashReplay) import LogBrew

enum NativeCrashContextState: String {
    case captured
    case notCaptured = "not_captured"
    case unavailable
}

struct NativeCrashDiagnosticSnapshot: Codable, Equatable {
    let schemaVersion: Int
    let trace: TelemetryTraceContext?
    let session: TelemetrySessionContext?
    let subject: TelemetrySubjectContext?
    let impact: IssueImpactEvidence?

    init(context: TelemetryContext?, impact: IssueImpactEvidence?) throws {
        let context = try context.map(validateNativeCrashCorrelationContext)
        let impact = try impact.map { value in
            guard value.affectedUserSegment == nil,
                  let value = try validateIssueDiagnosticEvidence(
                      IssueDiagnosticEvidence(impact: value),
                  ).impact,
                  value.failedAction != nil
            else {
                throw NativeCrashError(.invalidConfiguration)
            }
            return value
        }
        guard context != nil || impact != nil else {
            throw NativeCrashError(.invalidConfiguration)
        }
        schemaVersion = 1
        trace = context?.trace
        session = context?.session
        subject = context?.subject
        self.impact = impact
    }

    var correlationContext: TelemetryContext? {
        trace == nil && session == nil && subject == nil
            ? nil
            : TelemetryContext(trace: trace, session: session, subject: subject)
    }
}

enum NativeCrashCorrelation {
    static let reportKey = "logbrew_native_correlation"
    private static let maximumBytes = 4 * 1024

    static func encoded(
        context: TelemetryContext?,
        impact: IssueImpactEvidence? = nil,
    ) throws -> String? {
        guard context != nil || impact != nil else {
            return nil
        }
        do {
            let data = try nativeCrashEncoded(NativeCrashDiagnosticSnapshot(
                context: context,
                impact: impact,
            ))
            guard data.count <= maximumBytes, let value = String(data: data, encoding: .utf8) else {
                throw NativeCrashError(.invalidConfiguration)
            }
            return value
        } catch {
            throw NativeCrashError(.invalidConfiguration)
        }
    }

    static func captured(
        in rawReport: [String: Any],
    ) -> (NativeCrashDiagnosticSnapshot?, NativeCrashContextState) {
        nativeCrashCaptured(in: rawReport, key: reportKey, maximumBytes: maximumBytes, validate: validated)
    }

    static func validated(_ object: Any) throws -> NativeCrashDiagnosticSnapshot {
        try nativeCrashValidated(object, maximumBytes: maximumBytes) { decoded in
            guard decoded.schemaVersion == 1 else {
                throw NativeCrashError(.invalidConfiguration)
            }
            return try NativeCrashDiagnosticSnapshot(
                context: decoded.correlationContext,
                impact: decoded.impact,
            )
        }
    }
}

struct NativeCrashBreadcrumbSnapshot: Codable, Equatable {
    let schemaVersion: Int
    let breadcrumbs: [IssueBreadcrumb]
    let truncated: Bool

    init(breadcrumbs: [IssueBreadcrumb], truncated: Bool) {
        schemaVersion = 1
        self.breadcrumbs = breadcrumbs
        self.truncated = truncated
    }
}

enum NativeCrashBreadcrumbs {
    static let reportKey = "logbrew_native_breadcrumbs"
    static let maximumBytes = 64 * 1024

    static func encoded(_ values: [IssueBreadcrumb]?, truncated: Bool) throws -> String? {
        guard let values, !values.isEmpty else {
            return nil
        }
        do {
            var breadcrumbs = try values.suffix(maximumIssueBreadcrumbs).map(validateIssueBreadcrumb)
            var wasTruncated = truncated || breadcrumbs.count < values.count
            while !breadcrumbs.isEmpty {
                let data = try nativeCrashEncoded(NativeCrashBreadcrumbSnapshot(
                    breadcrumbs: breadcrumbs,
                    truncated: wasTruncated,
                ))
                if data.count <= maximumBytes, let value = String(data: data, encoding: .utf8) {
                    return value
                }
                breadcrumbs.removeFirst()
                wasTruncated = true
            }
        } catch let error as NativeCrashError {
            throw error
        } catch {
            throw NativeCrashError(.invalidConfiguration)
        }
        throw NativeCrashError(.invalidConfiguration)
    }

    static func captured(
        in rawReport: [String: Any],
    ) -> (NativeCrashBreadcrumbSnapshot?, NativeCrashContextState) {
        nativeCrashCaptured(in: rawReport, key: reportKey, maximumBytes: maximumBytes, validate: validated)
    }

    static func validated(_ object: Any) throws -> NativeCrashBreadcrumbSnapshot {
        try nativeCrashValidated(object, maximumBytes: maximumBytes) { decoded in
            guard decoded.schemaVersion == 1,
                  !decoded.breadcrumbs.isEmpty,
                  decoded.breadcrumbs.count <= maximumIssueBreadcrumbs
            else {
                throw NativeCrashError(.invalidConfiguration)
            }
            return try NativeCrashBreadcrumbSnapshot(
                breadcrumbs: decoded.breadcrumbs.map(validateIssueBreadcrumb),
                truncated: decoded.truncated,
            )
        }
    }
}

private func nativeCrashCaptured<Value>(
    in rawReport: [String: Any],
    key: String,
    maximumBytes: Int,
    validate: (Any) throws -> Value,
) -> (Value?, NativeCrashContextState) {
    guard let user = rawReport["user"] as? [String: Any], let rawValue = user[key] else {
        return (nil, .notCaptured)
    }
    guard let value = rawValue as? String,
          let data = value.data(using: .utf8),
          data.count <= maximumBytes,
          let object = try? JSONSerialization.jsonObject(with: data),
          let snapshot = try? validate(object)
    else {
        return (nil, .unavailable)
    }
    return (snapshot, .captured)
}

private func nativeCrashValidated<Value: Codable>(
    _ object: Any,
    maximumBytes: Int,
    normalize: (Value) throws -> Value,
) throws -> Value {
    do {
        guard JSONSerialization.isValidJSONObject(object) else {
            throw NativeCrashError(.invalidConfiguration)
        }
        let source = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard source.count <= maximumBytes else {
            throw NativeCrashError(.invalidConfiguration)
        }
        let value = try normalize(JSONDecoder().decode(Value.self, from: source))
        let normalized = try nativeCrashEncoded(value)
        let normalizedObject = try JSONSerialization.jsonObject(with: normalized)
        guard object as? NSDictionary == normalizedObject as? NSDictionary else {
            throw NativeCrashError(.invalidConfiguration)
        }
        return value
    } catch let error as NativeCrashError {
        throw error
    } catch {
        throw NativeCrashError(.invalidConfiguration)
    }
}

private func nativeCrashEncoded(_ value: some Encodable) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
}
