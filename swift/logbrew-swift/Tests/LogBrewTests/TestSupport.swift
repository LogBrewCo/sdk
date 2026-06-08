import Foundation
import Testing

func parsePayload(_ json: String) throws -> [String: Any] {
    let value = try JSONSerialization.jsonObject(with: Data(json.utf8))
    return try #require(value as? [String: Any])
}
