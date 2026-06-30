using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;
using LogBrew;

internal static class OperationTracingTests
{
    private const string IncomingTraceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";

    internal static int Run()
    {
        var tests = 0;
        DependencySpansCorrelateAndSanitizeMetadata();
        tests++;
        AsyncDependencySpanKeepsTraceActive();
        tests++;
        DependencySpanPreservesOriginalErrors();
        tests++;
        CaptureFailureDoesNotReplaceOperationResult();
        tests++;
        QueueOperationInjectsTraceparentFromActiveSpan();
        tests++;
        QueueOperationContinuesIncomingTraceparentAndLinksMessages();
        tests++;
        QueueOperationTreatsMalformedPropagationAsNonFatal();
        tests++;
        return tests;
    }

    private static void DependencySpansCorrelateAndSanitizeMetadata()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "operation-tests", "0.1.0");
        var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
        string dbResult;
        using (LogBrewTrace.Activate(root))
        {
            dbResult = LogBrewOperationTracing.DatabaseOperation(
                client,
                "orders.select",
                () =>
                {
                    Require(LogBrewTrace.Current != null, "expected active DB trace");
                    Require(LogBrewTrace.Current!.TraceId == root.TraceId, "expected DB child trace id");
                    Require(LogBrewTrace.Current.ParentSpanId == root.SpanId, "expected DB parent span");
                    return "order_123";
                },
                LogBrewOperationTracing.DatabaseOperationOptions.Create()
                    .WithEventIdPrefix("dotnet_db")
                    .WithSystem("sqlserver")
                    .WithOperationKind("select")
                    .WithDatabaseName("checkout")
                    .WithStatementTemplate("SELECT * FROM orders WHERE id = ?")
                    .WithRowCount(1)
                    .WithMetadata(new Dictionary<string, object?>
                    {
                        ["safe"] = true,
                        ["query"] = "SELECT * FROM orders WHERE id = 'se" + "cret'",
                        ["connection_string"] = "Server=private;Pass" + "word=se" + "cret",
                        ["database_host"] = "db.internal"
                    }));

            LogBrewOperationTracing.CacheOperation(
                client,
                "cart.get",
                () => 1,
                LogBrewOperationTracing.CacheOperationOptions.Create()
                    .WithEventIdPrefix("dotnet_cache")
                    .WithSystem("redis")
                    .WithOperationKind("get")
                    .WithCacheName("cart")
                    .WithHit(true)
                    .WithItemSizeBytes(42)
                    .WithItemCount(1)
                    .WithMetadata(new Dictionary<string, object?> { ["safeCache"] = "yes", ["cache-key"] = "cart:se" + "cret" }));

            LogBrewOperationTracing.QueueOperation(
                client,
                "invoice.publish",
                () => true,
                LogBrewOperationTracing.QueueOperationOptions.Create()
                    .WithEventIdPrefix("dotnet_queue")
                    .WithSystem("kafka")
                    .WithOperationKind("publish")
                    .WithQueueName("invoices")
                    .WithTaskName("invoice.created")
                    .WithMessageCount(2)
                    .WithMetadata(new Dictionary<string, object?> { ["safeQueue"] = "yes", ["messageBody"] = "se" + "cret body" }));
        }

        Require(dbResult == "order_123", "expected DB operation result");
        Require(client.PendingEvents() == 3, "expected three dependency spans");
        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"id\": \"dotnet_db_span_",
            "\"name\": \"database:orders.select\"",
            "\"source\": \"database.operation\"",
            "\"dbSystem\": \"sqlserver\"",
            "\"dbOperation\": \"orders.select\"",
            "\"dbOperationKind\": \"select\"",
            "\"dbName\": \"checkout\"",
            "\"dbStatementTemplate\": \"SELECT * FROM orders WHERE id = ?\"",
            "\"rowCount\": 1",
            "\"safe\": true",
            "\"name\": \"cache:cart.get\"",
            "\"source\": \"cache.operation\"",
            "\"cacheSystem\": \"redis\"",
            "\"cacheHit\": true",
            "\"safeCache\": \"yes\"",
            "\"name\": \"queue:invoice.publish\"",
            "\"source\": \"queue.operation\"",
            "\"queueSystem\": \"kafka\"",
            "\"queueName\": \"invoices\"",
            "\"taskName\": \"invoice.created\"",
            "\"messageCount\": 2",
            "\"safeQueue\": \"yes\"",
            "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"",
            "\"parentSpanId\": \"b7ad6b7169203331\"",
            "\"sampled\": true"
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing operation payload: " + expected);
        }

        foreach (var blocked in new[] { "cart:se" + "cret", "se" + "cret body", "Server=private", "Pass" + "word=se" + "cret", "db.internal", "id = 'se" + "cret'" })
        {
            Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected blocked metadata to be omitted: " + blocked);
        }
    }

    private static void AsyncDependencySpanKeepsTraceActive()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "operation-tests", "0.1.0");
        var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203332");
        using (LogBrewTrace.Activate(root))
        {
            var result = LogBrewOperationTracing.CacheOperationAsync(
                client,
                "profile.get",
                async () =>
                {
                    await Task.Yield();
                    Require(LogBrewTrace.Current != null, "expected async active trace");
                    Require(LogBrewTrace.Current!.TraceId == root.TraceId, "expected async trace id");
                    Require(LogBrewTrace.Current.ParentSpanId == root.SpanId, "expected async parent span");
                    return "profile";
                },
                LogBrewOperationTracing.CacheOperationOptions.Create().WithSystem("memory")).GetAwaiter().GetResult();
            Require(result == "profile", "expected async operation result");
        }

        var payload = client.PreviewJson();
        Require(payload.Contains("\"name\": \"cache:profile.get\"", StringComparison.Ordinal), "expected async cache span");
        Require(payload.Contains("\"cacheSystem\": \"memory\"", StringComparison.Ordinal), "expected async cache metadata");
        Require(payload.Contains("\"parentSpanId\": \"b7ad6b7169203332\"", StringComparison.Ordinal), "expected async parent span");
    }

    private static void DependencySpanPreservesOriginalErrors()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "operation-tests", "0.1.0");
        var original = new InvalidOperationException("database exploded with sensitive details");
        try
        {
            LogBrewOperationTracing.DatabaseOperation<int>(
                client,
                "orders.fail",
                () => throw original,
                LogBrewOperationTracing.DatabaseOperationOptions.Create().WithSystem("postgresql"));
        }
        catch (InvalidOperationException error)
        {
            Require(object.ReferenceEquals(error, original), "expected original operation error");
        }

        var payload = client.PreviewJson();
        Require(payload.Contains("\"status\": \"error\"", StringComparison.Ordinal), "expected error span");
        Require(payload.Contains("\"errorType\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected error type only");
        Require(payload.Contains("\"events\"", StringComparison.Ordinal), "expected error span event summary");
        Require(payload.Contains("\"name\": \"exception\"", StringComparison.Ordinal), "expected exception span event");
        Require(payload.Contains("\"exceptionType\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected exception event type only");
        Require(payload.Contains("\"exceptionEscaped\": true", StringComparison.Ordinal), "expected escaped exception event");
        Require(!payload.Contains("sensitive details", StringComparison.Ordinal), "expected error message to be omitted");
    }

    private static void CaptureFailureDoesNotReplaceOperationResult()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "operation-tests", "0.1.0");
        var captureErrors = 0;
        var result = LogBrewOperationTracing.QueueOperation(
            client,
            "closed.capture",
            () => 42,
            LogBrewOperationTracing.QueueOperationOptions.Create()
                .WithEventIdPrefix("dotnet_queue")
                .OnError(error =>
                {
                    Require(error.Code == "shutdown_error", "expected shutdown capture error");
                    captureErrors++;
                }));
        client.Shutdown(RecordingTransport.AlwaysAccept());

        result = LogBrewOperationTracing.QueueOperation(
            client,
            "closed.capture",
            () => result,
            LogBrewOperationTracing.QueueOperationOptions.Create()
                .WithEventIdPrefix("dotnet_queue")
                .OnError(_ =>
                {
                    captureErrors++;
                    throw new InvalidOperationException("diagnostics callback failed");
                }));
        Require(result == 42, "expected capture failure to preserve operation result");
        Require(captureErrors == 1, "expected one capture failure callback");
    }

    private static void QueueOperationInjectsTraceparentFromActiveSpan()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "operation-tests", "0.1.0");
        var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203333");
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using (LogBrewTrace.Activate(root))
        {
            LogBrewOperationTracing.QueueOperation(
                client,
                "invoice.publish",
                () =>
                {
                    Require(headers.TryGetValue("traceparent", out var traceparent), "expected outgoing traceparent header");
                    Require(LogBrewTrace.Current != null, "expected queue trace to be active");
                    Require(traceparent == LogBrewTrace.Current!.Traceparent, "expected outgoing traceparent to match active queue span");
                    return true;
                },
                LogBrewOperationTracing.QueueOperationOptions.Create()
                    .WithEventIdPrefix("dotnet_queue_publish")
                    .WithSystem("kafka")
                    .WithOperationKind("publish")
                    .WithQueueName("invoices")
                    .WithTraceparentHeaderSetter((name, value) => headers[name] = value));
        }

        var injected = Traceparent.Parse(headers["traceparent"]);
        var payload = client.PreviewJson();
        Require(injected.TraceId == root.TraceId, "expected outgoing queue trace to preserve active trace id");
        Require(payload.Contains("\"id\": \"dotnet_queue_publish_span_" + injected.ParentSpanId + "\"", StringComparison.Ordinal), "expected queue span id to match outgoing traceparent");
        Require(payload.Contains("\"parentSpanId\": \"" + root.SpanId + "\"", StringComparison.Ordinal), "expected queue span to be child of active root");
        Require(!payload.Contains("traceparent", StringComparison.Ordinal), "expected raw traceparent header not to be copied into payload");
    }

    private static void QueueOperationContinuesIncomingTraceparentAndLinksMessages()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "operation-tests", "0.1.0");
        var incoming = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
        var linked = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-00";
        var result = LogBrewOperationTracing.QueueOperation(
            client,
            "invoice.process",
            () =>
            {
                Require(LogBrewTrace.Current != null, "expected consumer queue trace to be active");
                Require(LogBrewTrace.Current!.TraceId == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "expected incoming trace id");
                Require(LogBrewTrace.Current.ParentSpanId == "bbbbbbbbbbbbbbbb", "expected incoming parent span");
                return "processed";
            },
            LogBrewOperationTracing.QueueOperationOptions.Create()
                .WithEventIdPrefix("dotnet_queue_process")
                .WithSystem("rabbitmq")
                .WithOperationKind("process")
                .WithQueueName("invoice-work")
                .WithIncomingTraceparent(incoming)
                .WithLinkedMessageTraceparent(linked, new Dictionary<string, object?> { ["relation"] = "message", ["payload"] = "se" + "cret" }));

        Require(result == "processed", "expected queue result");
        var payload = client.PreviewJson();
        Require(payload.Contains("\"traceId\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"", StringComparison.Ordinal), "expected incoming trace id in queue span");
        Require(payload.Contains("\"parentSpanId\": \"bbbbbbbbbbbbbbbb\"", StringComparison.Ordinal), "expected incoming parent span");
        Require(payload.Contains("\"links\"", StringComparison.Ordinal), "expected queue span links");
        Require(payload.Contains("\"traceId\": \"cccccccccccccccccccccccccccccccc\"", StringComparison.Ordinal), "expected linked message trace id");
        Require(payload.Contains("\"spanId\": \"dddddddddddddddd\"", StringComparison.Ordinal), "expected linked message span id");
        Require(payload.Contains("\"sampled\": false", StringComparison.Ordinal), "expected linked message sampled flag");
        Require(payload.Contains("\"relation\": \"message\"", StringComparison.Ordinal), "expected safe link metadata");
        Require(!payload.Contains("se" + "cret", StringComparison.Ordinal), "expected unsafe link metadata to be omitted");
    }

    private static void QueueOperationTreatsMalformedPropagationAsNonFatal()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "operation-tests", "0.1.0");
        var errors = 0;
        var result = LogBrewOperationTracing.QueueOperation(
            client,
            "invoice.bad-propagation",
            () =>
            {
                Require(LogBrewTrace.Current != null, "expected fallback trace to be active");
                return 7;
            },
            LogBrewOperationTracing.QueueOperationOptions.Create()
                .WithEventIdPrefix("dotnet_queue_bad")
                .WithIncomingTraceparent("not-a-traceparent")
                .WithLinkedMessageTraceparent("also-not-a-traceparent")
                .WithTraceparentHeaderSetter((_, _) => throw new InvalidOperationException("setter failed with details"))
                .OnError(error =>
                {
                    Require(error.Code == "validation_error" || error.Code == "capture_error", "expected propagation or capture diagnostic");
                    Require(!error.Message.Contains("setter failed with details", StringComparison.Ordinal), "expected setter details to be redacted");
                    errors++;
                }));

        Require(result == 7, "expected malformed propagation not to replace operation result");
        Require(errors == 3, "expected malformed incoming, malformed link, and setter diagnostics");
        var payload = client.PreviewJson();
        Require(payload.Contains("\"name\": \"queue:invoice.bad-propagation\"", StringComparison.Ordinal), "expected fallback queue span");
        Require(!payload.Contains("not-a-traceparent", StringComparison.Ordinal), "expected malformed incoming header not to be copied");
        Require(!payload.Contains("also-not-a-traceparent", StringComparison.Ordinal), "expected malformed linked header not to be copied");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }
}
