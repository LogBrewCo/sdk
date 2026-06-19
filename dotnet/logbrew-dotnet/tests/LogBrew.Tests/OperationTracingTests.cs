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

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }
}
