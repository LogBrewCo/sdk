import LogBrew
import Testing

func richClient() throws -> LogBrewClient {
    try LogBrewClient.create(
        apiKey: "LOGBREW_API_KEY",
        sdkName: "test",
        sdkVersion: "0.1.0",
        includeAutomaticContext: false,
    )
}

func richParsedEvents(_ client: LogBrewClient) throws -> [[String: Any]] {
    let payload = try parsePayload(client.previewJSON())
    return try #require(payload["events"] as? [[String: Any]])
}

func richParsedAttributes(_ client: LogBrewClient) throws -> [String: Any] {
    let event = try #require(richParsedEvents(client).first)
    return try #require(event["attributes"] as? [String: Any])
}

func richContext(_ client: LogBrewClient) throws -> [String: Any] {
    let attributes = try richParsedAttributes(client)
    return try #require(attributes["context"] as? [String: Any])
}
