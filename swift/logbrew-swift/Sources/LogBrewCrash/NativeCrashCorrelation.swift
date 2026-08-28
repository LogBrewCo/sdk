import Foundation
@_spi(CrashReplay) import LogBrew

enum NativeCrashContextState: String {
    case captured
    case notCaptured = "not_captured"
    case unavailable
}

enum NativeCrashCorrelation {
    static let reportKey = "logbrew_native_correlation"
    private static let maximumBytes = 1024

    static func encoded(_ context: TelemetryContext?) throws -> String? {
        guard let context else {
            return nil
        }
        do {
            let data = try encoder().encode(validateNativeCrashCorrelationContext(context))
            guard data.count <= maximumBytes, let value = String(data: data, encoding: .utf8) else {
                throw NativeCrashError(.invalidConfiguration)
            }
            return value
        } catch let error as NativeCrashError {
            throw error
        } catch {
            throw NativeCrashError(.invalidConfiguration)
        }
    }

    static func captured(in rawReport: [String: Any]) -> (TelemetryContext?, NativeCrashContextState) {
        guard let user = rawReport["user"] as? [String: Any], let value = user[reportKey] else {
            return (nil, .notCaptured)
        }
        guard let value = value as? String,
              let data = value.data(using: .utf8),
              data.count <= maximumBytes,
              let object = try? JSONSerialization.jsonObject(with: data),
              let context = try? validated(object)
        else {
            return (nil, .unavailable)
        }
        return (context, .captured)
    }

    static func validated(_ object: Any) throws -> TelemetryContext {
        do {
            guard JSONSerialization.isValidJSONObject(object) else {
                throw NativeCrashError(.invalidConfiguration)
            }
            let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            guard data.count <= maximumBytes else {
                throw NativeCrashError(.invalidConfiguration)
            }
            let context = try validateNativeCrashCorrelationContext(
                JSONDecoder().decode(TelemetryContext.self, from: data),
            )
            let normalized = try encoder().encode(context)
            let normalizedObject = try JSONSerialization.jsonObject(with: normalized)
            guard object as? NSDictionary == normalizedObject as? NSDictionary else {
                throw NativeCrashError(.invalidConfiguration)
            }
            return context
        } catch let error as NativeCrashError {
            throw error
        } catch {
            throw NativeCrashError(.invalidConfiguration)
        }
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
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
                let data = try encoder().encode(NativeCrashBreadcrumbSnapshot(
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
        guard let user = rawReport["user"] as? [String: Any], let value = user[reportKey] else {
            return (nil, .notCaptured)
        }
        guard let value = value as? String,
              let data = value.data(using: .utf8),
              data.count <= maximumBytes,
              let object = try? JSONSerialization.jsonObject(with: data),
              let snapshot = try? validated(object)
        else {
            return (nil, .unavailable)
        }
        return (snapshot, .captured)
    }

    static func validated(_ object: Any) throws -> NativeCrashBreadcrumbSnapshot {
        do {
            guard JSONSerialization.isValidJSONObject(object) else {
                throw NativeCrashError(.invalidConfiguration)
            }
            let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            guard data.count <= maximumBytes else {
                throw NativeCrashError(.invalidConfiguration)
            }
            let decoded = try JSONDecoder().decode(NativeCrashBreadcrumbSnapshot.self, from: data)
            guard decoded.schemaVersion == 1,
                  !decoded.breadcrumbs.isEmpty,
                  decoded.breadcrumbs.count <= maximumIssueBreadcrumbs
            else {
                throw NativeCrashError(.invalidConfiguration)
            }
            let snapshot = try NativeCrashBreadcrumbSnapshot(
                breadcrumbs: decoded.breadcrumbs.map(validateIssueBreadcrumb),
                truncated: decoded.truncated,
            )
            let normalized = try encoder().encode(snapshot)
            let normalizedObject = try JSONSerialization.jsonObject(with: normalized)
            guard object as? NSDictionary == normalizedObject as? NSDictionary else {
                throw NativeCrashError(.invalidConfiguration)
            }
            return snapshot
        } catch let error as NativeCrashError {
            throw error
        } catch {
            throw NativeCrashError(.invalidConfiguration)
        }
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
