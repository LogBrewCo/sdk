using System;
using System.Collections.Generic;
using LogBrew;

internal static class ServerApiKeyTests
{
    private const string Variable = "LOGBREW_SERVER_API_KEY";

    internal static int Run()
    {
        var previous = Environment.GetEnvironmentVariable(Variable);
        try
        {
            ClientWithoutKeySendsWithServerApiKeyVariable();
            ExplicitKeyWinsOverServerApiKeyVariable();
            MissingKeyNamesTheServerApiKeyVariable();
        }
        finally
        {
            Environment.SetEnvironmentVariable(Variable, previous);
        }

        return 3;
    }

    private static void ClientWithoutKeySendsWithServerApiKeyVariable()
    {
        Environment.SetEnvironmentVariable(Variable, "env-server-key");
        AssertSentKey(null, "env-server-key");
    }

    private static void ExplicitKeyWinsOverServerApiKeyVariable()
    {
        Environment.SetEnvironmentVariable(Variable, "env-server-key");
        AssertSentKey("explicit-key", "explicit-key");
    }

    private static void MissingKeyNamesTheServerApiKeyVariable()
    {
        Environment.SetEnvironmentVariable(Variable, " ");
        try
        {
            LogBrewClient.Create(null, "logbrew-dotnet-test", "1.0.0");
        }
        catch (SdkException error) when (error.Code == "configuration_error" && error.Message.Contains(Variable, StringComparison.Ordinal))
        {
            return;
        }

        throw new InvalidOperationException("expected a configuration error naming " + Variable);
    }

    private static void AssertSentKey(string? explicitKey, string expectedKey)
    {
        var transport = new KeyRecordingTransport();
        var client = LogBrewClient.Create(explicitKey, "logbrew-dotnet-test", "1.0.0");
        client.Log("evt_server_key_001", "2026-11-27T10:00:00Z", LogAttributes.Create("first event", "info"));
        client.Flush(transport);
        if (transport.ApiKeys.Count != 1 || transport.ApiKeys[0] != expectedKey)
        {
            throw new InvalidOperationException("sent keys [" + string.Join(", ", transport.ApiKeys) + "], want [" + expectedKey + "]");
        }
    }

    private sealed class KeyRecordingTransport : ITransport
    {
        internal List<string> ApiKeys { get; } = new List<string>();

        public TransportResponse Send(string apiKey, string body)
        {
            ApiKeys.Add(apiKey);
            return new TransportResponse(202, 1);
        }
    }
}
