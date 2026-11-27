#if os(macOS) || os(Linux)
    import Foundation
    import LogBrew
    import Testing

    @Suite("Server API key", .serialized)
    struct ServerAPIKeyTests {
        @Test("client without a key sends with LOGBREW_SERVER_API_KEY")
        func clientWithoutKeySendsWithServerAPIKeyVariable() throws {
            try withServerAPIKey("env-server-key") {
                let sentKeys = try sentAPIKeys(explicitKey: nil)
                #expect(sentKeys == ["env-server-key"])
            }
        }

        @Test("explicit key wins over LOGBREW_SERVER_API_KEY")
        func explicitKeyWinsOverServerAPIKeyVariable() throws {
            try withServerAPIKey("env-server-key") {
                let sentKeys = try sentAPIKeys(explicitKey: "explicit-key")
                #expect(sentKeys == ["explicit-key"])
            }
        }

        @Test("missing key names LOGBREW_SERVER_API_KEY")
        func missingKeyNamesServerAPIKeyVariable() throws {
            try withServerAPIKey(" ") {
                let error = try #require(throws: SdkError.self) {
                    try LogBrewClient.create(sdkName: "logbrew-swift-test", sdkVersion: "1.0.0")
                }
                #expect(error.code == "configuration_error")
                #expect(error.message.contains("LOGBREW_SERVER_API_KEY"))
            }
        }
    }

    private final class KeyRecordingTransport: Transport {
        private(set) var apiKeys: [String] = []

        func send(apiKey: String, body _: Data) throws -> TransportResponse {
            apiKeys.append(apiKey)
            return TransportResponse(statusCode: 202, attempts: 1)
        }
    }

    private func sentAPIKeys(explicitKey: String?) throws -> [String] {
        let client = try LogBrewClient.create(apiKey: explicitKey, sdkName: "logbrew-swift-test", sdkVersion: "1.0.0")
        try client.log(
            "evt_server_key_001",
            timestamp: "2026-11-27T10:00:00Z",
            attributes: LogAttributes(message: "first event", level: .info),
        )
        let transport = KeyRecordingTransport()
        _ = try client.flush(transport: transport)
        return transport.apiKeys
    }

    private func withServerAPIKey(_ value: String, _ body: () throws -> Void) throws {
        let previous = ProcessInfo.processInfo.environment["LOGBREW_SERVER_API_KEY"]
        setenv("LOGBREW_SERVER_API_KEY", value, 1)
        defer {
            if let previous {
                setenv("LOGBREW_SERVER_API_KEY", previous, 1)
            } else {
                unsetenv("LOGBREW_SERVER_API_KEY")
            }
        }
        try body()
    }
#endif
