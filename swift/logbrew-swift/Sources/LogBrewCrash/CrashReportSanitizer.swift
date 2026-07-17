import CryptoKit
import Foundation

struct CrashReportSanitizer {
    let maxReplayBytes: Int
    let ownerNonce: UUID

    func makeRecord(reportID: Int64, rawReport: [String: Any]) throws -> NativeCrashRecord {
        let data = try canonicalData(rawReport)
        guard let report = rawReport["report"] as? [String: Any],
              let rawID = report["id"] as? String,
              let uuid = UUID(uuidString: rawID),
              let rawTimestamp = report["timestamp"] as? String,
              let timestamp = normalizedTimestamp(rawTimestamp)
        else {
            throw NativeCrashError(.reportCorrupt)
        }

        let crash = rawReport["crash"] as? [String: Any]
        let error = crash?["error"] as? [String: Any]
        return NativeCrashRecord(
            eventID: uuid.uuidString.lowercased(),
            timestamp: timestamp,
            mechanism: mechanism(error?["type"] as? String),
            reportID: reportID,
            digest: Data(SHA256.hash(data: data)),
            ownerNonce: ownerNonce,
        )
    }

    func digest(_ rawReport: [String: Any]) throws -> Data {
        try Data(SHA256.hash(data: canonicalData(rawReport)))
    }

    private func canonicalData(_ rawReport: [String: Any]) throws -> Data {
        guard JSONSerialization.isValidJSONObject(rawReport) else {
            throw NativeCrashError(.reportCorrupt)
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: rawReport, options: [.sortedKeys])
            guard data.count <= maxReplayBytes else {
                throw NativeCrashError(.reportCorrupt)
            }
            return data
        } catch let error as NativeCrashError {
            throw error
        } catch {
            throw NativeCrashError(.reportCorrupt)
        }
    }

    private func normalizedTimestamp(_ raw: String) -> String? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: raw) {
            return formatter.string(from: date)
        }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: raw) else {
            return nil
        }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    private func mechanism(_ rawValue: String?) -> NativeCrashMechanism {
        switch rawValue {
        case "signal": .signal
        case "mach": .machException
        case "cpp_exception": .cppException
        case "nsexception": .objectiveCException
        case "memory_termination": .memoryTermination
        case "deadlock": .deadlock
        default: .unknown
        }
    }
}
