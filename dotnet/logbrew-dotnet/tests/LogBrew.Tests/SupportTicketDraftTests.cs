using System;
using System.Collections.Generic;
using LogBrew;

internal static class SupportTicketDraftTests
{
    internal static int Run()
    {
        var tests = 0;
        CreatesPlannedPayloadAndRedactsDiagnostics();
        tests++;
        RejectsInvalidRouteOwnedValues();
        tests++;
        LimitsDiagnosticMapSize();
        tests++;
        return tests;
    }

    private static void CreatesPlannedPayloadAndRedactsDiagnostics()
    {
        var draft = SupportTicketDraft.Create(
            SupportTicketDraftInput.Create(
                    "sdk",
                    "ingest_failure",
                    "Telemetry flush failed",
                    "Flush returned usage_limit_exceeded")
                .WithProjectId("proj_123")
                .WithEnvironment("production")
                .WithRuntime(".NET 10")
                .WithFramework("ASP.NET Core")
                .WithSdkPackage("LogBrew")
                .WithSdkVersion("0.1.0")
                .WithRelease("checkout@1.2.3")
                .WithTraceId("4BF92F3577B34DA6A3CE929D0E0E4736")
                .WithEventId("evt_checkout_flush")
                .WithDiagnostics(new Dictionary<string, object?>
                {
                    ["attemptCount"] = 2,
                    ["retryable"] = false,
                    ["apiKey"] = string.Concat("lbw", "_ingest_", "hidden"),
                    ["endpoint"] = "https://api.example/ingest?debug=true#frag",
                    ["localPath"] = "/Users/example/app/.env",
                    ["error"] = new InvalidOperationException("contains hidden message"),
                    ["headers"] = new Dictionary<string, object?>
                    {
                        ["authorization"] = string.Concat("Bearer", " hidden"),
                        ["cookie"] = "sid=hidden",
                        ["accept"] = "application/json"
                    },
                    ["events"] = new object?[]
                    {
                        new Dictionary<string, object?> { ["id"] = "evt_checkout_flush", ["type"] = "span" },
                        new Dictionary<string, object?> { ["token"] = "hidden" }
                    },
                    ["callback"] = new Func<string>(() => "ignored")
                }));

        var payload = draft.ToDictionary();
        Require((string)payload["source"]! == "sdk", "expected source");
        Require((string)payload["category"]! == "ingest_failure", "expected category");
        Require((string)payload["project_id"]! == "proj_123", "expected project id");
        Require((string)payload["runtime"]! == ".NET 10", "expected runtime");
        Require((string)payload["framework"]! == "ASP.NET Core", "expected framework");
        Require((string)payload["sdk_package"]! == "LogBrew", "expected package");
        Require((string)payload["sdk_version"]! == "0.1.0", "expected version");
        Require((string)payload["trace_id"]! == "4bf92f3577b34da6a3ce929d0e0e4736", "expected normalized trace id");

        var diagnostics = (IReadOnlyDictionary<string, object?>)payload["diagnostics"]!;
        Require((int)diagnostics["attemptCount"]! == 2, "expected attempt count");
        Require((bool)diagnostics["retryable"]! == false, "expected retryable flag");
        Require((string)diagnostics["apiKey"]! == "[redacted]", "expected API key redaction");
        Require((string)diagnostics["endpoint"]! == "[redacted-url]/ingest", "expected URL origin redaction");
        Require((string)diagnostics["localPath"]! == "[redacted-path]", "expected local path redaction");

        var error = (IReadOnlyDictionary<string, object?>)diagnostics["error"]!;
        Require((string)error["type"]! == "System.InvalidOperationException", "expected exception type only");
        var headers = (IReadOnlyDictionary<string, object?>)diagnostics["headers"]!;
        Require((string)headers["authorization"]! == "[redacted]", "expected authorization redaction");
        Require((string)headers["cookie"]! == "[redacted]", "expected cookie redaction");
        Require((string)headers["accept"]! == "application/json", "expected safe header value");
        var events = (IReadOnlyList<object?>)diagnostics["events"]!;
        var secondEvent = (IReadOnlyDictionary<string, object?>)events[1]!;
        Require((string)secondEvent["token"]! == "[redacted]", "expected nested token redaction");
        Require(!diagnostics.ContainsKey("callback"), "expected unsupported callback omission");

        var json = draft.ToJson();
        foreach (var blocked in new[] { "hidden", "api.example", "/Users/example", "traceparent", "contains hidden message" })
        {
            Require(!json.Contains(blocked, StringComparison.Ordinal), "expected JSON to omit " + blocked);
        }
    }

    private static void RejectsInvalidRouteOwnedValues()
    {
        ExpectSdkError("validation_error", "support ticket source must be one of: cli, sdk, website, docs, mobile", () =>
            SupportTicketDraft.Create(SupportTicketDraftInput.Create("daemon", "ingest_failure", "Telemetry failed", "Flush failed")));
        ExpectSdkError("validation_error", "support ticket trace_id must not be all zeros", () =>
            SupportTicketDraft.Create(
                SupportTicketDraftInput.Create("sdk", "ingest_failure", "Telemetry failed", "Flush failed")
                    .WithTraceId("00000000000000000000000000000000")));
        ExpectSdkError("validation_error", "support ticket title must be non-empty", () =>
            SupportTicketDraft.Create(SupportTicketDraftInput.Create("sdk", "ingest_failure", "   ", "Flush failed")));
    }

    private static void LimitsDiagnosticMapSize()
    {
        var diagnostics = new Dictionary<string, object?>(StringComparer.Ordinal);
        for (var index = 0; index < 25; index++)
        {
            diagnostics["field" + index.ToString(System.Globalization.CultureInfo.InvariantCulture)] = index;
        }

        var draft = SupportTicketDraft.Create(
            SupportTicketDraftInput.Create("sdk", "other", "Diagnostics too large", "Large maps should be bounded")
                .WithDiagnostics(diagnostics));

        var payload = draft.ToDictionary();
        var safeDiagnostics = (IReadOnlyDictionary<string, object?>)payload["diagnostics"]!;
        Require(safeDiagnostics.Count == 20, "expected diagnostic maps to keep only 20 entries");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static void ExpectSdkError(string code, string messageFragment, Action callback)
    {
        try
        {
            callback();
        }
        catch (SdkException error)
        {
            Require(error.Code == code, "expected " + code + " but got " + error.Code);
            Require(error.Message.Contains(messageFragment, StringComparison.Ordinal), "expected error containing " + messageFragment);
            return;
        }

        throw new InvalidOperationException("expected SdkException with code " + code);
    }
}
