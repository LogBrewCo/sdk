using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using LogBrew;

internal static class TelemetryContextTests
{
    private const string TraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    private const string SpanId = "b7ad6b7169203331";
    private const string ParentSpanId = "00f067aa0ba902b7";
    private const string Timestamp = "2026-06-02T10:00:00Z";

    internal static int Run()
    {
        SharedContextCoversEveryEventAndMergesOverrides();
        SafeRuntimeDefaultsCanBeDisabled();
        ContextRejectsUnsafeOrUnboundedValues();
        ContextDetachesCallerOwnedTags();
        ContextSurvivesConcurrentCapture();
        TraceContextCreatesTypedTelemetryContext();
        AmbientContextFlowsAndUnwindsAcrossAsyncWork();
        return 7;
    }

    private static void SharedContextCoversEveryEventAndMergesOverrides()
    {
        var clientContext = TelemetryContext.Create()
            .WithResource(
                TelemetryResource.Create()
                    .WithService("checkout-api", "1.4.0")
                    .WithDeployment("production", "2026.06.02")
                    .WithFramework("aspnetcore", "10.0")
                    .WithApplication("checkout", "1.4.0", "104")
                    .Build())
            .WithSession("session_current", "session_previous")
            .WithSubject("user_opaque_42", "user")
            .WithTag("region", "eu")
            .WithTag("plan", "team")
            .Build();
        var eventContext = TelemetryContext.Create()
            .WithResource(TelemetryResource.Create().WithService("checkout-worker").Build())
            .WithTrace(TraceId, SpanId, ParentSpanId, sampled: true)
            .WithTag("region", "us")
            .Build();
        var client = LogBrewClient.Create(
            "LOGBREW_API_KEY",
            "logbrew-dotnet",
            "0.1.0",
            new LogBrewClientOptions
            {
                Context = clientContext,
                DisableRuntimeContext = true
            });

        client.Release("context_release", Timestamp, ReleaseAttributes.Create("1.4.0").WithContext(eventContext));
        client.Environment("context_environment", Timestamp, EnvironmentAttributes.Create("production").WithContext(eventContext));
        client.Issue("context_issue", Timestamp, IssueAttributes.Create("Checkout failed", "error").WithContext(eventContext));
        client.Log("context_log", Timestamp, LogAttributes.Create("payment retry", "warning").WithContext(eventContext));
        client.Span("context_span", Timestamp, SpanAttributes.Create("POST /checkout", TraceId, SpanId, "error").WithContext(eventContext));
        client.Metric("context_metric", Timestamp, MetricAttributes.Create("checkout.duration", "histogram", 43, "ms", "delta").WithContext(eventContext));
        client.Action("context_action", Timestamp, ActionAttributes.Create("checkout.submit", "failure").WithContext(eventContext));

        using var preview = JsonDocument.Parse(client.PreviewJson());
        var events = preview.RootElement.GetProperty("events").EnumerateArray().ToArray();
        Require(events.Length == 7, "expected all seven event types");
        foreach (var telemetryEvent in events)
        {
            var context = telemetryEvent.GetProperty("attributes").GetProperty("context");
            Require(context.GetProperty("schemaVersion").GetInt32() == 1, "expected context schema version");
            var service = context.GetProperty("resource").GetProperty("service");
            Require(service.GetProperty("name").GetString() == "checkout-worker", "expected event service override");
            Require(service.GetProperty("version").GetString() == "1.4.0", "expected client service field to survive");
            var trace = context.GetProperty("trace");
            Require(trace.GetProperty("traceId").GetString() == TraceId, "expected trace id");
            Require(trace.GetProperty("spanId").GetString() == SpanId, "expected span id");
            Require(trace.GetProperty("parentSpanId").GetString() == ParentSpanId, "expected parent span id");
            Require(trace.GetProperty("sampled").GetBoolean(), "expected sampled trace");
            Require(context.GetProperty("session").GetProperty("id").GetString() == "session_current", "expected client session");
            Require(context.GetProperty("subject").GetProperty("id").GetString() == "user_opaque_42", "expected client subject");
            var tags = context.GetProperty("tags");
            Require(tags.GetProperty("region").GetString() == "us", "expected event tag override");
            Require(tags.GetProperty("plan").GetString() == "team", "expected client tag to survive");
        }
    }

    private static void SafeRuntimeDefaultsCanBeDisabled()
    {
        var defaultClient = LogBrewClient.Create("LOGBREW_API_KEY", "logbrew-dotnet", "0.1.0");
        defaultClient.Log("runtime_default", Timestamp, LogAttributes.Create("started", "info"));
        using (var preview = JsonDocument.Parse(defaultClient.PreviewJson()))
        {
            var resource = FirstContext(preview).GetProperty("resource");
            Require(resource.GetProperty("runtime").GetProperty("name").GetString() == "dotnet", "expected .NET runtime name");
            Require(!string.IsNullOrWhiteSpace(resource.GetProperty("runtime").GetProperty("version").GetString()), "expected .NET runtime version");
            Require(!string.IsNullOrWhiteSpace(resource.GetProperty("operatingSystem").GetProperty("name").GetString()), "expected OS family");
            Require(!string.IsNullOrWhiteSpace(resource.GetProperty("device").GetProperty("architecture").GetString()), "expected architecture");
        }

        var disabledClient = LogBrewClient.Create(
            "LOGBREW_API_KEY",
            "logbrew-dotnet",
            "0.1.0",
            new LogBrewClientOptions { DisableRuntimeContext = true });
        disabledClient.Log("runtime_disabled", Timestamp, LogAttributes.Create("started", "info"));
        using var disabledPreview = JsonDocument.Parse(disabledClient.PreviewJson());
        var attributes = disabledPreview.RootElement.GetProperty("events")[0].GetProperty("attributes");
        Require(!attributes.TryGetProperty("context", out _), "expected runtime context opt-out");
    }

    private static void ContextRejectsUnsafeOrUnboundedValues()
    {
        ExpectSdkError("telemetry context must include", () => TelemetryContext.Create().Build());
        ExpectSdkError("telemetry resource must not be empty", () => TelemetryResource.Create().Build());
        ExpectSdkError("must be 32 non-zero hex characters", () =>
            TelemetryContext.Create().WithTrace("trace_001").Build());
        ExpectSdkError("previousId must differ from id", () =>
            TelemetryContext.Create().WithSession("same", "same").Build());
        ExpectSdkError("kind must be anonymous or user", () =>
            TelemetryContext.Create().WithSubject("opaque", "email").Build());
        ExpectSdkError("tag key is invalid", () =>
            TelemetryContext.Create().WithTag("bad key", "value").Build());
        ExpectSdkError("tag value", () =>
            TelemetryContext.Create().WithTag("safe", "line\nvalue").Build());
        ExpectSdkError("must contain 1-32 entries", () =>
        {
            var builder = TelemetryContext.Create();
            for (var index = 0; index < 33; index++)
            {
                builder.WithTag("tag" + index.ToString(System.Globalization.CultureInfo.InvariantCulture), "value");
            }

            builder.Build();
        });

        var accepted = string.Concat(Enumerable.Repeat(char.ConvertFromUtf32(0x1f642), 256));
        TelemetryContext.Create().WithTag("unicode", accepted).Build();
        ExpectSdkError("tag value", () =>
            TelemetryContext.Create().WithTag("unicode", accepted + char.ConvertFromUtf32(0x1f642)).Build());
    }

    private static void ContextDetachesCallerOwnedTags()
    {
        var tags = new Dictionary<string, string> { ["region"] = "eu" };
        var context = TelemetryContext.Create().WithTags(tags).Build();
        tags["region"] = "mutated";
        var client = LogBrewClient.Create(
            "LOGBREW_API_KEY",
            "logbrew-dotnet",
            "0.1.0",
            new LogBrewClientOptions { Context = context, DisableRuntimeContext = true });
        client.Log("detached_context", Timestamp, LogAttributes.Create("started", "info"));
        using var preview = JsonDocument.Parse(client.PreviewJson());
        Require(FirstContext(preview).GetProperty("tags").GetProperty("region").GetString() == "eu", "expected detached tags");
    }

    private static void ContextSurvivesConcurrentCapture()
    {
        var context = TelemetryContext.Create()
            .WithResource(TelemetryResource.Create().WithService("checkout-worker", "1.4.0").Build())
            .WithSession("session_load")
            .Build();
        var client = LogBrewClient.Create(
            "LOGBREW_API_KEY",
            "logbrew-dotnet",
            "0.1.0",
            new LogBrewClientOptions { Context = context, DisableRuntimeContext = true });
        Parallel.For(0, 8, worker =>
        {
            for (var index = 0; index < 100; index++)
            {
                client.Log(
                    "context_concurrent_" + worker.ToString(System.Globalization.CultureInfo.InvariantCulture) + "_" + index.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Timestamp,
                    LogAttributes.Create("worker event", "info"));
            }
        });

        Require(client.PendingEvents() == 800, "expected zero concurrent context drops");
        using var preview = JsonDocument.Parse(client.PreviewJson());
        var events = preview.RootElement.GetProperty("events").EnumerateArray().ToArray();
        Require(events.Length == 800, "expected every concurrent event");
        Require(events.All(telemetryEvent =>
            telemetryEvent.GetProperty("attributes").GetProperty("context").GetProperty("session").GetProperty("id").GetString() == "session_load"),
            "expected context on every concurrent event");
    }

    private static void TraceContextCreatesTypedTelemetryContext()
    {
        var trace = LogBrewTraceContext.FromTraceparent(
            "00-" + TraceId + "-" + ParentSpanId + "-01",
            SpanId);
        var eventOverride = TelemetryContext.Create()
            .WithTrace(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "bbbbbbbbbbbbbbbb",
                sampled: false)
            .Build();
        var client = LogBrewClient.Create(
            "LOGBREW_API_KEY",
            "logbrew-dotnet",
            "0.1.0",
            new LogBrewClientOptions { DisableRuntimeContext = true });
        client.Log("typed_trace", Timestamp, LogAttributes.Create("retry", "warning").WithContext(trace.ToTelemetryContext()));
        using (LogBrewTrace.Activate(trace))
        {
            client.Release("active_trace_release", Timestamp, ReleaseAttributes.Create("1.0.0"));
            client.Environment("active_trace_environment", Timestamp, EnvironmentAttributes.Create("production"));
            client.Issue("active_trace_issue", Timestamp, IssueAttributes.Create("Checkout failed", "error"));
            client.Log("active_trace_log", Timestamp, LogAttributes.Create("retry", "warning"));
            client.Span("active_trace_span", Timestamp, SpanAttributes.Create("POST /checkout", TraceId, SpanId, "ok"));
            client.Metric("active_trace_metric", Timestamp, MetricAttributes.Create("checkout.duration", "histogram", 42, "ms", "delta"));
            client.Action("active_trace_action", Timestamp, ActionAttributes.Create("checkout.submit", "success"));
            client.Log(
                "active_trace_override",
                Timestamp,
                LogAttributes.Create("explicit trace", "info").WithContext(eventOverride));
        }

        using var preview = JsonDocument.Parse(client.PreviewJson());
        var serializedTrace = FirstContext(preview).GetProperty("trace");
        Require(serializedTrace.GetProperty("traceId").GetString() == TraceId, "expected typed trace id");
        Require(serializedTrace.GetProperty("spanId").GetString() == SpanId, "expected typed span id");
        Require(serializedTrace.GetProperty("parentSpanId").GetString() == ParentSpanId, "expected typed parent span id");
        var events = preview.RootElement.GetProperty("events").EnumerateArray().Skip(1).ToArray();
        foreach (var telemetryEvent in events.Where(item => item.GetProperty("id").GetString() != "active_trace_override"))
        {
            var activeTrace = telemetryEvent.GetProperty("attributes").GetProperty("context").GetProperty("trace");
            Require(activeTrace.GetProperty("traceId").GetString() == TraceId, "expected active trace on every event type");
            Require(activeTrace.GetProperty("spanId").GetString() == SpanId, "expected active span on every event type");
            Require(activeTrace.GetProperty("parentSpanId").GetString() == ParentSpanId, "expected active parent span on every event type");
        }

        var overriddenTrace = events.Single(item => item.GetProperty("id").GetString() == "active_trace_override")
            .GetProperty("attributes").GetProperty("context").GetProperty("trace");
        Require(overriddenTrace.GetProperty("traceId").GetString() == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "expected explicit event trace to win last");
        Require(overriddenTrace.GetProperty("spanId").GetString() == "bbbbbbbbbbbbbbbb", "expected explicit event span to win last");
        Require(!overriddenTrace.GetProperty("sampled").GetBoolean(), "expected explicit event sampled flag to win last");
    }

    private static void AmbientContextFlowsAndUnwindsAcrossAsyncWork()
    {
        Require(LogBrewTelemetry.CurrentContext == null, "expected no ambient context before scope");
        var ambient = TelemetryContext.Create()
            .WithSession("ambient_session")
            .WithSubject("ambient_subject", "anonymous")
            .WithTag("journey", "checkout")
            .Build();
        var nested = TelemetryContext.Create()
            .WithSession("nested_session")
            .WithTag("journey", "payment")
            .Build();
        var eventOverride = TelemetryContext.Create()
            .WithTag("journey", "event_override")
            .Build();
        var client = LogBrewClient.Create(
            "LOGBREW_API_KEY",
            "logbrew-dotnet",
            "0.1.0",
            new LogBrewClientOptions { DisableRuntimeContext = true });

        using (LogBrewTelemetry.ActivateContext(ambient))
        {
            Require(LogBrewTelemetry.CurrentContext != null, "expected active ambient context");
            Task.Run(() =>
            {
                Require(LogBrewTelemetry.CurrentContext != null, "expected ambient context in async work");
                using (LogBrewTelemetry.ActivateContext(nested))
                {
                    client.Log(
                        "nested_context",
                        Timestamp,
                        LogAttributes.Create("nested request event", "info").WithContext(eventOverride));
                }

                client.Log("ambient_context", Timestamp, LogAttributes.Create("request event", "info"));
            }).GetAwaiter().GetResult();
        }

        Require(LogBrewTelemetry.CurrentContext == null, "expected ambient context to clear after scope");
        using var preview = JsonDocument.Parse(client.PreviewJson());
        var events = preview.RootElement.GetProperty("events").EnumerateArray().ToArray();
        var nestedContext = events.Single(item => item.GetProperty("id").GetString() == "nested_context")
            .GetProperty("attributes").GetProperty("context");
        Require(nestedContext.GetProperty("session").GetProperty("id").GetString() == "nested_session", "expected nested session override");
        Require(nestedContext.GetProperty("subject").GetProperty("id").GetString() == "ambient_subject", "expected ambient subject in nested scope");
        Require(nestedContext.GetProperty("tags").GetProperty("journey").GetString() == "event_override", "expected event tag to win last");

        var ambientContext = events.Single(item => item.GetProperty("id").GetString() == "ambient_context")
            .GetProperty("attributes").GetProperty("context");
        Require(ambientContext.GetProperty("session").GetProperty("id").GetString() == "ambient_session", "expected outer ambient session after nested scope");
        Require(ambientContext.GetProperty("subject").GetProperty("id").GetString() == "ambient_subject", "expected ambient subject");
        Require(ambientContext.GetProperty("tags").GetProperty("journey").GetString() == "checkout", "expected outer ambient tag after nested scope");
    }

    private static JsonElement FirstContext(JsonDocument preview)
    {
        return preview.RootElement.GetProperty("events")[0].GetProperty("attributes").GetProperty("context");
    }

    private static void ExpectSdkError(string messageFragment, Action callback)
    {
        try
        {
            callback();
        }
        catch (SdkException error)
        {
            Require(error.Code == "validation_error", "expected validation_error");
            Require(error.DetailMessage.Contains(messageFragment, StringComparison.Ordinal), "expected error containing " + messageFragment);
            return;
        }

        throw new InvalidOperationException("expected SdkException containing " + messageFragment);
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }
}
